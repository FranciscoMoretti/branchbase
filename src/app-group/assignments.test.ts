import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import pathModule from "node:path";

import { FileBranchBaseStateStore } from "./assignments";
import type { InstanceRequest } from "./assignments";

const COLLISION_SAFE_HOSTNAME = /^web-[a-f0-9]{6}\.main\.chat-js\.localhost$/u;

const request = (
  overrides: Partial<Parameters<FileBranchBaseStateStore["instance"]>[0]> = {}
): InstanceRequest => ({
  configFingerprint: "default-contract",
  groupId: "development",
  mode: "per-worktree" as const,
  repoLabel: "chat-js",
  repoPath: "/code/one/chat-js",
  worktreeLabel: "main",
  worktreePath: "/code/one/chat-js",
  ...overrides,
});

describe("BranchBase local App-group instance state", () => {
  it("rejects structurally invalid persisted state", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const statePath = pathModule.join(directory, "state.json");
      writeFileSync(
        statePath,
        JSON.stringify({
          repositories: {
            [request().repoPath]: {
              id: "repository",
              instances: "not-an-instance-record",
              path: request().repoPath,
              routeLabel: "chat-js",
              worktrees: {},
            },
          },
          version: 2,
        })
      );

      expect(() =>
        new FileBranchBaseStateStore(statePath).instance(request())
      ).toThrow("Invalid BranchBase local state");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("creates one stable instance and Friendly hostname per worktree", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const statePath = pathModule.join(directory, "state.json");
      const firstStore = new FileBranchBaseStateStore(statePath);
      const instance = firstStore.instance(request());
      const first = firstStore.endpoint({
        appId: "web",
        appLabel: "Web",
        groupId: "development",
        instanceId: instance.id,
        repoPath: "/code/one/chat-js",
      });
      const restoredStore = new FileBranchBaseStateStore(statePath);
      const restoredInstance = restoredStore.instance(
        request({ worktreeLabel: "renamed-main" })
      );
      const restored = restoredStore.endpoint({
        appId: "web",
        appLabel: "Renamed Web",
        groupId: "development",
        instanceId: restoredInstance.id,
        repoPath: "/code/one/chat-js",
      });

      expect(restoredInstance.id).toBe(instance.id);
      expect(restored).toEqual(first);
      expect(first.hostname).toBe("web.main.chat-js.localhost");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("shares selectable instances and lets one worktree select a secondary instance", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const store = new FileBranchBaseStateStore(
        pathModule.join(directory, "state.json")
      );
      const mainRequest = request({
        groupId: "services",
        mode: "selectable",
      });
      const featureRequest = request({
        groupId: "services",
        mode: "selectable",
        worktreeLabel: "feature",
        worktreePath: "/code/one/chat-js-feature",
      });
      const shared = store.instance(mainRequest);
      expect(store.instance(featureRequest).id).toBe(shared.id);

      const experiment = store.createSelectableInstance(
        featureRequest,
        "Migration experiment"
      );
      expect(store.instance(featureRequest).id).toBe(experiment.id);
      expect(store.instance(mainRequest).id).toBe(shared.id);
      expect(
        store.instances(
          mainRequest.repoPath,
          "services",
          mainRequest.configFingerprint
        )
      ).toEqual([
        expect.objectContaining({ id: shared.id, name: "Default" }),
        expect.objectContaining({
          id: experiment.id,
          name: "Migration experiment",
        }),
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("isolates selectable instances with incompatible configuration contracts", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const store = new FileBranchBaseStateStore(
        pathModule.join(directory, "state.json")
      );
      const stable = request({
        configFingerprint: "stable-contract",
        groupId: "services",
        mode: "selectable",
      });
      const experiment = request({
        configFingerprint: "experiment-contract",
        groupId: "services",
        mode: "selectable",
      });

      const stableInstance = store.instance(stable);
      const experimentInstance = store.instance(experiment);
      const stableSelection = store.createSelectableInstance(
        stable,
        "Shared data"
      );
      const experimentSelection = store.createSelectableInstance(
        experiment,
        "Shared data"
      );

      expect(experimentInstance.id).not.toBe(stableInstance.id);
      expect(store.instance(stable).id).toBe(stableSelection.id);
      expect(store.instance(experiment).id).toBe(experimentSelection.id);
      expect(
        store.instances(
          stable.repoPath,
          stable.groupId,
          stable.configFingerprint
        )
      ).toContainEqual(expect.objectContaining({ id: stableInstance.id }));
      expect(
        store.instances(
          experiment.repoPath,
          experiment.groupId,
          experiment.configFingerprint
        )
      ).toContainEqual(expect.objectContaining({ id: experimentInstance.id }));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps legacy selectable instances visible, reserved, and selectable", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const statePath = pathModule.join(directory, "state.json");
      const selectable = request({ groupId: "services", mode: "selectable" });
      const store = new FileBranchBaseStateStore(statePath);
      const primary = store.instance(selectable);
      const secondary = store.createSelectableInstance(
        selectable,
        "Legacy data"
      );
      const persisted = JSON.parse(readFileSync(statePath, "utf-8"));
      persisted.repositories[selectable.repoPath].instances[
        primary.id
      ].configFingerprint = "";
      persisted.repositories[selectable.repoPath].instances[
        secondary.id
      ].configFingerprint = "";
      writeFileSync(statePath, JSON.stringify(persisted));

      const restored = new FileBranchBaseStateStore(statePath);
      expect(
        restored
          .instances(
            selectable.repoPath,
            selectable.groupId,
            selectable.configFingerprint
          )
          .map(({ id }) => id)
      ).toEqual([primary.id, secondary.id]);
      expect(() =>
        restored.createSelectableInstance(selectable, "legacy DATA")
      ).toThrow('An instance named "legacy DATA" already exists');
      expect(restored.selectInstance(selectable, secondary.id).id).toBe(
        secondary.id
      );
      expect(restored.instance(selectable).configFingerprint).toBe(
        selectable.configFingerprint
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports persisted runs only for the worktree that owns them", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const store = new FileBranchBaseStateStore(
        pathModule.join(directory, "state.json")
      );
      const main = request();
      const instance = store.instance(main);
      store.saveRun(
        { instanceId: instance.id, repoPath: main.repoPath },
        {
          apps: {},
          createdAt: new Date().toISOString(),
          groupId: main.groupId,
          instanceId: instance.id,
          instanceIdsByGroup: { [main.groupId]: instance.id },
          worktreePath: main.worktreePath,
        }
      );

      expect(store.hasRunForWorktree(main.repoPath, main.worktreePath)).toBe(
        true
      );
      expect(
        store.runningInstancesForWorktree(main.repoPath, main.worktreePath)
      ).toEqual([expect.objectContaining({ id: instance.id })]);
      expect(
        store.hasRunForWorktree(main.repoPath, "/code/one/chat-js-feature")
      ).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reserves the automatic selectable instance name", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const store = new FileBranchBaseStateStore(
        pathModule.join(directory, "state.json")
      );
      const selectable = request({
        groupId: "services",
        mode: "selectable",
      });

      expect(() =>
        store.createSelectableInstance(selectable, "default")
      ).toThrow('Instance name "Default" is reserved');
      expect(store.instance(selectable).name).toBe("Default");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists an automatically assigned port on the instance endpoint", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const statePath = pathModule.join(directory, "state.json");
      const store = new FileBranchBaseStateStore(statePath);
      const instance = store.instance(request());
      store.endpoint({
        appId: "web",
        appLabel: "Web",
        groupId: "development",
        instanceId: instance.id,
        repoPath: request().repoPath,
      });
      store.assignEndpointPort(
        { instanceId: instance.id, repoPath: request().repoPath },
        "web",
        43_127
      );

      const restored = new FileBranchBaseStateStore(statePath).instance(
        request()
      );
      expect(Object.values(restored.endpoints)[0]?.port).toBe(43_127);
      expect(store.leasedPorts()).toEqual(new Set([43_127]));
      const key = { instanceId: instance.id, repoPath: request().repoPath };
      expect(() => store.assignEndpointPort(key, "web", 43_128)).toThrow(
        "stable backing port"
      );
      store.assignEndpointPort(key, "web", 43_128, true);
      expect(store.leasedPorts()).toEqual(new Set([43_128]));
      store.saveRun(key, {
        apps: {},
        createdAt: new Date().toISOString(),
        groupId: request().groupId,
        instanceId: instance.id,
        instanceIdsByGroup: { [request().groupId]: instance.id },
        worktreePath: request().worktreePath,
      });
      expect(() => store.assignEndpointPort(key, "web", 43_129, true)).toThrow(
        "stable backing port"
      );
      expect(store.leasedPorts()).toEqual(new Set([43_128]));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps hostnames unique when per-worktree groups reuse an App label", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const store = new FileBranchBaseStateStore(
        pathModule.join(directory, "state.json")
      );
      const first = store.instance(request({ groupId: "product" }));
      const second = store.instance(request({ groupId: "admin" }));
      const firstEndpoint = store.endpoint({
        appId: "web",
        appLabel: "Web",
        groupId: "product",
        instanceId: first.id,
        repoPath: request().repoPath,
      });
      const secondEndpoint = store.endpoint({
        appId: "web",
        appLabel: "Web",
        groupId: "admin",
        instanceId: second.id,
        repoPath: request().repoPath,
      });

      expect(firstEndpoint.hostname).toBe("web.main.chat-js.localhost");
      expect(secondEndpoint.hostname).not.toBe(firstEndpoint.hostname);
      expect(secondEndpoint.hostname).toMatch(COLLISION_SAFE_HOSTNAME);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists v1 migration before returning generated instance identities", () => {
    const directory = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-state-")
    );
    try {
      const statePath = pathModule.join(directory, "state.json");
      writeFileSync(
        statePath,
        JSON.stringify({
          repositories: {
            [request().repoPath]: {
              id: "repository",
              path: request().repoPath,
              routeLabel: "chat-js",
              worktrees: {
                [request().worktreePath]: {
                  endpoints: {
                    "development\0web": {
                      appId: "web",
                      groupId: "development",
                      hostname: "web.main.chat-js.localhost",
                      id: "endpoint",
                      routeLabel: "web",
                    },
                  },
                  id: "worktree",
                  path: request().worktreePath,
                  routeLabel: "main",
                  runs: {},
                },
              },
            },
          },
          version: 1,
        })
      );

      const store = new FileBranchBaseStateStore(statePath);
      const instance = store.instance(request());
      expect(
        store.endpoint({
          appId: "web",
          appLabel: "Web",
          groupId: "development",
          instanceId: instance.id,
          repoPath: request().repoPath,
        }).hostname
      ).toBe("web.main.chat-js.localhost");
      expect(JSON.parse(readFileSync(statePath, "utf-8")).version).toBe(2);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
