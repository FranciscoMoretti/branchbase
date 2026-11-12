# BranchBase

BranchBase is an open-source, macOS-first local development control plane for Git worktrees. It keeps each worktree's apps, ports, processes, logs, and Codex tasks in one place, so parallel work does not turn into a collection of terminals and forgotten conversations.

Use it when you regularly create worktrees, run several copies of the same app, or have multiple Codex tasks working in the same repository.

## What it gives you

- One dashboard for every worktree in a repository.
- Independently startable app groups, such as product apps and local infrastructure.
- Stable Friendly URLs, collision-free backing ports, listener detection, process ownership, and managed logs. App groups can be isolated per worktree or use explicitly selected named instances.
- Command review and trust before repository setup or lifecycle commands run.
- Every non-archived Codex task associated with each exact worktree path.
- Direct **Open task** and **New task** links into the Codex desktop app.
- Optional live Codex activity and automatic BranchBase context through the bundled plugin.

The core model is:

```text
repository
  -> worktrees
       -> app groups
            -> apps, ports, processes, and logs
       -> associated Codex tasks
```

## Quick start

### Requirements

- Core BranchBase: macOS, Git, [Bun](https://bun.sh/) 1.3 or newer, and `lsof` (included with macOS).
- Codex task discovery: a compatible Codex CLI or ChatGPT desktop app bundle.
- **Open task** and **New task**: ChatGPT desktop, which handles `codex://` links.
- Live status and automatic context: the bundled BranchBase plugin installed in Codex, with its hooks trusted.

Codex is optional, and the integration does not require an OpenAI API key.

### Run the current integration from `main`

The Codex integration is currently available from `main`:

```sh
git clone https://github.com/FranciscoMoretti/BranchBase.git
cd BranchBase
bun install --frozen-lockfile
bun run build
bun scripts/daemon.ts start --repo /path/to/your/repository
```

Open <http://127.0.0.1:3999>. BranchBase will inspect the repository's worktrees and ask you to review any repository commands before trusting them.

Use these commands to manage the source-run daemon:

```sh
bun scripts/daemon.ts status
bun scripts/daemon.ts stop
```

### Package installation

The npm package is named `branchbase` and requires Bun 1.3 or newer:

```sh
bun add --global branchbase
branchbase start --repo /path/to/your/repository
```

BranchBase 0.5.1 also installs `bbase` as a shorter CLI alias. Both commands use the same daemon, configuration, and state:

```sh
bbase start --repo /path/to/your/repository
bbase project list --json
bbase stop
```

When `branchbase` is installed as a project dependency, both commands are also available in package scripts. The package name and configuration import remain `branchbase` and `branchbase/config`.

### CLI-only use

Starting the daemon does not open a browser. The CLI and dashboard share the same daemon, command validation, and command-fingerprint approval rules.

```sh
bun scripts/daemon.ts daemon start
bun scripts/daemon.ts project list --json
bun scripts/daemon.ts project status --repo /path/to/repository --json
bun scripts/daemon.ts execute start-apps --input '{"repoPath":"/path/to/repository","worktreeId":"WORKTREE_ID","appGroupName":"APP_GROUP_ID"}'
bun scripts/daemon.ts logs --repo /path/to/repository --worktree WORKTREE_ID --group APP_GROUP_ID
bun scripts/daemon.ts dashboard --repo /path/to/repository
```

`execute` exposes the same commands as the dashboard, including configuration and trust approval. Review the configuration and fingerprints in Project status before approving commands. Failed requests are not automatically retried, avoiding accidental duplicate mutations. The daemon must be running for queries and commands; `help` lists the interface.

After upgrading or switching installations, daemon startup, status, dashboard opening, and CLI requests check the running daemon's build identity. The identity includes the canonical installation path and installed source/assets, so different builds of the same version are detected. A mismatch (including an older daemon without build identity support) exits with a restart instruction before sending application requests. Run `bbase daemon stop`, wait for the old daemon to exit, then `bbase daemon start` using the intended installation. For a source checkout, use `bun scripts/daemon.ts` in place of `bbase`. Build checks never stop the daemon or managed apps automatically, and `stop` remains available across build mismatches.

See [Architecture](docs/architecture.md) for module ownership and dependency rules.

## Codex integration

BranchBase matches Codex tasks to worktrees using the task's exact canonical working directory. It exposes every matching non-archived top-level task; the UI may emphasize the newest one, but the backend does not discard the others.

### Task discovery and desktop links

No plugin is required for the basic integration:

1. Start BranchBase for a repository.
2. Open that repository in the dashboard.
3. Select a worktree to see all of its associated Codex tasks.
4. Use **Open task** to continue an existing conversation or **New task** to open Codex at that worktree's path.

BranchBase starts a private `codex app-server` process and decodes only task names, IDs, timestamps, Git metadata, and exact working directories. Although a task-list response can contain a preview, BranchBase does not retain, project, or expose it, and it never requests full turns or transcripts with `thread/read`. If task discovery is unavailable, the rest of BranchBase continues to work; the **New task** link is still rendered and works when ChatGPT desktop is installed.

### Optional live status and automatic context

Install the bundled BranchBase plugin to add **Working**, **Waiting for approval**, **Ready**, and **Unknown** activity plus automatic BranchBase context:

```sh
codex plugin marketplace add FranciscoMoretti/BranchBase --ref main
codex plugin add branchbase@branchbase
```

Then restart the ChatGPT desktop app, keep the BranchBase daemon running, and open or resume a Codex task at a worktree whose root contains a valid `.branchbase.json`. Review and trust the BranchBase plugin hooks when Codex asks.

The context uses an explicit allowlist: canonical worktree path, branch, app and group labels, ports, URLs, and process/readiness state. This helps Codex use the correct running app instead of starting a competing server. Managed logs, environment values, repository command definitions, prompts, transcripts, and tool arguments or results are omitted. Hooks are fail-open: if BranchBase is stopped or the plugin is disabled, Codex continues normally and live activity eventually becomes Unknown.

See the official [Codex plugin](https://learn.chatgpt.com/docs/plugins) and [hook](https://learn.chatgpt.com/docs/hooks) documentation for the underlying installation and trust model.

## Discover projects without configuration

Use **Add project → Development folder** to watch a folder containing Git repositories, or choose **Single project** to add one repository. BranchBase includes linked worktrees even when their checkouts live outside that folder. No `.branchbase.json` is needed for observation.

On macOS, observed projects show associated TCP listeners, process start times, and sampled CPU and memory. Verified HTTP listeners have Open links; other listeners have copyable addresses. Processes are associated by working directory and Git root. BranchBase does not infer app groups, claim who launched a process, retrieve an external process's logs, or take control of it.

Development-folder scans run every 30 seconds while the dashboard is active; **Development folders → Scan now** refreshes them immediately. Scans go three levels deep, skip hidden and dependency directories and symlinks, and stop traversing once a repository is found. Each folder scan is limited to 2,000 visited directories and 100 repositories; up to 20 development folders can be watched. Removing a folder keeps discovered projects. Removing a project suppresses its rediscovery until it is explicitly added again.

**Configure app groups** creates a reviewed starter configuration. Command approval remains a separate step before Start or Setup can execute anything.

## Disk, RAM, and CPU

Repository cards and repository headers show **Disk** as the sum of their worktree folder sizes. Each worktree row shows its own **Disk** usage alongside its existing status and actions. **RAM** and **CPU** remain separate, explicitly labeled process metrics. Measurements appear automatically, including for repositories without `.branchbase.json`.

Disk scans run in the background, with at most two folders measured at once and a 30-second limit per folder. At most 64 scans wait in the queue; queued scans expire after 30 seconds without a status read, and the cache retains at most 512 folders. Cached values refresh every five minutes while viewed. Initial and partial measurements are labeled rather than presented as complete totals.

Sizes include dependencies, build output, and ignored files inside each folder. Symlinks and mounted filesystems are not traversed. External caches and container volumes outside the folders are excluded. The primary folder includes shared Git data. Project totals sum folder estimates; shared files or nested worktrees may be counted more than once, and filesystem storage sharing means measured size is not guaranteed space reclaimed.

Use a linked worktree's actions menu to **Delete worktree** when appropriate. The confirmation includes its path and measured size. BranchBase takes a fresh service observation before removal, protects the primary worktree, and never forces Git removal. A shared service owned by another worktree does not block deletion of an idle consumer. External processes can still start after the observation; BranchBase cannot lock launches from unrelated terminals. Dirty or locked worktrees are refused. Deletion removes ignored local files too, but keeps the Git branch.

## Repository configuration

Commit `.branchbase.json` at the repository root. The setup command prepares one worktree; each app group can then be started and stopped independently.

```json
{
  "$schema": "https://raw.githubusercontent.com/FranciscoMoretti/BranchBase/main/schema/branchbase.schema.json",
  "version": 1,
  "setup": { "argv": ["bun", "install"] },
  "appGroups": {
    "Product Apps": {
      "instances": { "mode": "per-worktree" },
      "start": { "argv": ["bun", "run", "dev:branchbase"] },
      "stop": "process",
      "env": {
        "WEB_PORT": "{apps.Web.port}",
        "API_PORT": "{apps.API.port}",
        "API_URL": "{apps.API.url}"
      },
      "apps": {
        "Web": { "protocol": "http", "readiness": "tcp" },
        "API": {
          "protocol": "http",
          "readiness": { "type": "http", "path": "/health" }
        }
      }
    },
    "Local Infrastructure": {
      "category": "infrastructure",
      "instances": { "mode": "selectable" },
      "start": { "argv": ["docker", "compose", "up", "-d"] },
      "stop": { "argv": ["docker", "compose", "down"] },
      "env": {
        "PGHOST": "{apps.Postgres.host}",
        "PGPORT": "{apps.Postgres.port}"
      },
      "apps": {
        "Postgres": { "protocol": "tcp", "readiness": "tcp" }
      }
    }
  }
}
```

Important configuration behavior:

- The Primary worktree's `.branchbase.json` is the Project default. Every worktree inherits it unless **This worktree** is selected as its Configuration source in App-group details → Configuration.
- A worktree-specific selection reads `.branchbase.json` from that worktree, so a branch can test different commands or App groups without changing its siblings. If the selected file is missing or invalid, BranchBase visibly falls back to the Project default while preserving the worktree-specific preference.
- Commands are argv arrays and run from the selected worktree root.
- With `"stop": "process"`, Start must remain in the foreground. BranchBase owns that process and terminates it on Stop.
- A command-based Stop is useful for detached infrastructure such as Docker Compose.
- Set `"category": "infrastructure"` on an App group to include its instances in the Infrastructure tab. The default is `"application"`; names do not determine category. Shared instances appear once, with their selecting worktrees.
- App groups default to `"instances": { "mode": "per-worktree" }`, which gives every worktree its own stable endpoints without any slot or port setup.
- `"mode": "selectable"` creates a shared Default instance and lets each worktree select or create named alternatives—for example, an isolated Docker Compose database for a migration experiment.
- BranchBase assigns each instance collision-free loopback backing ports and keeps them stable across Stop and Restart.
- HTTP Apps receive stable `*.localhost` Friendly URLs through Portless. TCP Apps expose their assigned host and port to command templates.
- App-group environment values can be literals or templates such as `{apps.Web.port}`, `{apps.Web.directUrl}`, and `{apps.Web.url}`. A group may reference another selected instance's host, port, direct URL, or Friendly URL with tokens such as `{appGroups.Local Infrastructure.apps.Postgres.port}`.

For a repository without configuration, BranchBase can prepare a starter file based on common runtime markers. Undetected commands are clearly labeled and require editing for the project. Creating the file does not approve commands; you review and trust the resulting fingerprint before anything runs.

### Repository tooling API

Bun scripts can reuse BranchBase's checked-in configuration contract:

```ts
import {
  findBranchBaseConfig,
  loadBranchBaseConfig,
  resolveStartCommand,
  type ResolvedBranchBaseAppGroups,
  type BranchBaseConfig,
} from "branchbase/config";
```

The public API exposes configuration schemas and types, discovery/loading, and command resolution against an active run's endpoint values. Endpoint allocation, Portless routing, process ownership, command execution, trust, and controller internals remain private.

## Architecture

Maintained decisions and compatibility notes live in:

- [ADR 0001: Portless runtime](docs/adr/0001-portless-runtime.md)
- [ADR 0002: Repository schema and local state](docs/adr/0002-repository-schema-and-local-state.md)
- [ADR 0003: Adopt the BranchBase namespace](docs/adr/0003-branchbase-namespace.md)

## Development

```sh
bun install
bun run dev
bun run lint
bun run test:types
bun run test
bun run test:integration
bun run build
```

`bun run dev` uses an isolated development session for the current BranchBase checkout. It chooses collision-free dashboard and Portless ports, prints the dashboard URL, and keeps its state, trust decisions, managed-process records, logs, routes, and Codex hook capability separate from the production daemon under `~/.branchbase/development/`. An installed or source-run daemon may remain running while BranchBase is developed.

Only one development server may own a checkout's session at a time. Different BranchBase checkouts receive different sessions and can run concurrently. Before development starts an app group, it checks the production BranchBase state and refuses to run the repository Start command if production still has a verified process or listener for the same worktree. This guard is read-only and only affects BranchBase development.

Stopping the foreground development server releases its ownership lease and stops only its own Portless proxy. Codex task discovery remains available, but the isolated development hook capability does not replace a running production daemon's capability.

`BRANCHBASE_PORT` and `BRANCHBASE_PORTLESS_PORT` may be used when a fixed development port is required. They are not needed for normal development.

Git, configuration, port inspection, process ownership, and command rules stay behind `WorkspaceController` and its internal modules.

## Worktree endpoint profiles

Keep one shared configuration while giving a chosen worktree exact local ports. Add an optional section to `.branchbase.json`, using existing group and app IDs:

```json
"endpointProfiles": {
  "localhost": {
    "name": "Localhost",
    "ports": { "development": { "web": 3000, "api": 8000 } }
  }
}
```

In the worktree view, select **Endpoint profile → Localhost → Apply endpoints**. Other worktrees keep their selections and assignments. Worktrees on Project default use literal configured ports, or stable automatic assignments when no literal port is declared. Existing environment and argv bindings such as `{apps.web.port}` receive the assigned value.

The same operation is available without the dashboard:

```sh
bbase execute select-endpoint-profile --input '{"repoPath":"/path/to/project","worktreeId":"WORKTREE_ID","profileId":"localhost"}'
```

Use `"profileId":null` to return to Project default. Find worktree IDs with `bbase project status --repo /path/to/project --json`.

Apply only after stopping the affected apps and releasing `bbase exec` command contexts. All requested ports are checked before the selection changes; a conflict leaves the previous assignments intact. Another worktree's reservations are protected even while stopped. Stop and Restart retain the selection. Changes do not start apps or alter Friendly URLs. Profiles support per-worktree application groups; shared and infrastructure endpoints retain their existing configuration. A profile cannot contradict an app's literal `port`.

Direct URLs continue to use `127.0.0.1`. A tool configured for `localhost` can use the selected port, but the two hostnames remain different browser origins; authentication-origin configuration is separate.

## Resource profiles

Use shared project infrastructure, isolated resources per worktree, or existing services on your machine. Profiles support branch rules, connection previews, dependency startup, and explicit restarts when switching. See the [resource profiles guide](docs/resource-profiles.md) for configuration and Docker Compose examples.

Declare infrastructure definition files in `.branchbase.json` under `managedResources` to discover them automatically. Named managed resources can also serve applications across projects, with independent lifecycle commands, fixed ports, connection outputs, and command approval. See the [managed resources guide](docs/managed-resources.md).

## Documentation site

The user guides live in `website/content` and use [Blume](https://useblume.dev). The docs are a separate private package, so their dependencies are not part of the BranchBase CLI installation. Use Node.js 22.19 or newer for Blume and Bun for package management:

```sh
bun install --cwd website --frozen-lockfile
bun run docs:dev
```

Build and validate before publishing:

```sh
bun run docs:build
bun run docs:validate
```

If the docs development server is running, use `bun run docs:build --isolated` to verify a build without interrupting it. That build stays in `website/.blume-verify/dist`.

The static output is `website/dist`. Generated runtime files, build output, and local secrets are ignored. Set `deployment.site` in `website/blume.config.ts` when choosing the production domain to enable canonical URLs and the sitemap. No deployment is configured yet.

## License

Apache-2.0
