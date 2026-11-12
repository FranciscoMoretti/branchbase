import { z } from "zod";

import type { BranchBaseConfig } from "./branchbase-schema";

export const EndpointProfilePortsSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), z.number().int().min(1024).max(65_535))
);

export const EndpointProfilesSchema = z.record(
  z.string().min(1),
  z.strictObject({
    name: z.string().min(1),
    ports: EndpointProfilePortsSchema,
  })
);

export const findEndpointProfile = (
  config: BranchBaseConfig,
  profileId: string
) => {
  const { endpointProfiles } = config;
  return endpointProfiles && Object.hasOwn(endpointProfiles, profileId)
    ? endpointProfiles[profileId]
    : undefined;
};

export const endpointProfilePort = (
  ports: z.infer<typeof EndpointProfilePortsSchema>,
  groupId: string,
  appId: string
): number | undefined => {
  const group = Object.hasOwn(ports, groupId) ? ports[groupId] : undefined;
  return group && Object.hasOwn(group, appId) ? group[appId] : undefined;
};

export const endpointProfilePorts = (
  config: BranchBaseConfig,
  profileId: string | null
): Record<string, Record<string, number>> => {
  if (profileId === null) {
    return {};
  }
  const profile = findEndpointProfile(config, profileId);
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
