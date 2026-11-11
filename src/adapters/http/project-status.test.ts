import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProjectStatus } from "../../project/status";
import { DaemonClient } from "../cli/client";
import { createBranchBaseServer } from "./branchbase-server";
import type { BranchBaseServerController } from "./branchbase-server";

test("HTTP and CLI preserve partial Project status without requiring configured inspection", async () => {
  const appRoot = mkdtempSync(path.join(tmpdir(), "branchbase-status-http-"));
  const runtime = {
    buildId: "project-status-test",
    installationPath: appRoot,
    version: "test",
  };
  const expected = createProjectStatus({
    configurationError: "Invalid configuration",
    repoPath: "/repo",
    workspace: null,
    worktrees: [{ branch: "main", id: "main", isMain: true, path: "/repo" }],
  });
  const controller: BranchBaseServerController = {
    close: () => Promise.resolve(),
    execute: () => Promise.reject(new Error("not used")),
    handleCodexHook: () => ({ accepted: false }),
    inspect: () => {
      throw new Error("configured inspection must not be called");
    },
    inspectCodex: () => Promise.reject(new Error("not used")),
    logs: () => [],
    refreshProjectStatus: (repoPath) => {
      expect(repoPath).toBe("/repo");
      return expected;
    },
  };
  const server = await createBranchBaseServer({
    appRoot,
    controller,
    development: false,
    enableCodexHooks: false,
    port: 0,
    runtime,
  });
  try {
    const origin = await server.listen();
    const response = await fetch(
      new URL("/api/project-status?repoPath=/repo", origin)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    const cli = new DaemonClient(origin, fetch, runtime);
    expect(
      await cli.query("/api/project-status", { repoPath: "/repo" })
    ).toEqual(expected);
    const invalid = await fetch(new URL("/api/project-status", origin));
    expect(invalid.status).toBe(400);
  } finally {
    await server.close();
    rmSync(appRoot, { force: true, recursive: true });
  }
});
