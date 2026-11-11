import pathModule from "node:path";

import {
  assertRuntimeUnchanged,
  readRuntimeIdentity,
} from "../adapters/host/runtime-identity";

const appRoot = pathModule.dirname(pathModule.dirname(import.meta.dirname));
const runtime = readRuntimeIdentity(appRoot);
const { createDaemon } = await import("./bootstrap");
const server = await createDaemon({
  appRoot,
  ...(process.env.BRANCHBASE_CODEX_CONTROL_DIR
    ? { codexControlDirectory: process.env.BRANCHBASE_CODEX_CONTROL_DIR }
    : {}),
  development: false,
  host: "127.0.0.1",
  port: Number(process.env.BRANCHBASE_PORT ?? 3999),
  runtime,
});

try {
  assertRuntimeUnchanged(runtime);
  console.log(`BranchBase: ${await server.listen()}`);
} catch (error) {
  await server.close();
  throw error;
}

const closeOnSignal = async (): Promise<void> => {
  try {
    await server.close();
  } catch {
    process.exitCode = 1;
  }
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void closeOnSignal();
  });
}
