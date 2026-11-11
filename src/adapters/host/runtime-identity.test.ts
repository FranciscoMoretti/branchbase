import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import pathModule from "node:path";

import {
  assertRuntimeUnchanged,
  readRuntimeIdentity,
} from "./runtime-identity";

test("runtime identity detects same-version upgrades and installation switches, but resolves symlinks", () => {
  const temporary = mkdtempSync(
    pathModule.join(tmpdir(), "branchbase-identity-")
  );
  const root = pathModule.join(temporary, "installation");
  try {
    mkdirSync(pathModule.join(root, "scripts"), { recursive: true });
    mkdirSync(pathModule.join(root, "src"));
    mkdirSync(pathModule.join(root, "dist"));
    writeFileSync(
      pathModule.join(root, "package.json"),
      JSON.stringify({ version: "0.5.0" })
    );
    writeFileSync(pathModule.join(root, "scripts/daemon.ts"), "// cli");
    writeFileSync(pathModule.join(root, "src/main.ts"), "// build A");
    writeFileSync(pathModule.join(root, "dist/index.html"), "build A");
    const original = readRuntimeIdentity(root);
    expect(readRuntimeIdentity(root)).toEqual(original);
    expect(() => assertRuntimeUnchanged(original)).not.toThrow();
    const alias = pathModule.join(temporary, "alias");
    symlinkSync(root, alias);
    expect(readRuntimeIdentity(alias)).toEqual(original);
    const other = pathModule.join(temporary, "other");
    cpSync(root, other, { recursive: true });
    expect(readRuntimeIdentity(other).buildId).not.toBe(original.buildId);
    for (const file of [
      "main.test.ts",
      "main.spec.ts",
      "test-fixtures.ts",
      "portless-fixture.ts",
    ]) {
      writeFileSync(pathModule.join(root, "src", file), "// test-only edit");
    }
    expect(readRuntimeIdentity(root)).toEqual(original);
    writeFileSync(pathModule.join(root, "src/main.ts"), "// build B");
    const updated = readRuntimeIdentity(root);
    expect(() => assertRuntimeUnchanged(original)).toThrow(
      "installation changed during startup"
    );
    expect(updated.version).toBe(original.version);
    expect(updated.buildId).not.toBe(original.buildId);
    writeFileSync(pathModule.join(root, "dist/index.html"), "build B");
    expect(readRuntimeIdentity(root).buildId).not.toBe(updated.buildId);
    expect(original.version).toBe("0.5.0");
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("runtime identity captures lockfiles and resolved transitive dependency versions and contents", () => {
  const root = mkdtempSync(
    pathModule.join(tmpdir(), "branchbase-dependency-identity-")
  );
  try {
    mkdirSync(pathModule.join(root, "scripts"));
    writeFileSync(pathModule.join(root, "scripts/daemon.ts"), "// cli");
    writeFileSync(
      pathModule.join(root, "package.json"),
      JSON.stringify({ dependencies: { example: "^1.0.0" }, version: "0.5.1" })
    );
    const dependency = pathModule.join(root, "node_modules", "example");
    const transitive = pathModule.join(root, "node_modules", "nested");
    mkdirSync(dependency, { recursive: true });
    mkdirSync(transitive, { recursive: true });
    writeFileSync(
      pathModule.join(dependency, "package.json"),
      JSON.stringify({ dependencies: { nested: "^1.0.0" }, version: "1.0.0" })
    );
    writeFileSync(
      pathModule.join(transitive, "package.json"),
      JSON.stringify({ version: "1.0.0" })
    );
    const original = readRuntimeIdentity(root);
    writeFileSync(
      pathModule.join(transitive, "package.json"),
      JSON.stringify({ version: "1.1.0" })
    );
    const changedDependency = readRuntimeIdentity(root);
    expect(changedDependency.buildId).not.toBe(original.buildId);
    writeFileSync(
      pathModule.join(transitive, "index.js"),
      "export const build = 'A';"
    );
    const dependencyBuildA = readRuntimeIdentity(root);
    writeFileSync(
      pathModule.join(transitive, "index.js"),
      "export const build = 'B';"
    );
    const dependencyBuildB = readRuntimeIdentity(root);
    expect(dependencyBuildB.buildId).not.toBe(dependencyBuildA.buildId);
    writeFileSync(pathModule.join(root, "bun.lock"), "changed resolution");
    expect(readRuntimeIdentity(root).buildId).not.toBe(
      dependencyBuildB.buildId
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
