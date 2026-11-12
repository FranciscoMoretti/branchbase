import { z } from "zod";

import { BranchBaseCommandSchema } from "./branchbase-command";
import { branchbaseTemplateError } from "./branchbase-template";
import {
  EndpointProfilesSchema,
  supportsEndpointProfile,
} from "./endpoint-profiles";
import {
  ResourceProfilesSchema,
  dependencyOrder,
  resolveResourceProfile,
} from "./resource-profiles";

export const MIN_BRANCHBASE_PORT = 1024;
export const MAX_BRANCHBASE_PORT = 65_535;

export const BranchBaseAppGroupNameSchema = z.string().min(1);
export const BranchBaseAppIdSchema = z.string().min(1);
export const BranchBaseEnvironmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

const HttpReadinessSchema = z.strictObject({
  path: z.string().startsWith("/").default("/"),
  statuses: z
    .string()
    .regex(/^\d{3}-\d{3}$/u)
    .refine((range) => {
      const [minimum, maximum] = range.split("-").map(Number);
      return (
        minimum !== undefined &&
        maximum !== undefined &&
        minimum >= 100 &&
        maximum <= 599 &&
        minimum <= maximum
      );
    }, "HTTP status range must be ordered between 100 and 599")
    .default("200-399"),
  timeoutSeconds: z.number().int().min(1).max(300).default(60),
  type: z.literal("http"),
});

export const BranchBaseReadinessSchema = z.union([
  z.literal("tcp"),
  HttpReadinessSchema,
]);

export const BranchBaseAppSchema = z.strictObject({
  name: z.string().min(1).optional(),
  port: z.number().int().min(1024).max(65_535).optional(),
  protocol: z.enum(["http", "tcp"]),
  readiness: BranchBaseReadinessSchema.default("tcp"),
});

export type BranchBaseApp = z.infer<typeof BranchBaseAppSchema>;

export const BranchBaseAppGroupStopSchema = z.union([
  z.literal("process"),
  BranchBaseCommandSchema,
]);

export const BranchBaseAppGroupInstancesSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("per-worktree") }),
  z.strictObject({ mode: z.literal("selectable") }),
]);

export const BranchBaseAppGroupSchema = z.strictObject({
  apps: z.record(BranchBaseAppIdSchema, BranchBaseAppSchema),
  category: z.enum(["application", "infrastructure"]).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  env: z.record(BranchBaseEnvironmentNameSchema, z.string()).optional(),
  inputs: z
    .record(
      BranchBaseEnvironmentNameSchema,
      z.strictObject({ file: z.string().startsWith("/") })
    )
    .optional(),
  instances: BranchBaseAppGroupInstancesSchema.default({
    mode: "per-worktree",
  }),
  name: z.string().min(1).optional(),
  outputs: z
    .record(z.string().regex(/^[a-zA-Z0-9_.-]+$/u), z.string())
    .optional(),
  start: BranchBaseCommandSchema,
  stop: BranchBaseAppGroupStopSchema,
});

export type BranchBaseAppGroup = z.infer<typeof BranchBaseAppGroupSchema>;

const BranchBaseConfigObjectSchema = z.strictObject({
  $schema: z.string().optional(),
  appGroups: z.record(BranchBaseAppGroupNameSchema, BranchBaseAppGroupSchema),
  endpointProfiles: EndpointProfilesSchema.optional(),
  managedResources: z
    .record(
      z.string().regex(/^[a-zA-Z0-9_-]+$/u),
      z.strictObject({ file: z.string().min(1) })
    )
    .optional(),
  profiles: ResourceProfilesSchema.optional(),
  setup: BranchBaseCommandSchema,
  version: z.literal(1),
});

type BranchBaseConfigShape = z.infer<typeof BranchBaseConfigObjectSchema>;

const validateResourceScopes = (
  config: BranchBaseConfigShape,
  profileId: string,
  context: z.RefinementCtx
): void => {
  const profile = resolveResourceProfile(config, "", profileId);
  for (const [groupId, connection] of Object.entries(
    profile?.connections ?? {}
  )) {
    if (connection.policy !== "project") {
      continue;
    }
    let dependencies: string[];
    try {
      dependencies = dependencyOrder(config, groupId).filter(
        (id) => id !== groupId
      );
    } catch {
      continue;
    }
    for (const id of dependencies) {
      const dependency = profile?.connections[id];
      if (!dependency || dependency.policy === "worktree") {
        context.addIssue({
          code: "custom",
          message: `Project resource "${groupId}" cannot depend on worktree-specific group "${id}"`,
          path: ["profiles", "definitions", profileId, "connections", groupId],
        });
      }
    }
  }
};

const validateProfiles = (
  config: BranchBaseConfigShape,
  context: z.RefinementCtx
): void => {
  if (config.profiles) {
    const { profiles } = config;
    for (const id of [
      profiles.default,
      ...(profiles.rules ?? []).map((rule) => rule.profile),
    ]) {
      if (!profiles.definitions[id]) {
        context.addIssue({
          code: "custom",
          message: `Unknown profile "${id}"`,
          path: ["profiles"],
        });
      }
    }
    for (const [id, profile] of Object.entries(profiles.definitions)) {
      validateResourceScopes(config, id, context);
      for (const groupId of Object.keys(profile.connections)) {
        if (config.appGroups[groupId]?.category !== "infrastructure") {
          context.addIssue({
            code: "custom",
            message: "Connections must name infrastructure App groups",
            path: ["profiles", "definitions", id, "connections", groupId],
          });
        }
      }
    }
  }
};

const validateEndpointProfiles = (
  config: BranchBaseConfigShape,
  context: z.RefinementCtx
): void => {
  for (const [profileId, profile] of Object.entries(
    config.endpointProfiles ?? {}
  )) {
    for (const [groupId, apps] of Object.entries(profile.ports)) {
      const group = config.appGroups[groupId];
      if (!group || !supportsEndpointProfile(group)) {
        context.addIssue({
          code: "custom",
          message:
            "Endpoint profiles support existing per-worktree application groups only",
          path: ["endpointProfiles", profileId, "ports", groupId],
        });
        continue;
      }
      for (const [appId, port] of Object.entries(apps)) {
        const app = group.apps[appId];
        if (!app || (app.port !== undefined && app.port !== port)) {
          context.addIssue({
            code: "custom",
            message:
              "Endpoint profiles require unique ports on existing per-worktree application apps, consistent with literal ports",
            path: ["endpointProfiles", profileId, "ports", groupId, appId],
          });
        }
      }
    }
    const resolved = new Set<number>();
    for (const [groupId, group] of Object.entries(config.appGroups)) {
      for (const [appId, app] of Object.entries(group.apps)) {
        const port = profile.ports[groupId]?.[appId] ?? app.port;
        if (port !== undefined && resolved.has(port)) {
          context.addIssue({
            code: "custom",
            message: `Port ${port} is requested by multiple apps`,
            path: ["endpointProfiles", profileId],
          });
        }
        if (port !== undefined) {
          resolved.add(port);
        }
      }
    }
  }
};

const validateBranchBaseConfig = (
  config: BranchBaseConfigShape,
  context: z.RefinementCtx
): void => {
  const groups = Object.entries(config.appGroups);
  if (groups.length === 0) {
    context.addIssue({
      code: "custom",
      message: "BranchBase config requires at least one App group",
      path: ["appGroups"],
    });
    return;
  }

  validateEndpointProfiles(config, context);
  validateProfiles(config, context);
  for (const [groupId, group] of groups) {
    try {
      dependencyOrder(config, groupId);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: String(error),
        path: ["appGroups", groupId, "dependsOn"],
      });
    }
    const apps = Object.entries(group.apps);
    if (apps.length === 0 && group.stop !== "process") {
      context.addIssue({
        code: "custom",
        message: "A command-controlled App group requires at least one App",
        path: ["appGroups", groupId, "apps"],
      });
      continue;
    }
    for (const [appId, app] of apps) {
      if (app.protocol === "tcp" && app.readiness !== "tcp") {
        context.addIssue({
          code: "custom",
          message: "TCP Apps support TCP readiness only",
          path: ["appGroups", groupId, "apps", appId, "readiness"],
        });
      }
    }
    for (const field of ["env", "outputs"] as const) {
      for (const [name, template] of Object.entries(group[field] ?? {})) {
        const error = branchbaseTemplateError(
          template,
          config.appGroups,
          groupId
        );
        if (error) {
          context.addIssue({
            code: "custom",
            message: error,
            path: ["appGroups", groupId, field, name],
          });
        }
      }
    }
    for (const [index, argument] of group.start.argv.entries()) {
      const error = branchbaseTemplateError(
        argument,
        config.appGroups,
        groupId
      );
      if (error) {
        context.addIssue({
          code: "custom",
          message: error,
          path: ["appGroups", groupId, "start", "argv", index],
        });
      }
    }
    if (group.stop !== "process") {
      for (const [index, argument] of group.stop.argv.entries()) {
        const error = branchbaseTemplateError(
          argument,
          config.appGroups,
          groupId
        );
        if (error) {
          context.addIssue({
            code: "custom",
            message: error,
            path: ["appGroups", groupId, "stop", "argv", index],
          });
        }
      }
    }
  }
};

export const BranchBaseConfigSchema = BranchBaseConfigObjectSchema.superRefine(
  validateBranchBaseConfig
);

export type BranchBaseConfig = z.infer<typeof BranchBaseConfigSchema>;
export type WorktreeEnvConfig = BranchBaseConfig;

export const cloneBranchBaseConfig = (
  config: BranchBaseConfig
): BranchBaseConfig => structuredClone(config);
