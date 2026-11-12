import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { pollUntil } from "../adapters/host/polling";
import {
  ProcessSupervisor,
  appGroupInstanceProcessId,
} from "../adapters/host/process-supervisor";
import { FileBranchBaseStateStore } from "../app-group/assignments";
import { AppGroupRuntime } from "../app-group/lifecycle";
import type { AppGroupTarget } from "../app-group/lifecycle";
import { reserveBackingPort } from "../app-group/readiness";
import { BranchBaseConfigSchema } from "../configuration/branchbase-schema";

const fixture = async () => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "shared-resources-"))
  );
  const owner = path.join(root, "owner");
  mkdirSync(owner);
  writeFileSync(
    path.join(owner, "database.ts"),
    `import {createServer} from 'node:net';import {appendFileSync} from 'node:fs';createServer(s=>s.end()).listen(Number(process.env.PORT),'127.0.0.1',()=>appendFileSync('starts',process.env.ID+'\\n'));`
  );
  const first = await reserveBackingPort();
  const second = await reserveBackingPort();
  const ports = [first.port, second.port];
  await first.release();
  await second.release();
  const definition = {
    directory: owner,
    files: ["database.ts"],
    id: "database",
    idle: "stop-when-unused",
    instances: {
      "0": { outputs: { database: "core-api-0" }, ports: { db: ports[0] } },
      "1": { outputs: { database: "core-api-1" }, ports: { db: ports[1] } },
    },
    name: "Shared database",
    recipe: {
      apps: { db: { protocol: "tcp" } },
      env: { ID: "{instance.id}", PORT: "{apps.db.port}" },
      start: { argv: [process.execPath, "database.ts"] },
      stop: "process",
    },
    version: 1,
  };
  const file = path.join(owner, "resource.json");
  writeFileSync(file, JSON.stringify(definition));
  const processes = new ProcessSupervisor(path.join(root, "control"));
  const state = new FileBranchBaseStateStore(
    path.join(root, "control", "state.json")
  );
  const runtime = new AppGroupRuntime(
    processes,
    {
      activate: async () => {},
      deactivate: async () => {},
      observe: () => "inactive",
      url: (h) => `http://${h}`,
    },
    state
  );
  const registration = runtime.managedResources.register(file);
  const target = (name: string, instance: string): AppGroupTarget => {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "worker.ts"),
      `setInterval(()=>{},1000)`
    );
    return {
      config: BranchBaseConfigSchema.parse({
        appGroups: {
          db: {
            apps: { db: { protocol: "tcp" } },
            category: "infrastructure",
            outputs: { database: "" },
            start: { argv: ["false"] },
            stop: "process",
          },
          worker: {
            apps: {},
            env: {
              DATABASE: "{appGroups.db.outputs.database}",
              DB_PORT: "{appGroups.db.apps.db.port}",
            },
            start: { argv: [process.execPath, "worker.ts"] },
            stop: "process",
          },
        },
        profiles: {
          default: instance,
          definitions: {
            "0": {
              connections: {
                db: { instance: "0", policy: "managed", resource: "database" },
              },
              name: "Infrastructure 0",
            },
            "1": {
              connections: {
                db: { instance: "1", policy: "managed", resource: "database" },
              },
              name: "Infrastructure 1",
            },
          },
        },
        setup: { argv: ["true"] },
        version: 1,
      }),
      groupId: "worker",
      repoPath: directory,
      worktree: { id: name, path: directory, routeLabel: name },
    };
  };
  const close = async () => {
    for (const { instance } of state.allResourceInstances()) {
      if (instance.run) {
        // oxlint-disable-next-line no-await-in-loop -- Stop each test-owned process before deleting its directory.
        await processes.stopManagedProcess(
          appGroupInstanceProcessId(instance.id),
          instance.run.worktreePath
        );
      }
    }
    rmSync(root, { force: true, recursive: true });
  };
  return {
    close,
    definition,
    file,
    owner,
    ports,
    registration,
    root,
    runtime,
    state,
    target,
  };
};

test("selecting endpoint profiles leaves a running managed resource alone", async () => {
  const f = await fixture();
  const reservation = await reserveBackingPort();
  const { port } = reservation;
  await reservation.release();
  try {
    const target = f.target("consumer", "0");
    const config = BranchBaseConfigSchema.parse({
      ...target.config,
      appGroups: {
        ...target.config.appGroups,
        worker: {
          ...target.config.appGroups.worker,
          apps: { api: { protocol: "tcp" } },
        },
      },
      endpointProfiles: {
        local: { name: "Local", ports: { worker: { api: port } } },
      },
    });
    f.runtime.managedResources.approve("database", f.registration.revision);
    const owner = f.runtime.managedResources.target("database", "0");
    await f.runtime.start(owner);
    const before = f.runtime.reconcile(owner).resource;
    await f.runtime.selectEndpointProfile({ ...target, config }, "local");
    const { db, worker } = f.runtime.reconcile({ ...target, config });
    expect(db).toEqual(before);
    expect(Object.values(worker.endpoints)[0]?.port).toBe(port);
  } finally {
    await f.close();
  }
}, 20_000);

test("four applications across projects share two independently identified managed resources", async () => {
  const f = await fixture();
  try {
    const targets = [
      f.target("app0", "0"),
      f.target("app1", "0"),
      f.target("app2", "1"),
      f.target("app3", "1"),
    ];
    const before = f.runtime.reconcile(targets[0]).worker.id;
    await expect(f.runtime.start(targets[0])).rejects.toThrow(
      "approve resource"
    );
    f.runtime.managedResources.approve("database", f.registration.revision);
    await Promise.all(targets.map((t) => f.runtime.start(t)));
    expect(
      readFileSync(path.join(f.owner, "starts"), "utf-8").trim().split("\n")
    ).toHaveLength(2);
    const firstContext = await f.runtime.manualCommandContext(targets[0]);
    expect(firstContext.env).toEqual({
      DATABASE: "core-api-0",
      DB_PORT: String(f.ports[0]),
    });
    await f.runtime.releaseManualCommandContext(firstContext.leaseId);
    const otherContext = await f.runtime.manualCommandContext(targets[3]);
    expect(otherContext.env.DATABASE).toBe("core-api-1");
    await f.runtime.releaseManualCommandContext(otherContext.leaseId);
    expect(f.runtime.reconcile(targets[0]).worker.id).toBe(before);
    const shared = f.runtime.managedResources.target("database", "0");
    await expect(f.runtime.stop(shared)).rejects.toThrow("in use");
    await f.runtime.stop(targets[0]);
    expect(
      f.state.allInstances("resource:database").find((i) => i.name === "0")?.run
    ).not.toBeNull();
    await f.runtime.selectProfile(targets[1], "1", true);
    expect(
      f.state.allInstances("resource:database").find((i) => i.name === "0")?.run
    ).toBeNull();
    const switchedContext = await f.runtime.manualCommandContext(targets[1]);
    expect(switchedContext.env.DATABASE).toBe("core-api-1");
    await f.runtime.releaseManualCommandContext(switchedContext.leaseId);
    await Promise.all(targets.slice(1).map((t) => f.runtime.stop(t)));
    expect(
      f.state.allInstances("resource:database").every((i) => i.run === null)
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);

test("consumers wait for every endpoint of their selected managed resource", async () => {
  const f = await fixture();
  try {
    writeFileSync(
      f.file,
      JSON.stringify({
        ...f.definition,
        recipe: {
          ...f.definition.recipe,
          apps: {
            ...f.definition.recipe.apps,
            unavailable: {
              protocol: "http",
              readiness: { path: "/health", timeoutSeconds: 1, type: "http" },
            },
          },
        },
      })
    );
    const registration = f.runtime.managedResources.register(f.file);
    f.runtime.managedResources.approve("database", registration.revision);
    const target = f.target("consumer", "0");
    await expect(f.runtime.start(target)).rejects.toThrow(
      'Dependency "db" is not ready'
    );
    expect(f.runtime.reconcile(target).worker.run).toBeNull();
    expect(f.runtime.managedCatalog()[0].observations["0"].health).toBe(
      "partially-running"
    );
  } finally {
    await f.close();
  }
}, 15_000);

test("source edits preserve identity and prevent Stop from invoking a changed recipe", async () => {
  const f = await fixture();
  try {
    f.runtime.managedResources.approve("database", f.registration.revision);
    const target = f.target("app0", "0");
    await f.runtime.start(target);
    const { id } = f.runtime.reconcile(target).db;
    writeFileSync(
      path.join(f.owner, "database.ts"),
      "throw new Error('changed');"
    );
    expect(f.runtime.reconcile(target).db.id).toBe(id);
    await expect(f.runtime.stop(target)).rejects.toThrow("changed since Start");
    expect(f.state.allInstances("resource:database")[0].run).not.toBeNull();
  } finally {
    await f.close();
  }
}, 15_000);

test("configured port conflicts fail without allocating a replacement", async () => {
  const f = await fixture();
  const lease = await reserveBackingPort(new Set(), f.ports[0]);
  try {
    f.runtime.managedResources.approve("database", f.registration.revision);
    await expect(f.runtime.start(f.target("app0", "0"))).rejects.toThrow();
    expect(f.state.allInstances("resource:database")[0].run).toBeNull();
  } finally {
    await lease.release();
    await f.close();
  }
}, 15_000);

test("detached status commands validate their target and report errors through exit codes", async () => {
  const f = await fixture();
  try {
    const script = path.join(f.owner, "detached.ts");
    writeFileSync(
      script,
      `import {spawn} from 'node:child_process';import {readFileSync,writeFileSync,existsSync} from 'node:fs';const mode=process.argv[2];const file='detached-'+process.env.PORT+'.json';if(mode==='start'){const child=spawn(process.execPath,['database.ts'],{detached:true,stdio:'ignore',env:process.env});writeFileSync(file,JSON.stringify({pid:child.pid,id:process.env.ID}));child.unref();}else {const record=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;if(mode==='stop'){if(record)process.kill(record.pid,'SIGTERM');}else{let running=false;try{if(record){process.kill(record.pid,0);running=true;}}catch{}if(record&&record.id!==process.env.ID)process.exit(2);process.exit(running?0:1);}}`
    );
    const definition = {
      ...f.definition,
      files: [...f.definition.files, "detached.ts"],
      recipe: {
        ...f.definition.recipe,
        start: { argv: [process.execPath, "detached.ts", "start"] },
        stop: { argv: [process.execPath, "detached.ts", "stop"] },
      },
      status: { argv: [process.execPath, "detached.ts", "status"] },
    };
    writeFileSync(f.file, JSON.stringify(definition));
    const registration = f.runtime.managedResources.register(f.file);
    f.runtime.managedResources.approve("database", registration.revision);
    const target = f.target("app0", "0");
    await f.runtime.start(target);
    const context = await f.runtime.manualCommandContext(target);
    expect(context.env.DATABASE).toBe("core-api-0");
    await f.runtime.releaseManualCommandContext(context.leaseId);
    const marker = path.join(f.owner, `detached-${f.ports[0]}.json`);
    const captured = JSON.parse(readFileSync(marker, "utf-8"));
    writeFileSync(marker, JSON.stringify({ ...captured, id: "other-owner" }));
    await expect(f.runtime.start(f.target("app1", "0"))).rejects.toThrow(
      "unexpected code 2"
    );
    writeFileSync(marker, JSON.stringify(captured));
    await f.runtime.stop(target);
    expect(f.state.allInstances("resource:database")[0].run).toBeNull();
  } finally {
    for (const port of f.ports) {
      try {
        const record = JSON.parse(
          readFileSync(path.join(f.owner, `detached-${port}.json`), "utf-8")
        );
        process.kill(record.pid, "SIGTERM");
      } catch {
        /* Test-owned detached process may already have exited. */
      }
    }
    await f.close();
  }
}, 15_000);

test("declared local inputs stay out of persisted bindings and logs while selected outputs win", async () => {
  const f = await fixture();
  try {
    f.runtime.managedResources.approve("database", f.registration.revision);
    const target = f.target("app0", "0");
    const secret = path.join(f.root, "secret");
    writeFileSync(secret, "private-test-value");
    const override = path.join(f.root, "override");
    writeFileSync(override, "9999");
    target.config.appGroups.worker.inputs = {
      DB_PORT: { file: override },
      TOKEN: { file: secret },
    };
    target.config.appGroups.worker.env = {
      ...target.config.appGroups.worker.env,
      TOKEN: "default",
    };
    writeFileSync(
      path.join(target.worktree.path, "worker.ts"),
      `import {writeFileSync} from 'node:fs';writeFileSync('received.json',JSON.stringify({token:process.env.TOKEN,port:process.env.DB_PORT}));console.log(process.env.TOKEN);setInterval(()=>{},1000);`
    );
    await f.runtime.start(target);
    await pollUntil(
      () => existsSync(path.join(target.worktree.path, "received.json")),
      {
        intervalMs: 20,
        message: "Worker did not record its environment",
        timeoutMs: 3000,
      }
    );
    const received = JSON.parse(
      readFileSync(path.join(target.worktree.path, "received.json"), "utf-8")
    );
    expect(received).toEqual({
      port: String(f.ports[0]),
      token: "private-test-value",
    });
    expect(readFileSync(f.state.path, "utf-8")).not.toContain(
      "private-test-value"
    );
    const context = await f.runtime.manualCommandContext(target);
    expect(context.env.TOKEN).toBeUndefined();
    await f.runtime.releaseManualCommandContext(context.leaseId);
    const instance = f.runtime.reconcile(target).worker;
    expect(
      readFileSync(
        path.join(
          f.root,
          "control",
          `${appGroupInstanceProcessId(instance.id)}.log`
        ),
        "utf-8"
      )
    ).not.toContain("private-test-value");
    await f.runtime.stop(target);
  } finally {
    await f.close();
  }
}, 15_000);

test("manual commands resolve stopped application bindings and protect resources until release", async () => {
  const f = await fixture();
  try {
    f.runtime.managedResources.approve("database", f.registration.revision);
    const target = f.target("app0", "0");
    const context = await f.runtime.manualCommandContext(target);
    expect(context.env).toEqual({
      DATABASE: "core-api-0",
      DB_PORT: String(f.ports[0]),
    });
    expect(
      f.state
        .allResourceInstances()
        .every((entry) => entry.instance.run === null)
    ).toBe(true);
    const owner = f.runtime.managedResources.target("database", "0");
    await f.runtime.start(owner);
    await expect(f.runtime.stop(owner)).rejects.toThrow("in use");
    await f.runtime.releaseManualCommandContext(context.leaseId);
    expect(f.state.allInstances("resource:database")[0].run).toBeNull();
  } finally {
    await f.close();
  }
}, 15_000);

test("detached resources without TCP endpoints use status exit codes", async () => {
  const f = await fixture();
  try {
    writeFileSync(
      path.join(f.owner, "service.ts"),
      `import {existsSync,writeFileSync,rmSync} from 'node:fs';const mode=process.argv[2];if(mode==='start')writeFileSync('active','yes');else if(mode==='stop')rmSync('active',{force:true});else process.exit(existsSync('active')?0:3);`
    );
    writeFileSync(
      f.file,
      JSON.stringify({
        ...f.definition,
        files: ["service.ts"],
        instances: { "0": { outputs: {}, ports: {} } },
        recipe: {
          apps: {},
          env: { ID: "{instance.id}" },
          start: { argv: [process.execPath, "service.ts", "start"] },
          stop: { argv: [process.execPath, "service.ts", "stop"] },
        },
        status: {
          argv: [process.execPath, "service.ts", "status"],
          stoppedExitCodes: [1, 3],
        },
      })
    );
    const registration = f.runtime.managedResources.register(f.file);
    f.runtime.managedResources.approve("database", registration.revision);
    const owner = f.runtime.managedResources.target("database", "0");
    await f.runtime.start(owner);
    expect(f.runtime.managedCatalog()[0].observations["0"].health).toBe(
      "running"
    );
    expect(await f.runtime.start(owner)).toBe("already-running");
    await f.runtime.stop(owner);
    expect(existsSync(path.join(f.owner, "active"))).toBe(false);
  } finally {
    await f.close();
  }
}, 15_000);

test("resolved output script paths must belong to the approved source manifest", async () => {
  const f = await fixture();
  try {
    const definition = {
      ...f.definition,
      files: [],
      instances: {
        "0": {
          ...f.definition.instances["0"],
          outputs: { script: "database.ts" },
        },
      },
      recipe: {
        ...f.definition.recipe,
        start: { argv: [process.execPath, "{outputs.script}"] },
      },
    };
    writeFileSync(f.file, JSON.stringify(definition));
    const registration = f.runtime.managedResources.register(f.file);
    f.runtime.managedResources.approve("database", registration.revision);
    await expect(
      f.runtime.start(f.runtime.managedResources.target("database", "0"))
    ).rejects.toThrow("files manifest");
    expect(existsSync(path.join(f.owner, "starts"))).toBe(false);
  } finally {
    await f.close();
  }
});

test("catalog inspections share asynchronous status checks across named instances", async () => {
  const f = await fixture();
  try {
    writeFileSync(
      path.join(f.owner, "service.ts"),
      `import {appendFileSync,existsSync,writeFileSync,rmSync} from 'node:fs';
      const marker='active-'+process.env.ID;const mode=process.argv[2];
      if(mode==='start')writeFileSync(marker,'yes');else if(mode==='stop')rmSync(marker,{force:true});else{
        appendFileSync('observations',process.env.ID+'\\n');
        const timer=setInterval(()=>{if(existsSync('observe')){clearInterval(timer);process.exit(existsSync(marker)?0:1)}},20);
      }`
    );
    writeFileSync(
      f.file,
      JSON.stringify({
        ...f.definition,
        files: ["service.ts"],
        instances: {
          "0": { outputs: {}, ports: {} },
          "1": { outputs: {}, ports: {} },
        },
        recipe: {
          apps: {},
          env: { ID: "{instance.id}" },
          start: { argv: [process.execPath, "service.ts", "start"] },
          stop: { argv: [process.execPath, "service.ts", "stop"] },
        },
        status: {
          argv: [process.execPath, "service.ts", "status"],
          stoppedExitCodes: [1, 3],
        },
      })
    );
    writeFileSync(path.join(f.owner, "observe"), "yes");
    const registration = f.runtime.managedResources.register(f.file);
    f.runtime.managedResources.approve("database", registration.revision);
    await f.runtime.start(f.runtime.managedResources.target("database", "0"));
    await f.runtime.start(f.runtime.managedResources.target("database", "1"));
    writeFileSync(path.join(f.owner, "observations"), "");
    rmSync(path.join(f.owner, "observe"));
    const fresh = new AppGroupRuntime(
      new ProcessSupervisor(path.join(f.root, "control")),
      {
        activate: async () => {},
        deactivate: async () => {},
        observe: () => "inactive",
        url: (h) => `http://${h}`,
      },
      f.state
    );
    fresh.managedCatalog();
    fresh.managedCatalog();
    await pollUntil(
      () =>
        readFileSync(path.join(f.owner, "observations"), "utf-8")
          .trim()
          .split("\n").length === 2,
      {
        intervalMs: 20,
        message: "Status checks were blocked or duplicated",
        timeoutMs: 2000,
      }
    );
    writeFileSync(path.join(f.owner, "observe"), "yes");
    await pollUntil(
      () =>
        Object.values(fresh.managedCatalog()[0].observations).every(
          (item) => item.health === "running"
        ),
      {
        intervalMs: 20,
        message: "Status results did not refresh",
        timeoutMs: 2000,
      }
    );
    expect(
      readFileSync(path.join(f.owner, "observations"), "utf-8")
        .trim()
        .split("\n")
    ).toHaveLength(2);
    await f.runtime.stop(f.runtime.managedResources.target("database", "0"));
    await f.runtime.stop(f.runtime.managedResources.target("database", "1"));
  } finally {
    await f.close();
  }
}, 15_000);
