import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import pathModule from "node:path";

import { pollUntil } from "../src/adapters/host/polling";

const PROJECT_ROOT = pathModule.resolve(import.meta.filename, "../..");

interface CommandOptions {
  allowFailure?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

const run = (
  command: string,
  args: string[],
  options: CommandOptions = {}
): string => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...options.env },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  }
  return output;
};

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message);
  }
};

const unusedPort = async (): Promise<number> => {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert(address && typeof address !== "string", "Could not reserve a port");
  const { port } = address;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
};

const waitUntilStopped = async (url: string): Promise<void> => {
  await pollUntil(
    async () => {
      try {
        await fetch(url);
        return false;
      } catch {
        return true;
      }
    },
    {
      intervalMs: 100,
      maxAttempts: 50,
      message: "Packed BranchBase daemon did not stop",
    }
  );
};

const temporaryRoot = mkdtempSync(
  pathModule.join(tmpdir(), "branchbase-pack-")
);
const packDirectory = pathModule.join(temporaryRoot, "pack");
const installDirectory = pathModule.join(temporaryRoot, "consumer");
const fixtureDirectory = pathModule.join(temporaryRoot, "repository");
const homeDirectory = pathModule.join(temporaryRoot, "home");
let cliPath = "";
let daemonEnvironment: Record<string, string> = {};

try {
  mkdirSync(installDirectory);
  const tarballName = "branchbase.tgz";
  mkdirSync(packDirectory);
  const tarballPath = pathModule.join(packDirectory, tarballName);
  run("bun", ["pm", "pack", "--filename", tarballPath, "--quiet"]);
  assert(existsSync(tarballPath), "bun pm pack did not create the tarball");

  const packedFiles = run("tar", ["-tzf", tarballPath]);
  for (const requiredPath of [
    "package/scripts/daemon.ts",
    "package/dist/index.html",
    "package/plugins/branchbase/.codex-plugin/plugin.json",
    "package/plugins/branchbase/hooks/hooks.json",
    "package/plugins/branchbase/hooks/branchbase-hook",
    "package/plugins/branchbase/hooks/branchbase-hook.ts",
    "package/schema/branchbase.schema.json",
    "package/schema/managed-resource.schema.json",
    "package/src/configuration/public.ts",
  ]) {
    assert(
      packedFiles.split("\n").includes(requiredPath),
      `Packed artifact is missing ${requiredPath}`
    );
  }
  assert(
    !packedFiles.split("\n").some((path) => path.startsWith("package/dev/")),
    "Packed artifact unexpectedly includes contributor development tooling"
  );

  writeFileSync(
    pathModule.join(installDirectory, "package.json"),
    '{"name":"branchbase-pack-consumer","private":true,"type":"module"}\n',
    { flag: "wx" }
  );
  run("bun", ["add", "--ignore-scripts", tarballPath], {
    cwd: installDirectory,
  });
  cliPath = pathModule.join(
    installDirectory,
    "node_modules",
    ".bin",
    "branchbase"
  );
  assert(
    existsSync(cliPath),
    "Packed install did not expose the branchbase CLI"
  );
  const helpOutput = run(cliPath, ["help"], { cwd: installDirectory });
  assert(
    helpOutput.includes("branchbase project status"),
    "Packed CLI help did not run without a daemon"
  );
  const aliasPath = pathModule.join(
    installDirectory,
    "node_modules",
    ".bin",
    "bbase"
  );
  assert(existsSync(aliasPath), "Packed install did not expose the bbase CLI");
  assert(
    run(aliasPath, ["help"], { cwd: installDirectory }) === helpOutput,
    "Packed bbase alias did not expose the same CLI"
  );
  run(
    "bun",
    [
      "-e",
      'import { BranchBaseConfigSchema } from "branchbase/config"; const config = BranchBaseConfigSchema.parse({ version: 1, setup: { argv: ["bun", "install"] }, appGroups: { Apps: { start: { argv: ["bun", "run", "dev"] }, stop: "process", env: { PORT: "{apps.web.port}" }, apps: { web: { protocol: "http", readiness: "tcp" } } } } }); if (config.appGroups.Apps.apps.web.protocol !== "http") process.exit(1);',
    ],
    { cwd: installDirectory }
  );

  run("git", ["init", "--quiet", fixtureDirectory]);
  run("git", ["config", "user.email", "pack-smoke@branchbase.local"], {
    cwd: fixtureDirectory,
  });
  run("git", ["config", "user.name", "BranchBase Pack Smoke"], {
    cwd: fixtureDirectory,
  });
  writeFileSync(pathModule.join(fixtureDirectory, "README.md"), "# Fixture\n");
  writeFileSync(
    pathModule.join(fixtureDirectory, ".branchbase.json"),
    `${JSON.stringify(
      {
        appGroups: {
          Apps: {
            apps: {
              fixture: { protocol: "http", readiness: "tcp" },
            },
            env: { PORT: "{apps.fixture.port}" },
            start: { argv: ["bun", "run", "dev"] },
            stop: "process",
          },
        },
        setup: { argv: ["bun", "install"] },
        version: 1,
      },
      null,
      2
    )}\n`
  );
  run("git", ["add", "."], { cwd: fixtureDirectory });
  run("git", ["commit", "--quiet", "-m", "Create smoke fixture"], {
    cwd: fixtureDirectory,
  });

  const port = await unusedPort();
  daemonEnvironment = {
    BRANCHBASE_NO_OPEN: "1",
    BRANCHBASE_PORT: String(port),
    HOME: homeDirectory,
  };
  const startOutput = run(aliasPath, ["start", "--repo", fixtureDirectory], {
    cwd: installDirectory,
    env: daemonEnvironment,
  });
  assert(
    startOutput.includes("BranchBase started"),
    "Packed CLI did not start"
  );
  assert(
    run(cliPath, ["status"], {
      cwd: installDirectory,
      env: daemonEnvironment,
    }).includes("BranchBase is running"),
    "Packed CLI status did not report the daemon"
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await fetch(`${baseUrl}/api/health`);
  const healthBody = (await health.json()) as {
    pid?: number;
    service?: string;
  };
  assert(
    health.ok && healthBody.service === "branchbase",
    "Packed daemon health check failed"
  );
  const workspace = await fetch(
    `${baseUrl}/api/workspace?${new URLSearchParams({ repoPath: fixtureDirectory })}`
  );
  const workspaceBody = (await workspace.json()) as { repoPath?: string };
  assert(
    workspace.ok && workspaceBody.repoPath === realpathSync(fixtureDirectory),
    "Packed daemon did not inspect the disposable Git fixture"
  );
  const projectStatus = JSON.parse(
    run(cliPath, ["project", "status", "--repo", fixtureDirectory, "--json"], {
      cwd: installDirectory,
      env: daemonEnvironment,
    })
  ) as { configuration?: { state?: string }; repoPath?: string };
  assert(
    projectStatus.repoPath === realpathSync(fixtureDirectory) &&
      projectStatus.configuration?.state === "ready",
    "Packed CLI project status did not report the configured fixture"
  );
  const projectList = JSON.parse(
    run(cliPath, ["project", "list", "--json"], {
      cwd: installDirectory,
      env: daemonEnvironment,
    })
  ) as { projects?: unknown[] };
  assert(
    Array.isArray(projectList.projects),
    "Packed CLI project list did not return a projects array"
  );

  // A second installation of the same version must not silently reuse this daemon.
  const installedRoot = pathModule.dirname(
    pathModule.dirname(realpathSync(cliPath))
  );
  const otherRoot = pathModule.join(
    installDirectory,
    "node_modules",
    "branchbase-other"
  );
  cpSync(installedRoot, otherRoot, { recursive: true });
  const otherCli = pathModule.join(otherRoot, "scripts", "daemon.ts");
  for (const args of [["start"], ["status"], ["project", "list", "--json"]]) {
    const mismatch = run(otherCli, args, {
      allowFailure: true,
      cwd: installDirectory,
      env: daemonEnvironment,
    });
    assert(
      mismatch.includes("CLI/daemon build mismatch") &&
        mismatch.includes("bbase daemon stop"),
      "A different installation silently reused the packed daemon"
    );
  }
  // The live daemon must retain its startup identity after an in-place upgrade.
  const installedMain = pathModule.join(
    installedRoot,
    "src",
    "daemon",
    "main.ts"
  );
  const originalMain = readFileSync(installedMain, "utf-8");
  writeFileSync(
    installedMain,
    `${originalMain}\n// Same-version upgrade fixture\n`
  );
  const upgradedStart = run(cliPath, ["start"], {
    allowFailure: true,
    cwd: installDirectory,
    env: daemonEnvironment,
  });
  assert(
    upgradedStart.includes("CLI/daemon build mismatch"),
    "An in-place upgrade changed the running daemon's reported identity"
  );
  writeFileSync(installedMain, originalMain);
  const unchangedHealth = await fetch(`${baseUrl}/api/health`);
  const unchangedBody = (await unchangedHealth.json()) as { pid?: number };
  assert(
    unchangedBody.pid === healthBody.pid,
    "Build checks replaced the running daemon"
  );
  const ui = await fetch(`${baseUrl}/`);
  const uiHtml = await ui.text();
  assert(
    ui.ok && uiHtml.includes("/assets/"),
    "Packed daemon did not serve the production UI"
  );
  const assetPath = uiHtml.match(
    /(?:src|href)="(?<assetPath>\/assets\/[^"]+)"/u
  )?.groups?.assetPath;
  assert(assetPath, "Packed production UI did not reference a built asset");
  const assetResponse = await fetch(`${baseUrl}${assetPath}`);
  assert(assetResponse.ok, "Packed daemon did not serve its built UI asset");

  assert(
    run(otherCli, ["stop"], {
      cwd: installDirectory,
      env: daemonEnvironment,
    }).includes("BranchBase stopped"),
    "Packed CLI did not stop"
  );
  await waitUntilStopped(`${baseUrl}/api/health`);
  const stoppedStatus = run(cliPath, ["status"], {
    allowFailure: true,
    cwd: installDirectory,
    env: daemonEnvironment,
  });
  assert(
    stoppedStatus.includes("BranchBase is stopped"),
    "Packed CLI status did not report the stopped daemon"
  );

  assert(
    run(otherCli, ["start"], {
      cwd: installDirectory,
      env: daemonEnvironment,
    }).includes("BranchBase started"),
    "The intended installation did not start after stopping the old daemon"
  );
  const restartedList = JSON.parse(
    run(otherCli, ["project", "list", "--json"], {
      cwd: installDirectory,
      env: daemonEnvironment,
    })
  ) as { projects?: unknown[] };
  assert(
    Array.isArray(restartedList.projects),
    "CLI requests did not recover after restarting from the intended installation"
  );
  run(otherCli, ["stop"], { cwd: installDirectory, env: daemonEnvironment });
  await waitUntilStopped(`${baseUrl}/api/health`);

  const daemonLog = readFileSync(
    pathModule.join(homeDirectory, ".branchbase", "server.log"),
    "utf-8"
  );
  assert(
    !daemonLog.includes("VITE"),
    "Packed daemon unexpectedly started the Vite development server"
  );
  console.log(
    "Packed BranchBase artifact passed install and daemon smoke tests"
  );
} finally {
  if (cliPath) {
    run(cliPath, ["stop"], {
      allowFailure: true,
      cwd: installDirectory,
      env: daemonEnvironment,
    });
  }
  rmSync(temporaryRoot, { force: true, recursive: true });
}
