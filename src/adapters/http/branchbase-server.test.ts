import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import pathModule from "node:path";

import { AppGroupLifecycleError } from "../../app-group/lifecycle-error";
import { ProductCatalogError } from "../../project/catalog";
import { RUNTIME_HEADER } from "../host/runtime-identity";
import { createBranchBaseServer } from "./branchbase-server";
import type { BranchBaseServerController } from "./branchbase-server";

const testRuntime = {
  buildId: "http-test",
  installationPath: "/test",
  version: "test",
};

describe("BranchBase HTTP server", () => {
  it("preserves the product catalog error code for API callers", async () => {
    const appRoot = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-server-catalog-")
    );
    const catalogFile = pathModule.join(appRoot, "product.json");
    const controller = {
      close: () => Promise.resolve(),
      execute: () => Promise.reject(new Error("not used")),
      handleCodexHook: () => ({ accepted: false }),
      inspect: () => {
        throw new Error("not used");
      },
      inspectCodex: () => Promise.reject(new Error("not used")),
      logs: () => [],
      projects: () => {
        throw new ProductCatalogError(catalogFile, new Error("invalid JSON"));
      },
    } as unknown as BranchBaseServerController;
    const server = await createBranchBaseServer({
      appRoot,
      controller,
      development: false,
      enableCodexHooks: false,
      port: 0,
      runtime: testRuntime,
    });

    try {
      const url = await server.listen();
      const response = await fetch(new URL("/api/projects", url));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: "invalid_product_catalog",
        error: `BranchBase could not read a valid project catalog at ${catalogFile}. The file was left unchanged; repair or restore it before retrying.`,
      });
    } finally {
      await server.close();
      rmSync(appRoot, { force: true, recursive: true });
    }
  });

  it("preserves stable App-group lifecycle error codes", async () => {
    const appRoot = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-server-error-")
    );
    const controller = {
      close: () => Promise.resolve(),
      execute: () =>
        Promise.reject(
          new AppGroupLifecycleError(
            "route-conflict",
            "web.main.repo.localhost is already routed elsewhere"
          )
        ),
      handleCodexHook: () => ({ accepted: false }),
      inspect: () => {
        throw new Error("not used");
      },
      inspectCodex: () => Promise.reject(new Error("not used")),
      logs: () => [],
    } as unknown as BranchBaseServerController;
    const server = await createBranchBaseServer({
      appRoot,
      controller,
      development: false,
      enableCodexHooks: false,
      port: 0,
      runtime: testRuntime,
    });

    try {
      const url = await server.listen();
      const sessionResponse = await fetch(new URL("/api/session", url));
      const session = (await sessionResponse.json()) as { token: string };
      const response = await fetch(new URL("/api/commands/start-apps", url), {
        body: JSON.stringify({
          appGroupName: "development",
          repoPath: "/code/repo",
          worktreeId: "main",
        }),
        headers: {
          "content-type": "application/json",
          "x-branchbase-token": session.token,
        },
        method: "POST",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: "route-conflict",
        error: "web.main.repo.localhost is already routed elsewhere",
      });
    } finally {
      await server.close();
      rmSync(appRoot, { force: true, recursive: true });
    }
  });

  it("starts, authorizes commands, and closes through one interface", async () => {
    const appRoot = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-server-test-")
    );
    const runtime = {
      buildId: "server-test-build",
      installationPath: appRoot,
      version: "test",
    };
    let closeCalls = 0;
    let commandCalls = 0;
    const controller = {
      close: () => {
        closeCalls += 1;
        return Promise.resolve();
      },
      execute: () => {
        commandCalls += 1;
        return Promise.resolve({
          command: "clear-logs",
          message: "cleared",
          ok: true,
        });
      },
      handleCodexHook: () => ({ accepted: false }),
      inspect: () => {
        throw new Error("not used");
      },
      inspectCodex: () => {
        throw new Error("not used");
      },
      logs: () => [],
    } as unknown as BranchBaseServerController;
    const server = await createBranchBaseServer({
      appRoot,
      controller,
      development: false,
      enableCodexHooks: false,
      port: 0,
      runtime,
    });

    try {
      const url = await server.listen();
      const health = await fetch(new URL("/api/health", url));
      expect(await health.json()).toMatchObject({
        ok: true,
        runtime,
        service: "branchbase",
      });

      const sessionResponse = await fetch(new URL("/api/session", url));
      const session = (await sessionResponse.json()) as { token: string };
      const mismatched = await fetch(new URL("/api/commands/clear-logs", url), {
        body: "{}",
        headers: {
          "content-type": "application/json",
          [RUNTIME_HEADER]: "another-build",
          "x-branchbase-token": session.token,
        },
        method: "POST",
      });
      expect(mismatched.status).toBe(409);
      expect(await mismatched.json()).toMatchObject({
        code: "daemon-build-mismatch",
      });
      expect(commandCalls).toBe(0);
      const unauthorized = await fetch(
        new URL("/api/commands/clear-logs", url),
        {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );
      expect(unauthorized.status).toBe(403);
      const authorized = await fetch(new URL("/api/commands/clear-logs", url), {
        body: "{}",
        headers: {
          "content-type": "application/json",
          [RUNTIME_HEADER]: runtime.buildId,
          "x-branchbase-token": session.token,
        },
        method: "POST",
      });
      expect(authorized.status).toBe(200);
      expect(commandCalls).toBe(1);
    } finally {
      await server.close();
      await server.close();
      rmSync(appRoot, { force: true, recursive: true });
    }
    expect(closeCalls).toBe(1);
  });

  it("returns project errors with a null workspace", async () => {
    const appRoot = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-server-projects-")
    );
    const controller = {
      close: () => Promise.resolve(),
      execute: () => Promise.reject(new Error("not used")),
      handleCodexHook: () => ({ accepted: false }),
      inspect: () => {
        throw new Error("not used");
      },
      inspectCodex: () => Promise.reject(new Error("not used")),
      logs: () => [],
      projects: () => [
        {
          addedAt: "2026-09-06T00:00:00.000Z",
          error: "Repository is unavailable",
          name: "Unavailable project",
          path: "/code/unavailable",
          pins: [],
          workspace: null,
        },
      ],
    } as unknown as BranchBaseServerController;
    const server = await createBranchBaseServer({
      appRoot,
      controller,
      development: false,
      enableCodexHooks: false,
      port: 0,
      runtime: testRuntime,
    });

    try {
      const url = await server.listen();
      const response = await fetch(new URL("/api/projects", url));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        projects: [
          {
            addedAt: "2026-09-06T00:00:00.000Z",
            error: "Repository is unavailable",
            name: "Unavailable project",
            path: "/code/unavailable",
            pins: [],
            workspace: null,
          },
        ],
      });
    } finally {
      await server.close();
      rmSync(appRoot, { force: true, recursive: true });
    }
  });

  it("reports unavailable observation support instead of a schema error", async () => {
    const appRoot = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-server-observation-")
    );
    const controller = {
      close: () => Promise.resolve(),
      execute: () => Promise.reject(new Error("not used")),
      handleCodexHook: () => ({ accepted: false }),
      inspect: () => {
        throw new Error("not used");
      },
      inspectCodex: () => Promise.reject(new Error("not used")),
      logs: () => [],
    } as unknown as BranchBaseServerController;
    const server = await createBranchBaseServer({
      appRoot,
      controller,
      development: false,
      enableCodexHooks: false,
      port: 0,
      runtime: testRuntime,
    });

    try {
      const url = await server.listen();
      const response = await fetch(
        new URL("/api/observation?repoPath=%2Fcode%2Frepo", url)
      );
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        code: "observation-unavailable",
        error: "Repository observation is unavailable.",
      });
    } finally {
      await server.close();
      rmSync(appRoot, { force: true, recursive: true });
    }
  });

  it("formats IPv6 hosts as valid origins", async () => {
    const appRoot = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-server-ipv6-")
    );
    const controller = {
      close: () => Promise.resolve(),
      execute: () => Promise.reject(new Error("not used")),
      handleCodexHook: () => ({ accepted: false }),
      inspect: () => {
        throw new Error("not used");
      },
      inspectCodex: () => Promise.reject(new Error("not used")),
      logs: () => [],
    } as unknown as BranchBaseServerController;
    const server = await createBranchBaseServer({
      appRoot,
      controller,
      development: false,
      enableCodexHooks: false,
      host: "::1",
      port: 0,
      runtime: testRuntime,
    });

    try {
      const url = await server.listen();
      expect(url).toStartWith("http://[::1]:");
      const response = await fetch(new URL("/api/health", url));
      expect(response.status).toBe(200);
    } finally {
      await server.close();
      rmSync(appRoot, { force: true, recursive: true });
    }
  });

  it("cleans up the Codex hook capability on process exit", async () => {
    const appRoot = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-server-exit-")
    );
    const codexDirectory = pathModule.join(appRoot, "codex");
    const capabilityFile = pathModule.join(codexDirectory, "capability.json");
    const controller = {
      close: () => Promise.resolve(),
      execute: () => Promise.reject(new Error("not used")),
      handleCodexHook: () => ({ accepted: false }),
      inspect: () => {
        throw new Error("not used");
      },
      inspectCodex: () => Promise.reject(new Error("not used")),
      logs: () => [],
    } as unknown as BranchBaseServerController;
    const previousExitListeners = new Set(process.listeners("exit"));
    const server = await createBranchBaseServer({
      appRoot,
      codexControlDirectory: codexDirectory,
      controller,
      development: false,
      port: 0,
      runtime: testRuntime,
    });

    try {
      await server.listen();
      expect(existsSync(capabilityFile)).toBe(true);
      const exitHandler = process
        .listeners("exit")
        .find((listener) => !previousExitListeners.has(listener));
      expect(exitHandler).toBeDefined();
      exitHandler?.(0);
      expect(existsSync(capabilityFile)).toBe(false);
    } finally {
      await server.close();
      rmSync(appRoot, { force: true, recursive: true });
    }
    expect(
      process
        .listeners("exit")
        .every((listener) => previousExitListeners.has(listener))
    ).toBe(true);
  });
});
