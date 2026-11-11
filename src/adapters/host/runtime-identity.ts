import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import pathModule from "node:path";

import { z } from "zod";

export const RuntimeIdentitySchema = z.object({
  buildId: z.string().min(1),
  installationPath: z.string().min(1),
  version: z.string().min(1),
});

export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

export const RUNTIME_HEADER = "x-branchbase-build";
export const RUNTIME_PATH_PREFIX = "/api/runtime/";
export const DAEMON_RESTART_INSTRUCTIONS =
  "Restart required: run `bbase daemon stop`, wait for the daemon to exit, then run `bbase daemon start` from the intended installation. For a source checkout, replace `bbase` with `bun scripts/daemon.ts`, run from that checkout.";

const TEST_DIRECTORY_NAMES = new Set(["fixtures", "__tests__", "__mocks__"]);
const TEST_FILE = /(?:\.test\.|\.spec\.|^test-|[-.]fixture[s]?\.)/u;

const PackageManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  version: z.string().min(1),
});

/** Resolved manifests capture installed versions, including hoisted/transitive dependencies. */
const installedDependencyFiles = (root: string): string[] => {
  const pending = [pathModule.join(root, "package.json")];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const manifest = PackageManifestSchema.parse(
      JSON.parse(readFileSync(file, "utf-8"))
    );
    const require = createRequire(file);
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      const directory = require.resolve
        .paths(name)
        ?.find((candidate) =>
          existsSync(pathModule.join(candidate, name, "package.json"))
        );
      if (directory) {
        pending.push(
          realpathSync(pathModule.join(directory, name, "package.json"))
        );
      }
    }
  }
  return [...seen].toSorted();
};

const runtimeFiles = (root: string, directory: string): string[] => {
  const absolute = pathModule.join(root, directory);
  if (!existsSync(absolute)) {
    return [];
  }
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = pathModule.join(directory, entry.name);
    if (TEST_DIRECTORY_NAMES.has(entry.name) || TEST_FILE.test(entry.name)) {
      return [];
    }
    return entry.isDirectory() ? runtimeFiles(root, relative) : [relative];
  });
};

/** Snapshot once at startup; an in-place upgrade must not change a live daemon's identity. */
export const readRuntimeIdentity = (
  appRoot = pathModule.resolve(import.meta.dirname, "../../..")
): RuntimeIdentity => {
  const installationPath = realpathSync(appRoot);
  const manifest = readFileSync(
    pathModule.join(installationPath, "package.json")
  );
  const { version } = z
    .object({ version: z.string().min(1) })
    .parse(JSON.parse(manifest.toString("utf-8")));
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      "branchbase-runtime-v1",
      installationPath,
      process.versions.bun,
    ])
  );
  const files = [
    "package.json",
    "scripts/daemon.ts",
    ...[
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ].filter((file) => existsSync(pathModule.join(installationPath, file))),
    ...["src", "dist", "plugins", "schema"].flatMap((directory) =>
      runtimeFiles(installationPath, directory)
    ),
  ].toSorted();
  for (const file of files) {
    const contents = readFileSync(pathModule.join(installationPath, file));
    hash.update(JSON.stringify([file, contents.length]));
    hash.update(contents);
  }
  for (const file of installedDependencyFiles(installationPath)) {
    const contents = readFileSync(file);
    hash.update(JSON.stringify([file, contents.length]));
    hash.update(contents);
  }
  return { buildId: hash.digest("hex"), installationPath, version };
};

export const assertRuntimeUnchanged = (expected: RuntimeIdentity): void => {
  if (
    readRuntimeIdentity(expected.installationPath).buildId !== expected.buildId
  ) {
    throw new Error(
      "BranchBase installation changed during startup. Retry after the upgrade completes."
    );
  }
};

const describeRuntime = (identity: RuntimeIdentity): string =>
  `${identity.version} (${identity.buildId.slice(0, 12)}) at ${identity.installationPath}`;

export const runtimeMismatchMessage = (
  expected: RuntimeIdentity,
  actual?: RuntimeIdentity
): string =>
  `CLI/daemon build mismatch. CLI: ${describeRuntime(expected)}. Daemon: ${actual ? describeRuntime(actual) : "unknown (no supported build identity)"}. ${DAEMON_RESTART_INSTRUCTIONS}`;
