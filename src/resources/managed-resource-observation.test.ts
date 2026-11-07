import { expect, test } from "bun:test";

import { ManagedResourceObservation } from "./managed-resource-observation";

const observe = () => Promise.reject(new Error("Docker is unavailable"));

test("background status failures stay unknown until a successful observation", async () => {
  const observations = new ManagedResourceObservation();
  expect(observations.inspect("instance", observe)).toBe(false);
  await Promise.resolve();
  expect(() => observations.inspect("instance", observe)).toThrow(
    "Docker is unavailable"
  );
  observations.record("instance", true);
  expect(observations.inspect("instance", observe)).toBe(true);
});
