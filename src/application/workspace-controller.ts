import { realpathSync } from "node:fs";
import pathModule from "node:path";

import {
  git,
  resolveWorktrees,
  readOnlyWorktreePath,
  projectAliasPaths,
} from "../adapters/git/project-worktrees";
import { measureDirectoryDiskUsage } from "../adapters/host/disk-usage";
import { pathInside } from "../adapters/host/ports";
import {
  ProcessSupervisor,
  setupProcessId,
} from "../adapters/host/process-supervisor";
import { PortlessRoutingEngine } from "../adapters/routing/portless";
import type { LocalRoutingEngine } from "../adapters/routing/portless";
import { FileBranchBaseStateStore } from "../app-group/assignments";
import { AppGroupRuntime, isDetachedGroupId } from "../app-group/lifecycle";
import type { AppGroupTarget } from "../app-group/lifecycle";
import { CodexContextStore } from "../codex/branchbase-context";
import { CodexHookActivityStore } from "../codex/codex-hook-activity";
import type { CodexHookObservation } from "../codex/codex-hook-activity";
import { projectCodexIntegration } from "../codex/codex-integration";
import type {
  CodexIntegrationAdapter,
  CodexIntegrationLoadOptions,
  CodexIntegrationSnapshot,
} from "../codex/codex-integration";
import { CodexTaskDiscoveryAdapter } from "../codex/codex-task-discovery";
import {
  findBranchBaseConfig,
  loadBranchBaseConfig,
  loadBranchBaseConfigDocument,
  resolveSetupCommand,
  updateBranchBaseConfig,
} from "../configuration/branchbase-config";
import type { WorktreeEnvConfig } from "../configuration/branchbase-config";
import type { BranchBaseConfig } from "../configuration/branchbase-schema";
import { commandWorkingDirectory } from "../configuration/command-directory";
import { initializeRepository as initializeRepositoryConfig } from "../configuration/initializer";
import { MissingWorktreeConfigError } from "../configuration/missing-config-error";
import {
  repositoryCommandFingerprint,
  repositoryIsTrusted,
  revokeRepositoryTrust,
  trustRepository as saveRepositoryTrust,
} from "../configuration/repository-trust";
import type { RepositoryTrustApproval } from "../configuration/repository-trust-approval";
import { defaultResourceProfiles } from "../configuration/resource-profiles";
import type { WorktreeConfigSource } from "../configuration/worktree-config-source";
import { ProductStore } from "../project/catalog";
import type { AppPin, ProjectOverview } from "../project/catalog-contract";
import { readConfiguredStatus } from "../project/configured-status";
import { ProjectDiscovery } from "../project/discovery";
import type { Observation } from "../project/discovery-contract";
import { aggregateDiskUsage } from "../project/disk-usage";
import { readProjectStatus } from "../project/status";
import type { ProjectStatus } from "../project/status-contract";
import { WorktreeDiskUsageCache } from "../project/worktree-disk-usage";
import { worktreeHasRunningAppGroups } from "../project/worktree-status-contract";
import type { WorkspaceSnapshot } from "../project/worktree-status-contract";
import { ExistingResourceSchema } from "../resources/resource-contract";
import { parseCommandInput, parseCommandResult } from "./command-contract";
import type {
  BranchBaseCommandInput,
  BranchBaseCommandName,
  BranchBaseCommandResult,
} from "./command-contract";
import { clearLogs } from "./commands/clear-logs";
import { createAppGroupInstance } from "./commands/create-app-group-instance";
import { createWorktree } from "./commands/create-worktree";
import { deleteWorktree } from "./commands/delete-worktree";
import { initializeRepository as initializeRepositoryCommand } from "./commands/initialize-repository";
import { pickRepository } from "./commands/pick-repository";
import { previewRepositoryConfig } from "./commands/preview-repository-config";
import { restartApps } from "./commands/restart-apps";
import { restartRunningApps } from "./commands/restart-running-apps";
import { retryApps } from "./commands/retry-apps";
import { selectAppGroupInstance } from "./commands/select-app-group-instance";
import { selectWorktreeConfigSource } from "./commands/select-worktree-config-source";
import { setupAllApps } from "./commands/setup-all-apps";
import { startAllApps } from "./commands/start-all-apps";
import { startApps } from "./commands/start-apps";
import { stopAllApps } from "./commands/stop-all-apps";
import { stopApps } from "./commands/stop-apps";
import { trustRepository } from "./commands/trust-repository";
import { updateRepositoryConfig } from "./commands/update-repository-config";
import { reconcileProject } from "./reconciliation";

export { MissingWorktreeConfigError } from "../configuration/missing-config-error";

type CommandHandler = (
  controller: WorkspaceController,
  input: Record<string, unknown>
) => unknown;

const COMMAND_HANDLERS: Record<BranchBaseCommandName, CommandHandler> = {
  "add-development-folder": (controller, input) => {
    controller.addDevelopmentFolder(String(input.repoPath));
    return {
      command: "add-development-folder",
      message: "Development folder added",
      ok: true,
    };
  },
  "approve-managed-resource": (controller, input) => {
    controller.approveManagedResource(
      String(input.resource),
      String(input.revision)
    );
    return {
      command: "approve-managed-resource",
      message: "Resource revision approved",
      ok: true,
    };
  },
  "build-managed-resource": async (controller, input) => {
    await controller.buildManagedResource(
      String(input.resource),
      String(input.instance)
    );
    return {
      command: "build-managed-resource",
      message: "Resource build completed",
      ok: true,
    };
  },
  "clear-logs": clearLogs,
  "create-app-group-instance": createAppGroupInstance,
  "create-worktree": createWorktree,
  "delete-worktree": deleteWorktree,
  "enable-resource-profiles": (controller, input) => {
    controller.enableResourceProfiles(
      String(input.repoPath),
      String(input.revision)
    );
    return {
      command: "enable-resource-profiles",
      message:
        "Shared and isolated profiles added. Review and approve the updated configuration before starting.",
      ok: true,
    };
  },
  "initialize-repository": initializeRepositoryCommand,
  "operate-managed-resource": async (controller, input) => {
    await controller.operateManagedResource(
      String(input.resource),
      String(input.instance),
      String(input.action)
    );
    return {
      command: "operate-managed-resource",
      message: "Resource operation completed",
      ok: true,
    };
  },
  "pick-repository": pickRepository,
  "preview-repository-config": previewRepositoryConfig,
  "preview-resource-profile": (controller, input) =>
    controller.previewResourceProfile(
      String(input.repoPath),
      String(input.worktreeId),
      input.profileId === null ? null : String(input.profileId)
    ),
  "register-managed-resource": (controller, input) =>
    controller.registerManagedResource(String(input.definitionPath)),
  "register-resource": (controller, input) => {
    controller.registerResource(input.resource);
    return {
      command: "register-resource",
      message:
        "Existing resource connected. Its lifecycle remains externally managed.",
      ok: true,
    };
  },
  "release-command-context": async (controller, input) => {
    await controller.releaseCommandContext(String(input.leaseId));
    return {
      command: "release-command-context",
      message: "Manual command context released",
      ok: true,
    };
  },
  "remove-development-folder": (controller, input) => {
    controller.removeDevelopmentFolder(String(input.repoPath));
    return {
      command: "remove-development-folder",
      message: "Folder removed; projects kept",
      ok: true,
    };
  },
  "remove-project": (controller, input) => {
    controller.removeProject(String(input.repoPath));
    return {
      command: "remove-project",
      message: "Project removed; files kept on disk",
      ok: true,
    };
  },
  "resource-command-context": (controller, input) =>
    controller.resourceCommandContext(
      String(input.repoPath),
      String(input.worktreeId),
      String(input.appGroupName)
    ),
  "restart-apps": restartApps,
  "restart-running-apps": restartRunningApps,
  "retry-apps": retryApps,
  "revoke-trust": (controller, input) => {
    controller.revokeTrust(String(input.repoPath));
    return {
      command: "revoke-trust",
      message: "Command approvals revoked",
      ok: true,
    };
  },
  "save-project": (controller, input) => {
    controller.saveProject(
      String(input.repoPath),
      input.name as string | undefined,
      input.pins as AppPin[] | undefined
    );
    return { command: "save-project", message: "Project saved", ok: true };
  },
  "scan-development-folders": (controller) => {
    controller.scanDevelopmentFolders();
    return {
      command: "scan-development-folders",
      message: "Folder scan complete",
      ok: true,
    };
  },
  "select-app-group-instance": selectAppGroupInstance,
  "select-endpoint-profile": async (controller, input) => {
    await controller.selectEndpointProfile(
      String(input.repoPath),
      String(input.worktreeId),
      input.profileId === null ? null : String(input.profileId)
    );
    return {
      command: "select-endpoint-profile",
      message: "Endpoint profile applied",
      ok: true as const,
    };
  },
  "select-resource-profile": async (controller, input) => {
    await controller.selectResourceProfile(
      String(input.repoPath),
      String(input.worktreeId),
      input.profileId === null ? null : String(input.profileId),
      input.restart === true
    );
    return {
      command: "select-resource-profile",
      message: "Resource profile applied",
      ok: true,
    };
  },
  "select-worktree-config-source": selectWorktreeConfigSource,
  "setup-all-apps": setupAllApps,
  "start-all-apps": startAllApps,
  "start-apps": startApps,
  "stop-all-apps": stopAllApps,
  "stop-apps": stopApps,
  "trust-repository": trustRepository,
  "update-repository-config": updateRepositoryConfig,
};

const codexEnabledWorktree = (path: string): boolean => {
  try {
    const root = realpathSync(path);
    const configPath = findBranchBaseConfig(root);
    if (!configPath) {
      return false;
    }
    loadBranchBaseConfigDocument(configPath);
    return true;
  } catch {
    return false;
  }
};

export interface WorkspaceControllerRuntimeOptions {
  codexContext?: CodexContextStore;
  codexHooks?: CodexHookActivityStore;
  developmentStartPreflight?: DevelopmentStartPreflight;
  processes?: ProcessSupervisor;
  routing?: LocalRoutingEngine;
  state?: FileBranchBaseStateStore;
}

export type DevelopmentStartPreflight = (
  worktreePath: string
) => Promise<void> | void;

export interface CodexHookResult {
  accepted: boolean;
  additionalContext?: string;
}

export class WorkspaceController {
  private readonly diskUsage = new WorktreeDiskUsageCache(
    measureDirectoryDiskUsage
  );
  private readonly product: ProductStore;
  private readonly appGroups: AppGroupRuntime;
  private readonly codexAdapter: CodexIntegrationAdapter;
  private readonly codexActivity: CodexHookActivityStore;
  private readonly codexContext: CodexContextStore;
  private readonly developmentStartPreflight:
    | DevelopmentStartPreflight
    | undefined;
  private readonly codexRefreshes = new Map<string, Promise<void>>();
  private readonly knownCodexTasksByPath = new Map<string, Set<string>>();
  private readonly pendingCodexObservations = new Map<
    string,
    Map<string, { cwd: string; sessionId: string }>
  >();
  private readonly discovery: ProjectDiscovery;
  private readonly processes: ProcessSupervisor;
  private readonly routing: LocalRoutingEngine;
  private readonly state: FileBranchBaseStateStore;

  constructor(
    codexAdapter: CodexIntegrationAdapter = new CodexTaskDiscoveryAdapter(),
    runtime: WorkspaceControllerRuntimeOptions = {}
  ) {
    this.codexAdapter = codexAdapter;
    this.codexActivity = runtime.codexHooks ?? new CodexHookActivityStore();
    this.codexContext = runtime.codexContext ?? new CodexContextStore();
    this.developmentStartPreflight = runtime.developmentStartPreflight;
    this.processes = runtime.processes ?? new ProcessSupervisor();
    this.routing = runtime.routing ?? new PortlessRoutingEngine();
    this.state = runtime.state ?? new FileBranchBaseStateStore();
    this.product = new ProductStore(pathModule.dirname(this.state.path));
    this.discovery = new ProjectDiscovery(
      this.product,
      (path) => resolveWorktrees(git(path, ["rev-parse", "--show-toplevel"])),
      (path) => git(path, ["rev-parse", "--show-toplevel"]),
      () => this.processes.listManagedProcesses().map((process) => process.pid)
    );
    this.appGroups = new AppGroupRuntime(
      this.processes,
      this.routing,
      this.state
    );
  }

  close(): Promise<void> {
    this.diskUsage.close();
    return this.codexAdapter.close();
  }

  forgetWorktreeDiskUsage(path: string): void {
    this.diskUsage.forget(path);
  }

  worktreeRemovalTarget(repoPath: string, id: string) {
    const status = this.projectStatus(repoPath, { freshObservation: true });
    const worktree = status.worktrees.find((item) => item.id === id);
    if (!worktree) {
      throw new Error("Unknown worktree");
    }
    if (worktree.isMain) {
      throw new Error("The main worktree cannot be deleted");
    }
    if (status.issues.some((issue) => issue.area !== "configuration")) {
      throw new Error(
        "Could not verify running resources. Refresh the repository before deleting this worktree."
      );
    }
    const configured = status.workspace?.worktrees.find(
      (item) => item.id === id
    );
    const observed = status.observation?.worktrees.find(
      (item) => item.id === id
    );
    const recorded = this.state.runningInstancesForWorktree(
      status.repoPath,
      worktree.path
    );
    const managed = this.processes
      .listManagedProcesses()
      .some((item) => pathInside(item.cwd, worktree.path));
    if (
      this.appGroups.hasPendingLifecycle(worktree.path) ||
      managed ||
      recorded.length ||
      observed?.services.length ||
      configured?.setupState === "running" ||
      configured?.appGroups.some(
        (group) =>
          !group.external &&
          (!group.run || group.run.worktreePath === worktree.path) &&
          (group.pending ||
            group.processRunning ||
            group.health !== "not-running")
      )
    ) {
      throw new Error(
        "Stop this worktree's app groups and detected services before deleting it."
      );
    }
    return { mainWorktreePath: status.repoPath, worktree };
  }

  async inspectCodex(
    repoPath: string,
    options?: CodexIntegrationLoadOptions
  ): Promise<CodexIntegrationSnapshot> {
    const worktrees = resolveWorktrees(
      git(repoPath, ["rev-parse", "--show-toplevel"])
    ).map(({ id, path }) => ({ id, path }));
    const discovered = await this.codexAdapter.loadAssociatedTasks(
      worktrees,
      options
    );
    for (const { path } of worktrees) {
      this.knownCodexTasksByPath.set(path, new Set());
    }
    for (const { task, worktreePath } of discovered.tasks) {
      this.knownCodexTasksByPath.get(worktreePath)?.add(task.id);
    }
    const activitySnapshot = this.codexActivity.applyToSnapshot(
      discovered,
      new Date(),
      (worktreePath) => codexEnabledWorktree(worktreePath)
    );
    const adapterSnapshot = this.codexContext.applyToSnapshot(activitySnapshot);
    return projectCodexIntegration(worktrees, adapterSnapshot);
  }

  observeCodexHook(observation: CodexHookObservation): boolean {
    return this.acceptCodexHook(observation, new Date()) !== null;
  }

  handleCodexHook(
    observation: CodexHookObservation,
    observedAt = new Date()
  ): CodexHookResult {
    const accepted = this.acceptCodexHook(observation, observedAt);
    if (!accepted) {
      return { accepted: false };
    }
    if (accepted.cwd !== accepted.root) {
      return { accepted: true };
    }
    try {
      const worktree = this.inspect(accepted.root).worktrees.find(
        ({ path }) => path === accepted.cwd
      );
      const additionalContext = worktree
        ? this.codexContext.share(observation, worktree, observedAt)
        : undefined;
      return additionalContext
        ? { accepted: true, additionalContext }
        : { accepted: true };
    } catch {
      return { accepted: true };
    }
  }

  private acceptCodexHook(
    observation: CodexHookObservation,
    observedAt: Date
  ): { cwd: string; root: string } | null {
    try {
      const cwd = realpathSync(observation.cwd);
      const root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
      if (!codexEnabledWorktree(root)) {
        return null;
      }
      this.codexActivity.observe({ ...observation, cwd }, observedAt);
      if (!this.knownCodexTasksByPath.get(cwd)?.has(observation.sessionId)) {
        const pending = this.pendingCodexObservations.get(root) ?? new Map();
        pending.set(`${cwd}\0${observation.sessionId}`, {
          cwd,
          sessionId: observation.sessionId,
        });
        this.pendingCodexObservations.set(root, pending);
        this.requestCodexRefresh(root);
      }
      return { cwd, root };
    } catch {
      return null;
    }
  }

  async execute<Name extends BranchBaseCommandName>(
    command: Name,
    input: unknown
  ): Promise<BranchBaseCommandResult<Name>> {
    const handler = COMMAND_HANDLERS[command];
    const parsed = parseCommandInput(command, input);
    const values = parsed as BranchBaseCommandInput<Name> &
      Record<string, unknown>;
    const repoPath =
      typeof values.repoPath === "string" ? values.repoPath : null;
    const record = (
      severity: "info" | "success" | "warning",
      message: string
    ) => {
      if (!repoPath || command === "preview-repository-config") {
        return;
      }
      let canonicalPath = repoPath;
      let worktreeName: string | undefined;
      try {
        const worktrees = resolveWorktrees(
          git(repoPath, ["rev-parse", "--show-toplevel"])
        );
        canonicalPath = worktrees[0]?.path ?? repoPath;
        worktreeName =
          worktrees.find((worktree) => worktree.id === values.worktreeId)
            ?.branch ?? undefined;
      } catch {
        // Failed discovery commands retain the supplied path as their context.
      }
      try {
        this.product.append({
          kind:
            command.includes("config") || command.includes("trust")
              ? "configuration"
              : "command",
          message,
          repoPath: canonicalPath,
          severity,
          ...(worktreeName ? { worktreeName } : {}),
          ...(typeof values.worktreeId === "string"
            ? { worktreeId: values.worktreeId }
            : {}),
          ...(typeof values.appGroupName === "string"
            ? { groupId: values.appGroupName }
            : {}),
        });
      } catch {
        process.stderr.write(
          "BranchBase could not persist an activity event.\n"
        );
      }
    };
    try {
      const result = await handler(this, values);
      const parsedResult = parseCommandResult(command, result);
      const message =
        typeof parsedResult === "object" &&
        parsedResult !== null &&
        "message" in parsedResult &&
        typeof parsedResult.message === "string"
          ? parsedResult.message
          : `${command.replaceAll("-", " ")}: completed`;
      record("success", message);
      return parsedResult;
    } catch (error) {
      record("warning", `${command.replaceAll("-", " ")}: failed`);
      throw error;
    }
  }

  inspect(repoPath: string): WorkspaceSnapshot {
    reconcileProject(repoPath, this.state, this.appGroups);
    const snapshot = readConfiguredStatus(repoPath, {
      appGroups: this.appGroups,
      processes: this.processes,
      state: this.state,
    });
    this.product.observe(snapshot);
    snapshot.disk = this.populateWorktreeDiskUsage(snapshot.worktrees);
    this.populateResourceProfiles(snapshot);
    return snapshot;
  }
  previewResourceProfile(
    repoPath: string,
    worktreeId: string,
    profileId: string | null
  ) {
    const { worktree } = this.worktree(repoPath, worktreeId);
    const profile = this.appGroups.profileStatus(
      this.appGroupTarget(repoPath, worktreeId, worktree.primaryAppGroup),
      profileId
    );
    if (!profile) {
      throw new Error("Configure resource profiles first.");
    }
    return profile;
  }

  operateManagedResource(id: string, name: string, action: string) {
    const target = this.appGroups.managedResources.target(id, name);
    if (action === "start") {
      return this.appGroups.start(target);
    }
    if (action === "stop") {
      return this.appGroups.stop(target);
    }
    if (action === "restart") {
      return this.appGroups.restart(target);
    }
    throw new Error("Unknown resource operation");
  }

  registerManagedResource(file: string) {
    const resource = this.appGroups.managedResources.register(file);
    return {
      definition: resource.definition,
      directory: resource.directory,
      id: resource.definition.id,
      revision: resource.revision,
    };
  }
  approveManagedResource(id: string, revision: string) {
    this.appGroups.managedResources.approve(id, revision);
  }
  buildManagedResource(id: string, instance: string) {
    return this.appGroups.buildManagedResource(id, instance);
  }
  resourceCommandContext(
    repoPath: string,
    worktreeId: string,
    groupId: string
  ) {
    const target = this.appGroupTarget(repoPath, worktreeId, groupId);
    this.assertConfigTrusted(target.repoPath, target.config);
    return this.appGroups.manualCommandContext(target);
  }

  releaseCommandContext(id: string) {
    return this.appGroups.releaseManualCommandContext(id);
  }

  registerResource(input: unknown): void {
    this.appGroups.resourceStore.register(ExistingResourceSchema.parse(input));
  }

  enableResourceProfiles(repoPath: string, revision: string): void {
    const workspace = this.inspect(repoPath);
    if (workspace.projectDefaultConfig.profiles) {
      throw new Error("Resource profiles are already configured.");
    }
    if (
      workspace.worktrees.some(
        (worktree) =>
          this.state.hasRunForWorktree(workspace.repoPath, worktree.path) ||
          this.appGroups.hasPendingLifecycle(worktree.path)
      )
    ) {
      throw new Error(
        "Stop this project's App groups before enabling resource profiles."
      );
    }
    const config = workspace.projectDefaultConfig;
    config.profiles = defaultResourceProfiles(config);
    updateBranchBaseConfig(
      workspace.projectDefaultConfigPath,
      config,
      revision
    );
  }

  async selectEndpointProfile(
    repoPath: string,
    worktreeId: string,
    profileId: string | null
  ): Promise<void> {
    const { workspace, worktree } = this.worktree(repoPath, worktreeId);
    if (
      worktree.setupState === "running" ||
      this.appGroups.hasPendingLifecycle(worktree.path)
    ) {
      throw new Error(
        "Wait for setup and lifecycle operations before changing endpoint profiles."
      );
    }
    await this.appGroups.selectEndpointProfile(
      this.appGroupTarget(
        workspace.repoPath,
        worktree.id,
        worktree.primaryAppGroup
      ),
      profileId
    );
  }

  async selectResourceProfile(
    repoPath: string,
    worktreeId: string,
    profileId: string | null,
    restart: boolean
  ): Promise<void> {
    const { workspace, worktree } = this.worktree(repoPath, worktreeId);
    if (
      worktree.setupState === "running" ||
      this.appGroups.hasPendingLifecycle(worktree.path)
    ) {
      throw new Error(
        "Wait for the current lifecycle operation before changing profile."
      );
    }
    const target = this.appGroupTarget(
      workspace.repoPath,
      worktree.id,
      worktree.primaryAppGroup
    );
    // Applying connections to a stopped worktree executes no commands. Restart does.
    if (restart) {
      this.assertConfigTrusted(target.repoPath, target.config);
    }
    await this.appGroups.selectProfile(target, profileId, restart);
  }

  private populateResourceProfiles(workspace: WorkspaceSnapshot): void {
    workspace.resourceIssues = this.appGroups.managedResources.discover(
      workspace.mainWorktreePath,
      workspace.projectDefaultConfig
    );
    workspace.existingResources = this.appGroups.resourceStore.resources();
    workspace.managedResources = this.appGroups.managedCatalog();
    for (const worktree of workspace.worktrees) {
      const config = loadBranchBaseConfig(worktree.configuration.path);
      const selected = this.state.worktreeEndpointProfile(
        workspace.repoPath,
        worktree.path
      );
      const target = {
        config,
        groupId: worktree.primaryAppGroup,
        repoPath: workspace.repoPath,
        worktree: {
          id: worktree.id,
          path: worktree.path,
          routeLabel: worktree.branch,
        },
      };
      const choices = Object.entries(config.endpointProfiles ?? {}).map(
        ([id, profile]) => ({ id, ...profile })
      );
      worktree.endpointProfile = {
        changeBlocked:
          worktree.setupState === "running" ||
          ((choices.length > 0 || selected !== null) &&
            this.appGroups.endpointProfileChangeBlocked(target)),
        choices,
        error:
          selected !== null && !config.endpointProfiles?.[selected]
            ? `Endpoint profile "${selected}" is unavailable. Select another profile or the Project default.`
            : null,
        id: selected,
      };
      worktree.profile = this.appGroups.profileStatus(target);
    }
  }

  private populateWorktreeDiskUsage(worktrees: ProjectStatus["worktrees"]) {
    for (const worktree of worktrees) {
      worktree.disk = this.diskUsage.read(worktree.path);
    }
    return aggregateDiskUsage(
      worktrees.flatMap((worktree) => (worktree.disk ? [worktree.disk] : []))
    );
  }

  projectStatus(
    repoPath: string,
    options: { freshObservation?: boolean } = {}
  ): ProjectStatus {
    const status = readProjectStatus(repoPath, {
      appGroups: this.appGroups,
      observe: (path) =>
        this.discovery.observe(path, { fresh: options.freshObservation }),
      processes: this.processes,
      state: this.state,
    });
    status.disk = this.populateWorktreeDiskUsage(status.worktrees);
    const disks = new Map(
      status.worktrees.map((worktree) => [worktree.id, worktree.disk])
    );
    for (const worktrees of [
      status.worktrees,
      status.workspace?.worktrees ?? [],
      status.observation?.worktrees ?? [],
    ]) {
      for (const worktree of worktrees) {
        worktree.disk = disks.get(worktree.id);
      }
    }
    if (status.workspace) {
      status.workspace.disk = status.disk;
      this.populateResourceProfiles(status.workspace);
      status.issues.push(
        ...(status.workspace.resourceIssues ?? []).map((message) => ({
          area: "configuration" as const,
          code: "managed-resource-unavailable",
          message,
        }))
      );
    }
    if (status.observation) {
      status.observation.disk = status.disk;
    }
    return status;
  }

  refreshProjectStatus(repoPath: string): ProjectStatus {
    let reconciliationError: unknown;
    try {
      reconcileProject(repoPath, this.state, this.appGroups);
    } catch (error) {
      reconciliationError = error;
    }
    const status = this.projectStatus(repoPath);
    if (reconciliationError && status.configuration.state === "ready") {
      status.issues.push({
        area: "runtime",
        code: "reconciliation-failed",
        message:
          reconciliationError instanceof Error
            ? reconciliationError.message
            : String(reconciliationError),
      });
    }
    if (status.workspace) {
      this.product.observe(status.workspace);
    }
    if (status.observation && !status.observation.warning) {
      this.product.observeDetected(status.observation);
    }
    return status;
  }

  saveProject(repoPath: string, name?: string, pins?: AppPin[]): void {
    const root = resolveWorktrees(
      git(repoPath, ["rev-parse", "--show-toplevel"])
    )[0]?.path;
    if (!root) {
      throw new Error("No Git worktrees found");
    }
    const existing = this.product
      .projects()
      .find((project) => project.path === root);
    this.product.saveProject(
      root,
      name ?? existing?.name ?? pathModule.basename(root),
      pins
    );
  }

  addDevelopmentFolder(path: string) {
    this.discovery.addFolder(path);
  }
  removeDevelopmentFolder(path: string) {
    this.discovery.removeFolder(path);
  }
  scanDevelopmentFolders() {
    this.discovery.scan(true);
  }
  developmentFolders() {
    return this.discovery.folders();
  }
  observeRepository(path: string) {
    const observation = this.discovery.observe(path);
    if (!observation.warning) {
      this.product.observeDetected(observation);
    }
    return observation;
  }
  projects(): ProjectOverview[] {
    this.discovery.scan();
    return this.product.projects().map((project) => {
      let observation: Observation | null = null;
      try {
        const status = this.refreshProjectStatus(project.path);
        ({ observation } = status);
        return {
          ...project,
          disk: status.disk,
          error: status.issues.map((issue) => issue.message).join("; ") || null,
          observation,
          workspace: status.workspace,
        };
      } catch (error) {
        return {
          ...project,
          error: error instanceof Error ? error.message : String(error),
          observation,
          workspace: null,
        };
      }
    });
  }

  activity(repoPath?: string) {
    return this.product.events(repoPath);
  }

  removeProject(repoPath: string): void {
    const projects = this.product.projects();
    const exact = projects.find((project) => project.path === repoPath);
    const aliases = exact ? null : projectAliasPaths(repoPath);
    const saved =
      exact ?? projects.find((project) => aliases?.has(project.path));
    if (!saved) {
      throw new Error("This project is not saved in BranchBase.");
    }
    const resources = this.state.repositoryResources(saved.path);
    const paths = new Set([saved.path, ...resources.worktreePaths]);
    if (
      resources.hasRetainedRuns ||
      [...paths].some((path) => this.appGroups.hasPendingLifecycle(path)) ||
      this.processes
        .listManagedProcesses()
        .some((process) =>
          [...paths].some((path) => pathInside(process.cwd, path))
        )
    ) {
      throw new Error(
        "Stop this project's App groups and setup processes before removing it. Retained runs must be cleaned up first."
      );
    }
    this.product.removeProject(saved.path);
  }

  revokeTrust(repoPath: string): void {
    const workspace = this.inspect(repoPath);
    const resources = this.state.repositoryResources(workspace.repoPath);
    const worktreePaths = [
      ...new Set([
        ...resources.worktreePaths,
        ...workspace.worktrees.map((worktree) => worktree.path),
      ]),
    ];
    const hasPendingLifecycle = resources.worktreePaths.some((worktreePath) =>
      this.appGroups.hasPendingLifecycle(worktreePath)
    );
    const hasRunningSetup = worktreePaths.some((path) => {
      const ownerId = Buffer.from(path).toString("base64url");
      return (
        this.processes.managedPidByIdentity(
          setupProcessId(ownerId),
          ownerId
        ) !== null
      );
    });
    if (
      resources.hasRetainedRuns ||
      hasRunningSetup ||
      hasPendingLifecycle ||
      workspace.worktrees.some(
        (worktree) =>
          worktreeHasRunningAppGroups(worktree) ||
          worktree.setupState === "running" ||
          this.appGroups.hasPendingLifecycle(worktree.path)
      )
    ) {
      throw new Error(
        "Stop App groups, finish setup processes, and clear retained runs before revoking approval."
      );
    }
    revokeRepositoryTrust(workspace.repoPath, this.processes.controlDirectory);
  }

  startAppGroup(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string
  ): Promise<"already-running" | "started"> {
    if (!this.developmentStartPreflight) {
      return this.startTrustedAppGroup(repoPath, worktreeIdValue, groupId);
    }
    return this.startAppGroupAfterDevelopmentPreflight(
      repoPath,
      worktreeIdValue,
      groupId,
      this.developmentStartPreflight
    );
  }

  retryAppGroup(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string
  ): Promise<"already-running" | "retried"> {
    this.assertTrusted(repoPath, worktreeIdValue);
    const target = this.appGroupTarget(repoPath, worktreeIdValue, groupId);
    this.assertConfigTrusted(target.repoPath, target.config);
    return this.appGroups.retry(target);
  }

  restartAppGroup(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string
  ): Promise<"restarted"> {
    if (!this.developmentStartPreflight) {
      return this.restartTrustedAppGroup(repoPath, worktreeIdValue, groupId);
    }
    return this.restartAppGroupAfterDevelopmentPreflight(
      repoPath,
      worktreeIdValue,
      groupId,
      this.developmentStartPreflight
    );
  }

  stopAppGroup(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string
  ): Promise<"already-stopped" | "stopped"> {
    if (isDetachedGroupId(groupId)) {
      const worktrees = resolveWorktrees(
        git(repoPath, ["rev-parse", "--show-toplevel"])
      );
      const worktree = worktrees.find((item) => item.id === worktreeIdValue);
      const root = worktrees[0]?.path;
      if (!worktree || !root) {
        throw new Error("Unknown worktree");
      }
      return this.appGroups.stopConfiguredOrDetached(
        root,
        worktree.path,
        groupId
      );
    }
    const target = this.appGroupTarget(repoPath, worktreeIdValue, groupId);
    if (target.config.appGroups[groupId]?.stop !== "process") {
      this.assertConfigTrusted(target.repoPath, target.config);
    }
    return this.appGroups.stopConfiguredOrDetached(
      target.repoPath,
      target.worktree.path,
      groupId,
      target
    );
  }

  config(repoPath: string): WorktreeEnvConfig {
    return this.inspect(repoPath).projectDefaultConfig;
  }

  updateConfiguration(
    repoPath: string,
    config: BranchBaseConfig,
    revision: string
  ): void {
    const workspace = this.inspect(repoPath);
    const topologyChanged =
      JSON.stringify(workspace.projectDefaultConfig.appGroups) !==
      JSON.stringify(config.appGroups);
    const hasRunningProcesses = workspace.worktrees.some(
      (worktree) =>
        worktree.setupState === "running" ||
        worktreeHasRunningAppGroups(worktree)
    );
    if (topologyChanged && hasRunningProcesses) {
      throw new Error(
        "Stop repository App groups and setup processes before changing their configuration."
      );
    }
    updateBranchBaseConfig(
      workspace.projectDefaultConfigPath,
      config,
      revision
    );
  }

  assertTrusted(repoPath: string, worktreeIdValue?: string): void {
    const workspace = this.inspect(repoPath);
    const trusted = worktreeIdValue
      ? workspace.worktrees.find(({ id }) => id === worktreeIdValue)
          ?.configuration.trusted
      : workspace.trusted;
    if (!trusted) {
      throw new Error("Review and trust this repository's commands first");
    }
  }

  trustRepository(
    repoPath: string,
    approvals?: readonly RepositoryTrustApproval[]
  ): void {
    const workspace = this.inspect(repoPath);
    const reviewed = approvals ?? [
      {
        fingerprint: workspace.trustFingerprint,
      },
    ];
    const configurations = reviewed.map((approval) => {
      const path = approval.worktreeId
        ? (() => {
            const worktree = workspace.worktrees.find(
              (item) => item.id === approval.worktreeId
            );
            if (!worktree) {
              throw new Error("Unknown worktree");
            }
            return worktree.configuration.path;
          })()
        : workspace.projectDefaultConfigPath;
      const config = loadBranchBaseConfig(path);
      if (repositoryCommandFingerprint(config) !== approval.fingerprint) {
        throw new Error(
          "Repository commands changed after they were reviewed; review them again."
        );
      }
      return { config, path };
    });
    for (const { config } of new Map(
      configurations.map((configuration) => [configuration.path, configuration])
    ).values()) {
      saveRepositoryTrust(
        workspace.repoPath,
        config,
        this.processes.controlDirectory
      );
    }
  }

  readonly initializeRepository = initializeRepositoryConfig;

  worktree(repoPath: string, id: string) {
    const workspace = this.inspect(repoPath);
    const worktree = workspace.worktrees.find((item) => item.id === id);
    if (!worktree) {
      throw new Error("Unknown worktree");
    }
    return { workspace, worktree };
  }

  logs(repoPath: string, id: string, appGroupId?: string): string[] {
    const target = appGroupId
      ? this.appGroupTarget(repoPath, id, appGroupId)
      : null;
    this.worktree(repoPath, id);
    return this.processes.readManagedLog(
      target ? this.appGroups.logId(target) : id
    );
  }

  createAppGroupInstance(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string,
    name: string
  ) {
    return this.appGroups.createInstance(
      this.appGroupTarget(repoPath, worktreeIdValue, groupId),
      name
    );
  }

  selectAppGroupInstance(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string,
    instanceId: string
  ) {
    return this.appGroups.selectInstance(
      this.appGroupTarget(repoPath, worktreeIdValue, groupId),
      instanceId
    );
  }

  selectWorktreeConfigSource(
    repoPath: string,
    worktreeIdValue: string,
    source: WorktreeConfigSource
  ): void {
    const { workspace, worktree } = this.worktree(repoPath, worktreeIdValue);
    if (
      worktree.configuration.changeBlocked ||
      this.appGroups.hasPendingLifecycle(worktree.path)
    ) {
      throw new Error(
        "Stop this worktree's App groups and setup process before changing its configuration source."
      );
    }
    if (source === "checkout") {
      const path = findBranchBaseConfig(worktree.path);
      if (!path) {
        throw new MissingWorktreeConfigError(
          pathModule.join(worktree.path, ".branchbase.json")
        );
      }
      loadBranchBaseConfigDocument(path);
    }
    this.state.setWorktreeConfigSource(
      {
        repoLabel: workspace.repoName,
        repoPath: workspace.repoPath,
        worktreeLabel: worktree.branch,
        worktreePath: worktree.path,
      },
      source
    );
  }

  startSetup(repoPath: string, worktreeIdValue: string): void {
    const { workspace, worktree } = this.worktree(repoPath, worktreeIdValue);
    if (this.appGroups.hasPendingLifecycle(worktree.path)) {
      throw new Error(
        "Wait for the current lifecycle operation before starting setup."
      );
    }
    const config = loadBranchBaseConfig(worktree.configuration.path);
    this.assertConfigTrusted(workspace.repoPath, config);
    const setup = resolveSetupCommand(config);
    this.processes.appendManagedLog(
      worktree.id,
      `[branchbase] Running setup: ${setup.argv.join(" ")}`
    );
    this.processes.startManagedProcess({
      argv: setup.argv,
      cwd: commandWorkingDirectory(worktree.path, setup.cwd),
      env: setup.env,
      label: "Setup",
      logId: worktree.id,
      ownerId: worktree.id,
      ownerRoot: worktree.path,
      processId: setupProcessId(worktree.id),
      trackExitFailure: true,
    });
  }

  clearLogs(repoPath: string, worktreeIdValue: string, groupId: string): void {
    const target = this.appGroupTarget(repoPath, worktreeIdValue, groupId);
    this.processes.clearManagedLog(this.appGroups.logId(target));
  }

  private appGroupTarget(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string
  ): AppGroupTarget {
    const { workspace, worktree } = this.worktree(repoPath, worktreeIdValue);
    const config = loadBranchBaseConfig(worktree.configuration.path);
    if (!config.appGroups[groupId]) {
      throw new Error(`Unknown App group "${groupId}"`);
    }
    return {
      config,
      groupId,
      repoPath: workspace.repoPath,
      worktree: {
        id: worktree.id,
        path: worktree.path,
        routeLabel: worktree.branch,
      },
    };
  }

  private async startAppGroupAfterDevelopmentPreflight(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string,
    preflight: DevelopmentStartPreflight
  ): Promise<"already-running" | "started"> {
    await preflight(readOnlyWorktreePath(repoPath, worktreeIdValue));
    return this.startTrustedAppGroup(repoPath, worktreeIdValue, groupId);
  }

  private async restartAppGroupAfterDevelopmentPreflight(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string,
    preflight: DevelopmentStartPreflight
  ): Promise<"restarted"> {
    await preflight(readOnlyWorktreePath(repoPath, worktreeIdValue));
    return this.restartTrustedAppGroup(repoPath, worktreeIdValue, groupId);
  }

  private startTrustedAppGroup(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string
  ): Promise<"already-running" | "started"> {
    this.assertTrusted(repoPath, worktreeIdValue);
    const target = this.appGroupTarget(repoPath, worktreeIdValue, groupId);
    this.assertConfigTrusted(target.repoPath, target.config);
    return this.appGroups.start(target);
  }

  private restartTrustedAppGroup(
    repoPath: string,
    worktreeIdValue: string,
    groupId: string
  ): Promise<"restarted"> {
    this.assertTrusted(repoPath, worktreeIdValue);
    const target = this.appGroupTarget(repoPath, worktreeIdValue, groupId);
    this.assertConfigTrusted(target.repoPath, target.config);
    return this.appGroups.restart(target);
  }

  protected assertConfigTrusted(
    repoPath: string,
    config: BranchBaseConfig
  ): void {
    if (
      !repositoryIsTrusted(repoPath, config, this.processes.controlDirectory)
    ) {
      throw new Error("Review and trust this repository's commands first");
    }
  }

  private requestCodexRefresh(root: string): void {
    if (this.codexRefreshes.has(root)) {
      return;
    }
    // The refresh promise compares itself in its finally block for identity-safe cleanup.
    const refreshHolder: { promise?: Promise<void> } = {};
    const refresh = (async () => {
      try {
        await this.inspectCodex(root, { force: true });
      } catch {
        // Codex refreshes are best-effort and retried by the next hook event.
      } finally {
        this.discardUnmatchedCodexObservations(root);
        if (this.codexRefreshes.get(root) === refreshHolder.promise) {
          this.codexRefreshes.delete(root);
        }
      }
    })();
    refreshHolder.promise = refresh;
    this.codexRefreshes.set(root, refresh);
  }

  private discardUnmatchedCodexObservations(root: string): void {
    const pending = this.pendingCodexObservations.get(root);
    this.pendingCodexObservations.delete(root);
    for (const observation of pending?.values() ?? []) {
      if (
        !this.knownCodexTasksByPath
          .get(observation.cwd)
          ?.has(observation.sessionId)
      ) {
        this.codexActivity.discard(observation.cwd, observation.sessionId);
        this.codexContext.discard(observation.cwd, observation.sessionId);
      }
    }
  }
}
