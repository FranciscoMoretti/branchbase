#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import pathModule from "node:path";

import { DaemonClient } from "../src/adapters/cli/client";
import { runCli } from "../src/adapters/cli/run";
import { currentHost } from "../src/adapters/host/host-adapter";
import { pollUntil } from "../src/adapters/host/polling";
import {
  repositoryPathFromArgs,
  repositoryUrl,
} from "../src/repository-context";

const APP_ROOT = pathModule.dirname(import.meta.dirname);
const CONTROL_DIR = pathModule.join(homedir(), ".branchbase");
const PID_FILE = pathModule.join(CONTROL_DIR, "server.pid");
const LOG_FILE = pathModule.join(CONTROL_DIR, "server.log");
const cliArgs = process.argv.slice(2);
const daemonArgs = cliArgs[0] === "daemon" ? cliArgs.slice(1) : cliArgs;
const [command] = daemonArgs;
const selectedRepoPath = repositoryPathFromArgs(
  daemonArgs.slice(1),
  process.env.INIT_CWD
);
const repoPath = selectedRepoPath ? pathModule.resolve(selectedRepoPath) : null;

const appUrl = (): string =>
  repositoryUrl(
    `http://127.0.0.1:${process.env.BRANCHBASE_PORT ?? 3999}/`,
    repoPath
  );

const openApp = (): void => {
  if (process.env.BRANCHBASE_NO_OPEN === "1") {
    return;
  }
  currentHost().openUrl(appUrl());
};

interface DaemonRecord {
  pid: number;
  startMarker: string;
}

const startMarker = (pid: number): string => {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf-8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
};

const readPid = (file = PID_FILE): number | null => {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const record = JSON.parse(readFileSync(file, "utf-8")) as DaemonRecord;
    return Number.isInteger(record.pid) &&
      record.pid > 0 &&
      record.startMarker.length > 0 &&
      startMarker(record.pid) === record.startMarker
      ? record.pid
      : null;
  } catch {
    return null;
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForHealth = async (expectedPid: number): Promise<void> => {
  const url = `http://127.0.0.1:${process.env.BRANCHBASE_PORT ?? 3999}/api/health`;
  await pollUntil(
    async () => {
      try {
        const response = await fetch(url);
        const body = (await response.json()) as {
          pid?: number;
          service?: string;
        };
        return (
          response.ok &&
          body.service === "branchbase" &&
          body.pid === expectedPid
        );
      } catch {
        // The detached server is still starting.
        return false;
      }
    },
    {
      intervalMs: 100,
      maxAttempts: 50,
      message: `BranchBase did not become healthy; inspect ${LOG_FILE}`,
    }
  );
};

const start = async (): Promise<void> => {
  mkdirSync(CONTROL_DIR, { recursive: true });
  const existing = readPid();
  if (existing && alive(existing)) {
    await new DaemonClient(appUrl()).verifyRuntime(existing);
    console.log(`BranchBase is already running (pid ${existing}): ${appUrl()}`);
    return;
  }
  rmSync(PID_FILE, { force: true });
  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, ["run", "src/daemon/main.ts"], {
    cwd: APP_ROOT,
    detached: true,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  if (!child.pid) {
    throw new Error("Failed to start BranchBase");
  }
  child.unref();
  writeFileSync(
    PID_FILE,
    `${JSON.stringify({ pid: child.pid, startMarker: startMarker(child.pid) })}\n`
  );
  await waitForHealth(child.pid);
  await new DaemonClient(appUrl()).verifyRuntime(child.pid);
  console.log(`BranchBase started: ${appUrl()}`);
};

const status = async (): Promise<void> => {
  const pid = readPid();
  if (pid && alive(pid)) {
    await new DaemonClient(appUrl()).verifyRuntime(pid);
    console.log(`BranchBase is running (pid ${pid})`);
    return;
  }
  console.log("BranchBase is stopped");
  process.exitCode = 1;
};

const stop = (): void => {
  const pid = readPid();
  if (!(pid && alive(pid))) {
    rmSync(PID_FILE, { force: true });
    console.log("BranchBase is already stopped");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The daemon may have exited after the liveness check.
  }
  rmSync(PID_FILE, { force: true });
  console.log("BranchBase stopped");
};

try {
  if (command === "start") {
    await start();
  } else if (command === "status") {
    await status();
  } else if (command === "stop") {
    stop();
  } else if (command === "dashboard") {
    await new DaemonClient(appUrl()).verifyRuntime();
    openApp();
    console.log(appUrl());
  } else {
    console.log(
      await runCli(
        cliArgs,
        new DaemonClient(
          `http://127.0.0.1:${process.env.BRANCHBASE_PORT ?? 3999}`
        ),
        process.cwd()
      )
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
