import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProcessSupervisor } from "../adapters/host/process-supervisor";
import type { LocalRoutingEngine } from "../adapters/routing/portless";
import { FileBranchBaseStateStore } from "../app-group/assignments";
import { AppGroupRuntime } from "../app-group/lifecycle";
import type { AppGroupTarget } from "../app-group/lifecycle";
import { reserveBackingPort } from "../app-group/readiness";
import { BranchBaseConfigSchema } from "../configuration/branchbase-schema";
import { repositoryCommandFingerprint } from "../configuration/repository-trust";
import { WorkspaceController } from "./workspace-controller";

const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Missing fixture value");
  }
  return value;
};

const fixture = async () => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "branchbase-endpoints-"))
  );
  const ports = await Promise.all([reserveBackingPort(), reserveBackingPort()]);
  const config = BranchBaseConfigSchema.parse({
    appGroups: {
      dev: {
        apps: { api: { protocol: "http" }, web: { protocol: "http" } },
        env: {
          API_PORT: "{apps.api.port}",
          WEB_PORT: "{apps.web.port}",
          WEB_URL: "{apps.web.directUrl}",
        },
        start: { argv: [process.execPath, "server.ts"] },
        stop: "process",
      },
    },
    endpointProfiles: {
      local: {
        name: "Localhost",
        ports: { dev: { api: ports[1].port, web: ports[0].port } },
      },
    },
    setup: { argv: ["true"] },
    version: 1,
  });
  await Promise.all(ports.map((port) => port.release()));
  const state = new FileBranchBaseStateStore(path.join(root, "state.json"));
  const processes = new ProcessSupervisor(path.join(root, "control"));
  const routes = new Map<string, number>();
  const routing: LocalRoutingEngine = {
    activate: (route) => {
      routes.set(route.hostname, route.port);
      return Promise.resolve();
    },
    deactivate: (route) => {
      routes.delete(route.hostname);
      return Promise.resolve();
    },
    observe: (route) => {
      if (!routes.has(route.hostname)) {
        return "inactive";
      }
      return routes.get(route.hostname) === route.port ? "active" : "conflict";
    },
    url: (hostname) => `http://${hostname}`,
  };
  const runtime = new AppGroupRuntime(processes, routing, state);
  const targets: AppGroupTarget[] = ["main", "feature"].map((id) => {
    const directory = path.join(root, id);
    mkdirSync(directory);
    writeFileSync(
      path.join(directory, "server.ts"),
      'for (const name of ["WEB_PORT", "API_PORT"]) Bun.serve({hostname:"127.0.0.1",port:Number(process.env[name]),fetch:()=>new Response("ok")});'
    );
    return {
      config,
      groupId: "dev",
      repoPath: root,
      worktree: { id, path: directory, routeLabel: id },
    };
  });
  const endpoints = (target = targets[0]) =>
    Object.values(runtime.reconcile(target).dev.endpoints);
  const close = async () => {
    for (const target of targets) {
      // oxlint-disable-next-line no-await-in-loop -- Finish stopping fixture listeners before removing their ownership records.
      await runtime.stop(target);
    }
    rmSync(root, { force: true, recursive: true });
  };
  return {
    close,
    config,
    endpoints,
    processes,
    root,
    routes,
    routing,
    runtime,
    state,
    targets,
  };
};

test("endpoint profiles isolate worktrees and keep startup, readiness, URLs and restart on the assigned ports", async () => {
  const f = await fixture();
  try {
    const [main, feature] = f.targets;
    await f.runtime.selectEndpointProfile(main, "local");
    await f.runtime.selectEndpointProfile(feature, null);
    const pinned = f.endpoints(main);
    const automatic = f.endpoints(feature);
    expect(pinned.map((app) => app.port).toSorted()).toEqual(
      Object.values(
        required(f.config.endpointProfiles).local.ports.dev
      ).toSorted()
    );
    expect(
      automatic.every((app) => !pinned.some((pin) => pin.port === app.port))
    ).toBe(true);
    await f.runtime.start(main);
    await f.runtime.start(feature);
    const instance = f.runtime.reconcile(main).dev;
    const run = required(
      f.state.run({
        instanceId: instance.id,
        repoPath: main.repoPath,
      })
    );
    await Promise.all(
      Object.values(run.apps).map(async (endpoint) => {
        expect(endpoint.port).toBe(
          required(f.config.endpointProfiles).local.ports.dev[endpoint.appId]
        );
        expect(endpoint.directUrl).toBe(`http://127.0.0.1:${endpoint.port}`);
        expect(
          f.routing.observe({
            hostname: required(endpoint.hostname),
            port: endpoint.port,
          })
        ).toBe("active");
        const response = await fetch(required(endpoint.directUrl));
        expect(response.status).toBe(200);
      })
    );
    await expect(f.runtime.selectEndpointProfile(main, null)).rejects.toThrow(
      "Stop the affected apps"
    );
    await f.runtime.stop(main);
    const restored = new AppGroupRuntime(
      f.processes,
      f.routing,
      new FileBranchBaseStateStore(f.state.path)
    );
    const updatedConfig = structuredClone(main.config);
    const profiles = required(updatedConfig.endpointProfiles);
    profiles.another = { name: "Another profile", ports: {} };
    const updated = { ...main, config: updatedConfig };
    await restored.start(updated);
    expect(restored.reconcile(updated).dev.id).toBe(instance.id);
    expect(f.endpoints(main)).toEqual(pinned);
    expect(f.endpoints(feature)).toEqual(automatic);
    await restored.stop(updated);
    await f.runtime.selectEndpointProfile(updated, null);
    expect(
      f.state.worktreeEndpointProfile(main.repoPath, main.worktree.path)
    ).toBeNull();
    const persisted = readFileSync(f.state.path, "utf-8");
    expect(persisted).not.toContain('"endpointProfile"');
    expect(persisted).not.toContain('"requestedPort"');
  } finally {
    await f.close();
  }
}, 20_000);

test("profile application is atomic for foreign listeners, other worktree reservations and retained routes", async () => {
  const f = await fixture();
  try {
    const [main, feature] = f.targets;
    await f.runtime.selectEndpointProfile(main, null);
    const before = f.endpoints(main);
    const blocker = await reserveBackingPort(
      new Set(),
      required(f.config.endpointProfiles).local.ports.dev.api
    );
    try {
      await expect(
        f.runtime.selectEndpointProfile(main, "local")
      ).rejects.toThrow("Cannot assign");
      expect(f.endpoints(main)).toEqual(before);
      expect(
        f.state.worktreeEndpointProfile(main.repoPath, main.worktree.path)
      ).toBeNull();
    } finally {
      await blocker.release();
    }
    await f.runtime.selectEndpointProfile(feature, "local");
    await expect(
      f.runtime.selectEndpointProfile(main, "local")
    ).rejects.toThrow("already assigned");
    expect(f.endpoints(main)).toEqual(before);
    f.routes.set(before[0].hostname, required(before[0].port));
    await expect(f.runtime.selectEndpointProfile(main, null)).rejects.toThrow(
      "listener or route"
    );
    expect(f.endpoints(main)).toEqual(before);
    f.routes.clear();
  } finally {
    await f.close();
  }
});

test("manual command bindings prevent reassignment until released; missing profiles block Start", async () => {
  const f = await fixture();
  try {
    const [main] = f.targets;
    await f.runtime.selectEndpointProfile(main, "local");
    const context = await f.runtime.manualCommandContext(main);
    expect(context.env.WEB_PORT).toBe(
      String(required(f.config.endpointProfiles).local.ports.dev.web)
    );
    await expect(f.runtime.selectEndpointProfile(main, null)).rejects.toThrow(
      "command contexts"
    );
    await f.runtime.releaseManualCommandContext(context.leaseId);
    const { endpointProfiles: _profiles, ...withoutProfiles } = main.config;
    const changed = { ...main, config: withoutProfiles };
    await expect(f.runtime.start(changed)).rejects.toThrow("unavailable");
    await f.runtime.selectEndpointProfile(changed, null);
    expect(
      f.state.worktreeEndpointProfile(main.repoPath, main.worktree.path)
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test("manual contexts lease referenced endpoints without blocking unrelated groups", async () => {
  const f = await fixture();
  try {
    const [main] = f.targets;
    const config = BranchBaseConfigSchema.parse({
      ...main.config,
      appGroups: {
        ...main.config.appGroups,
        dependency: {
          apps: { db: { protocol: "tcp" } },
          outputs: { port: "{apps.db.port}" },
          start: { argv: ["true"] },
          stop: "process",
        },
        dev: {
          ...main.config.appGroups.dev,
          env: { DB_PORT: "{appGroups.dependency.outputs.port}" },
        },
        unrelated: {
          apps: { cache: { protocol: "tcp" } },
          start: { argv: ["true"] },
          stop: "process",
        },
      },
    });
    const target = { ...main, config };
    const { dependency, dev, unrelated } = f.runtime.reconcile(target);
    const context = await f.runtime.manualCommandContext(target);
    try {
      expect(f.runtime.resourceStore.lease(context.leaseId).toSorted()).toEqual(
        [dependency.id, dev.id].toSorted()
      );
      expect(f.runtime.resourceStore.hasLease(unrelated.id)).toBe(false);
    } finally {
      await f.runtime.releaseManualCommandContext(context.leaseId);
    }
  } finally {
    await f.close();
  }
});

test("endpoint definitions reject unsupported targets, duplicate ports and literal-port contradictions and participate in trust", async () => {
  const f = await fixture();
  try {
    for (const ports of [
      { missing: { web: 3000 } },
      { dev: { unknown: 3000 } },
      { dev: { api: 3000, web: 3000 } },
    ]) {
      expect(
        BranchBaseConfigSchema.safeParse({
          ...f.config,
          endpointProfiles: { local: { name: "Local", ports } },
        }).success
      ).toBe(false);
    }
    for (const group of [
      { ...f.config.appGroups.dev, instances: { mode: "selectable" } },
      { ...f.config.appGroups.dev, category: "infrastructure" },
      {
        ...f.config.appGroups.dev,
        apps: {
          ...f.config.appGroups.dev.apps,
          web: { port: 1024, protocol: "http" },
        },
      },
    ]) {
      expect(
        BranchBaseConfigSchema.safeParse({
          ...f.config,
          appGroups: { dev: group },
        }).success
      ).toBe(false);
    }
    const changed = structuredClone(f.config);
    required(changed.endpointProfiles).local.ports.dev.web = 1024;
    expect(repositoryCommandFingerprint(changed)).not.toBe(
      repositoryCommandFingerprint(f.config)
    );
  } finally {
    await f.close();
  }
});

test("controller commands expose endpoint choices and persist selection for one inheriting worktree", async () => {
  const f = await fixture();
  const controller = new WorkspaceController(undefined, {
    processes: f.processes,
    routing: f.routing,
    state: f.state,
  });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: f.root, encoding: "utf-8" });
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
  };
  try {
    git("init", "-q");
    git("config", "user.name", "BranchBase Test");
    git("config", "user.email", "test@example.test");
    writeFileSync(
      path.join(f.root, ".branchbase.json"),
      JSON.stringify(f.config)
    );
    git("add", ".branchbase.json");
    git("commit", "-qm", "fixture");
    git("worktree", "add", "-qb", "feature", path.join(f.root, "linked"));
    const initial = controller.inspect(f.root);
    const main = required(
      initial.worktrees.find((worktree) => worktree.isMain)
    );
    expect(main.endpointProfile?.choices[0].id).toBe("local");
    await controller.execute("select-endpoint-profile", {
      profileId: "local",
      repoPath: f.root,
      worktreeId: main.id,
    });
    const applied = controller.inspect(f.root);
    expect(
      applied.worktrees.find((worktree) => worktree.isMain)?.endpointProfile?.id
    ).toBe("local");
    expect(
      applied.worktrees.find((worktree) => !worktree.isMain)?.endpointProfile
        ?.id
    ).toBeNull();
    expect(
      applied.worktrees.every(
        (worktree) => worktree.configuration.source === "project-default"
      )
    ).toBe(true);
    await expect(
      controller.execute("select-endpoint-profile", {
        profileId: "missing",
        repoPath: f.root,
        worktreeId: main.id,
      })
    ).rejects.toThrow("unavailable");
  } finally {
    await controller.close();
    await f.close();
  }
});

test("concurrent profile applications cannot claim the same ports", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled(
      f.targets.map((target) =>
        f.runtime.selectEndpointProfile(target, "local")
      )
    );
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(
      f.targets.filter(
        (target) =>
          f.state.worktreeEndpointProfile(
            target.repoPath,
            target.worktree.path
          ) === "local"
      )
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("an exact profile request can replace this stopped worktree's automatic assignment without losing endpoint identity", async () => {
  const f = await fixture();
  try {
    const [main] = f.targets;
    const profile = required(f.config.endpointProfiles).local;
    Reflect.deleteProperty(profile.ports.dev, "web");
    const instance = f.runtime.reconcile(main).dev;
    const web = f.state.endpoint({
      appId: "web",
      appLabel: "Web",
      groupId: "dev",
      instanceId: instance.id,
      repoPath: main.repoPath,
    });
    f.state.assignEndpointPort(
      { instanceId: instance.id, repoPath: main.repoPath },
      "web",
      profile.ports.dev.api
    );
    await f.runtime.selectEndpointProfile(main, "local");
    const apps = f.endpoints(main);
    expect(apps.find((app) => app.appId === "api")?.port).toBe(
      profile.ports.dev.api
    );
    expect(apps.find((app) => app.appId === "web")?.port).not.toBe(
      profile.ports.dev.api
    );
    expect(apps.find((app) => app.appId === "web")?.id).toBe(web.id);
    expect(apps.find((app) => app.appId === "web")?.hostname).toBe(
      web.hostname
    );
  } finally {
    await f.close();
  }
});

test("endpoint preferences leave shared infrastructure's stable assignments unchanged", async () => {
  const f = await fixture();
  try {
    const [main] = f.targets;
    const apiPort = required(f.config.endpointProfiles).local.ports.dev.api;
    Reflect.deleteProperty(f.config, "endpointProfiles");
    const group = f.config.appGroups.dev;
    group.category = "infrastructure";
    group.instances = { mode: "selectable" };
    group.apps.api.port = apiPort;
    await f.runtime.start(main);
    await f.runtime.stop(main);
    const before = f.endpoints(main);
    await f.runtime.selectEndpointProfile(main, null);
    expect(f.endpoints(main)).toEqual(before);
    await f.runtime.start(main);
    expect(f.endpoints(main)).toEqual(before);
  } finally {
    await f.close();
  }
}, 20_000);
