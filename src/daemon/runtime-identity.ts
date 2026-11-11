import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import pathModule from "node:path";

import { z } from "zod";

export const RuntimeIdentitySchema = z.object({
  buildId: z.string().min(1),
  installationPath: z.string().min(1),
  version: z.string().min(1),
});

export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

export const RUNTIME_HEADER = "x-branchbase-build";
export const DAEMON_RESTART_INSTRUCTIONS =
  "Restart required: run `bbase daemon stop`, wait for the daemon to exit, then run `bbase daemon start` from the intended installation.";

const runtimeFiles = (root: string, directory: string): string[] => {
  const absolute = pathModule.join(root, directory);
  if (!existsSync(absolute)) {
    return [];
  }
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = pathModule.join(directory, entry.name);
    if (entry.name === "fixtures" || entry.name.includes(".test.")) {
      return [];
    }
    return entry.isDirectory() ? runtimeFiles(root, relative) : [relative];
  });
};

/** Snapshot once at startup; an in-place upgrade must not change a live daemon's identity. */
export const readRuntimeIdentity = (
  appRoot = pathModule.resolve(import.meta.dirname, "../..")
): RuntimeIdentity => {
  const installationPath = realpathSync(appRoot);
  const manifest = readFileSync(
    pathModule.join(installationPath, "package.json")
  );
  const { version } = z
    .object({ version: z.string().min(1) })
    .parse(JSON.parse(manifest.toString("utf-8")));
  const hash = createHash("sha256");
  hash.update(JSON.stringify(["branchbase-runtime-v1", installationPath]));
  const files = [
    "package.json",
    "scripts/daemon.ts",
    ...["src", "dist", "plugins", "schema"].flatMap((directory) =>
      runtimeFiles(installationPath, directory)
    ),
  ].toSorted();
  for (const file of files) {
    const contents = readFileSync(pathModule.join(installationPath, file));
    hash.update(JSON.stringify([file, contents.length]));
    hash.update(contents);
  }
  return { buildId: hash.digest("hex"), installationPath, version };
};

const describeRuntime = (identity: RuntimeIdentity): string =>
  `${identity.version} (${identity.buildId.slice(0, 12)}) at ${identity.installationPath}`;

export const runtimeMismatchMessage = (
  expected: RuntimeIdentity,
  actual?: RuntimeIdentity
): string =>
  `CLI/daemon build mismatch. CLI: ${describeRuntime(expected)}. Daemon: ${actual ? describeRuntime(actual) : "unknown (no supported build identity)"}. ${DAEMON_RESTART_INSTRUCTIONS}`;
