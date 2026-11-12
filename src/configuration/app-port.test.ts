import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import pathModule from "node:path";

import { configuredAppPort } from "./app-port";
import { BranchBaseAppSchema } from "./branchbase-schema";

it.each([
  { content: undefined, expected: undefined, port: undefined },
  { content: undefined, expected: 3000, port: 3000 },
  { content: "OTHER_PORT=4000\n", expected: undefined, port: undefined },
  { content: "OTHER_PORT=4000\n", expected: 3000, port: 3000 },
  { content: "WEB_PORT=\n", expected: 3000, port: 3000 },
  { content: 'WEB_PORT=""\n', expected: undefined, port: undefined },
  { content: "WEB_PORT=4000\n", expected: 4000, port: 3000 },
  {
    content: 'export WEB_PORT="4000" # local override\n',
    expected: 4000,
    port: undefined,
  },
  { content: "WEB_PORT=1024\n", expected: 1024, port: undefined },
  { content: "WEB_PORT=65535\n", expected: 65_535, port: undefined },
])("resolves a dotenv port or fallback: %j", ({ content, expected, port }) => {
  const root = mkdtempSync(pathModule.join(tmpdir(), "branchbase-port-"));
  try {
    if (content !== undefined) {
      writeFileSync(pathModule.join(root, ".env.local"), content);
    }
    const app = BranchBaseAppSchema.parse({
      port,
      portFromEnv: { file: ".env.local", variable: "WEB_PORT" },
      protocol: "http",
    });
    expect(configuredAppPort(app, root)).toBe(expected);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it.each([
  "invalid",
  "1023",
  "65536",
  "-3000",
  "3000.5",
  "3e3",
  "0xbb8",
  "999999999999999999999",
])("rejects invalid dotenv ports without using the fallback: %s", (value) => {
  const root = mkdtempSync(pathModule.join(tmpdir(), "branchbase-port-"));
  try {
    writeFileSync(pathModule.join(root, ".env.local"), `WEB_PORT=${value}\n`);
    const app = BranchBaseAppSchema.parse({
      port: 3000,
      portFromEnv: { file: ".env.local", variable: "WEB_PORT" },
      protocol: "http",
    });
    expect(() => configuredAppPort(app, root)).toThrow(
      "Invalid port for WEB_PORT"
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("resolves a shared definition against each worktree's own file", () => {
  const root = mkdtempSync(pathModule.join(tmpdir(), "branchbase-port-"));
  const app = BranchBaseAppSchema.parse({
    portFromEnv: { file: ".env.local", variable: "WEB_PORT" },
    protocol: "http",
  });
  try {
    const first = pathModule.join(root, "first");
    const second = pathModule.join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(pathModule.join(first, ".env.local"), "WEB_PORT=3000\n");
    writeFileSync(pathModule.join(second, ".env.local"), "WEB_PORT=3010\n");
    expect(configuredAppPort(app, first)).toBe(3000);
    expect(configuredAppPort(app, second)).toBe(3010);
    expect(
      configuredAppPort(
        BranchBaseAppSchema.parse({ port: 3020, protocol: "http" }),
        first
      )
    ).toBe(3020);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
