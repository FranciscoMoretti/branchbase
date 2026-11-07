# Named managed resources

A profile can connect an infrastructure group to any named instance in the machine-wide registry:

```json
{ "policy": "managed", "resource": "local-database", "instance": "1" }
```

The consumer's `.branchbase.json` keeps an infrastructure group declaring the endpoint and output names it uses. Its Start/Stop placeholders are never executed for a `managed` connection. Its applications map outputs explicitly, for example `"DB_NAME":"{appGroups.database.outputs.database}"` and `"DB_PORT":"{appGroups.database.apps.database.port}"`. Declare public output names on the consumer group, with empty strings as interface placeholders.

## Repository declarations

Declare owned resource files in the primary checkout’s `.branchbase.json`:

```json
{
  "managedResources": {
    "local-database": { "file": "infra/database.json" }
  }
}
```

These fields are added alongside `version`, `setup`, `appGroups`, and `profiles`. Opening or refreshing the project discovers its definitions automatically. The Infrastructure page identifies resources declared by this project and offers **Review definition**; execution still requires approval of the exact resource revision. Discovery starts nothing.

Paths resolve from the primary checkout, even when opening a linked worktree. Each declaration key must match the definition’s `id`. Ownership declarations are project-level; worktree-specific configurations select connections, while the primary configuration declares owners. A separate clone cannot silently take ownership of the same resource ID. Consumer-only projects should omit the declaration and reference the existing resource through their profiles. Removing a declaration does not unregister or stop a shared resource already registered on the machine.

## Inspecting resources in the UI

Infrastructure opens with **Project connections**: selected instances, endpoint addresses, and the worktrees that selected them. Selection is configuration, not evidence of active traffic. Expand **Resources on this machine** to inspect managed definitions and external connections across projects; definitions declared by the current project appear first.

Each named instance shows its observed status and active consumer count. Start is available for stopped, approved instances; Stop and Restart are disabled while consumers or manual commands use an instance. Review definition shows the authoritative owner directory and complete recipe, including declared public outputs. A missing observation is shown as unavailable, not stopped.

A worktree with healthy infrastructure and stopped applications says **Applications stopped · infrastructure running**. Execution distinguishes a foreground process from a resource running without one. Usage metrics cover tracked host processes and worktree files; Docker CPU, memory, and volumes are not included.

## Owner definition

Create a version-controlled JSON file or a user-local definition:

```json
{
  "version": 1,
  "id": "local-database",
  "name": "Local database",
  "directory": ".",
  "files": ["database.ts"],
  "idle": "stop-when-unused",
  "recipe": {
    "apps": { "database": { "protocol": "tcp" } },
    "env": { "PORT": "{apps.database.port}", "INSTANCE": "{instance.id}" },
    "start": { "argv": ["bun", "database.ts"] },
    "stop": "process"
  },
  "instances": {
    "0": {
      "ports": { "database": 5432 },
      "outputs": { "database": "core-api-0" }
    },
    "1": {
      "ports": { "database": 5532 },
      "outputs": { "database": "core-api-1" }
    }
  }
}
```

`directory` resolves relative to the definition file and is the authoritative execution directory. Instance names are scoped to the registered resource ID. Resource IDs cannot be rebound silently to a different owner file. Use a distinct ID for an unrelated clone.

The Infrastructure page registers the file and shows its recipe before approval. Registration and viewing start nothing. Alternatively use `branchbase execute register-managed-resource --input '{"repoPath":"/project","definitionPath":"/owner/resource.json"}'`, review the returned definition/revision, then `approve-managed-resource` with `repoPath`, `resource`, and that exact `revision`.

`files` must include local command files and all transitive scripts, Compose files, and build inputs that affect the lifecycle. Their contents and resolved locations participate in approval. Changes require approval; an active run retains its old revision. Restore the old revision to stop it safely before approving and starting the replacement. Stable instance and volume identities survive recipe changes. Do not use disposable consumer worktrees as owner directories.

## Ports, outputs, and lifecycle

App endpoints can set `port` explicitly, while named resource instances override endpoint ports through `ports`. Conflicts fail visibly; there is no fallback to a random port. Omit a port to request dynamic allocation. Once assigned, an instance retains its backing port; changing an assigned fixed port requires explicit reconciliation rather than silent reassignment.

Outputs are public strings derived from configuration. They may interpolate endpoint tokens or `{instance.name}` / `{instance.id}`. Use separate outputs for host-local and container-reachable URLs. There is no arbitrary expression language or command-discovered output mechanism.

Optional `build.argv` runs only through **Build**, or `build-managed-resource` with `resource` and `instance`. It does not start the resource. Build inputs participate in the same revision fingerprint; there is no automatic build cache or implicit rebuild.

A detached resource must declare `status.argv`. BranchBase uses its exit code, not stdout or a returned instance ID:

- `0`: running.
- `1`: stopped by default. Set `status.stoppedExitCodes` to other nonzero codes when needed; an empty array treats every nonzero exit as an error.
- Any other exit code, signal, launch failure, timeout, or output-limit failure: unknown/error, not stopped. Lifecycle operations fail rather than accepting an unknown result; dashboard health remains partial until status can be checked successfully.

For example, a service CLI that uses exit `3` for stopped can be configured as follows (replace `service-cli` with your actual command):

```json
{
  "status": {
    "argv": ["service-cli", "status", "--instance", "{instance.name}"],
    "stoppedExitCodes": [3]
  }
}
```

Status uses the owner's execution directory and selected instance environment. Scope Start, Stop, and Status to the same native identity, such as a Compose project name, container name, or service name. Commands remain responsible for validating their target; a successful exit is not independent proof of ownership. In particular, `docker compose ps` succeeding does not by itself mean a stack is running. BranchBase retains its internal instance ID for state, consumers, and optional command bindings, but no command must return it.

Status runs with a five-second timeout and bounded output. Endpoint readiness remains separate: status must indicate running and every required endpoint must be ready before consumers start or HTTP routes are exposed.

When upgrading from the previous JSON status contract, stop detached resources with the previous BranchBase version and unchanged recipe first. Update status commands to return exit codes, then approve their new definitions before starting again. The normalized exit-code policy changes the approved revision, preventing captured JSON-era runs from being silently reinterpreted.

Stopping one consumer protects all other consumers across projects. The owner's `idle` policy alone decides whether to stop after the final consumer. Stop commands must preserve data; destruction and migration orchestration are not included.

## Local inputs and manual commands

Declare local values as `inputs: {"TOKEN":{"file":"/absolute/private/token"}}` on the group. Files are read when commands execute, including after daemon restarts. Do not rely on the daemon inheriting your interactive shell's environment. Precedence is group defaults, declared local inputs, then selected connection bindings. Descriptors, not secret values, are persisted. Keep credentials out of public outputs and literal command arguments. Commands with input files suppress persisted stdout/stderr; manual commands still use the invoking terminal.

For a selected application, execute an ordinary command with its captured connection context:

```sh
branchbase exec --repo /project --worktree WORKTREE_ID --group applications -- pnpm db:migrate
```

This directly invokes the supplied command without a shell. It does not select a migration order, migrate on Start, or change shared Temporal queues. It resolves connections without starting applications or resources, so it also works before the application can start. Start the required infrastructure explicitly if the command needs it. A persisted reservation protects the selected resources until the CLI finishes. If the CLI is forcibly killed, the reservation remains conservatively in `resources.json`; release its ID with `release-command-context` after verifying the command has exited. Worktree and group IDs make the selection unambiguous across projects. One application instance per group per checkout remains the initial supported model.

## Alaro adapter

The Alaro checkout has `branchbase/infra.json`, `scripts/branchbase-infra.py`, and `scripts/branchbase-config.py`. Generate an application selection once per checkout with `python3 scripts/branchbase-config.py 0` (or `1`, `2`, `3`); the generator refuses to overwrite an existing configuration. Application instances 0/1 default to infrastructure 0, and 2/3 to infrastructure 1. Use the checkout configuration preference for each separately generated worktree config.

The adapter receives explicit ports, names, and identity. It preserves `alaro-0`/`alaro-1` Compose projects and data volumes, never edits `.env.instance`, and refuses to take over unlabeled or differently owned containers. Initial adoption of an existing unmanaged stack is an explicit operator step. It keeps Stop separate from cleanup. Datadog TCP/UDP ports are 8126/8125 for instance 0 and 8226/8225 for instance 1; the adapter checks UDP availability as well as the TCP endpoints tracked by BranchBase.

Alaro's existing `env.sh` and settings sources preserve injected environment variables above TOML defaults; `turbo.json` uses loose environment propagation. BranchBase injects both legacy and nested setting names, database/bucket metadata, and host/container URLs. The configured legacy application-worker port is preserved as an environment binding; the inspected checkout has no separate `dev:worker` package task, so the adapter does not invent a listener for it. Temporal namespaces and queues stay under Alaro's existing configuration.
