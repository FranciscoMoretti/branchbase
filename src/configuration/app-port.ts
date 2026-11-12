import { existsSync, readFileSync } from "node:fs";
import pathModule from "node:path";
import { parseEnv } from "node:util";

import type { BranchBaseApp } from "./branchbase-schema";
import { MAX_BRANCHBASE_PORT, MIN_BRANCHBASE_PORT } from "./branchbase-schema";

export const configuredAppPort = (
  app: BranchBaseApp,
  worktreePath: string
): number | undefined => {
  if (!app.portFromEnv) {
    return app.port;
  }
  const file = pathModule.resolve(worktreePath, app.portFromEnv.file);
  if (!existsSync(file)) {
    return app.port;
  }
  const value = parseEnv(readFileSync(file, "utf-8"))[app.portFromEnv.variable];
  if (value === undefined || value === "") {
    return app.port;
  }
  const port = Number(value);
  if (
    !/^\d+$/u.test(value) ||
    !Number.isInteger(port) ||
    port < MIN_BRANCHBASE_PORT ||
    port > MAX_BRANCHBASE_PORT
  ) {
    throw new Error(`Invalid port for ${app.portFromEnv.variable} in ${file}`);
  }
  return port;
};
