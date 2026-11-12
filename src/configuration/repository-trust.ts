import { createHash } from "node:crypto";
import { homedir } from "node:os";
import pathModule from "node:path";

import { TrustStore } from "../adapters/persistence/trust-store";
import type { BranchBaseCommand } from "./branchbase-command";
import type { BranchBaseConfig } from "./branchbase-config";

const defaultControlDirectory = (): string =>
  process.env.BRANCHBASE_CONTROL_DIR ??
  pathModule.join(homedir(), ".branchbase");

const trustStore = (controlDirectory?: string, failOnInvalid = false) =>
  new TrustStore(controlDirectory ?? defaultControlDirectory()).read(
    failOnInvalid
  );

export const repositoryRequiresTrust = (_config: BranchBaseConfig): boolean =>
  true;

const fingerprintCommand = (command: BranchBaseCommand) => ({
  argv: command.argv,
  ...(command.cwd ? { cwd: command.cwd } : {}),
});

const configurationFingerprint = (
  config: BranchBaseConfig,
  includeEndpointProfiles: boolean
): string => {
  const commands = {
    appGroups: Object.fromEntries(
      Object.entries(config.appGroups).map(([name, group]) => [
        name,
        {
          apps: group.apps,
          ...(config.profiles
            ? { category: group.category ?? "application" }
            : {}),
          ...(group.dependsOn ? { dependsOn: group.dependsOn } : {}),
          env: group.env ?? {},
          ...(group.outputs ? { outputs: group.outputs } : {}),
          ...(group.inputs ? { inputs: group.inputs } : {}),
          instances: group.instances,
          start: fingerprintCommand(group.start),
          stop:
            group.stop === "process"
              ? "process"
              : fingerprintCommand(group.stop),
        },
      ])
    ),
    setup: fingerprintCommand(config.setup),
    ...(includeEndpointProfiles && config.endpointProfiles
      ? { endpointProfiles: config.endpointProfiles }
      : {}),
    ...(config.profiles ? { profiles: config.profiles } : {}),
  };
  return createHash("sha256")
    .update(JSON.stringify(commands))
    .digest("base64url");
};

/** Endpoint choices affect trust, but do not change the app-group topology. */
export const appGroupConfigurationFingerprint = (
  config: BranchBaseConfig
): string => configurationFingerprint(config, false);

export const repositoryCommandFingerprint = (
  config: BranchBaseConfig
): string => configurationFingerprint(config, true);

export const repositoryFingerprintIsTrusted = (
  repoPath: string,
  fingerprint: string,
  controlDirectory?: string,
  knownValue?: boolean | string | string[]
): boolean => {
  const trusted = knownValue ?? trustStore(controlDirectory)[repoPath];
  return Array.isArray(trusted)
    ? trusted.includes(fingerprint)
    : trusted === fingerprint;
};

export const repositoryIsTrusted = (
  repoPath: string,
  config: BranchBaseConfig,
  controlDirectory?: string
): boolean => {
  if (!repositoryRequiresTrust(config)) {
    return true;
  }
  const trusted = trustStore(controlDirectory)[repoPath];
  const fingerprint = repositoryCommandFingerprint(config);
  return repositoryFingerprintIsTrusted(
    repoPath,
    fingerprint,
    controlDirectory,
    trusted
  );
};

export const trustRepository = (
  repoPath: string,
  config: BranchBaseConfig,
  controlDirectory?: string
): void => {
  const storeAdapter = new TrustStore(
    controlDirectory ?? defaultControlDirectory()
  );
  const fingerprint = repositoryCommandFingerprint(config);
  storeAdapter.update((store) => {
    const existing = store[repoPath];
    let fingerprints: string[] = [];
    if (Array.isArray(existing)) {
      fingerprints = existing;
    } else if (typeof existing === "string") {
      fingerprints = [existing];
    }
    return {
      ...store,
      [repoPath]: [...new Set([...fingerprints, fingerprint])],
    };
  });
};

export const revokeRepositoryTrust = (
  repoPath: string,
  controlDirectory?: string
): void => {
  const storeAdapter = new TrustStore(
    controlDirectory ?? defaultControlDirectory()
  );
  storeAdapter.update((store) => {
    Reflect.deleteProperty(store, repoPath);
    return store;
  });
};
