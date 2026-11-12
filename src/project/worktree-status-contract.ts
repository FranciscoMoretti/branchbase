import { z } from "zod";

import { BranchBaseConfigSchema } from "../configuration/branchbase-schema";
import { EndpointProfilePortsSchema } from "../configuration/endpoint-profiles";
import { WorktreeConfigSourceSchema } from "../configuration/worktree-config-source";
import {
  WorktreeProfileSchema,
  ExistingResourceSchema,
} from "../resources/resource-contract";
import { DiskUsageSchema } from "./disk-usage-contract";

export type { WorktreeConfigSource } from "../configuration/worktree-config-source";

export const ProcessUsageSchema = z.object({
  cpuPercent: z.number().nonnegative(),
  memoryBytes: z.number().nonnegative(),
  processCount: z.number().int().nonnegative(),
});

const AppHealthSchema = z.enum(["not-running", "partially-running", "running"]);

export const AppEndpointSnapshotSchema = z.strictObject({
  directUrl: z.string().nullable(),
  host: z.string().optional(),
  id: z.string(),
  label: z.string(),
  listening: z.boolean(),
  open: z.boolean(),
  ownership: z.enum(["owned", "foreign", "none"]),
  port: z.number().int().nullable(),
  protocol: z.enum(["http", "tcp"]),
  readiness: z.enum(["ready", "unready", "waiting"]),
  routeState: z.enum(["inactive", "active", "conflict", "unavailable"]),
  url: z.string().nullable(),
});

export const AppGroupSnapshotSchema = z.strictObject({
  apps: z.array(AppEndpointSnapshotSchema),
  category: z.enum(["application", "infrastructure"]).optional(),
  cleanupOnly: z.boolean().optional(),
  dependencies: z
    .array(
      z.strictObject({
        groupId: z.string(),
        instanceId: z.string(),
        name: z.string(),
      })
    )
    .optional(),
  external: z.boolean().optional(),
  health: AppHealthSchema,
  id: z.string().min(1),
  instance: z.strictObject({
    id: z.string().min(1),
    mode: z.enum(["per-worktree", "selectable"]),
    name: z.string().min(1),
  }),
  instances: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      running: z.boolean(),
    })
  ),
  name: z.string().min(1),
  pending: z.boolean().optional(),
  processRunning: z.boolean(),
  resources: ProcessUsageSchema.nullable().optional(),
  run: z
    .strictObject({ startedAt: z.string(), worktreePath: z.string() })
    .nullable()
    .optional(),
  stop: z.enum(["command", "process"]),
});

export const WorktreeSnapshotSchema = z.strictObject({
  appGroups: z.array(AppGroupSnapshotSchema),
  appLabel: z.string(),
  apps: z.array(AppEndpointSnapshotSchema),
  branch: z.string(),
  configuration: z.strictObject({
    changeBlocked: z.boolean(),
    error: z.string().nullable(),
    path: z.string(),
    preference: WorktreeConfigSourceSchema,
    revision: z.string().min(1),
    source: WorktreeConfigSourceSchema,
    trustCommands: z.array(z.string()),
    trustFingerprint: z.string().min(1),
    trusted: z.boolean(),
  }),
  disk: DiskUsageSchema.optional(),
  endpointProfile: z
    .strictObject({
      changeBlocked: z.boolean(),
      choices: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          ports: EndpointProfilePortsSchema,
        })
      ),
      error: z.string().nullable(),
      id: z.string().nullable(),
    })
    .optional(),
  health: AppHealthSchema,
  id: z.string(),
  isMain: z.boolean(),
  name: z.string(),
  path: z.string(),
  primaryAppGroup: z.string().min(1),
  processRunning: z.boolean(),
  profile: WorktreeProfileSchema.optional(),
  setupState: z.enum(["failed", "idle", "running"]),
});

export const WorkspaceSnapshotSchema = z.strictObject({
  disk: DiskUsageSchema.optional(),
  existingResources: z.array(ExistingResourceSchema).optional(),
  globalProcesses: z.array(
    z.strictObject({
      argv: z.array(z.string()),
      cwd: z.string(),
      label: z.string(),
      ownerId: z.string(),
      pid: z.number().int().positive(),
      startedAt: z.string(),
    })
  ),
  globalRunningCount: z.number().int().nonnegative(),
  mainWorktreePath: z.string(),
  managedResources: z
    .array(
      z.object({
        approved: z.boolean(),
        canBuild: z.boolean(),
        error: z.string().optional(),
        id: z.string(),
        instances: z.array(z.string()),
        name: z.string(),
        observations: z.record(
          z.string(),
          z.object({
            consumers: z.number(),
            health: z.enum(["running", "partially-running", "not-running"]),
            manual: z.boolean(),
          })
        ),
        path: z.string(),
        revision: z.string(),
      })
    )
    .optional(),
  projectDefaultConfig: BranchBaseConfigSchema,
  projectDefaultConfigPath: z.string(),
  projectDefaultConfigRevision: z.string().min(1),
  projectDefaultPrimaryAppGroup: z.string().min(1),
  repoName: z.string(),
  repoPath: z.string(),
  resourceIssues: z.array(z.string()).optional(),
  resources: ProcessUsageSchema.nullable().optional(),
  trustCommands: z.array(z.string()),
  trustFingerprint: z.string().min(1),
  trustRequired: z.boolean(),
  trusted: z.boolean(),
  updatedAt: z.string(),
  worktrees: z.array(WorktreeSnapshotSchema),
});

export type AppHealth = z.infer<typeof AppHealthSchema>;
export type AppEndpointSnapshot = z.infer<typeof AppEndpointSnapshotSchema>;
export type AppGroupSnapshot = z.infer<typeof AppGroupSnapshotSchema>;
export type GlobalProcessSnapshot = z.infer<
  typeof WorkspaceSnapshotSchema.shape.globalProcesses.element
>;
export type WorktreeSnapshot = z.infer<typeof WorktreeSnapshotSchema>;
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export const appGroupIsRunning = (
  group: Pick<AppGroupSnapshot, "cleanupOnly" | "health" | "processRunning">
): boolean =>
  group.cleanupOnly === true ||
  group.health !== "not-running" ||
  group.processRunning;

export const appGroupIsStopped = (
  group: Pick<AppGroupSnapshot, "cleanupOnly" | "health" | "processRunning">
): boolean => !appGroupIsRunning(group);

export const appGroupCanRestart = (
  group: Pick<AppGroupSnapshot, "cleanupOnly" | "health" | "processRunning">
): boolean => group.cleanupOnly !== true && appGroupIsRunning(group);

export const worktreeHasRunningAppGroups = (
  worktree: Pick<WorktreeSnapshot, "appGroups">
): boolean =>
  worktree.appGroups.some(
    (group) =>
      !group.external &&
      (appGroupIsRunning(group) ||
        group.instances.some((instance) => instance.running))
  );

export const appsAreRunning = (
  worktree: Pick<WorktreeSnapshot, "health" | "processRunning"> &
    Partial<Pick<WorktreeSnapshot, "appGroups">>
): boolean => {
  if (worktree.appGroups) {
    return worktree.appGroups.some(appGroupIsRunning);
  }
  return worktree.health !== "not-running" || worktree.processRunning;
};

export const appsAreStopped = (
  worktree: Pick<WorktreeSnapshot, "health" | "processRunning"> &
    Partial<Pick<WorktreeSnapshot, "appGroups">>
): boolean => !appsAreRunning(worktree);

export const appsCanRestart = (
  worktree: Pick<WorktreeSnapshot, "health" | "processRunning"> &
    Partial<Pick<WorktreeSnapshot, "appGroups">>
): boolean =>
  worktree.appGroups
    ? worktree.appGroups.some(appGroupCanRestart)
    : appsAreRunning(worktree);
