import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import pathModule from "node:path";

import { processStartMarker } from "../adapters/host/process-inspection";
import { readRuntimeIdentity } from "../adapters/host/runtime-identity";

test.each(["matching", "mismatched", "legacy"])(
  "daemon start and status verify a %s live daemon without replacing it",
  async (mode) => {
    const homeDirectory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-cli-identity-")
    );
    const controlDirectory = pathModule.join(homeDirectory, ".branchbase");
    mkdirSync(controlDirectory);
    const pidFile = pathModule.join(controlDirectory, "server.pid");
    const record = JSON.stringify({
      pid: process.pid,
      startMarker: processStartMarker(process.pid),
    });
    writeFileSync(pidFile, record);
    const runtime = readRuntimeIdentity();
    const server = Bun.serve({
      fetch: () =>
        Response.json({
          ok: true,
          pid: process.pid,
          runtime:
            mode === "legacy"
              ? undefined
              : {
                  ...runtime,
                  buildId: mode === "matching" ? runtime.buildId : "old-build",
                },
          service: "branchbase",
        }),
      hostname: "127.0.0.1",
      port: 0,
    });
    const invoke = async (command: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          pathModule.resolve(import.meta.dirname, "../../scripts/daemon.ts"),
          "daemon",
          command,
        ],
        {
          env: {
            ...process.env,
            BRANCHBASE_PORT: String(server.port),
            HOME: homeDirectory,
          },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stderr, stdout };
    };
    try {
      const results = await Promise.all([invoke("start"), invoke("status")]);
      for (const result of results) {
        expect(result.code).toBe(mode === "matching" ? 0 : 1);
        if (mode === "matching") {
          expect(result.stdout).toContain("running");
          expect(result.stderr).toBe("");
        } else {
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("CLI/daemon build mismatch");
          expect(result.stderr).toContain("bbase daemon stop");
          expect(result.stderr).toContain("bbase daemon start");
        }
      }
      expect(readFileSync(pidFile, "utf-8")).toBe(record);
    } finally {
      await server.stop(true);
      rmSync(homeDirectory, { force: true, recursive: true });
    }
  },
  // Each real CLI process fingerprints the installed dependency tree before and
  // after loading modules. Allow cold filesystem reads on the macOS CI runner.
  15_000
);
