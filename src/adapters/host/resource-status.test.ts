import { expect, test } from "bun:test";

import {
  managedResourceRunning,
  observeManagedResourceRunning,
} from "./resource-status";

const command = (source: string) => [process.execPath, "-e", source];

test.each([
  [0, true],
  [1, false],
  [3, false],
] as const)(
  "status exit %i works with ordinary stdout",
  async (code, expected) => {
    const argv = command(
      `console.log('ordinary output');process.exit(${code})`
    );
    expect(managedResourceRunning(argv, process.cwd(), {}, [1, 3])).toBe(
      expected
    );
    expect(
      await observeManagedResourceRunning(argv, process.cwd(), {}, [1, 3])
    ).toBe(expected);
  }
);

test("only configured stopped exit codes mean stopped", async () => {
  const argv = command("process.exit(1)");
  expect(managedResourceRunning(argv, process.cwd(), {})).toBe(false);
  expect(await observeManagedResourceRunning(argv, process.cwd(), {})).toBe(
    false
  );
  expect(() => managedResourceRunning(argv, process.cwd(), {}, [3])).toThrow(
    "unexpected code 1"
  );
  await expect(
    observeManagedResourceRunning(argv, process.cwd(), {}, [3])
  ).rejects.toThrow("unexpected code 1");
});

test.each([
  { argv: command("process.exit(2)") },
  { argv: ["/branchbase-test-missing-executable"] },
  { argv: command("process.kill(process.pid, 'SIGTERM')") },
  { argv: command("console.log('x'.repeat(100000))") },
])(
  "unexpected exits and execution failures remain errors: %j",
  async ({ argv }) => {
    expect(() => managedResourceRunning(argv, process.cwd(), {})).toThrow(
      "Resource status command"
    );
    await expect(
      observeManagedResourceRunning(argv, process.cwd(), {})
    ).rejects.toThrow("Resource status command");
  }
);

test("status commands receive the selected instance environment", async () => {
  const argv = command(
    "process.exit(process.env.COMPOSE_PROJECT_NAME === 'alaro-1' ? 0 : 2)"
  );
  const env = { COMPOSE_PROJECT_NAME: "alaro-1" };
  expect(managedResourceRunning(argv, process.cwd(), env)).toBe(true);
  expect(await observeManagedResourceRunning(argv, process.cwd(), env)).toBe(
    true
  );
});

test("status timeouts remain errors even when stopped is an expected result", async () => {
  const argv = command("setInterval(() => {}, 1000)");
  const pending = observeManagedResourceRunning(argv, process.cwd(), {});
  const rejection = expect(pending).rejects.toThrow("running state is unknown");
  expect(() => managedResourceRunning(argv, process.cwd(), {})).toThrow(
    "running state is unknown"
  );
  await rejection;
}, 15_000);
