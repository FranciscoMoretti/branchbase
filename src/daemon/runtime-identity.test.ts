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

import { readRuntimeIdentity } from "./runtime-identity";

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
    const alias = pathModule.join(temporary, "alias");
    symlinkSync(root, alias);
    expect(readRuntimeIdentity(alias)).toEqual(original);
    const other = pathModule.join(temporary, "other");
    cpSync(root, other, { recursive: true });
    expect(readRuntimeIdentity(other).buildId).not.toBe(original.buildId);
    writeFileSync(
      pathModule.join(root, "src/main.test.ts"),
      "// test-only edit"
    );
    expect(readRuntimeIdentity(root)).toEqual(original);
    writeFileSync(pathModule.join(root, "src/main.ts"), "// build B");
    const updated = readRuntimeIdentity(root);
    expect(updated.version).toBe(original.version);
    expect(updated.buildId).not.toBe(original.buildId);
    writeFileSync(pathModule.join(root, "dist/index.html"), "build B");
    expect(readRuntimeIdentity(root).buildId).not.toBe(updated.buildId);
    expect(original.version).toBe("0.5.0");
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});
