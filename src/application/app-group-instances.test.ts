import { describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import pathModule from "node:path";

import { ProcessSupervisor } from "../adapters/host/process-supervisor";
import type { LocalRoutingEngine } from "../adapters/routing/portless";
import { FileBranchBaseStateStore } from "../app-group/assignments";
import { AppGroupRuntime } from "../app-group/lifecycle";
import type { BranchBaseConfig } from "../configuration/branchbase-schema";
import {
  repositoryCommandFingerprint,
  trustRepository,
} from "../configuration/repository-trust";
import { WorkspaceController } from "./workspace-controller";

type InMemoryRoutingEngine = LocalRoutingEngine & {
  point: (hostname: string, port: number) => void;
  prepared: boolean;
};

const inMemoryRoutingEngine = (): InMemoryRoutingEngine => {
  const routes = new Map<string, number>();
  const routing: InMemoryRoutingEngine = {
    activate: (route) => {
      if (!routing.prepared) {
        throw new Error("Routing activated before preflight");
      }
      routes.set(route.hostname, route.port);
      return Promise.resolve();
    },
    deactivate: (route) => {
      routes.delete(route.hostname);
      return Promise.resolve();
    },
    observe: (route) => {
      const port = routes.get(route.hostname);
      if (port === undefined) {
        return "inactive" as const;
      }
      return port === route.port ? ("active" as const) : ("conflict" as const);
    },
    point: (hostname, port) => {
      routes.set(hostname, port);
    },
    prepare: () => {
      routing.prepared = true;
      return Promise.resolve();
    },
    prepared: false,
    url: (hostname) => `http://${hostname}:1355`,
  };
  return routing;
};

const failingPrepareRoutingEngine = (): InMemoryRoutingEngine => {
  const routing = inMemoryRoutingEngine();
  routing.prepare = () => Promise.reject(new Error("Portless unavailable"));
  return routing;
};

type BlockingPrepareRoutingEngine = InMemoryRoutingEngine & {
  release: () => void;
};

const blockingPrepareRoutingEngine = (): BlockingPrepareRoutingEngine => {
  let released = false;
  let releasePrepare: (() => void) | null = null;
  const routing = inMemoryRoutingEngine() as BlockingPrepareRoutingEngine;
  routing.prepare = () => {
    if (released) {
      routing.prepared = true;
      return Promise.resolve();
    }

    const result: PromiseWithResolvers<void> = Promise.withResolvers();
    releasePrepare = () => result.resolve();
    return result.promise;
  };
  routing.release = () => {
    released = true;
    routing.prepared = true;
    releasePrepare?.();
  };
  return routing;
};

type RecoverableActivationRoutingEngine = InMemoryRoutingEngine & {
  recover: () => void;
};

const recoverableActivationRoutingEngine =
  (): RecoverableActivationRoutingEngine => {
    let failing = true;
    const routing =
      inMemoryRoutingEngine() as RecoverableActivationRoutingEngine;
    const { activate } = routing;
    routing.activate = (route) =>
      failing
        ? Promise.reject(new Error("Portless route activation failed"))
        : activate(route);
    routing.recover = () => {
      failing = false;
    };
    return routing;
  };

const trustedController = (
  runtime: ConstructorParameters<typeof WorkspaceController>[1]
): WorkspaceController => {
  const controller = new WorkspaceController(undefined, runtime);
  spyOn(controller, "assertTrusted").mockImplementation(() => {});
  const configTrustSeam = controller as unknown as {
    assertConfigTrusted: (repoPath: string, config: BranchBaseConfig) => void;
  };
  spyOn(configTrustSeam, "assertConfigTrusted").mockImplementation(() => {});
  return controller;
};

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
};

const createSelectableInstanceFixture = (): {
  controller: WorkspaceController;
  featureWorktree: string;
  repository: string;
  temporary: string;
} => {
  const temporary = mkdtempSync(
    pathModule.join(tmpdir(), "branchbase-instances-")
  );
  const repository = pathModule.join(temporary, "project");
  const featureWorktree = pathModule.join(temporary, "project-feature");
  mkdirSync(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "branchbase@example.test");
  git(repository, "config", "user.name", "BranchBase Test");
  writeFileSync(
    pathModule.join(repository, ".branchbase.json"),
    JSON.stringify({
      appGroups: {
        Apps: {
          apps: { Web: { protocol: "http" } },
          start: { argv: ["true"] },
          stop: "process",
        },
        Services: {
          apps: { Database: { protocol: "tcp" } },
          instances: { mode: "selectable" },
          start: { argv: ["true"] },
          stop: { argv: ["true"] },
        },
      },
      setup: { argv: ["true"] },
      version: 1,
    })
  );
  git(repository, "add", ".branchbase.json");
  git(repository, "commit", "-qm", "test config");
  git(repository, "worktree", "add", "-qb", "feature", featureWorktree);
  const controller = new WorkspaceController(undefined, {
    processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
    routing: inMemoryRoutingEngine(),
    state: new FileBranchBaseStateStore(
      pathModule.join(temporary, "state.json")
    ),
  });
  return { controller, featureWorktree, repository, temporary };
};

const requiredWorktree = (
  snapshot: ReturnType<WorkspaceController["inspect"]>,
  isMain: boolean
) => {
  const worktree = snapshot.worktrees.find((item) => item.isMain === isMain);
  if (!worktree) {
    throw new Error(`Missing ${isMain ? "main" : "feature"} worktree`);
  }
  return worktree;
};

const requiredAppGroup = (
  worktree: ReturnType<typeof requiredWorktree>,
  id: string
) => {
  const group = worktree.appGroups.find((item) => item.id === id);
  if (!group) {
    throw new Error(`Missing App group ${id}`);
  }
  return group;
};

const requiredApp = (
  group: ReturnType<typeof requiredAppGroup>,
  id: string
) => {
  const app = group.apps.find((item) => item.id === id);
  if (!app) {
    throw new Error(`Missing App ${id}`);
  }
  return app;
};

const listenerPort = (server: Server): number => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test listener did not expose a TCP port");
  }
  return address.port;
};

const requiredRun = (
  state: FileBranchBaseStateStore,
  key: { instanceId: string; repoPath: string }
) => {
  const run = state.run(key);
  if (!run) {
    throw new Error("Expected a persisted App-group run");
  }
  return run;
};

const requiredDatabaseEndpoint = (run: ReturnType<typeof requiredRun>) => {
  const database = run.apps.Database;
  if (!database) {
    throw new Error("Expected a persisted Database endpoint");
  }
  return database;
};

const createCrossGroupFixture = (): {
  controller: WorkspaceController;
  repository: string;
  routing: InMemoryRoutingEngine;
  temporary: string;
  worktreeId: string;
} => {
  const temporary = mkdtempSync(
    pathModule.join(tmpdir(), "branchbase-runtime-")
  );
  const repository = pathModule.join(temporary, "project");
  mkdirSync(repository);
  git(repository, "init", "-q");
  writeFileSync(
    pathModule.join(repository, ".branchbase.json"),
    JSON.stringify({
      appGroups: {
        Apps: {
          apps: {
            Slow: {
              protocol: "http",
              readiness: {
                path: "/",
                statuses: "200-399",
                timeoutSeconds: 1,
                type: "http",
              },
            },
            Web: {
              portFromEnv: { file: ".env.instance", variable: "WEB_PORT" },
              protocol: "http",
            },
          },
          env: {
            DATABASE_PORT: "{appGroups.Services.apps.Database.port}",
            SLOW_PORT: "{apps.Slow.port}",
            WEB_PORT: "{apps.Web.port}",
          },
          start: {
            argv: [
              "bun",
              "-e",
              "const fs=require('node:fs');const http=require('node:http');fs.writeFileSync('resolved-env.txt',process.env.DATABASE_PORT+'\\n'+process.env.WEB_PORT);http.createServer((_request,response)=>response.end('ok')).listen(Number(process.env.WEB_PORT),'127.0.0.1')",
            ],
          },
          stop: "process",
        },
        Services: {
          apps: { Database: { protocol: "tcp" } },
          instances: { mode: "selectable" },
          start: { argv: ["true"] },
          stop: { argv: ["true"] },
        },
      },
      setup: { argv: ["true"] },
      version: 1,
    })
  );
  const routing = inMemoryRoutingEngine();
  const controller = trustedController({
    processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
    routing,
    state: new FileBranchBaseStateStore(
      pathModule.join(temporary, "state.json")
    ),
  });
  const worktreeId = requiredWorktree(controller.inspect(repository), true).id;
  return { controller, repository, routing, temporary, worktreeId };
};

const close = async (server: Server): Promise<void> => {
  if (!server.listening) {
    return;
  }
  const closed = once(server, "close");
  server.close();
  await closed;
};

const cleanupCrossGroupFixture = async (fixture: {
  blocker: Server | null;
  controller: WorkspaceController;
  repository: string;
  temporary: string;
  worktreeId: string;
}): Promise<void> => {
  if (fixture.blocker) {
    try {
      await close(fixture.blocker);
    } catch {
      // Fixture cleanup is best effort.
    }
  }
  try {
    await fixture.controller.stopAppGroup(
      fixture.repository,
      fixture.worktreeId,
      "Apps"
    );
  } catch {
    // Fixture cleanup is best effort.
  }
  rmSync(fixture.temporary, { force: true, recursive: true });
};

const listen = async (server: Server, port: number): Promise<void> => {
  const listening = once(server, "listening");
  server.listen(port, "127.0.0.1");
  await listening;
};

describe("App-group instance assignment", () => {
  it("uses an approved captured Stop command for a detached run", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-cleanup-stop-")
    );
    try {
      const controlDirectory = pathModule.join(temporary, "control");
      const marker = pathModule.join(temporary, "stopped");
      const config = {
        appGroups: {
          Services: {
            apps: {
              Dummy: { protocol: "tcp" as const, readiness: "tcp" as const },
            },
            instances: { mode: "per-worktree" as const },
            start: { argv: ["true"] },
            stop: { argv: ["true"] },
          },
        },
        setup: { argv: ["true"] },
        version: 1 as const,
      };
      const state = new FileBranchBaseStateStore(
        pathModule.join(temporary, "state.json")
      );
      const instance = state.instance({
        configFingerprint: repositoryCommandFingerprint(config),
        groupId: "Services",
        mode: "per-worktree",
        repoLabel: "project",
        repoPath: temporary,
        worktreeLabel: "main",
        worktreePath: temporary,
      });
      state.saveRun(
        { instanceId: instance.id, repoPath: temporary },
        {
          apps: {
            Dummy: {
              appId: "Dummy",
              host: "127.0.0.1",
              port: 65_534,
              protocol: "tcp",
            },
          },
          createdAt: new Date().toISOString(),
          groupId: "Services",
          instanceId: instance.id,
          instanceIdsByGroup: { Services: instance.id },
          stop: {
            argv: [
              "bun",
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "stopped")`,
            ],
            env: {},
          },
          worktreePath: temporary,
        }
      );
      trustRepository(temporary, config, controlDirectory);
      const runtime = new AppGroupRuntime(
        new ProcessSupervisor(controlDirectory),
        inMemoryRoutingEngine(),
        state
      );

      await runtime.stopConfiguredOrDetached(
        temporary,
        temporary,
        `cleanup:${instance.id}`
      );

      expect(readFileSync(marker, "utf-8")).toBe("stopped");
      expect(state.run({ instanceId: instance.id, repoPath: temporary })).toBe(
        null
      );
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("stops detached cleanup through the command boundary when config is malformed", async () => {
    const temporary = realpathSync(
      mkdtempSync(pathModule.join(tmpdir(), "branchbase-cleanup-command-"))
    );
    try {
      const repository = pathModule.join(temporary, "repo");
      mkdirSync(repository);
      git(repository, "init", "-q");
      git(repository, "config", "user.email", "branchbase@example.test");
      git(repository, "config", "user.name", "BranchBase Test");
      const marker = pathModule.join(temporary, "stopped");
      const config = {
        appGroups: {
          Services: {
            apps: {
              Dummy: { protocol: "tcp" as const, readiness: "tcp" as const },
            },
            instances: { mode: "per-worktree" as const },
            start: { argv: ["true"] },
            stop: { argv: ["true"] },
          },
        },
        setup: { argv: ["true"] },
        version: 1 as const,
      };
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        JSON.stringify(config)
      );
      git(repository, "add", ".branchbase.json");
      git(repository, "commit", "-qm", "test config");
      const state = new FileBranchBaseStateStore(
        pathModule.join(temporary, "state.json")
      );
      const controller = trustedController({
        processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
        routing: inMemoryRoutingEngine(),
        state,
      });
      const [worktree] = controller.inspect(repository).worktrees;
      if (!worktree) {
        throw new Error("Missing test worktree");
      }
      const instance = state.instanceLookup({
        configFingerprint: repositoryCommandFingerprint(config),
        groupId: "Services",
        mode: "per-worktree",
        repoLabel: "repo",
        repoPath: repository,
        worktreeLabel: worktree.branch,
        worktreePath: repository,
      });
      if (!instance) {
        throw new Error("Missing test instance");
      }
      state.saveRun(
        { instanceId: instance.id, repoPath: repository },
        {
          apps: {
            Dummy: {
              appId: "Dummy",
              host: "127.0.0.1",
              port: 65_534,
              protocol: "tcp",
            },
          },
          createdAt: new Date().toISOString(),
          groupId: "Services",
          instanceId: instance.id,
          instanceIdsByGroup: { Services: instance.id },
          stop: {
            argv: [
              "bun",
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "stopped")`,
            ],
            env: {},
          },
          worktreePath: repository,
        }
      );
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        "{ malformed"
      );

      const result = await controller.execute("stop-apps", {
        appGroupName: `cleanup:${instance.id}`,
        repoPath: repository,
        worktreeId: worktree.id,
      });
      expect(result.ok).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(state.run({ instanceId: instance.id, repoPath: repository })).toBe(
        null
      );
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("exposes in-flight lifecycle work before a run is persisted", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-pending-start-")
    );
    const processes = new ProcessSupervisor(
      pathModule.join(temporary, "control")
    );
    try {
      const routing = blockingPrepareRoutingEngine();
      const runtime = new AppGroupRuntime(
        processes,
        routing,
        new FileBranchBaseStateStore(pathModule.join(temporary, "state.json"))
      );
      const target = {
        config: {
          appGroups: {
            Apps: {
              apps: {},
              instances: { mode: "per-worktree" as const },
              start: {
                argv: [process.execPath, "-e", "setInterval(Boolean, 1000)"],
              },
              stop: "process" as const,
            },
          },
          setup: { argv: ["true"] },
          version: 1 as const,
        },
        groupId: "Apps",
        repoPath: temporary,
        worktree: { id: "main", path: temporary, routeLabel: "main" },
      };

      const started = runtime.start(target);
      expect(runtime.hasPendingLifecycle(temporary)).toBe(true);
      expect(runtime.inspect(target, { pidsByPort: new Map() }).pending).toBe(
        true
      );
      routing.release();
      await started;
      expect(runtime.hasPendingLifecycle(temporary)).toBe(false);
      expect(runtime.inspect(target, { pidsByPort: new Map() }).pending).toBe(
        false
      );
    } finally {
      await Promise.all(
        processes
          .listManagedProcesses()
          .map((item) => processes.stopManagedProcess(item.ownerId, temporary))
      );
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("shares selectable defaults and lets one worktree switch to an isolated instance", () => {
    const { controller, repository, temporary } =
      createSelectableInstanceFixture();
    try {
      const initial = controller.inspect(repository);
      const main = requiredWorktree(initial, true);
      const feature = requiredWorktree(initial, false);
      const mainApps = requiredAppGroup(main, "Apps");
      const featureApps = requiredAppGroup(feature, "Apps");
      expect(mainApps.instance.mode).toBe("per-worktree");
      expect(mainApps.instance.id).not.toBe(featureApps.instance.id);

      const mainServices = requiredAppGroup(main, "Services");
      const featureServices = requiredAppGroup(feature, "Services");
      expect(mainServices.instance.name).toBe("Default");
      expect(mainServices.instance.id).toBe(featureServices.instance.id);

      controller.createAppGroupInstance(
        repository,
        feature.id,
        "Services",
        "Migration experiment"
      );
      const isolated = controller.inspect(repository);
      const isolatedMain = requiredAppGroup(
        requiredWorktree(isolated, true),
        "Services"
      );
      const isolatedFeature = requiredAppGroup(
        requiredWorktree(isolated, false),
        "Services"
      );

      expect(isolatedMain.instance.name).toBe("Default");
      expect(isolatedFeature.instance.name).toBe("Migration experiment");
      expect(
        isolatedFeature.instances.map((instance) => instance.name)
      ).toEqual(["Default", "Migration experiment"]);

      controller.selectAppGroupInstance(
        repository,
        feature.id,
        "Services",
        isolatedMain.instance.id
      );
      const sharedAgain = controller.inspect(repository);
      expect(
        requiredAppGroup(requiredWorktree(sharedAgain, false), "Services")
          .instance.id
      ).toBe(isolatedMain.instance.id);
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("serializes concurrent Starts of a shared instance across worktrees", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-shared-start-")
    );
    const repository = pathModule.join(temporary, "project");
    const featureWorktree = pathModule.join(temporary, "project-feature");
    mkdirSync(repository);
    let controller: WorkspaceController | null = null;
    let mainId = "";
    let featureId = "";
    try {
      git(repository, "init", "-q");
      git(repository, "config", "user.email", "branchbase@example.test");
      git(repository, "config", "user.name", "BranchBase Test");
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        JSON.stringify({
          appGroups: {
            Services: {
              apps: { Service: { protocol: "tcp" } },
              env: { SERVICE_PORT: "{apps.Service.port}" },
              instances: { mode: "selectable" },
              start: {
                argv: [
                  "bun",
                  "-e",
                  "require('node:net').createServer().listen(Number(process.env.SERVICE_PORT),'127.0.0.1')",
                ],
              },
              stop: "process",
            },
          },
          setup: { argv: ["true"] },
          version: 1,
        })
      );
      git(repository, "add", ".branchbase.json");
      git(repository, "commit", "-qm", "test config");
      git(repository, "worktree", "add", "-qb", "feature", featureWorktree);

      controller = trustedController({
        processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
        routing: inMemoryRoutingEngine(),
        state: new FileBranchBaseStateStore(
          pathModule.join(temporary, "state.json")
        ),
      });
      const initial = controller.inspect(repository);
      mainId = initial.worktrees.find((worktree) => worktree.isMain)?.id ?? "";
      featureId =
        initial.worktrees.find((worktree) => !worktree.isMain)?.id ?? "";
      const instanceIds = initial.worktrees.map(
        (worktree) => worktree.appGroups[0]?.instance.id
      );
      expect(new Set(instanceIds).size).toBe(1);

      const results = await Promise.all([
        controller.startAppGroup(repository, mainId, "Services"),
        controller.startAppGroup(repository, featureId, "Services"),
      ]);
      expect(results.toSorted()).toEqual(["already-running", "started"]);
      const running = controller.inspect(repository);
      expect(running.globalRunningCount).toBe(1);
      expect(
        running.worktrees.every(
          (worktree) => worktree.appGroups[0]?.health === "running"
        )
      ).toBe(true);
    } finally {
      if (controller && mainId) {
        await controller
          .stopAppGroup(repository, mainId, "Services")
          .catch(() => {});
      }
      rmSync(temporary, { force: true, recursive: true });
    }
  }, 10_000);

  it("retains a file-configured port across restart and changes it only after Stop", async () => {
    const { controller, repository, temporary, worktreeId } =
      createCrossGroupFixture();
    const reservation = createServer();
    await listen(reservation, 0);
    const port = listenerPort(reservation);
    await close(reservation);
    writeFileSync(
      pathModule.join(repository, ".env.instance"),
      `WEB_PORT=${port}\n`
    );
    try {
      await controller.startAppGroup(repository, worktreeId, "Apps");
      const apps = requiredAppGroup(
        requiredWorktree(controller.inspect(repository), true),
        "Apps"
      );
      expect(requiredApp(apps, "Web").port).toBe(port);
      const friendlyUrl = requiredApp(apps, "Web").url;
      expect(friendlyUrl).toBeString();
      const response = await fetch(`http://127.0.0.1:${port}`);
      expect(response.status).toBe(200);
      await controller.stopAppGroup(repository, worktreeId, "Apps");
      await controller.startAppGroup(repository, worktreeId, "Apps");
      expect(
        requiredApp(
          requiredAppGroup(
            requiredWorktree(controller.inspect(repository), true),
            "Apps"
          ),
          "Web"
        ).port
      ).toBe(port);
      const nextReservation = createServer();
      await listen(nextReservation, 0);
      const nextPort = listenerPort(nextReservation);
      await close(nextReservation);
      writeFileSync(
        pathModule.join(repository, ".env.instance"),
        `WEB_PORT=${nextPort}\n`
      );
      await expect(
        controller.startAppGroup(repository, worktreeId, "Apps")
      ).rejects.toThrow(
        "Stop Apps before changing the configured port for Web"
      );
      const runningResponse = await fetch(`http://127.0.0.1:${port}`);
      expect(runningResponse.status).toBe(200);
      await controller.stopAppGroup(repository, worktreeId, "Apps");
      await controller.startAppGroup(repository, worktreeId, "Apps");
      expect(
        requiredApp(
          requiredAppGroup(
            requiredWorktree(controller.inspect(repository), true),
            "Apps"
          ),
          "Web"
        ).port
      ).toBe(nextPort);
      expect(
        requiredApp(
          requiredAppGroup(
            requiredWorktree(controller.inspect(repository), true),
            "Apps"
          ),
          "Web"
        ).url
      ).toBe(friendlyUrl);
      const nextResponse = await fetch(`http://127.0.0.1:${nextPort}`);
      expect(nextResponse.status).toBe(200);
    } finally {
      await controller.stopAppGroup(repository, worktreeId, "Apps");
      await controller.close();
      rmSync(temporary, { force: true, recursive: true });
    }
  }, 20_000);

  it("rejects an occupied file-configured port before executing Start", async () => {
    const { controller, repository, temporary, worktreeId } =
      createCrossGroupFixture();
    const blocker = createServer();
    await listen(blocker, 0);
    const port = listenerPort(blocker);
    writeFileSync(
      pathModule.join(repository, ".env.instance"),
      `WEB_PORT=${port}\n`
    );
    try {
      await expect(
        controller.startAppGroup(repository, worktreeId, "Apps")
      ).rejects.toThrow();
      expect(existsSync(pathModule.join(repository, "resolved-env.txt"))).toBe(
        false
      );
      expect(
        requiredApp(
          requiredAppGroup(
            requiredWorktree(controller.inspect(repository), true),
            "Apps"
          ),
          "Web"
        ).port
      ).toBeNull();
      expect(blocker.listening).toBe(true);
    } finally {
      await close(blocker);
      await controller.close();
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("uses each worktree's dotenv port with inherited project configuration", async () => {
    const { controller, repository, temporary, worktreeId } =
      createCrossGroupFixture();
    git(repository, "config", "user.email", "branchbase@example.test");
    git(repository, "config", "user.name", "BranchBase Test");
    git(repository, "add", ".branchbase.json");
    git(repository, "commit", "-qm", "test config");
    const featurePath = pathModule.join(temporary, "feature");
    git(repository, "worktree", "add", "-qb", "feature", featurePath);
    const reservations = [createServer(), createServer()];
    await Promise.all(reservations.map((server) => listen(server, 0)));
    const [mainPort, featurePort] = reservations.map(listenerPort);
    await Promise.all(reservations.map(close));
    writeFileSync(
      pathModule.join(repository, ".env.instance"),
      `WEB_PORT=${mainPort}\n`
    );
    writeFileSync(
      pathModule.join(featurePath, ".env.instance"),
      `WEB_PORT=${featurePort}\n`
    );
    const feature = requiredWorktree(controller.inspect(repository), false);
    try {
      expect(feature.configuration.source).toBe("project-default");
      await controller.startAppGroup(repository, worktreeId, "Apps");
      await controller.startAppGroup(repository, feature.id, "Apps");
      const snapshot = controller.inspect(repository);
      const mainApp = requiredApp(
        requiredAppGroup(requiredWorktree(snapshot, true), "Apps"),
        "Web"
      );
      const featureApp = requiredApp(
        requiredAppGroup(requiredWorktree(snapshot, false), "Apps"),
        "Web"
      );
      expect(mainApp.port).toBe(mainPort);
      expect(featureApp.port).toBe(featurePort);
      expect(mainApp.url).not.toBe(featureApp.url);
      const responses = await Promise.all([
        fetch(`http://127.0.0.1:${mainPort}`),
        fetch(`http://127.0.0.1:${featurePort}`),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
    } finally {
      await controller.stopAppGroup(repository, worktreeId, "Apps");
      await controller.stopAppGroup(repository, feature.id, "Apps");
      await controller.close();
      rmSync(temporary, { force: true, recursive: true });
    }
  }, 20_000);

  it("materializes cross-group ports before Start and keeps them stable across Restart", async () => {
    const fixture = createCrossGroupFixture();
    const { controller, repository, routing, temporary, worktreeId } = fixture;
    let blocker: Server | null = null;
    try {
      expect(
        await controller.startAppGroup(repository, worktreeId, "Apps")
      ).toBe("started");
      expect(routing.prepared).toBe(true);
      const running = requiredWorktree(controller.inspect(repository), true);
      const apps = requiredAppGroup(running, "Apps");
      const services = requiredAppGroup(running, "Services");
      expect(apps.run).toEqual({
        startedAt: expect.any(String),
        worktreePath: running.path,
      });
      expect(apps.dependencies).toEqual([
        {
          groupId: "Services",
          instanceId: services.instance.id,
          name: services.instance.name,
        },
      ]);
      expect(apps.health).toBe("partially-running");
      const webPort = requiredApp(apps, "Web").port;
      const databasePort = requiredApp(services, "Database").port;
      expect(webPort).toBeNumber();
      expect(databasePort).toBeNumber();
      expect(
        readFileSync(
          pathModule.join(repository, "resolved-env.txt"),
          "utf-8"
        ).split("\n")
      ).toEqual([String(databasePort), String(webPort)]);

      blocker = createServer();
      await listen(blocker, databasePort as number);
      await expect(
        controller.startAppGroup(repository, worktreeId, "Services")
      ).rejects.toThrow("occupied by an unrelated process");
      await close(blocker);
      blocker = null;

      expect(
        await controller.stopAppGroup(repository, worktreeId, "Apps")
      ).toBe("stopped");
      const stoppedPort = requiredApp(
        requiredAppGroup(
          requiredWorktree(controller.inspect(repository), true),
          "Apps"
        ),
        "Web"
      ).port;
      expect(stoppedPort).toBe(webPort);

      expect(
        await controller.startAppGroup(repository, worktreeId, "Apps")
      ).toBe("started");
      expect(
        requiredApp(
          requiredAppGroup(
            requiredWorktree(controller.inspect(repository), true),
            "Apps"
          ),
          "Web"
        ).port
      ).toBe(webPort);

      const webHostname = new URL(
        requiredApp(
          requiredAppGroup(
            requiredWorktree(controller.inspect(repository), true),
            "Apps"
          ),
          "Web"
        ).url ?? ""
      ).hostname;
      routing.point(webHostname, (webPort as number) + 1);
      await expect(
        controller.stopAppGroup(repository, worktreeId, "Apps")
      ).rejects.toThrow("points to a different Backing endpoint");
      routing.point(webHostname, webPort as number);
      expect(
        await controller.stopAppGroup(repository, worktreeId, "Apps")
      ).toBe("stopped");
    } finally {
      await cleanupCrossGroupFixture({
        blocker,
        controller,
        repository,
        temporary,
        worktreeId,
      });
    }
  }, 15_000);

  it("fails Portless preflight before executing repository code", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-preflight-")
    );
    const repository = pathModule.join(temporary, "project");
    mkdirSync(repository);
    try {
      git(repository, "init", "-q");
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        JSON.stringify({
          appGroups: {
            Apps: {
              apps: { Web: { protocol: "http" } },
              start: {
                argv: [
                  "bun",
                  "-e",
                  "require('node:fs').writeFileSync('started.txt','yes')",
                ],
              },
              stop: "process",
            },
          },
          setup: { argv: ["true"] },
          version: 1,
        })
      );
      const controller = trustedController({
        processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
        routing: failingPrepareRoutingEngine(),
        state: new FileBranchBaseStateStore(
          pathModule.join(temporary, "state.json")
        ),
      });
      const id = controller.inspect(repository).worktrees[0]?.id ?? "";

      await expect(
        controller.startAppGroup(repository, id, "Apps")
      ).rejects.toMatchObject({
        code: "routing-unavailable",
        message: "Portless unavailable",
      });
      expect(existsSync(pathModule.join(repository, "started.txt"))).toBe(
        false
      );
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("reports a stable code when the Start command cannot launch", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-start-failure-")
    );
    const repository = pathModule.join(temporary, "project");
    mkdirSync(repository);
    try {
      git(repository, "init", "-q");
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        JSON.stringify({
          appGroups: {
            Apps: {
              apps: { Api: { protocol: "tcp" } },
              start: { argv: [`missing-branchbase-command-${process.pid}`] },
              stop: "process",
            },
          },
          setup: { argv: ["true"] },
          version: 1,
        })
      );
      const controller = trustedController({
        processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
        routing: inMemoryRoutingEngine(),
        state: new FileBranchBaseStateStore(
          pathModule.join(temporary, "state.json")
        ),
      });
      const id = controller.inspect(repository).worktrees[0]?.id ?? "";

      await expect(
        controller.startAppGroup(repository, id, "Apps")
      ).rejects.toMatchObject({ code: "start-failed" });
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("keeps a ready process available for diagnostics when routing fails", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-routing-")
    );
    const repository = pathModule.join(temporary, "project");
    mkdirSync(repository);
    let controller: WorkspaceController | null = null;
    let worktreeId = "";
    try {
      git(repository, "init", "-q");
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        JSON.stringify({
          appGroups: {
            Apps: {
              apps: { Web: { protocol: "http" } },
              env: { WEB_PORT: "{apps.Web.port}" },
              start: {
                argv: [
                  "bun",
                  "-e",
                  "require('node:http').createServer((_request,response)=>response.end('ok')).listen(Number(process.env.WEB_PORT),'127.0.0.1')",
                ],
              },
              stop: "process",
            },
          },
          setup: { argv: ["true"] },
          version: 1,
        })
      );
      const routing = recoverableActivationRoutingEngine();
      controller = trustedController({
        processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
        routing,
        state: new FileBranchBaseStateStore(
          pathModule.join(temporary, "state.json")
        ),
      });
      worktreeId = controller.inspect(repository).worktrees[0]?.id ?? "";

      await expect(
        controller.startAppGroup(repository, worktreeId, "Apps")
      ).rejects.toThrow("Portless route activation failed");
      const endpoint = controller
        .inspect(repository)
        .worktrees[0]?.appGroups.find((group) => group.id === "Apps")
        ?.apps.find((app) => app.id === "Web");
      expect(endpoint?.readiness).toBe("ready");
      expect(endpoint?.routeState).toBe("unavailable");
      expect(endpoint?.directUrl).toStartWith("http://127.0.0.1:");
      expect(endpoint?.open).toBe(false);

      routing.recover();
      expect(
        await controller.startAppGroup(repository, worktreeId, "Apps")
      ).toBe("started");
      const recovered = controller
        .inspect(repository)
        .worktrees[0]?.appGroups.find((group) => group.id === "Apps")
        ?.apps.find((app) => app.id === "Web");
      expect(recovered?.routeState).toBe("active");
      expect(recovered?.open).toBe(true);
    } finally {
      if (controller && worktreeId) {
        await controller
          .stopAppGroup(repository, worktreeId, "Apps")
          .catch(() => {});
      }
      rmSync(temporary, { force: true, recursive: true });
    }
  }, 10_000);

  it("retries readiness for a sibling that already owns its backing port", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-readiness-")
    );
    const repository = pathModule.join(temporary, "project");
    mkdirSync(repository);
    let controller: WorkspaceController | null = null;
    let worktreeId = "";
    try {
      git(repository, "init", "-q");
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        JSON.stringify({
          appGroups: {
            Apps: {
              apps: {
                Delayed: {
                  protocol: "http",
                  readiness: {
                    path: "/",
                    statuses: "200-399",
                    timeoutSeconds: 1,
                    type: "http",
                  },
                },
                Web: { protocol: "http" },
              },
              env: {
                DELAYED_PORT: "{apps.Delayed.port}",
                WEB_PORT: "{apps.Web.port}",
              },
              start: {
                argv: [
                  "bun",
                  "-e",
                  "const fs=require('node:fs');const http=require('node:http');http.createServer((_request,response)=>response.end('ok')).listen(Number(process.env.WEB_PORT),'127.0.0.1');http.createServer((_request,response)=>(response.statusCode=fs.existsSync('delayed-ready')?200:503,response.end('status'))).listen(Number(process.env.DELAYED_PORT),'127.0.0.1')",
                ],
              },
              stop: "process",
            },
          },
          setup: { argv: ["true"] },
          version: 1,
        })
      );
      controller = trustedController({
        processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
        routing: inMemoryRoutingEngine(),
        state: new FileBranchBaseStateStore(
          pathModule.join(temporary, "state.json")
        ),
      });
      worktreeId = controller.inspect(repository).worktrees[0]?.id ?? "";

      expect(
        await controller.startAppGroup(repository, worktreeId, "Apps")
      ).toBe("started");
      expect(
        controller.inspect(repository).worktrees[0]?.appGroups[0]?.health
      ).toBe("partially-running");

      writeFileSync(pathModule.join(repository, "delayed-ready"), "yes");
      expect(
        await controller.startAppGroup(repository, worktreeId, "Apps")
      ).toBe("started");
      const recovered =
        controller.inspect(repository).worktrees[0]?.appGroups[0];
      expect(recovered?.health).toBe("running");
      expect(recovered?.apps.every((app) => app.routeState === "active")).toBe(
        true
      );
    } finally {
      if (controller && worktreeId) {
        await controller
          .stopAppGroup(repository, worktreeId, "Apps")
          .catch(() => {});
      }
      rmSync(temporary, { force: true, recursive: true });
    }
  }, 10_000);

  it("keeps an all-unready command App group stoppable and retryable", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-unready-command-")
    );
    const repository = pathModule.join(temporary, "project");
    mkdirSync(repository);
    let controller: WorkspaceController | null = null;
    let worktreeId = "";
    try {
      git(repository, "init", "-q");
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        JSON.stringify({
          appGroups: {
            Services: {
              apps: {
                Service: {
                  protocol: "http",
                  readiness: {
                    path: "/",
                    statuses: "200-399",
                    timeoutSeconds: 1,
                    type: "http",
                  },
                },
              },
              env: { SERVICE_PORT: "{apps.Service.port}" },
              start: {
                argv: [
                  "bun",
                  "-e",
                  "const fs=require('node:fs');fs.writeFileSync('start-count',String(Number(fs.existsSync('start-count')?fs.readFileSync('start-count','utf8'):0)+1));require('node:http').createServer((_request,response)=>(response.statusCode=fs.existsSync('service-ready')?200:503,response.end('status'))).listen(Number(process.env.SERVICE_PORT),'127.0.0.1')",
                ],
              },
              stop: { argv: ["true"] },
            },
          },
          setup: { argv: ["true"] },
          version: 1,
        })
      );
      controller = trustedController({
        processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
        routing: inMemoryRoutingEngine(),
        state: new FileBranchBaseStateStore(
          pathModule.join(temporary, "state.json")
        ),
      });
      worktreeId = controller.inspect(repository).worktrees[0]?.id ?? "";

      await expect(
        controller.startAppGroup(repository, worktreeId, "Services")
      ).rejects.toThrow();
      const unready = controller.inspect(repository).worktrees[0]?.appGroups[0];
      expect(unready?.health).toBe("partially-running");
      expect(unready?.apps[0]?.listening).toBe(true);
      expect(unready?.instances[0]?.running).toBe(true);
      expect(
        readFileSync(pathModule.join(repository, "start-count"), "utf-8")
      ).toBe("1");

      writeFileSync(pathModule.join(repository, "service-ready"), "yes");
      expect(
        await controller.retryAppGroup(repository, worktreeId, "Services")
      ).toBe("retried");
      expect(
        controller.inspect(repository).worktrees[0]?.appGroups[0]?.health
      ).toBe("running");
      expect(
        readFileSync(pathModule.join(repository, "start-count"), "utf-8")
      ).toBe("1");
    } finally {
      if (controller && worktreeId) {
        await controller
          .stopAppGroup(repository, worktreeId, "Services")
          .catch(() => {});
      }
      rmSync(temporary, { force: true, recursive: true });
    }
  }, 10_000);

  it("requires a durable ownership claim for a command listener", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-ownership-")
    );
    const repository = pathModule.join(temporary, "project");
    mkdirSync(repository);
    const listener = createServer();
    try {
      git(repository, "init", "-q");
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        JSON.stringify({
          appGroups: {
            Services: {
              apps: { Database: { protocol: "tcp" } },
              instances: { mode: "selectable" },
              start: { argv: ["true"] },
              stop: { argv: ["true"] },
            },
          },
          setup: { argv: ["true"] },
          version: 1,
        })
      );
      const state = new FileBranchBaseStateStore(
        pathModule.join(temporary, "state.json")
      );
      const controller = trustedController({
        processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
        routing: inMemoryRoutingEngine(),
        state,
      });
      const initial = controller.inspect(repository);
      const worktree = requiredWorktree(initial, true);
      const group = requiredAppGroup(worktree, "Services");
      await listen(listener, 0);
      const port = listenerPort(listener);
      const key = {
        instanceId: group.instance.id,
        repoPath: initial.repoPath,
      };
      state.assignEndpointPort(key, "Database", port);
      state.saveRun(key, {
        apps: {
          Database: {
            appId: "Database",
            host: "127.0.0.1",
            port,
            protocol: "tcp",
          },
        },
        createdAt: new Date().toISOString(),
        groupId: "Services",
        instanceId: key.instanceId,
        instanceIdsByGroup: { Services: key.instanceId },
        worktreePath: worktree.path,
      });

      const inspected = requiredAppGroup(
        requiredWorktree(controller.inspect(repository), true),
        "Services"
      );
      const inspectedApp = requiredApp(inspected, "Database");
      expect(inspectedApp.listening).toBe(false);
      expect(inspectedApp.ownership).toBe("foreign");
      expect(inspectedApp.readiness).toBe("unready");
      expect(inspected.health).toBe("not-running");
      expect(inspected.instances[0]?.running).toBe(false);

      const claimedRun = requiredRun(state, key);
      const database = requiredDatabaseEndpoint(claimedRun);
      database.listenerClaimed = true;
      state.saveRun(key, claimedRun);

      const replacedListener = requiredAppGroup(
        requiredWorktree(controller.inspect(repository), true),
        "Services"
      );
      const replacedApp = requiredApp(replacedListener, "Database");
      expect(replacedApp.listening).toBe(true);
      expect(replacedApp.ownership).toBe("owned");
      expect(replacedListener.health).toBe("running");
    } finally {
      await close(listener).catch(() => {});
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("stops a shared instance with its captured Start environment", async () => {
    const temporary = mkdtempSync(
      pathModule.join(tmpdir(), "branchbase-shared-stop-")
    );
    const repository = pathModule.join(temporary, "project");
    const featureWorktree = pathModule.join(temporary, "project-feature");
    mkdirSync(repository);
    let controller: WorkspaceController | null = null;
    let featureId = "";
    try {
      git(repository, "init", "-q");
      git(repository, "config", "user.email", "branchbase@example.test");
      git(repository, "config", "user.name", "BranchBase Test");
      writeFileSync(
        pathModule.join(repository, ".branchbase.json"),
        JSON.stringify({
          appGroups: {
            Apps: {
              apps: { Web: { protocol: "http" } },
              start: { argv: ["true"] },
              stop: "process",
            },
            Services: {
              apps: { Database: { protocol: "tcp" } },
              env: {
                DB_PORT: "{apps.Database.port}",
                PRODUCT_PORT: "{appGroups.Apps.apps.Web.port}",
              },
              instances: { mode: "selectable" },
              start: {
                argv: [
                  "bun",
                  "-e",
                  "require('node:net').createServer().listen(Number(process.env.DB_PORT),'127.0.0.1')",
                ],
              },
              stop: {
                argv: [
                  "bun",
                  "-e",
                  "require('node:fs').writeFileSync('stopped-with-port.txt',process.env.PRODUCT_PORT)",
                ],
              },
            },
          },
          setup: { argv: ["true"] },
          version: 1,
        })
      );
      git(repository, "add", ".branchbase.json");
      git(repository, "commit", "-qm", "test config");
      git(repository, "worktree", "add", "-qb", "feature", featureWorktree);

      controller = trustedController({
        processes: new ProcessSupervisor(pathModule.join(temporary, "control")),
        routing: inMemoryRoutingEngine(),
        state: new FileBranchBaseStateStore(
          pathModule.join(temporary, "state.json")
        ),
      });
      const initial = controller.inspect(repository);
      const main = initial.worktrees.find((worktree) => worktree.isMain);
      const feature = initial.worktrees.find((worktree) => !worktree.isMain);
      featureId = feature?.id ?? "";

      await controller.startAppGroup(repository, main?.id ?? "", "Services");
      const mainProductPort = controller
        .inspect(repository)
        .worktrees.find((worktree) => worktree.isMain)
        ?.appGroups.find((group) => group.id === "Apps")
        ?.apps.find((app) => app.id === "Web")?.port;
      expect(mainProductPort).toBeNumber();

      await controller.stopAppGroup(repository, featureId, "Services");
      expect(
        readFileSync(
          pathModule.join(repository, "stopped-with-port.txt"),
          "utf-8"
        )
      ).toBe(String(mainProductPort));
    } finally {
      if (controller && featureId) {
        await controller
          .stopAppGroup(repository, featureId, "Services")
          .catch(() => {});
      }
      rmSync(temporary, { force: true, recursive: true });
    }
  }, 15_000);

  it("reconciles identity without allocating ports and keeps inspection read-only", () => {
    const fixture = createSelectableInstanceFixture();
    try {
      const statePath = pathModule.join(fixture.temporary, "state.json");
      const first = fixture.controller.inspect(fixture.repository);
      const afterFirst = readFileSync(statePath, "utf-8");
      const second = fixture.controller.inspect(fixture.repository);
      const afterSecond = readFileSync(statePath, "utf-8");
      expect(afterSecond).toBe(afterFirst);
      expect(
        second.worktrees.map((item) =>
          item.appGroups.map((group) => group.instance.id)
        )
      ).toEqual(
        first.worktrees.map((item) =>
          item.appGroups.map((group) => group.instance.id)
        )
      );
      const persisted = JSON.parse(afterSecond) as {
        repositories: Record<
          string,
          {
            instances: Record<
              string,
              { endpoints: Record<string, { port: number | null }> }
            >;
          }
        >;
      };
      expect(Object.values(persisted.repositories)[0]?.instances).toSatisfy(
        (instances) =>
          Object.values(instances).every((instance) =>
            Object.values(instance.endpoints).every(
              (endpoint) => endpoint.port === null
            )
          )
      );
    } finally {
      rmSync(fixture.temporary, { force: true, recursive: true });
    }
  });
});
