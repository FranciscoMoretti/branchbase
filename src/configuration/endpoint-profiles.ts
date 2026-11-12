import { z } from "zod";

import type { BranchBaseConfig } from "./branchbase-schema";

export const EndpointProfilesSchema = z.record(
  z.string().min(1),
  z.strictObject({
    name: z.string().min(1),
    ports: z.record(
      z.string().min(1),
      z.record(z.string().min(1), z.number().int().min(1024).max(65_535))
    ),
  })
);

export const endpointProfilePorts = (
  config: BranchBaseConfig,
  profileId: string | null
): Record<string, Record<string, number>> => {
  if (profileId === null) {
    return {};
  }
  const profile = config.endpointProfiles?.[profileId];
  if (!profile) {
    throw new Error(
      `Endpoint profile "${profileId}" is unavailable. Select another profile or the Project default.`
    );
  }
  return profile.ports;
};

export const supportsEndpointProfile = (
  group: BranchBaseConfig["appGroups"][string]
): boolean =>
  group.instances.mode === "per-worktree" &&
  group.category !== "infrastructure";
