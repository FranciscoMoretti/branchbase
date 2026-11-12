import pathModule from "node:path";

import type { z } from "zod";

import { pollUntil } from "../adapters/host/polling";
import {
  inspectListeningPorts,
  listeningPortPids,
  ownedPortPids,
  pidOwnedByWorktree,
  portOwnership,
} from "../adapters/host/ports";
import { appGroupInstanceProcessId } from "../adapters/host/process-supervisor";
import type { ProcessSupervisor } from "../adapters/host/process-supervisor";
import {
  commandEnvironment,
  managedResourceRunning,
  observeManagedResourceRunning,
} from "../adapters/host/resource-status";
import type {
  LocalRoute,
  LocalRouteState,
  LocalRoutingEngine,
} from "../adapters/routing/portless";
import { configuredAppPort } from "../configuration/app-port";
import {
  resolveStartCommand,
  resolveStopCommand,
} from "../configuration/branchbase-config";
import type { ResolvedBranchBaseAppGroups } from "../configuration/branchbase-config";
import type {
  BranchBaseApp,
  BranchBaseAppGroup,
  BranchBaseConfig,
} from "../configuration/branchbase-schema";
import { renderBranchBaseTemplate } from "../configuration/branchbase-template";
import { commandWorkingDirectory } from "../configuration/command-directory";
import {
  repositoryCommandFingerprint,
  repositoryFingerprintIsTrusted,
} from "../configuration/repository-trust";
import {
  resolveResourceProfile,
  dependencyOrder,
} from "../configuration/resource-profiles";
import type { ResourceConnection } from "../configuration/resource-profiles";
import type {
  AppEndpointSnapshot,
  AppGroupSnapshot,
  AppHealth,
} from "../project/worktree-status-contract";
import {
  ExternalResourceObservation,
  externalEndpoints,
  waitForExternalResource,
  unresolvedExternalResource,
} from "../resources/external-resource";
import {
  assertManagedCommandSources,
  ManagedResourceRegistry,
} from "../resources/managed-resource";
import type { ManagedDefinition } from "../resources/managed-resource";
import { ManagedResourceObservation } from "../resources/managed-resource-observation";
import type { WorktreeProfileSchema } from "../resources/resource-contract";
import { ResourceStore } from "../resources/resource-store";
import type {
  AppGroupInstance,
  AppGroupRun,
  EndpointAssignment,
  FileBranchBaseStateStore,
  InstanceRequest,
  RunEndpoint,
  RunKey,
} from "./assignments";
import { AppGroupLifecycleError } from "./lifecycle-error";
import {
  appIsReady,
  appIsReadySync,
  reserveBackingPort,
  waitForAppReadiness,
} from "./readiness";
import type { BackingPortLease } from "./readiness";

export interface AppGroupTarget {
  managed?: ManagedDefinition & { instanceName: string };
  config: BranchBaseConfig;
  groupId: string;
  repoPath: string;
  worktree: {
    id: string;
    path: string;
    routeLabel: string;
  };
}

interface LifecycleContext {
  group: BranchBaseAppGroup;
  key: RunKey;
  processId: string;
  processPath: string;
  target: AppGroupTarget;
}

interface RunContext extends LifecycleContext {
  run: AppGroupRun;
}

interface StopContext extends LifecycleContext {
  run: AppGroupRun | null;
}

const displayName = (id: string, value: { name?: string }): string =>
  value.name ?? id;

const groupHealth = (apps: AppEndpointSnapshot[]): AppHealth => {
  if (apps.every((app) => !app.listening)) {
    return "not-running";
  }
  return apps.every((app) => app.readiness === "ready")
    ? "running"
    : "partially-running";
};

const commandEndpointIsClaimed = (
  endpoint: RunEndpoint,
  ports: ReturnType<typeof inspectListeningPorts>
): boolean => {
  const current = listeningPortPids(ports, endpoint.port);
  return current.length > 0 && endpoint.listenerClaimed === true;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const PORT_STOP_TIMEOUT_MS = 5000;

const groupForTarget = (target: AppGroupTarget): BranchBaseAppGroup => {
  const group = target.config.appGroups[target.groupId];
  if (!group) {
    throw new Error(`Unknown App group "${target.groupId}"`);
  }
  return group;
};

const lifecycleKey = (repoPath: string, instanceId: string): string =>
  [repoPath, instanceId].join("\0");

const detachedGroupId = (instanceId: string): string => `cleanup:${instanceId}`;

const detachedInstanceId = (groupId: string): string | null =>
  groupId.startsWith("cleanup:") ? groupId.slice("cleanup:".length) : null;

export const isDetachedGroupId = (groupId: string): boolean =>
  detachedInstanceId(groupId) !== null;

const detachedTarget = (
  repoPath: string,
  instance: AppGroupInstance,
  run: AppGroupRun
): AppGroupTarget => {
  const apps = Object.fromEntries(
    Object.entries(run.apps).map(([appId, app]) => [
      appId,
      { protocol: app.protocol, readiness: "tcp" as const },
    ])
  );
  return {
    config: {
      appGroups: {
        [run.groupId]: {
          apps,
          instances: { mode: instance.mode },
          start: { argv: ["true"] },
          stop: "process",
        },
      },
      setup: { argv: ["true"] },
      version: 1,
    },
    groupId: run.groupId,
    repoPath,
    worktree: {
      id: run.worktreePath,
      path: run.worktreePath,
      routeLabel: instance.routeLabel,
    },
  };
};

const runKey = (repoPath: string, instanceId: string): RunKey => ({
  instanceId,
  repoPath,
});

const runEndpointFor = (run: AppGroupRun, appId: string): RunEndpoint => {
  const endpoint = run.apps[appId];
  if (!endpoint) {
    throw new AppGroupLifecycleError(
      "invalid-run-state",
      `Persisted run is missing App "${appId}"`
    );
  }
  return endpoint;
};

const assertReadyEndpointsOwned = (
  group: BranchBaseAppGroup,
  run: AppGroupRun,
  readyAppIds: ReadonlySet<string>
): void => {
  if (group.stop !== "process") {
    return;
  }
  const ports = inspectListeningPorts();
  const unowned = Object.values(run.apps).find(
    (endpoint) =>
      readyAppIds.has(endpoint.appId) &&
      portOwnership(ports, endpoint.port, run.worktreePath) !== "owned"
  );
  if (unowned) {
    throw new AppGroupLifecycleError(
      "endpoint-ownership-conflict",
      `Backing endpoint ${unowned.port} became ready outside this worktree; no Friendly URLs were published`
    );
  }
};

const observeRunListeners = (run: AppGroupRun): void => {
  const ports = inspectListeningPorts();
  for (const endpoint of Object.values(run.apps)) {
    const observedPids = listeningPortPids(ports, endpoint.port);
    if (observedPids.length > 0) {
      endpoint.listenerClaimed = true;
    }
  }
};

const waitForPortsStopped = async (run: AppGroupRun): Promise<boolean> => {
  const ports = new Set(Object.values(run.apps).map((app) => app.port));
  const timeoutMessage = "App listeners did not stop";
  const timeoutError = new Error(timeoutMessage);
  try {
    await pollUntil(
      () => {
        const snapshot = inspectListeningPorts();
        return [...ports].every(
          (port) => portOwnership(snapshot, port, "/") === "none"
        );
      },
      {
        intervalMs: 100,
        message: timeoutMessage,
        timeoutError,
        timeoutMs: PORT_STOP_TIMEOUT_MS,
      }
    );
    return true;
  } catch (error) {
    if (error === timeoutError) {
      return false;
    }
    throw error;
  }
};

const endpointRoute = (endpoint: RunEndpoint): LocalRoute => {
  if (!endpoint.hostname) {
    throw new Error(`${endpoint.appId} does not have a Friendly hostname`);
  }
  return { hostname: endpoint.hostname, port: endpoint.port };
};

const baseInstanceRequest = (target: AppGroupTarget): InstanceRequest => {
  const group = groupForTarget(target);
  return {
    configFingerprint: repositoryCommandFingerprint(target.config),
    groupId: target.groupId,
    mode: group.instances.mode,
    repoLabel: pathModule.basename(target.repoPath),
    repoPath: target.repoPath,
    worktreeLabel: target.worktree.routeLabel,
    worktreePath: target.worktree.path,
  };
};

const lifecycleContext = (
  target: AppGroupTarget,
  instance: AppGroupInstance,
  processPath: string
): LifecycleContext => ({
  group: groupForTarget(target),
  key: runKey(target.repoPath, instance.id),
  processId: appGroupInstanceProcessId(instance.id),
  processPath,
  target,
});

const readinessForRun = (context: RunContext): Promise<boolean[]> =>
  Promise.all(
    Object.entries(context.group.apps).map(([appId, app]) =>
      appIsReady(app, runEndpointFor(context.run, appId))
    )
  );

const runContext = (
  target: AppGroupTarget,
  instance: AppGroupInstance,
  run: AppGroupRun
): RunContext => ({
  ...lifecycleContext(target, instance, run.worktreePath),
  run,
});

const stopContext = (
  target: AppGroupTarget,
  instance: AppGroupInstance,
  run: AppGroupRun | null
): StopContext => ({
  ...lifecycleContext(
    target,
    instance,
    run?.worktreePath ?? target.worktree.path
  ),
  run,
});

export class AppGroupRuntime {
  private readonly lifecycleOperations = new Map<string, Promise<void>>();
  private readonly pendingWorktreeOperations = new Map<string, number>();
  private readonly processes: ProcessSupervisor;
  private readonly routing: LocalRoutingEngine;
  private readonly state: FileBranchBaseStateStore;
  readonly resourceStore: ResourceStore;
  readonly managedResources: ManagedResourceRegistry;
  private readonly externalObservation = new ExternalResourceObservation();
  private readonly managedObservation = new ManagedResourceObservation();

  constructor(
    processes: ProcessSupervisor,
    routing: LocalRoutingEngine,
    state: FileBranchBaseStateStore
  ) {
    this.processes = processes;
    this.routing = routing;
    this.state = state;
    this.resourceStore = new ResourceStore(pathModule.dirname(state.path));
    this.managedResources = new ManagedResourceRegistry(
      pathModule.dirname(state.path)
    );
  }

  managedCatalog() {
    const ports = inspectListeningPorts();
    return this.managedResources.list().map((resource) => ({
      ...resource,
      observations: Object.fromEntries(
        resource.instances.map((name) => {
          const target = this.managedResources.target(resource.id, name);
          const instance = this.reconcile(target).resource;
          const snapshot = this.inspectInstance(target, instance, ports);
          const consumers = this.state
            .allResourceInstances()
            .filter((entry) =>
              entry.instance.run?.dependencyGroupIds?.some(
                (id) =>
                  entry.instance.run?.instanceIdsByGroup[id] === instance.id
              )
            ).length;
          return [
            name,
            {
              consumers,
              health: snapshot.health,
              manual: this.resourceStore.hasLease(instance.id),
            },
          ];
        })
      ),
    }));
  }

  profile(target: AppGroupTarget) {
    const selected = this.resourceStore.profile(
      target.repoPath,
      target.worktree.path
    );
    const override =
      selected && target.config.profiles?.definitions[selected]
        ? selected
        : null;
    return resolveResourceProfile(
      target.config,
      target.worktree.routeLabel,
      override
    );
  }

  private idlePolicy(
    connection: ResourceConnection
  ): "external" | "keep-running" | "stop-when-unused" {
    if (connection.policy === "existing") {
      return "external";
    }
    if (connection.policy === "managed") {
      return this.managedResources.get(connection.resource).definition.idle;
    }
    return connection.idle ?? "keep-running";
  }

  private connection(target: AppGroupTarget): ResourceConnection | undefined {
    return this.profile(target)?.connections[target.groupId];
  }

  private instanceRequest(
    target: AppGroupTarget,
    override?: ResourceConnection
  ): InstanceRequest {
    const connection = override ?? this.connection(target);
    const request = baseInstanceRequest(target);
    if (target.managed) {
      return {
        ...request,
        configFingerprint: `resource:${target.managed.definition.id}`,
        instanceName: target.managed.instanceName,
        mode: "selectable",
      };
    }
    if (connection?.policy === "managed") {
      return this.instanceRequest(
        this.managedResources.target(connection.resource, connection.instance)
      );
    }
    if (connection?.policy === "project" || connection?.policy === "existing") {
      return {
        ...request,
        mode: "selectable",
        useDefault: connection.policy === "existing",
      };
    }
    return connection?.policy === "worktree"
      ? { ...request, mode: "per-worktree" }
      : request;
  }

  private externalBindings(
    target: AppGroupTarget
  ): ResolvedBranchBaseAppGroups {
    return Object.fromEntries(
      Object.entries(this.profile(target)?.connections ?? {}).flatMap(
        ([id, connection]) => {
          if (connection.policy === "managed") {
            const owner = this.managedResources.target(
              connection.resource,
              connection.instance
            );
            const instances = this.reconcile(owner);
            const bindings = this.resolveTemplateAppGroups(
              owner.config,
              owner.repoPath,
              owner.worktree.path,
              { resource: instances.resource.id }
            );
            return [[id, { ...bindings.resource, id }]];
          }
          if (connection.policy !== "existing") {
            return [];
          }
          const resource = this.resourceStore.resource(connection.resource);
          return [
            [
              id,
              {
                apps: externalEndpoints(target.config.appGroups[id], resource),
                id,
                instanceId: `external:${resource.id}`,
              },
            ],
          ];
        }
      )
    );
  }

  profileStatus(
    target: AppGroupTarget,
    override?: string | null
  ): z.infer<typeof WorktreeProfileSchema> | undefined {
    const profile =
      override === undefined
        ? this.profile(target)
        : resolveResourceProfile(
            target.config,
            target.worktree.routeLabel,
            override
          );
    if (!profile || !target.config.profiles) {
      return undefined;
    }
    const runs = this.state.runningInstancesForWorktree(
      target.repoPath,
      target.worktree.path
    );
    return {
      choices: Object.entries(target.config.profiles.definitions).map(
        ([id, value]) => ({ id, name: value.name })
      ),
      connections: Object.entries(profile.connections).map(
        ([groupId, connection]) => {
          let instance: AppGroupInstance | null = null;
          let connectionError: string | undefined;
          let idle: "external" | "keep-running" | "stop-when-unused" =
            "keep-running";
          try {
            instance = this.state.instanceLookup(
              this.instanceRequest({ ...target, groupId }, connection)
            );
            idle = this.idlePolicy(connection);
          } catch (error) {
            connectionError = errorMessage(error);
          }
          if (connection.policy === "existing") {
            try {
              externalEndpoints(
                target.config.appGroups[groupId],
                this.resourceStore.resource(connection.resource)
              );
            } catch (error) {
              connectionError = errorMessage(error);
            }
          }
          let resourceName = target.worktree.routeLabel;
          if (connection.policy === "project") {
            resourceName = "Project instance";
          }
          if (connection.policy === "managed") {
            resourceName = `${connection.resource} / ${connection.instance}`;
          }
          if (connection.policy === "existing") {
            resourceName = connection.resource;
          }
          return {
            error: connectionError,
            groupId,
            idle,
            name: target.config.appGroups[groupId]?.name ?? groupId,
            policy: connection.policy,
            resourceId:
              connection.policy === "existing"
                ? connection.resource
                : (instance?.id ?? ""),
            resourceName,
          };
        }
      ),
      id: profile.id,
      name: profile.name,
      runningProfile:
        runs.find(
          (instance) =>
            target.config.appGroups[instance.groupId]?.category !==
            "infrastructure"
        )?.run?.profileId ?? null,
      source: profile.source,
    };
  }

  inspect(
    target: AppGroupTarget,
    ports: ReturnType<typeof inspectListeningPorts>
  ): AppGroupSnapshot {
    const connection = this.connection(target);
    if (connection?.policy === "managed") {
      try {
        const owner = this.managedResources.target(
          connection.resource,
          connection.instance
        );
        const instance = this.reconcile(owner).resource;
        const snapshot = this.inspectInstance(owner, instance, ports);
        return {
          ...snapshot,
          id: target.groupId,
          name: groupForTarget(target).name ?? target.groupId,
        };
      } catch {
        return {
          ...unresolvedExternalResource(
            target.groupId,
            groupForTarget(target),
            connection.resource
          ),
          external: false,
        };
      }
    }
    if (connection?.policy === "existing") {
      try {
        return this.externalObservation.inspect(
          target.groupId,
          groupForTarget(target),
          this.resourceStore.resource(connection.resource)
        );
      } catch {
        return unresolvedExternalResource(
          target.groupId,
          groupForTarget(target),
          connection.resource
        );
      }
    }
    const instance = this.state.instanceLookup(this.instanceRequest(target));
    if (!instance) {
      throw new Error(
        `App group "${target.groupId}" must be reconciled before inspection`
      );
    }
    return this.inspectInstance(target, instance, ports);
  }

  /** Reconcile persisted endpoint identity without allocating backing ports. */
  reconcile(target: AppGroupTarget): Record<string, AppGroupInstance> {
    const instances: Record<string, AppGroupInstance> = {};
    for (const [groupId, group] of Object.entries(target.config.appGroups)) {
      const connection = this.connection({ ...target, groupId });
      if (connection?.policy === "managed") {
        try {
          instances[groupId] = this.reconcile(
            this.managedResources.target(
              connection.resource,
              connection.instance
            )
          ).resource;
        } catch {
          instances[groupId] = this.state.reconcileInstance(
            baseInstanceRequest({ ...target, groupId })
          );
        }
        continue;
      }
      const request = this.instanceRequest({ ...target, groupId });
      const instance = this.state.reconcileInstance(request);
      instances[groupId] = instance;
      for (const [appId, app] of Object.entries(group.apps)) {
        this.state.reconcileEndpoint({
          appId,
          appLabel: displayName(appId, app),
          groupId,
          instanceId: instance.id,
          repoPath: target.repoPath,
        });
      }
    }
    return instances;
  }

  inspectDetached(
    repoPath: string,
    instance: AppGroupInstance,
    ports: ReturnType<typeof inspectListeningPorts>
  ): AppGroupSnapshot {
    const { run } = instance;
    if (!run) {
      throw new Error("Cleanup target has no persisted run");
    }
    const target = detachedTarget(repoPath, instance, run);
    const snapshot = this.inspectInstance(target, instance, ports);
    return {
      ...snapshot,
      cleanupOnly: true,
      id: detachedGroupId(instance.id),
      instance: { ...snapshot.instance, mode: "per-worktree" },
      instances: [{ id: instance.id, name: instance.name, running: true }],
      name: `${run.groupId} (cleanup)`,
      stop: run.stop && run.stop !== "process" ? "command" : "process",
    };
  }

  private inspectInstance(
    target: AppGroupTarget,
    instance: AppGroupInstance,
    ports: ReturnType<typeof inspectListeningPorts>
  ): AppGroupSnapshot {
    const group = groupForTarget(target);
    const run = this.state.run(runKey(target.repoPath, instance.id));
    const processPath = run?.worktreePath ?? target.worktree.path;
    const processRunning =
      this.processes.managedPid(
        appGroupInstanceProcessId(instance.id),
        processPath
      ) !== null;
    const apps = Object.entries(group.apps).map(([appId, app]) => {
      const assignment = this.state.endpointLookup({
        appId,
        groupId: target.groupId,
        instanceId: instance.id,
        repoPath: target.repoPath,
      });
      return this.inspectEndpoint({
        app,
        appId,
        assignment,
        ports,
        run: run?.apps[appId] ?? null,
        stop: group.stop,
        worktreePath: processPath,
      });
    });
    const groupSnapshotDependencies = this.inspectDependencies(
      target,
      group,
      run
    );
    const groupSnapshotPending = this.lifecycleOperations.has(
      lifecycleKey(target.repoPath, instance.id)
    );
    const emptyGroupHealth = processRunning ? "running" : "not-running";
    let groupSnapshotHealth = apps.length
      ? groupHealth(apps)
      : emptyGroupHealth;
    if (run?.definition && target.managed) {
      try {
        this.managedResources.assertCaptured(run.definition);
        if (target.managed.definition.status) {
          if (!this.inspectDetachedRunning(runContext(target, instance, run))) {
            groupSnapshotHealth = "partially-running";
          } else if (apps.length === 0) {
            groupSnapshotHealth = "running";
          }
        }
      } catch {
        groupSnapshotHealth = "partially-running";
      }
    }
    const groupSnapshotInstances =
      instance.mode === "selectable"
        ? this.state
            .instances(
              target.repoPath,
              target.groupId,
              this.instanceRequest(target).configFingerprint
            )
            .map((option) => ({
              id: option.id,
              name: option.name,
              running: this.instanceIsRunning(option, group.stop, ports),
            }))
        : [
            {
              id: instance.id,
              name: instance.name,
              running: this.instanceIsRunning(instance, group.stop, ports),
            },
          ];
    const groupSnapshotName = displayName(target.groupId, group);
    return {
      apps,
      category: group.category ?? "application",
      dependencies: groupSnapshotDependencies,
      health: groupSnapshotHealth,
      id: target.groupId,
      instance: {
        id: instance.id,
        mode: instance.mode,
        name: instance.name,
      },
      instances: groupSnapshotInstances,
      name: groupSnapshotName,
      pending: groupSnapshotPending,
      processRunning,
      run: run
        ? { startedAt: run.createdAt, worktreePath: run.worktreePath }
        : null,
      stop: group.stop === "process" ? "process" : "command",
    };
  }

  private inspectDependencies(
    target: AppGroupTarget,
    group: BranchBaseAppGroup,
    run: AppGroupRun | null
  ) {
    const templates = [...Object.values(group.env ?? {}), ...group.start.argv];
    const dependencies =
      run?.dependencyGroupIds ?? dependencyOrder(target.config, target.groupId);
    return Object.keys(target.config.appGroups)
      .filter(
        (groupId) =>
          groupId !== target.groupId &&
          (dependencies.includes(groupId) ||
            templates.some((value) =>
              value.includes(`{appGroups.${groupId}.apps.`)
            ))
      )
      .flatMap((groupId) => {
        const capturedId = run?.bindings?.[groupId]?.instanceId;
        if (capturedId?.startsWith("external:")) {
          return [
            {
              groupId,
              instanceId: capturedId,
              name: capturedId.slice("external:".length),
            },
          ];
        }
        const external = this.profile(target)?.connections[groupId];
        if (!run && external?.policy === "existing") {
          return [
            {
              groupId,
              instanceId: `external:${external.resource}`,
              name: external.resource,
            },
          ];
        }
        if (!run && external?.policy === "managed") {
          return [
            {
              groupId,
              instanceId: `managed:${external.resource}:${external.instance}`,
              name: `${external.resource} / ${external.instance}`,
            },
          ];
        }
        const instanceId = run?.instanceIdsByGroup[groupId];
        const instance = instanceId
          ? this.state
              .allResourceInstances()
              .find((entry) => entry.instance.id === instanceId)?.instance
          : this.state.instanceLookup(
              this.instanceRequest({ ...target, groupId })
            );
        return instance
          ? [{ groupId, instanceId: instance.id, name: instance.name }]
          : [];
      });
  }

  start(target: AppGroupTarget): Promise<"already-running" | "started"> {
    const effectiveInstances = this.reconcile(target);
    return this.trackWorktreeOperation(
      target.worktree.path,
      this.serializeLifecycle(
        Object.values(effectiveInstances).map((instance) =>
          lifecycleKey(target.repoPath, instance.id)
        ),
        () => this.startWithDependencies(target, this.reconcile(target))
      )
    );
  }

  private async startWithDependencies(
    target: AppGroupTarget,
    instances: Record<string, AppGroupInstance>
  ): Promise<"already-running" | "started"> {
    let result: "started" | "already-running" = "already-running";
    for (const groupId of dependencyOrder(target.config, target.groupId)) {
      const dependencyTarget = { ...target, groupId };
      // oxlint-disable-next-line no-await-in-loop -- Dependencies must start before consumers.
      result = await this.startUnlocked(dependencyTarget, instances);
      const connection = this.connection(dependencyTarget);
      if (groupId === target.groupId || connection?.policy === "existing") {
        continue;
      }
      const owner =
        connection?.policy === "managed"
          ? this.managedResources.target(
              connection.resource,
              connection.instance
            )
          : dependencyTarget;
      const instance =
        connection?.policy === "managed"
          ? this.reconcile(owner).resource
          : instances[groupId];
      const dependency = this.state.run(runKey(owner.repoPath, instance.id));
      if (!dependency) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- All dependency endpoints must be ready before the next consumer.
      const readiness = await readinessForRun(
        runContext(owner, instance, dependency)
      );
      if (!readiness.every(Boolean)) {
        throw new Error(`Dependency "${groupId}" is not ready.`);
      }
    }
    return result;
  }

  private prepareResourceRun(
    target: AppGroupTarget,
    effectiveInstances: Record<string, AppGroupInstance>,
    instance: AppGroupInstance
  ): AppGroupRun {
    const group = groupForTarget(target);
    const key = runKey(target.repoPath, instance.id);
    let run = this.state.run(key);
    if (
      run?.definition &&
      target.managed?.revision !== run.definition.revision
    ) {
      throw new Error(
        "Resource recipe changed. Restore the running revision to stop it, then approve and start the updated definition."
      );
    }
    if (
      run?.profileId &&
      run.profileId !== this.profile(target)?.id &&
      group.category !== "infrastructure"
    ) {
      throw new Error(
        "The profile changed. Restart this application to apply its new connections."
      );
    }
    if (!run) {
      run = this.createRun({
        config: target.config,
        effectiveInstances,
        externalGroups: this.externalBindings(target),
        group,
        groupId: target.groupId,
        instance,
        repoPath: target.repoPath,
        worktreePath:
          this.connection(target)?.policy === "project"
            ? target.repoPath
            : target.worktree.path,
      });
      if (target.managed) {
        run.definition = {
          id: target.managed.definition.id,
          path: target.managed.path,
          revision: target.managed.revision,
        };
      }
      run.profileId = this.profile(target)?.id;
      run.dependencyGroupIds = dependencyOrder(
        target.config,
        target.groupId
      ).filter((id) => id !== target.groupId);
      run.resourceIdle = Object.fromEntries(
        Object.entries(this.profile(target)?.connections ?? {}).flatMap(
          ([id, dependencyConnection]) =>
            dependencyConnection.policy === "existing"
              ? []
              : [
                  [
                    id,
                    dependencyConnection.policy === "managed"
                      ? this.managedResources.get(dependencyConnection.resource)
                          .definition.idle
                      : (dependencyConnection.idle ?? "keep-running"),
                  ],
                ]
        )
      );
      this.state.saveRun(key, run);
    }

    return run;
  }

  private async startUnlocked(
    target: AppGroupTarget,
    effectiveInstances: Record<string, AppGroupInstance>
  ): Promise<"already-running" | "started"> {
    const group = groupForTarget(target);
    const connection = this.connection(target);
    if (connection?.policy === "managed") {
      const owner = this.managedResources.target(
        connection.resource,
        connection.instance
      );
      return this.startUnlocked(owner, this.reconcile(owner));
    }
    if (target.managed) {
      this.managedResources.assertApproved(target.managed);
    }
    if (connection?.policy === "existing") {
      await waitForExternalResource(
        group,
        this.resourceStore.resource(connection.resource)
      );
      return "already-running";
    }
    await this.prepareRouting();
    await this.materializeEffectiveInstances(target, effectiveInstances);
    const instance = effectiveInstances[target.groupId];
    if (!instance) {
      throw new Error(`Unknown App group "${target.groupId}"`);
    }
    const key = runKey(target.repoPath, instance.id);
    let run = this.state.run(key);
    const allocatedNow = run === null;
    run = this.prepareResourceRun(target, effectiveInstances, instance);

    const context = runContext(target, instance, run);
    this.assertRunPortsAvailable(context, allocatedNow);
    const readiness = await readinessForRun(context);
    if (this.runIsReady(context, readiness)) {
      return "already-running";
    }

    if (
      target.managed?.definition.status &&
      !allocatedNow &&
      readiness.some(Boolean) &&
      !this.detachedRunning(context)
    ) {
      throw new Error(
        "A listener is present but the selected managed resource is not running"
      );
    }
    this.launchRunProcess(context, readiness);
    await this.waitForAndPublishRun(context);
    return "started";
  }

  retry(target: AppGroupTarget): Promise<"already-running" | "retried"> {
    const connection = this.connection(target);
    if (connection?.policy === "managed") {
      return this.retry(
        this.managedResources.target(connection.resource, connection.instance)
      );
    }
    this.reconcile(target);
    const instance = this.state.instanceLookup(this.instanceRequest(target));
    if (!instance) {
      throw new Error(`Unknown App group "${target.groupId}"`);
    }
    return this.trackWorktreeOperation(
      target.worktree.path,
      this.serializeLifecycle(
        [lifecycleKey(target.repoPath, instance.id)],
        () => this.retryUnlocked(target, instance)
      )
    );
  }

  private async retryUnlocked(
    target: AppGroupTarget,
    instance: AppGroupInstance
  ): Promise<"already-running" | "retried"> {
    if (this.connection(target)?.policy === "existing") {
      throw new Error("This resource is externally managed.");
    }
    await this.prepareRouting();
    const key = runKey(target.repoPath, instance.id);
    const run = this.state.run(key);
    if (!run) {
      throw new AppGroupLifecycleError(
        "not-started",
        `${displayName(target.groupId, groupForTarget(target))} has not been started`
      );
    }
    if (run.definition) {
      this.managedResources.assertCaptured(run.definition);
    }
    const context = runContext(target, instance, run);
    this.assertRunPortsAvailable(context, false);
    const readiness = await readinessForRun(context);
    if (this.runIsReady(context, readiness)) {
      return "already-running";
    }
    await this.waitForAndPublishRun(context);
    return "retried";
  }

  stop(target: AppGroupTarget): Promise<"already-stopped" | "stopped"> {
    const connection = this.connection(target);
    if (connection?.policy === "managed") {
      return this.stop(
        this.managedResources.target(connection.resource, connection.instance)
      );
    }
    if (this.connection(target)?.policy === "existing") {
      return Promise.resolve("already-stopped");
    }
    this.reconcile(target);
    const instance = this.state.instanceLookup(this.instanceRequest(target));
    if (!instance) {
      throw new Error(`Unknown App group "${target.groupId}"`);
    }
    return this.trackWorktreeOperation(
      target.worktree.path,
      this.serializeLifecycle(
        [lifecycleKey(target.repoPath, instance.id)],
        async () => {
          if (this.connection(target)?.policy === "existing") {
            return "already-stopped" as const;
          }
          const current = this.reconcile(target)[target.groupId];
          this.assertNoResourceConsumers(target, current);
          const run = this.state.run(runKey(target.repoPath, current.id));
          const result = await this.stopUnlocked(target, current);
          await this.stopUnusedDependencies(target, run);
          return result;
        }
      )
    );
  }

  stopDetached(
    repoPath: string,
    worktreePath: string,
    groupId: string
  ): Promise<"already-stopped" | "stopped"> {
    const instanceId = detachedInstanceId(groupId);
    const instance = instanceId
      ? this.state.instanceById(repoPath, instanceId)
      : null;
    if (!(instance?.run && instance.run.worktreePath === worktreePath)) {
      throw new Error("Unknown cleanup App group");
    }
    const stopCommandTrusted = repositoryFingerprintIsTrusted(
      repoPath,
      instance.configFingerprint,
      this.processes.controlDirectory
    );
    return this.trackWorktreeOperation(
      worktreePath,
      this.serializeLifecycle([lifecycleKey(repoPath, instance.id)], () =>
        this.stopDetachedUnlocked(repoPath, instance, stopCommandTrusted)
      )
    );
  }

  /** Stop either a configured group or a retained run whose config disappeared. */
  stopConfiguredOrDetached(
    repoPath: string,
    worktreePath: string,
    groupId: string,
    target?: AppGroupTarget
  ): Promise<"already-stopped" | "stopped"> {
    if (!isDetachedGroupId(groupId)) {
      if (!target || groupId !== target.groupId) {
        throw new Error(`Unknown App group "${groupId}"`);
      }
      return this.stop(target);
    }
    return this.stopDetached(repoPath, worktreePath, groupId);
  }

  restart(target: AppGroupTarget): Promise<"restarted"> {
    const connection = this.connection(target);
    if (connection?.policy === "managed") {
      return this.restart(
        this.managedResources.target(connection.resource, connection.instance)
      );
    }
    if (this.connection(target)?.policy === "existing") {
      throw new Error("This resource is externally managed.");
    }
    const effectiveInstances = this.reconcile(target);
    const instance = effectiveInstances[target.groupId];
    if (!instance) {
      throw new Error(`Unknown App group "${target.groupId}"`);
    }
    const keys = Object.values(effectiveInstances).map((item) =>
      lifecycleKey(target.repoPath, item.id)
    );
    return this.trackWorktreeOperation(
      target.worktree.path,
      this.serializeLifecycle(keys, async () => {
        const current = this.reconcile(target);
        const selected = current[target.groupId];
        this.assertNoResourceConsumers(target, selected);
        const previous = this.state.run(runKey(target.repoPath, selected.id));
        await this.stopUnlocked(target, selected);
        await this.startWithDependencies(target, current);
        await this.stopUnusedDependencies(target, previous);
        return "restarted" as const;
      })
    );
  }

  hasPendingLifecycle(worktreePath: string): boolean {
    return (this.pendingWorktreeOperations.get(worktreePath) ?? 0) > 0;
  }

  private hasConsumers(_repoPath: string, instanceId: string): boolean {
    return (
      this.resourceStore.hasLease(instanceId) ||
      this.state
        .allResourceInstances()
        .map((entry) => entry.instance)
        .some(
          (item) =>
            item.id !== instanceId &&
            item.run?.dependencyGroupIds?.some(
              (groupId) => item.run?.instanceIdsByGroup[groupId] === instanceId
            )
        )
    );
  }

  private assertNoResourceConsumers(
    target: AppGroupTarget,
    instance: AppGroupInstance
  ): void {
    if (this.hasConsumers(target.repoPath, instance.id)) {
      throw new Error(
        "This resource is in use. Stop its applications before stopping or restarting it."
      );
    }
  }

  private async stopUnusedDependencies(
    target: AppGroupTarget,
    run: AppGroupRun | null
  ): Promise<void> {
    for (const groupId of (run?.dependencyGroupIds ?? []).toReversed()) {
      if (run?.resourceIdle?.[groupId] !== "stop-when-unused") {
        continue;
      }
      const owned = this.state
        .allResourceInstances()
        .find((entry) => entry.instance.id === run.instanceIdsByGroup[groupId]);
      const instance = owned?.instance;
      if (!instance?.run || this.hasConsumers(target.repoPath, instance.id)) {
        continue;
      }
      if (instance.run.definition && owned) {
        this.managedResources.assertCaptured(instance.run.definition);
        const owner = this.managedResources.target(
          instance.run.definition.id,
          instance.name
        );
        // oxlint-disable-next-line no-await-in-loop -- Release dependencies after their consumers.
        await this.stopUnlocked(owner, instance);
        continue;
      }
      const ownedTarget = {
        ...target,
        groupId,
        worktree: { ...target.worktree, path: instance.run.worktreePath },
      };
      // oxlint-disable-next-line no-await-in-loop -- Stop dependencies in reverse order after their last consumer.
      await this.stopUnlocked(ownedTarget, instance);
    }
  }

  async selectProfile(
    target: AppGroupTarget,
    profileId: string | null,
    restart: boolean
  ): Promise<void> {
    const proposed = resolveResourceProfile(
      target.config,
      target.worktree.routeLabel,
      profileId
    );
    if (!proposed) {
      throw new Error("Configure resource profiles for this project first.");
    }
    for (const [groupId, connection] of Object.entries(proposed.connections)) {
      if (connection.policy === "existing") {
        externalEndpoints(
          target.config.appGroups[groupId],
          this.resourceStore.resource(connection.resource)
        );
      }
    }
    const instances = this.reconcile(target);
    await this.trackWorktreeOperation(
      target.worktree.path,
      this.serializeLifecycle(
        Object.values(instances).map((instance) =>
          lifecycleKey(target.repoPath, instance.id)
        ),
        async () => {
          const applicationRuns = this.state
            .runningInstancesForWorktree(target.repoPath, target.worktree.path)
            .filter(
              (instance) =>
                target.config.appGroups[instance.groupId]?.category !==
                "infrastructure"
            );
          if (applicationRuns.length && !restart) {
            throw new Error(
              "Restart the running applications to change their resource connections."
            );
          }
          for (const instance of applicationRuns) {
            // oxlint-disable-next-line no-await-in-loop -- Finish stopping each application before changing its connections.
            await this.stopUnlocked(
              { ...target, groupId: instance.groupId },
              instance
            );
          }
          this.resourceStore.select(
            target.repoPath,
            target.worktree.path,
            profileId
          );
          const next = this.reconcile(target);
          for (const previous of applicationRuns) {
            // oxlint-disable-next-line no-await-in-loop -- Restart consumers after their dependencies are ready.
            await this.startWithDependencies(
              { ...target, groupId: previous.groupId },
              next
            );
          }
          for (const previous of applicationRuns) {
            // oxlint-disable-next-line no-await-in-loop -- Retire unused old dependencies only after the replacement is ready.
            await this.stopUnusedDependencies(target, previous.run);
          }
        }
      )
    );
  }

  private async stopUnlocked(
    target: AppGroupTarget,
    instance: AppGroupInstance
  ): Promise<"already-stopped" | "stopped"> {
    const key = runKey(target.repoPath, instance.id);
    const run = this.state.run(key);
    if (run?.definition) {
      this.managedResources.assertCaptured(run.definition);
    }
    const context = stopContext(target, instance, run);
    if (
      !run &&
      this.processes.managedPid(context.processId, context.processPath) === null
    ) {
      return "already-stopped";
    }

    const failures = await this.deactivateRunRoutes(context);
    failures.push(...(await this.executeConfiguredStop(context)));
    await this.stopRunProcesses(context);

    if (context.run && !(await waitForPortsStopped(context.run))) {
      failures.push(
        "App listeners did not stop; Backing endpoints remain quarantined"
      );
    }
    if (failures.length === 0) {
      this.state.removeRun(context.key);
    }
    if (failures.length > 0) {
      throw new AppGroupLifecycleError("stop-failed", failures.join("; "));
    }
    return "stopped";
  }

  private async stopDetachedUnlocked(
    repoPath: string,
    instance: AppGroupInstance,
    stopCommandTrusted: boolean
  ): Promise<"already-stopped" | "stopped"> {
    const { run } = instance;
    if (!run) {
      return "already-stopped";
    }
    const target = detachedTarget(repoPath, instance, run);
    this.assertNoResourceConsumers(target, instance);
    if (run?.definition) {
      this.managedResources.assertCaptured(run.definition);
    }
    const context = stopContext(target, instance, run);
    const failures = await this.deactivateRunRoutes(context);
    if (run.stop && run.stop !== "process" && stopCommandTrusted) {
      try {
        await this.processes.runFiniteCommand({
          argv: run.stop.argv,
          cwd: commandWorkingDirectory(run.worktreePath, run.stop.cwd),
          env: commandEnvironment(
            {
              ...context.group,
              env: run.environmentTemplates,
              inputs: run.inputs,
            },
            run.stop.env
          ),
          label: `Stop ${run.groupId}`,
          logId: context.processId,
          sensitive: Object.keys(run.inputs ?? {}).length > 0,
        });
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    await this.stopRunProcesses(context);
    if (!(await waitForPortsStopped(run))) {
      failures.push(
        "App listeners did not stop; Backing endpoints remain quarantined"
      );
    }
    if (failures.length === 0) {
      this.state.removeRun(context.key);
      return "stopped";
    }
    throw new AppGroupLifecycleError("stop-failed", failures.join("; "));
  }

  private async deactivateRunRoutes(context: StopContext): Promise<string[]> {
    const failures: string[] = [];
    for (const endpoint of Object.values(context.run?.apps ?? {})) {
      if (endpoint.protocol !== "http" || !endpoint.hostname) {
        continue;
      }
      try {
        const route = endpointRoute(endpoint);
        const routeState = this.routing.observe(route);
        if (routeState === "conflict") {
          failures.push(
            `${route.hostname} points to a different Backing endpoint`
          );
        } else if (routeState !== "inactive") {
          // oxlint-disable-next-line no-await-in-loop -- Route deactivation is serialized to preserve cleanup ordering.
          await this.routing.deactivate(route);
        }
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    return failures;
  }

  private async executeConfiguredStop(context: StopContext): Promise<string[]> {
    if (context.group.stop === "process") {
      return [];
    }
    try {
      const command =
        context.run?.stop && context.run.stop !== "process"
          ? context.run.stop
          : resolveStopCommand(
              context.target.config,
              context.target.groupId,
              context.run?.bindings ??
                this.resolveTemplateAppGroups(
                  context.target.config,
                  context.target.repoPath,
                  context.processPath,
                  context.run?.instanceIdsByGroup
                )
            );
      if (!command) {
        throw new Error(
          `${displayName(context.target.groupId, context.group)} has no Stop command`
        );
      }
      if (context.target.managed) {
        assertManagedCommandSources(
          context.target.managed,
          command.argv,
          commandWorkingDirectory(context.processPath, command.cwd)
        );
      }
      await this.processes.runFiniteCommand({
        argv: command.argv,
        cwd: commandWorkingDirectory(context.processPath, command.cwd),
        env: commandEnvironment(
          {
            ...context.group,
            env: context.run?.environmentTemplates ?? context.group.env,
            inputs: context.run?.inputs ?? context.group.inputs,
          },
          command.env
        ),
        label: `Stop ${displayName(context.target.groupId, context.group)}`,
        logId: context.processId,
        sensitive:
          Object.keys(context.run?.inputs ?? context.group.inputs ?? {})
            .length > 0,
      });
      return [];
    } catch (error) {
      return [errorMessage(error)];
    }
  }

  private async stopRunProcesses(context: StopContext): Promise<void> {
    await this.processes.stopManagedProcess(
      context.processId,
      context.processPath
    );
    if (context.group.stop !== "process" || !context.run) {
      return;
    }
    const killed = new Set<number>();
    for (const pid of ownedPortPids(
      inspectListeningPorts(),
      Object.values(context.run.apps).map((app) => app.port),
      context.processPath
    )) {
      if (
        pidOwnedByWorktree(pid, context.processPath) &&
        // oxlint-disable-next-line no-await-in-loop -- Owned listener cleanup is serialized to preserve process shutdown ordering.
        (await this.processes.stopOwnedProcess(pid, context.processId))
      ) {
        killed.add(pid);
      }
    }
    if (killed.size > 0) {
      this.processes.appendManagedLog(
        context.processId,
        `[branchbase] Stopped ${killed.size} owned listener${killed.size === 1 ? "" : "s"}`
      );
    }
  }

  createInstance(target: AppGroupTarget, name: string): AppGroupInstance {
    if (
      this.connection(target) &&
      this.connection(target)?.policy !== "project"
    ) {
      throw new Error(
        "Change the worktree profile to select a resource connection."
      );
    }
    return this.state.createSelectableInstance(
      this.instanceRequest(target),
      name
    );
  }

  selectInstance(target: AppGroupTarget, instanceId: string): AppGroupInstance {
    if (
      this.connection(target) &&
      this.connection(target)?.policy !== "project"
    ) {
      throw new Error(
        "Change the worktree profile to select a resource connection."
      );
    }
    return this.state.selectInstance(this.instanceRequest(target), instanceId);
  }

  logId(target: AppGroupTarget): string {
    const instance = this.state.instanceLookup(this.instanceRequest(target));
    if (!instance) {
      throw new Error(`Unknown App group "${target.groupId}"`);
    }
    return appGroupInstanceProcessId(instance.id);
  }

  private async serializeLifecycle<T>(
    keys: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const projectKeys = keys.map(
      (key) => `${key.split("\0")[0]}\0profile-change`
    );
    const operationKeys = [
      ...new Set(["managed-resources", ...keys, ...projectKeys]),
    ].toSorted();
    const predecessor = (async () => {
      await Promise.all(
        operationKeys.map(async (key) => {
          try {
            await (this.lifecycleOperations.get(key) ?? Promise.resolve());
          } catch {
            // A failed predecessor must not prevent the next lifecycle operation.
          }
        })
      );
    })();

    const completion: PromiseWithResolvers<void> = Promise.withResolvers();
    const tail = (async () => {
      await predecessor;
      await completion.promise;
    })();
    for (const key of operationKeys) {
      this.lifecycleOperations.set(key, tail);
    }
    await predecessor;
    try {
      return await operation();
    } finally {
      completion.resolve();
      for (const key of operationKeys) {
        if (this.lifecycleOperations.get(key) === tail) {
          this.lifecycleOperations.delete(key);
        }
      }
    }
  }

  private trackWorktreeOperation<T>(
    worktreePath: string,
    operation: Promise<T>
  ): Promise<T> {
    this.pendingWorktreeOperations.set(
      worktreePath,
      (this.pendingWorktreeOperations.get(worktreePath) ?? 0) + 1
    );
    return operation.finally(() => {
      const remaining =
        (this.pendingWorktreeOperations.get(worktreePath) ?? 1) - 1;
      if (remaining === 0) {
        this.pendingWorktreeOperations.delete(worktreePath);
      } else {
        this.pendingWorktreeOperations.set(worktreePath, remaining);
      }
    });
  }

  private async prepareRouting(): Promise<void> {
    try {
      await this.routing.prepare?.();
    } catch (error) {
      throw new AppGroupLifecycleError(
        "routing-unavailable",
        errorMessage(error)
      );
    }
  }

  private async waitForAndPublishRun(context: RunContext): Promise<void> {
    if (Object.keys(context.group.apps).length === 0) {
      if (context.target.managed?.definition.status) {
        await this.waitForDetachedResource(context);
        return;
      }
      await pollUntil(
        () =>
          this.processes.managedPid(context.processId, context.processPath) !==
          null,
        {
          intervalMs: 50,
          message: "Worker did not stay running",
          timeoutMs: 2000,
        }
      );
      return;
    }
    const readyAppIds = await this.waitForRunReadiness(context);
    if (context.target.managed?.definition.status) {
      await this.waitForDetachedResource(context);
    }
    assertReadyEndpointsOwned(context.group, context.run, readyAppIds);
    await this.publishReadyRun(context, readyAppIds);
  }

  private waitForDetachedResource(context: RunContext) {
    return pollUntil(() => this.detachedRunning(context), {
      intervalMs: 500,
      message:
        "Detached resource did not become ready; no routes were published",
      timeoutMs: 60_000,
    });
  }

  private instanceIsRunning(
    instance: AppGroupInstance,
    stop: BranchBaseAppGroup["stop"],
    ports: ReturnType<typeof inspectListeningPorts>
  ): boolean {
    const { run } = instance;
    if (!run) {
      return false;
    }
    if (run.definition) {
      try {
        const owner = this.managedResources.target(
          run.definition.id,
          instance.name
        );
        if (owner.managed?.definition.status) {
          return this.inspectDetachedRunning(runContext(owner, instance, run));
        }
      } catch {
        return false;
      }
    }
    if (
      this.processes.managedPid(
        appGroupInstanceProcessId(instance.id),
        run.worktreePath
      ) !== null
    ) {
      return true;
    }
    return Object.values(run.apps).some((endpoint) => {
      const ownership = portOwnership(ports, endpoint.port, run.worktreePath);
      return stop === "process"
        ? ownership === "owned"
        : commandEndpointIsClaimed(endpoint, ports);
    });
  }

  private createRun(input: {
    config: BranchBaseConfig;
    effectiveInstances: Record<string, AppGroupInstance>;
    externalGroups?: ResolvedBranchBaseAppGroups;
    group: BranchBaseAppGroup;
    groupId: string;
    instance: AppGroupInstance;
    repoPath: string;
    worktreePath: string;
  }): AppGroupRun {
    const apps = Object.fromEntries(
      Object.entries(input.group.apps).map(([appId, app]) => {
        const assignment = this.endpointAssignment({
          app,
          appId,
          groupId: input.groupId,
          instance: input.instance,
          repoPath: input.repoPath,
        });
        return [appId, this.runEndpoint(app, assignment)];
      })
    );
    const instanceIdsByGroup = Object.fromEntries(
      Object.entries(input.effectiveInstances).map(([groupId, instance]) => [
        groupId,
        input.externalGroups?.[groupId]?.instanceId ?? instance.id,
      ])
    );
    const bindings = this.resolveTemplateAppGroups(
      input.config,
      input.repoPath,
      input.worktreePath,
      instanceIdsByGroup,
      input.externalGroups
    );
    const stop =
      input.group.stop === "process"
        ? "process"
        : resolveStopCommand(input.config, input.groupId, bindings);
    return {
      apps,
      bindings,
      createdAt: new Date().toISOString(),
      environmentTemplates: input.group.env,
      groupId: input.groupId,
      inputs: input.group.inputs,
      instanceId: input.instance.id,
      instanceIdsByGroup,
      stop: stop ?? "process",
      worktreePath: input.worktreePath,
    };
  }

  private assertRunPortsAvailable(
    context: RunContext,
    allocatedNow: boolean
  ): void {
    const ports = inspectListeningPorts();
    const occupied = Object.values(context.run.apps).find((endpoint) => {
      const pids = listeningPortPids(ports, endpoint.port);
      if (pids.length === 0) {
        return false;
      }
      if (allocatedNow) {
        return true;
      }
      if (context.group.stop === "process") {
        return (
          portOwnership(ports, endpoint.port, context.run.worktreePath) !==
          "owned"
        );
      }
      return endpoint.listenerClaimed !== true;
    });
    if (!occupied) {
      return;
    }
    if (allocatedNow) {
      this.state.removeRun(context.key);
    }
    throw new AppGroupLifecycleError(
      "port-occupied",
      `Backing endpoint ${occupied.port} is occupied by an unrelated process`
    );
  }

  private runIsReady(
    context: RunContext,
    readiness: readonly boolean[]
  ): boolean {
    return (
      readiness.every(Boolean) &&
      (!context.target.managed?.definition.status ||
        this.detachedRunning(context)) &&
      this.allRoutesAreActive(context.run) &&
      (readiness.length > 0 ||
        Boolean(context.target.managed?.definition.status) ||
        this.processes.managedPid(context.processId, context.processPath) !==
          null)
    );
  }

  private allRoutesAreActive(run: AppGroupRun): boolean {
    return Object.values(run.apps).every(
      (endpoint) =>
        endpoint.protocol !== "http" ||
        (endpoint.hostname &&
          this.routing.observe(endpointRoute(endpoint)) === "active")
    );
  }

  async buildManagedResource(id: string, name: string): Promise<void> {
    const target = this.managedResources.target(id, name);
    const { managed } = target;
    const build = managed?.definition.build;
    if (!managed || !build) {
      throw new Error("This resource has no Build command");
    }
    this.managedResources.assertApproved(managed);
    await this.serializeLifecycle([], async () => {
      this.managedResources.assertApproved(managed);
      const instances = this.reconcile(target);
      if (instances.resource.run) {
        throw new Error("Stop the resource before building a new revision");
      }
      await this.materializeEffectiveInstances(target, instances);
      const bindings = this.resolveTemplateAppGroups(
        target.config,
        target.repoPath,
        target.worktree.path,
        { resource: instances.resource.id }
      );
      const command = resolveStartCommand(target.config, "resource", bindings);
      const argv = build.argv.map((value) =>
        renderBranchBaseTemplate(value, {
          appGroups: bindings,
          currentGroup: "resource",
        })
      );
      assertManagedCommandSources(managed, argv, managed.directory);
      await this.processes.runFiniteCommand({
        argv,
        cwd: managed.directory,
        env: commandEnvironment(target.config.appGroups.resource, command.env),
        label: `Build ${id}/${name}`,
        logId: appGroupInstanceProcessId(instances.resource.id),
        sensitive:
          Object.keys(target.config.appGroups.resource.inputs ?? {}).length > 0,
      });
    });
  }

  releaseManualCommandContext(id: string) {
    return this.serializeLifecycle([], async () => {
      const instances = this.resourceStore.lease(id);
      this.resourceStore.release(id);
      for (const instanceId of instances) {
        const owned = this.state
          .allResourceInstances()
          .find((entry) => entry.instance.id === instanceId);
        if (
          !owned?.instance.run?.definition ||
          this.hasConsumers(owned.repoPath, instanceId)
        ) {
          continue;
        }
        const resource = this.managedResources.get(
          owned.instance.run.definition.id
        );
        if (resource.definition.idle !== "stop-when-unused") {
          continue;
        }
        const target = this.managedResources.target(
          resource.definition.id,
          owned.instance.name
        );
        // oxlint-disable-next-line no-await-in-loop -- Retire released resources in order after the manual consumer exits.
        await this.stopUnlocked(target, owned.instance);
      }
    });
  }

  manualCommandContext(target: AppGroupTarget) {
    return this.serializeLifecycle([], async () => {
      const instances = this.reconcile(target);
      const running = this.state.run(
        runKey(target.repoPath, instances[target.groupId].id)
      );
      if (!running) {
        for (const connection of Object.values(
          this.profile(target)?.connections ?? {}
        )) {
          if (connection.policy !== "managed") {
            continue;
          }
          const owner = this.managedResources.target(
            connection.resource,
            connection.instance
          );
          if (owner.managed) {
            this.managedResources.assertApproved(owner.managed);
            const selected = this.reconcile(owner).resource;
            if (selected.run?.definition) {
              this.managedResources.assertCaptured(selected.run.definition);
            }
          }
          // oxlint-disable-next-line no-await-in-loop -- Reserve explicit owner endpoints without starting commands.
          await this.materializeEffectiveInstances(
            owner,
            this.reconcile(owner)
          );
        }
        await this.materializeEffectiveInstances(target, instances);
      }
      const bindings =
        running?.bindings ??
        this.resolveTemplateAppGroups(
          target.config,
          target.repoPath,
          target.worktree.path,
          Object.fromEntries(
            Object.entries(instances).map(([id, instance]) => [id, instance.id])
          ),
          this.externalBindings(target)
        );
      const command = resolveStartCommand(
        target.config,
        target.groupId,
        bindings
      );
      const inputs = running?.inputs ?? groupForTarget(target).inputs ?? {};
      const dependencies = dependencyOrder(target.config, target.groupId)
        .filter((id) => id !== target.groupId)
        .map((id) => bindings[id]?.instanceId)
        .filter((id): id is string => Boolean(id));
      const leaseId = this.resourceStore.hold(dependencies);
      return {
        cwd: commandWorkingDirectory(target.worktree.path, command.cwd),
        env: Object.fromEntries(
          Object.entries(command.env).filter(
            ([key]) =>
              !inputs[key] || groupForTarget(target).env?.[key]?.includes("{")
          )
        ),
        inputs,
        leaseId,
      };
    });
  }

  private statusCommand(context: RunContext) {
    if (context.run.definition) {
      this.managedResources.assertCaptured(context.run.definition);
    }
    const { managed } = context.target;
    const status = managed?.definition.status;
    if (!managed || !status) {
      return null;
    }
    const bindings = context.run.bindings ?? {};
    const command = resolveStartCommand(
      context.target.config,
      context.target.groupId,
      bindings
    );
    const argv = status.argv.map((value) =>
      renderBranchBaseTemplate(value, {
        appGroups: bindings,
        currentGroup: context.target.groupId,
      })
    );
    assertManagedCommandSources(managed, argv, context.processPath);
    return {
      argv,
      cwd: context.processPath,
      env: commandEnvironment(context.group, command.env),
      stoppedExitCodes: status.stoppedExitCodes,
    };
  }

  private static observationKey(context: RunContext): string {
    return JSON.stringify([
      context.run.instanceId,
      context.run.createdAt,
      context.run.definition?.revision,
    ]);
  }

  private inspectDetachedRunning(context: RunContext): boolean {
    // Validate the captured recipe even when a previous observation is cached.
    if (context.run.definition) {
      this.managedResources.assertCaptured(context.run.definition);
    }
    return this.managedObservation.inspect(
      AppGroupRuntime.observationKey(context),
      async () => {
        const command = this.statusCommand(context);
        return command
          ? await observeManagedResourceRunning(
              command.argv,
              command.cwd,
              command.env,
              command.stoppedExitCodes
            )
          : true;
      }
    );
  }

  private detachedRunning(context: RunContext): boolean {
    const command = this.statusCommand(context);
    const running = command
      ? managedResourceRunning(
          command.argv,
          command.cwd,
          command.env,
          command.stoppedExitCodes
        )
      : true;
    this.managedObservation.record(
      AppGroupRuntime.observationKey(context),
      running
    );
    return running;
  }

  private launchRunProcess(
    context: RunContext,
    readiness: readonly boolean[]
  ): void {
    if (
      this.processes.managedPid(context.processId, context.processPath) !==
        null ||
      readiness.some(Boolean)
    ) {
      return;
    }
    try {
      const command = resolveStartCommand(
        context.target.config,
        context.target.groupId,
        context.run?.bindings ??
          this.resolveTemplateAppGroups(
            context.target.config,
            context.target.repoPath,
            context.processPath,
            context.run.instanceIdsByGroup
          )
      );
      if (context.target.managed) {
        assertManagedCommandSources(
          context.target.managed,
          command.argv,
          commandWorkingDirectory(context.processPath, command.cwd)
        );
      }
      this.processes.startManagedProcess({
        argv: command.argv,
        cwd: commandWorkingDirectory(context.processPath, command.cwd),
        env: commandEnvironment(
          {
            ...context.group,
            inputs: context.run?.inputs ?? context.group.inputs,
          },
          command.env
        ),
        label: displayName(context.target.groupId, context.group),
        logId: context.processId,
        ownerId: context.processId,
        ownerRoot: context.processPath,
        processId: context.processId,
        sensitive:
          Object.keys(context.run?.inputs ?? context.group.inputs ?? {})
            .length > 0,
        trackExitFailure: true,
      });
    } catch (error) {
      throw new AppGroupLifecycleError("start-failed", errorMessage(error));
    }
  }

  private async waitForRunReadiness(context: RunContext): Promise<Set<string>> {
    const settled = await Promise.allSettled(
      Object.entries(context.group.apps).map(async ([appId, app]) => {
        await waitForAppReadiness(app, runEndpointFor(context.run, appId));
        return appId;
      })
    );
    const readyAppIds = new Set(
      settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      )
    );
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [errorMessage(result.reason)] : []
    );
    if (readyAppIds.size === 0) {
      observeRunListeners(context.run);
      this.state.saveRun(context.key, context.run);
      throw new AppGroupLifecycleError("readiness-failed", failures.join("; "));
    }
    for (const failure of failures) {
      this.processes.appendManagedLog(
        context.processId,
        `[branchbase] ${failure}`
      );
    }
    return readyAppIds;
  }

  private async publishReadyRun(
    context: RunContext,
    readyAppIds: ReadonlySet<string>
  ): Promise<void> {
    observeRunListeners(context.run);
    try {
      await this.activateRoutes(context.run, readyAppIds);
    } catch (error) {
      this.state.saveRun(context.key, context.run);
      throw error;
    }
    this.state.saveRun(context.key, context.run);
  }

  private endpointAssignment(input: {
    app: BranchBaseApp;
    appId: string;
    groupId: string;
    instance: AppGroupInstance;
    repoPath: string;
  }): EndpointAssignment {
    return this.state.endpoint({
      appId: input.appId,
      appLabel: displayName(input.appId, input.app),
      groupId: input.groupId,
      instanceId: input.instance.id,
      repoPath: input.repoPath,
    });
  }

  private inspectEndpoint(input: {
    app: BranchBaseApp;
    appId: string;
    assignment: EndpointAssignment | null;
    ports: ReturnType<typeof inspectListeningPorts>;
    run: RunEndpoint | null;
    stop: BranchBaseAppGroup["stop"];
    worktreePath: string;
  }): AppEndpointSnapshot {
    if (!input.run) {
      return {
        directUrl: null,
        id: input.appId,
        label: displayName(input.appId, input.app),
        listening: false,
        open: false,
        ownership: "none",
        port: input.assignment?.port ?? null,
        protocol: input.app.protocol,
        readiness: "waiting",
        routeState: "inactive",
        url: null,
      };
    }
    const inspectedOwnership = portOwnership(
      input.ports,
      input.run.port,
      input.worktreePath
    );
    const commandEndpointVerified = commandEndpointIsClaimed(
      input.run,
      input.ports
    );
    const listening =
      input.stop === "process"
        ? inspectedOwnership === "owned"
        : commandEndpointVerified;
    let ownership = inspectedOwnership;
    if (input.stop !== "process") {
      if (commandEndpointVerified) {
        ownership = "owned";
      } else if (inspectedOwnership !== "none") {
        ownership = "foreign";
      }
    }
    const ready = appIsReadySync(input.app, input.run, listening);
    const observedRouteState =
      input.run.protocol === "http" && input.run.hostname
        ? this.routing.observe({
            hostname: input.run.hostname,
            port: input.run.port,
          })
        : "inactive";
    const routeState =
      observedRouteState === "inactive" &&
      ready &&
      input.run.protocol === "http"
        ? "unavailable"
        : observedRouteState;
    return {
      directUrl: input.run.directUrl ?? null,
      id: input.appId,
      label: displayName(input.appId, input.app),
      listening,
      open: ready && routeState === "active",
      ownership,
      port: input.run.port,
      protocol: input.app.protocol,
      readiness: ready ? "ready" : "unready",
      routeState,
      url: ready && routeState === "active" ? (input.run.url ?? null) : null,
    };
  }

  private resolveTemplateAppGroups(
    config: BranchBaseConfig,
    repoPath: string,
    worktreePath: string,
    instanceIdsByGroup?: Record<string, string>,
    externalGroups: ResolvedBranchBaseAppGroups = {}
  ): ResolvedBranchBaseAppGroups {
    const configFingerprint = repositoryCommandFingerprint(config);
    const resolved: ResolvedBranchBaseAppGroups = Object.fromEntries(
      Object.entries(config.appGroups).map(([groupId, group]) => [
        groupId,
        externalGroups[groupId] ?? {
          apps: Object.fromEntries(
            Object.entries(group.apps).map(([appId, app]) => {
              const selectedInstanceId = instanceIdsByGroup?.[groupId];
              const instance = selectedInstanceId
                ? this.state.instanceById(repoPath, selectedInstanceId)
                : this.state.instanceLookup({
                    configFingerprint,
                    groupId,
                    mode: group.instances.mode,
                    repoLabel: pathModule.basename(repoPath),
                    repoPath,
                    worktreeLabel: pathModule.basename(worktreePath),
                    worktreePath,
                  });
              if (!(instance && instance.groupId === groupId)) {
                throw new Error(`Unknown App-group instance for "${groupId}"`);
              }
              const assignment = this.endpointAssignment({
                app,
                appId,
                groupId,
                instance,
                repoPath,
              });
              if (assignment.port !== null) {
                return [appId, this.runEndpoint(app, assignment)];
              }
              return [
                appId,
                app.protocol === "http"
                  ? { url: this.routing.url(assignment.hostname) }
                  : {},
              ];
            })
          ),
          id: groupId,
          instanceId: instanceIdsByGroup?.[groupId],
          instanceName: instanceIdsByGroup?.[groupId]
            ? this.state.instanceById(repoPath, instanceIdsByGroup[groupId])
                ?.name
            : undefined,
          outputs: group.outputs,
          worktreeId: this.state.worktreeIdentity(repoPath, worktreePath),
        },
      ])
    );
    for (const [id, group] of Object.entries(resolved)) {
      group.outputs = Object.fromEntries(
        Object.entries(group.outputs ?? {}).map(([name, value]) => [
          name,
          renderBranchBaseTemplate(value, {
            appGroups: resolved,
            currentGroup: id,
          }),
        ])
      );
    }
    return resolved;
  }

  private async materializeEffectiveInstances(
    target: AppGroupTarget,
    instances: Readonly<Record<string, AppGroupInstance>>
  ): Promise<void> {
    const leased = this.state.leasedPorts();
    const reservations: BackingPortLease[] = [];
    try {
      for (const [groupId, group] of Object.entries(target.config.appGroups)) {
        if (
          ["existing", "managed"].includes(
            this.connection({ ...target, groupId })?.policy ?? ""
          )
        ) {
          continue;
        }
        const instance = instances[groupId];
        if (!instance) {
          throw new Error(`Unknown App group "${groupId}"`);
        }
        const key = runKey(target.repoPath, instance.id);
        for (const [appId, app] of Object.entries(group.apps)) {
          const assignment = this.endpointAssignment({
            app,
            appId,
            groupId,
            instance,
            repoPath: target.repoPath,
          });
          const requestedPort = configuredAppPort(app, target.worktree.path);
          if (assignment.port !== null) {
            if (!requestedPort || requestedPort === assignment.port) {
              continue;
            }
            if (!app.portFromEnv) {
              throw new Error(
                `Instance endpoint ${appId} retains port ${assignment.port}; explicit reconciliation is required before changing it to ${requestedPort}`
              );
            }
            if (this.state.run(key) !== null) {
              throw new Error(
                `Stop ${groupId} before changing the configured port for ${appId}`
              );
            }
          }
          // oxlint-disable-next-line no-await-in-loop -- Port reservations update shared leased state sequentially.
          const reservation = await reserveBackingPort(leased, requestedPort);
          reservations.push(reservation);
          leased.add(reservation.port);
          this.state.assignEndpointPort(
            key,
            appId,
            reservation.port,
            app.portFromEnv !== undefined
          );
        }
      }
    } finally {
      await Promise.all(
        reservations.map((reservation) => reservation.release())
      );
    }
  }

  private runEndpoint(
    app: BranchBaseApp,
    assignment: EndpointAssignment
  ): RunEndpoint {
    if (assignment.port === null) {
      throw new Error(`${assignment.appId} has no assigned port`);
    }
    return {
      appId: assignment.appId,
      ...(app.protocol === "http"
        ? {
            directUrl: `http://127.0.0.1:${assignment.port}`,
            hostname: assignment.hostname,
            url: this.routing.url(assignment.hostname),
          }
        : {}),
      host: "127.0.0.1",
      port: assignment.port,
      protocol: app.protocol,
    };
  }

  private async activateRoutes(
    run: AppGroupRun,
    readyAppIds: ReadonlySet<string>
  ): Promise<void> {
    const routes = Object.values(run.apps).flatMap((endpoint) =>
      readyAppIds.has(endpoint.appId) &&
      endpoint.protocol === "http" &&
      endpoint.hostname
        ? [endpointRoute(endpoint)]
        : []
    );
    const newlyActivated: LocalRoute[] = [];
    try {
      const initialStates = new Map<LocalRoute, LocalRouteState>();
      for (const route of routes) {
        const state = this.routing.observe(route);
        initialStates.set(route, state);
        if (state === "conflict") {
          throw new AppGroupLifecycleError(
            "route-conflict",
            `${route.hostname} is already routed elsewhere`
          );
        }
      }
      for (const route of routes) {
        if (initialStates.get(route) === "inactive") {
          newlyActivated.push(route);
        }
        // oxlint-disable-next-line no-await-in-loop -- Route activation is serialized to preserve publication ordering.
        await this.routing.activate(route);
      }
    } catch (error) {
      const failures = [
        errorMessage(error),
        ...(await this.rollbackRoutes(newlyActivated)),
      ];
      throw new AppGroupLifecycleError(
        error instanceof AppGroupLifecycleError
          ? error.code
          : "route-publication-failed",
        failures.join("; ")
      );
    }
  }

  private async rollbackRoutes(
    routes: readonly LocalRoute[]
  ): Promise<string[]> {
    const failures: string[] = [];
    for (const route of routes.toReversed()) {
      try {
        const routeState = this.routing.observe(route);
        if (routeState !== "active" && routeState !== "unavailable") {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- Route rollback runs in reverse order to preserve cleanup ordering.
        await this.routing.deactivate(route);
      } catch (error) {
        failures.push(`Route rollback failed: ${errorMessage(error)}`);
      }
    }
    return failures;
  }
}
