import { inspectListeningPorts } from "../adapters/host/ports";
import { appGroupInstanceProcessId } from "../adapters/host/process-supervisor";
import type { ProcessSupervisor } from "../adapters/host/process-supervisor";
import type { LocalRoutingEngine } from "../adapters/routing/portless";
import {
  endpointProfilePort,
  endpointProfilePorts,
  supportsEndpointProfile,
} from "../configuration/endpoint-profiles";
import type { ResourceStore } from "../resources/resource-store";
import type { AppGroupInstance, FileBranchBaseStateStore } from "./assignments";
import type { AppGroupTarget } from "./lifecycle";
import { reserveBackingPort } from "./readiness";
import type { BackingPortLease } from "./readiness";

interface EndpointProfileContext {
  target: AppGroupTarget;
  state: FileBranchBaseStateStore;
  processes: ProcessSupervisor;
  resources: ResourceStore;
}

const eligibleGroups = (target: AppGroupTarget) =>
  Object.entries(target.config.appGroups).filter(([, group]) =>
    supportsEndpointProfile(group)
  );

const inspectProfileAssignments = ({
  target,
  state,
  processes,
  resources,
}: EndpointProfileContext) => {
  const groupIds = new Set(eligibleGroups(target).map(([id]) => id));
  const all = state.allResourceInstances();
  const affected = all.flatMap(({ repoPath, instance }) =>
    repoPath === target.repoPath &&
    instance.mode === "per-worktree" &&
    instance.worktreePath === target.worktree.path &&
    (groupIds.has(instance.groupId) ||
      Object.values(instance.endpoints).some(
        (endpoint) => endpoint.requestedPort !== undefined
      ))
      ? [instance]
      : []
  );
  const ids = new Set(affected.map((instance) => instance.id));
  const blocked =
    all.some(
      ({ instance }) =>
        instance.run &&
        (ids.has(instance.id) ||
          Object.values(instance.run.instanceIdsByGroup).some((id) =>
            ids.has(id)
          ))
    ) ||
    affected.some(
      (instance) =>
        resources.hasLease(instance.id) ||
        processes.managedPid(
          appGroupInstanceProcessId(instance.id),
          target.worktree.path
        ) !== null
    );
  return { affected, all, blocked, ids };
};

export const endpointProfileChangeBlocked = (input: EndpointProfileContext) =>
  inspectProfileAssignments(input).blocked;

/** Called under the runtime's lifecycle lock. Commit preferences and assignments together. */
export const applyEndpointProfile = async (
  input: EndpointProfileContext & {
    profileId: string | null;
    instances: Record<string, AppGroupInstance>;
    routing: LocalRoutingEngine;
  }
): Promise<void> => {
  const { target, profileId, state, routing, instances } = input;
  const pins = endpointProfilePorts(target.config, profileId);
  const { affected, all, blocked, ids } = inspectProfileAssignments(input);
  if (blocked) {
    throw new Error(
      "Stop the affected apps and release their command contexts before changing endpoint profiles."
    );
  }
  const listeners = inspectListeningPorts();
  for (const instance of affected) {
    for (const endpoint of Object.values(instance.endpoints)) {
      if (
        endpoint.port !== null &&
        (listeners.pidsByPort.has(endpoint.port) ||
          routing.observe({
            hostname: endpoint.hostname,
            port: endpoint.port,
          }) !== "inactive")
      ) {
        throw new Error(
          `Endpoint ${endpoint.appId} on port ${endpoint.port} still has a listener or route. Finish cleanup before changing profiles.`
        );
      }
    }
  }
  const excluded = new Set(
    all.flatMap(({ instance }) =>
      ids.has(instance.id)
        ? []
        : Object.values(instance.endpoints).flatMap((endpoint) =>
            endpoint.port === null ? [] : [endpoint.port]
          )
    )
  );
  const updates: Parameters<
    FileBranchBaseStateStore["applyEndpointProfile"]
  >[3] = affected.flatMap((instance) =>
    Object.values(instance.endpoints).map((endpoint) => ({
      appId: endpoint.appId,
      instanceId: instance.id,
      port: null,
      requestedPort: undefined,
    }))
  );
  const plans: ((typeof updates)[number] & { fixedPort?: number })[] =
    eligibleGroups(target).flatMap(([groupId, group]) =>
      Object.entries(group.apps).map(([appId, app]) => {
        const instance = state.instanceById(
          target.repoPath,
          instances[groupId].id
        );
        if (!instance) {
          throw new Error(`Missing instance ${groupId}`);
        }
        const endpoint = Object.values(instance.endpoints).find(
          (item) => item.appId === appId
        );
        if (!endpoint) {
          throw new Error(`Missing endpoint ${groupId}.${appId}`);
        }
        const requestedPort = endpointProfilePort(pins, groupId, appId);
        const fixedPort = requestedPort ?? app.port;
        return {
          appId,
          fixedPort,
          instanceId: instance.id,
          port:
            fixedPort ??
            (endpoint.requestedPort === undefined ? endpoint.port : null),
          requestedPort,
        };
      })
    );
  const exactPorts = new Set(
    plans.flatMap((plan) =>
      plan.fixedPort === undefined ? [] : [plan.fixedPort]
    )
  );
  for (const plan of plans) {
    // An explicit profile change can move this worktree's automatic assignment
    // when another of its apps needs that port. Other worktrees remain excluded.
    if (
      plan.fixedPort === undefined &&
      plan.port !== null &&
      exactPorts.has(plan.port)
    ) {
      plan.port = null;
    }
  }
  // Reserve exact and retained assignments first, so automatic allocation cannot consume them.
  plans.sort(
    (left, right) => Number(right.port !== null) - Number(left.port !== null)
  );
  const leases: BackingPortLease[] = [];
  try {
    for (const plan of plans) {
      let lease: BackingPortLease;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Each reservation excludes ports acquired earlier in the transaction.
        lease = await reserveBackingPort(excluded, plan.port ?? undefined);
      } catch (error) {
        throw new Error(
          `Cannot assign ${plan.appId}${plan.port === null ? "" : ` to port ${plan.port}`}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      leases.push(lease);
      excluded.add(lease.port);
      updates.push({ ...plan, port: lease.port });
    }
    state.applyEndpointProfile(
      target.repoPath,
      target.worktree.path,
      profileId,
      updates
    );
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
  }
};
