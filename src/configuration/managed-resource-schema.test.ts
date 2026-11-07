import { expect, test } from "bun:test";

import { ManagedResourceDefinitionSchema } from "./managed-resource-schema";

const definition = {
  directory: ".",
  files: [],
  id: "service",
  idle: "keep-running",
  instances: { "0": { outputs: {}, ports: {} } },
  name: "Service",
  recipe: {
    apps: {},
    start: { argv: ["service-cli", "start"] },
    stop: { argv: ["service-cli", "stop"] },
  },
  version: 1,
};

test("detached status defaults to exit 1 for stopped and accepts explicit alternatives", () => {
  const argv = ["service-cli", "status"];
  expect(
    ManagedResourceDefinitionSchema.parse({ ...definition, status: { argv } })
      .status?.stoppedExitCodes
  ).toEqual([1]);
  for (const stoppedExitCodes of [[], [3], [1, 3]]) {
    expect(
      ManagedResourceDefinitionSchema.parse({
        ...definition,
        status: { argv, stoppedExitCodes },
      }).status?.stoppedExitCodes
    ).toEqual(stoppedExitCodes);
  }
  for (const stoppedExitCodes of [[0], [-1], [256], [1.5]]) {
    expect(
      ManagedResourceDefinitionSchema.safeParse({
        ...definition,
        status: { argv, stoppedExitCodes },
      }).success
    ).toBe(false);
  }
  expect(ManagedResourceDefinitionSchema.safeParse(definition).success).toBe(
    false
  );
});
