import { expect, test } from "bun:test";

import {
  readRuntimeIdentity,
  RUNTIME_HEADER,
} from "../../daemon/runtime-identity";
import { DaemonClient } from "./client";
import { runCli } from "./run";

const runtime = readRuntimeIdentity();
const health = () =>
  Response.json({ ok: true, pid: 123, runtime, service: "branchbase" });

test("CLI validates commands before transport and sends the daemon session", async () => {
  const calls: string[] = [];
  const client = new DaemonClient("http://localhost:3999", (url, init) => {
    calls.push(url.pathname);
    if (url.pathname === "/api/health") {
      return Promise.resolve(health());
    }
    expect(new Headers(init?.headers).get(RUNTIME_HEADER)).toBe(
      runtime.buildId
    );
    if (url.pathname === "/api/session") {
      return Promise.resolve(Response.json({ token: "test-session" }));
    }
    expect(new Headers(init?.headers).get("x-branchbase-token")).toBe(
      "test-session"
    );
    expect(init?.method).toBe("POST");
    return Promise.resolve(
      Response.json({
        command: "clear-logs",
        message: "Logs cleared",
        ok: true,
      })
    );
  });
  await expect(client.execute("start-apps", {})).rejects.toThrow();
  expect(calls).toEqual([]);
  expect(
    await runCli(
      [
        "execute",
        "clear-logs",
        "--input",
        JSON.stringify({
          appGroupName: "development",
          repoPath: "/repo",
          worktreeId: "main",
        }),
      ],
      client,
      "/repo"
    )
  ).toBe("Logs cleared");
  expect(calls).toEqual([
    "/api/health",
    "/api/session",
    "/api/commands/clear-logs",
  ]);
});

test("CLI project status uses the same headless status query and defaults to cwd", async () => {
  const client = new DaemonClient("http://localhost:3999", (url) => {
    if (url.pathname === "/api/health") {
      return Promise.resolve(health());
    }
    expect(url.pathname).toBe("/api/project-status");
    expect(url.searchParams.get("repoPath")).toBe("/code/project");
    return Promise.resolve(
      Response.json({ configuration: { state: "unconfigured" } })
    );
  });
  const output = await runCli(
    ["project", "status", "--json"],
    client,
    "/code/project"
  );
  expect(JSON.parse(output)).toEqual({
    configuration: { state: "unconfigured" },
  });
});

test("CLI never replays a command after an ambiguous connection failure", async () => {
  let posts = 0;
  const client = new DaemonClient("http://localhost:3999", (url) => {
    if (url.pathname === "/api/health") {
      return Promise.resolve(health());
    }
    if (url.pathname === "/api/session") {
      return Promise.resolve(Response.json({ token: "test-session" }));
    }
    posts += 1;
    return Promise.reject(new Error("Connection lost"));
  });
  await expect(client.execute("scan-development-folders", {})).rejects.toThrow(
    "Connection lost"
  );
  expect(posts).toBe(1);
});

test.each([
  [".", "/code/project"],
  ["../other", "/code/other"],
  ["/different/project", "/different/project"],
])(
  "CLI resolves repository path %s for status and logs",
  async (repo, expected) => {
    const paths: string[] = [];
    const client = new DaemonClient("http://localhost:3999", (url) => {
      if (url.pathname === "/api/health") {
        return Promise.resolve(health());
      }
      expect(url.searchParams.get("repoPath")).toBe(expected);
      paths.push(url.pathname);
      return Promise.resolve(Response.json({ lines: [] }));
    });
    await runCli(
      ["project", "status", "--repo", repo],
      client,
      "/code/project"
    );
    await runCli(
      ["logs", "--repo", repo, "--worktree", "main", "--group", "app"],
      client,
      "/code/project"
    );
    expect(paths).toEqual(["/api/project-status", "/api/logs"]);
  }
);

test("CLI preserves multiline plain-text logs and structured JSON logs", async () => {
  const lines = ["first", "second"];
  const client = new DaemonClient("http://localhost:3999", (url) =>
    Promise.resolve(
      url.pathname === "/api/health" ? health() : Response.json({ lines })
    )
  );
  const args = ["logs", "--worktree", "main", "--group", "app"];
  expect(await runCli(args, client, "/repo")).toBe("first\nsecond");
  expect(
    JSON.parse(await runCli([...args, "--json"], client, "/repo"))
  ).toEqual({
    lines,
  });
});

test.each([
  undefined,
  { ...runtime, buildId: "older-build" },
  { ...runtime, installationPath: "/different/installation" },
])(
  "CLI blocks queries and mutations for a mismatched or legacy daemon (%j)",
  async (daemonRuntime) => {
    const calls: string[] = [];
    const client = new DaemonClient(
      "http://localhost:3999",
      (url) => {
        calls.push(url.pathname);
        return Promise.resolve(
          Response.json({
            ok: true,
            pid: 123,
            runtime: daemonRuntime,
            service: "branchbase",
          })
        );
      },
      runtime
    );
    await expect(client.query("/api/projects")).rejects.toThrow(
      "bbase daemon stop"
    );
    await expect(
      client.execute("scan-development-folders", {})
    ).rejects.toThrow("bbase daemon start");
    expect(calls).toEqual(["/api/health", "/api/health"]);
  }
);

test("CLI verifies the recorded PID and rejects a different service", async () => {
  const client = new DaemonClient(
    "http://localhost:3999",
    () => Promise.resolve(health()),
    runtime
  );
  await expect(client.verifyRuntime(456)).rejects.toThrow(
    "not recorded PID 456"
  );
  await client.verifyRuntime(123);
  const foreign = new DaemonClient(
    "http://localhost:3999",
    () =>
      Promise.resolve(
        Response.json({ ok: true, pid: 123, runtime, service: "other" })
      ),
    runtime
  );
  await expect(foreign.query("/api/projects")).rejects.toThrow(
    "not a healthy BranchBase daemon"
  );
});

test("CLI rechecks identity when a daemon changes between requests", async () => {
  let healthChecks = 0;
  const client = new DaemonClient(
    "http://localhost:3999",
    (url) => {
      if (url.pathname === "/api/health") {
        healthChecks += 1;
        return Promise.resolve(
          healthChecks === 1
            ? health()
            : Response.json({ ok: true, pid: 123, service: "branchbase" })
        );
      }
      return Promise.resolve(Response.json({ projects: [] }));
    },
    runtime
  );
  await client.query("/api/projects");
  await expect(client.query("/api/projects")).rejects.toThrow(
    "CLI/daemon build mismatch"
  );
  expect(healthChecks).toBe(2);
});

test("CLI help works without contacting the daemon", async () => {
  const client = new DaemonClient(
    "http://localhost:3999",
    () => {
      throw new Error("Help must remain offline");
    },
    runtime
  );
  expect(await runCli(["help"], client, "/repo")).toContain("bbase daemon");
});

test("CLI reports a daemon that is unavailable without rewriting the transport error", async () => {
  const client = new DaemonClient("http://127.0.0.1:3999", () =>
    Promise.reject(new Error("Failed to connect to daemon"))
  );
  await expect(runCli(["project", "list"], client, "/repo")).rejects.toThrow(
    "Failed to connect to daemon"
  );
});

test("exec passes resolved bindings to a real command and releases its reservation on failure", async () => {
  const calls: string[] = [];
  const client = new DaemonClient("http://localhost:3999", (url, init) => {
    calls.push(url.pathname);
    if (url.pathname === "/api/session") {
      return Promise.resolve(Response.json({ token: "test-session" }));
    }
    if (url.pathname === "/api/commands/resource-command-context") {
      expect(JSON.parse(String(init?.body))).toEqual({
        appGroupName: "app",
        repoPath: "/code/project",
        worktreeId: "main",
      });
      return Promise.resolve(
        Response.json({
          cwd: process.cwd(),
          env: { SELECTED_DATABASE: "core-api-1" },
          inputs: {},
          leaseId: "manual-consumer",
        })
      );
    }
    expect(JSON.parse(String(init?.body))).toEqual({
      leaseId: "manual-consumer",
    });
    return Promise.resolve(
      Response.json({
        command: "release-command-context",
        message: "Released",
        ok: true,
      })
    );
  });
  await expect(
    runCli(
      [
        "exec",
        "--worktree",
        "main",
        "--group",
        "app",
        "--",
        process.execPath,
        "-e",
        "process.exit(process.env.SELECTED_DATABASE === 'core-api-1' ? 7 : 9)",
      ],
      client,
      "/code/project"
    )
  ).rejects.toThrow("Command exited with 7");
  expect(calls).toEqual([
    "/api/session",
    "/api/commands/resource-command-context",
    "/api/session",
    "/api/commands/release-command-context",
  ]);
});
