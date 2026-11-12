import { z } from "zod";

import { BranchBaseConfigSchema } from "../configuration/branchbase-schema";
import { RepositoryTrustApprovalSchema } from "../configuration/repository-trust-approval";
import { WorktreeConfigSourceSchema } from "../configuration/worktree-config-source";
import { AppPinSchema } from "../project/catalog-contract";
import {
  ExistingResourceSchema,
  WorktreeProfileSchema,
} from "../resources/resource-contract";

const RepositoryPathSchema = z.object({
  repoPath: z.string().min(1),
});
const StartStopSchema = RepositoryPathSchema.extend({
  appGroupName: z.string().min(1),
  worktreeId: z.string().min(1),
});
const VisibleBulkSchema = RepositoryPathSchema.extend({
  appGroupName: z.string().min(1).optional(),
  worktreeIds: z.array(z.string().min(1)),
});

export const CommandReceiptSchema = z.object({
  appGroupName: z.string().optional(),
  command: z.string(),
  completion: z.enum(["accepted", "completed"]).default("completed"),
  message: z.string(),
  ok: z.literal(true),
  worktreeId: z.string().optional(),
});
export type CommandReceipt = z.input<typeof CommandReceiptSchema>;
export const PickRepositoryResultSchema = z.object({
  path: z.string().min(1).nullable(),
});
export const RepositoryInitializationPlanSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  configPath: z.string(),
  detectedRuntime: z.string(),
  detectedSetupCommand: z.string().nullable(),
  detectedStartCommand: z.string().nullable(),
  repoPath: z.string(),
});

const INPUT_SCHEMAS = {
  "add-development-folder": RepositoryPathSchema,
  "approve-managed-resource": RepositoryPathSchema.extend({
    resource: z.string().min(1),
    revision: z.string().min(1),
  }),
  "build-managed-resource": RepositoryPathSchema.extend({
    instance: z.string().min(1),
    resource: z.string().min(1),
  }),
  "clear-logs": StartStopSchema,
  "create-app-group-instance": StartStopSchema.extend({
    name: z.string().trim().min(1),
  }),
  "create-worktree": RepositoryPathSchema.extend({
    branch: z.string().min(1),
    createBranch: z.boolean(),
    folderName: z.string().min(1),
  }),
  "delete-worktree": RepositoryPathSchema.extend({
    appGroupName: z.string().min(1).optional(),
    worktreeId: z.string().min(1),
  }),
  "enable-resource-profiles": RepositoryPathSchema.extend({
    revision: z.string().min(1),
  }),
  "initialize-repository": RepositoryPathSchema,
  "operate-managed-resource": RepositoryPathSchema.extend({
    action: z.enum(["start", "stop", "restart"]),
    instance: z.string().min(1),
    resource: z.string().min(1),
  }),
  "pick-repository": z.object({}),
  "preview-repository-config": RepositoryPathSchema,
  "preview-resource-profile": RepositoryPathSchema.extend({
    profileId: z.string().min(1).nullable(),
    worktreeId: z.string().min(1),
  }),
  "register-managed-resource": RepositoryPathSchema.extend({
    definitionPath: z.string().min(1),
  }),
  "register-resource": RepositoryPathSchema.extend({
    resource: ExistingResourceSchema,
  }),
  "release-command-context": z.object({ leaseId: z.string().min(1) }),
  "remove-development-folder": RepositoryPathSchema,
  "remove-project": RepositoryPathSchema,
  "resource-command-context": StartStopSchema,
  "restart-apps": StartStopSchema,
  "restart-running-apps": VisibleBulkSchema,
  "retry-apps": StartStopSchema,
  "revoke-trust": RepositoryPathSchema,
  "save-project": RepositoryPathSchema.extend({
    name: z.string().trim().min(1).max(100).optional(),
    pins: z.array(AppPinSchema).max(24).optional(),
  }),
  "scan-development-folders": z.object({}),
  "select-app-group-instance": StartStopSchema.extend({
    instanceId: z.string().min(1),
  }),
  "select-endpoint-profile": RepositoryPathSchema.extend({
    profileId: z.string().min(1).nullable(),
    worktreeId: z.string().min(1),
  }),
  "select-resource-profile": RepositoryPathSchema.extend({
    profileId: z.string().min(1).nullable(),
    restart: z.boolean(),
    worktreeId: z.string().min(1),
  }),
  "select-worktree-config-source": RepositoryPathSchema.extend({
    source: WorktreeConfigSourceSchema,
    worktreeId: z.string().min(1),
  }),
  "setup-all-apps": VisibleBulkSchema,
  "start-all-apps": VisibleBulkSchema,
  "start-apps": StartStopSchema,
  "stop-all-apps": VisibleBulkSchema,
  "stop-apps": StartStopSchema,
  "trust-repository": RepositoryPathSchema.extend({
    approvals: z.array(RepositoryTrustApprovalSchema).min(1),
  }),
  "update-repository-config": RepositoryPathSchema.extend({
    config: BranchBaseConfigSchema,
    revision: z.string().min(1),
  }),
} as const;

const RESULT_SCHEMAS = {
  "add-development-folder": CommandReceiptSchema,
  "approve-managed-resource": CommandReceiptSchema,
  "build-managed-resource": CommandReceiptSchema,
  "clear-logs": CommandReceiptSchema,
  "create-app-group-instance": CommandReceiptSchema,
  "create-worktree": CommandReceiptSchema,
  "delete-worktree": CommandReceiptSchema,
  "enable-resource-profiles": CommandReceiptSchema,
  "initialize-repository": RepositoryInitializationPlanSchema,
  "operate-managed-resource": CommandReceiptSchema,
  "pick-repository": PickRepositoryResultSchema,
  "preview-repository-config": RepositoryInitializationPlanSchema,
  "preview-resource-profile": WorktreeProfileSchema,
  "register-managed-resource": z.object({
    definition: z.unknown(),
    directory: z.string(),
    id: z.string(),
    revision: z.string(),
  }),
  "register-resource": CommandReceiptSchema,
  "release-command-context": CommandReceiptSchema,
  "remove-development-folder": CommandReceiptSchema,
  "remove-project": CommandReceiptSchema,
  "resource-command-context": z.object({
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    inputs: z.record(z.string(), z.object({ file: z.string() })),
    leaseId: z.string(),
  }),
  "restart-apps": CommandReceiptSchema,
  "restart-running-apps": CommandReceiptSchema,
  "retry-apps": CommandReceiptSchema,
  "revoke-trust": CommandReceiptSchema,
  "save-project": CommandReceiptSchema,
  "scan-development-folders": CommandReceiptSchema,
  "select-app-group-instance": CommandReceiptSchema,
  "select-endpoint-profile": CommandReceiptSchema,
  "select-resource-profile": CommandReceiptSchema,
  "select-worktree-config-source": CommandReceiptSchema,
  "setup-all-apps": CommandReceiptSchema,
  "start-all-apps": CommandReceiptSchema,
  "start-apps": CommandReceiptSchema,
  "stop-all-apps": CommandReceiptSchema,
  "stop-apps": CommandReceiptSchema,
  "trust-repository": CommandReceiptSchema,
  "update-repository-config": CommandReceiptSchema,
} as const;

export type BranchBaseCommandName = keyof typeof INPUT_SCHEMAS;
export type BranchBaseCommandInput<Name extends BranchBaseCommandName> =
  z.infer<(typeof INPUT_SCHEMAS)[Name]>;
export type BranchBaseCommandResult<Name extends BranchBaseCommandName> =
  z.infer<(typeof RESULT_SCHEMAS)[Name]>;

export const isBranchBaseCommandName = (
  value: string
): value is BranchBaseCommandName => value in INPUT_SCHEMAS;

export const parseCommandInput = <Name extends BranchBaseCommandName>(
  name: Name,
  input: unknown
): BranchBaseCommandInput<Name> =>
  INPUT_SCHEMAS[name].parse(input) as BranchBaseCommandInput<Name>;

export const parseCommandResult = <Name extends BranchBaseCommandName>(
  name: Name,
  result: unknown
): BranchBaseCommandResult<Name> =>
  RESULT_SCHEMAS[name].parse(result) as BranchBaseCommandResult<Name>;
