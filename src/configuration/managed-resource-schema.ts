import { z } from "zod";

import { BranchBaseAppGroupSchema } from "./branchbase-schema";

const Values = z.record(z.string(), z.string());
export const ManagedResourceDefinitionSchema = z
  .strictObject({
    $schema: z.string().optional(),
    build: z
      .strictObject({ argv: z.array(z.string().min(1)).min(1) })
      .optional(),
    directory: z.string().min(1),
    files: z.array(z.string().min(1)),
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
    idle: z.enum(["keep-running", "stop-when-unused"]),
    instances: z.record(
      z.string().min(1),
      z.strictObject({
        env: Values.optional(),
        outputs: Values,
        ports: z.record(z.string(), z.number().int().min(1024).max(65_535)),
      })
    ),
    name: z.string().min(1),
    recipe: BranchBaseAppGroupSchema,
    status: z
      .strictObject({
        argv: z.array(z.string().min(1)).min(1),
        stoppedExitCodes: z
          .array(z.number().int().min(1).max(255))
          .default([1]),
      })
      .optional(),
    version: z.literal(1),
  })
  .superRefine((value, context) => {
    if (value.recipe.stop !== "process" && !value.status) {
      context.addIssue({
        code: "custom",
        message: "Detached resources require a status command",
        path: ["status"],
      });
    }
    if (value.recipe.dependsOn?.length) {
      context.addIssue({
        code: "custom",
        message: "Resource definitions must own a self-contained lifecycle",
        path: ["recipe", "dependsOn"],
      });
    }
    for (const [name, instance] of Object.entries(value.instances)) {
      for (const app of Object.keys(instance.ports)) {
        if (!value.recipe.apps[app]) {
          context.addIssue({
            code: "custom",
            message: `Unknown endpoint ${app}`,
            path: ["instances", name, "ports", app],
          });
        }
      }
    }
  });
