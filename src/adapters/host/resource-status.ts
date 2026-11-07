import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import type { BranchBaseAppGroup } from "../../configuration/branchbase-schema";

/** Read only declared local inputs. Values never enter persisted run bindings. */
export const localCommandInputs = (
  group: BranchBaseAppGroup
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(group.inputs ?? {}).map(([key, input]) => [
      key,
      readFileSync(input.file, "utf-8").trimEnd(),
    ])
  );

export const commandEnvironment = (
  group: BranchBaseAppGroup,
  resolved: Record<string, string>
) => ({
  ...resolved,
  ...localCommandInputs(group),
  ...Object.fromEntries(
    Object.entries(resolved).filter(([key]) => group.env?.[key]?.includes("{"))
  ),
});

export const runBoundCommand = async (
  argv: string[],
  context: {
    cwd: string;
    env: Record<string, string>;
    inputs: Record<string, { file: string }>;
  },
  release: () => Promise<unknown>
) => {
  // Keep the CLI alive through child shutdown and lease release. A direct
  // signal to the CLI must reach the child as well as terminal group signals.
  let child: ReturnType<typeof spawn> | undefined;
  const forward = (signal: NodeJS.Signals) => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) {
    process.on(signal, forward);
  }
  try {
    const secretInputs = Object.fromEntries(
      Object.entries(context.inputs).map(([key, input]) => [
        key,
        readFileSync(input.file, "utf-8").trimEnd(),
      ])
    );
    child = spawn(argv[0], argv.slice(1), {
      cwd: context.cwd,
      env: { ...process.env, ...secretInputs, ...context.env },
      stdio: "inherit",
    });
    const [code, signal] = await once(child, "exit");
    if (code !== 0) {
      throw new Error(`Command exited with ${signal ?? code}`);
    }
  } finally {
    try {
      await release();
    } finally {
      for (const signal of signals) {
        process.off(signal, forward);
      }
    }
  }
};

const resourceRunningForExitCode = (
  code: number,
  stoppedExitCodes: readonly number[]
): boolean => {
  if (code === 0) {
    return true;
  }
  if (stoppedExitCodes.includes(code)) {
    return false;
  }
  throw new Error(
    `Resource status command exited with unexpected code ${code}`
  );
};

const executeFile = promisify(execFile);

/** Dashboard observations must never block the daemon's event loop. */
export const observeManagedResourceRunning = async (
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  stoppedExitCodes: readonly number[] = [1]
): Promise<boolean> => {
  try {
    await executeFile(argv[0], argv.slice(1), {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      timeout: 5000,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "number" &&
      !("signal" in error && error.signal) &&
      !("killed" in error && error.killed)
    ) {
      return resourceRunningForExitCode(error.code, stoppedExitCodes);
    }
    // oxlint-disable-next-line preserve-caught-error -- Child errors contain stdout/stderr that may include secret inputs.
    throw new Error("Resource status command failed; running state is unknown");
  }
  return true;
};

/** The configured command targets the selected resource; stdout is not a protocol. */
export const managedResourceRunning = (
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  stoppedExitCodes: readonly number[] = [1]
): boolean => {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    timeout: 5000,
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error("Resource status command failed; running state is unknown");
  }
  return resourceRunningForExitCode(result.status, stoppedExitCodes);
};
