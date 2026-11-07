# Shared managed resources and independent application instances

Date: 2026-10-27

Status: Accepted requirements. Implemented interfaces are documented in the [managed resources guide](../managed-resources.md) and [ADR 0007](../adr/0007-independent-managed-resources.md).

## Purpose

Apps and infrastructure should use the same basic lifecycle model, with infrastructure instances having their own identity and connections. Sharing determines who can use an instance; it must not determine whether BranchBase can manage it.

This document records the requirements for named managed infrastructure, informed by an application with independent application and infrastructure selections. It supersedes the restriction that resources shared across projects must be externally managed. Repository-specific adapters remain outside BranchBase.

## Problem

The original resource-profile implementation offered a project-default managed instance, a managed instance dedicated to a worktree, or an externally managed connection. Those choices could not express several worktrees sharing a second named managed instance. They also could not express BranchBase-managed resources shared across separate projects or clones.

Alaro demonstrates the missing case. Its application instance number and infrastructure instance number are independent. Most application instances use infrastructure instance `0`. Work that needs a different database schema can use infrastructure instance `1`, and several application instances can share that infrastructure instance.

An infrastructure selection is more than a host and port. It also selects database names, storage buckets, and other connection metadata. Repeating that metadata in each application or profile would make configuration inconsistent and difficult to maintain.

The integration must preserve Alaro's observable behavior, including its current numbered ports, while adapting its scripts to explicit BranchBase inputs. BranchBase must not acquire Alaro-specific naming, folder, or port-arithmetic conventions.

## Required behavior

The central acceptance example is:

| Application instance | Example source checkout | Infrastructure instance |
| --- | --- | --- |
| `0` | Main | `0` |
| `1` | UI changes | `0` |
| `2` | Migration-related development | `1` |
| `3` | Testing the same infrastructure changes | `1` |

Each application can stop independently. Stopping an application must not stop infrastructure still used by another consumer. Switching a connection must not change the identity of the application instance. Infrastructure remains identifiable when an originating consumer worktree is removed.

Sharing must work both among worktrees of a project and across separately tracked projects. Instance names such as `0` and `1` are local to a resource definition; they must not accidentally identify another project's unrelated instance with the same name.

## Domain model

| Concept | Responsibility |
| --- | --- |
| Resource definition | A recipe: commands, execution directory, inputs, endpoint declarations, readiness, and connection outputs. |
| Resource instance | A concrete resource with stable identity, a name such as `0` or `1`, explicit parameters, and associated persistent data. |
| Application instance | An independently identifiable application group associated with a source checkout, with its own ports and selected connections. |
| Connection | A binding from a consumer's logical dependency to a particular resource instance. |
| Profile | A convenient preset for selecting connections, including defaults or dedicated-instance creation. It is not itself a running environment. |

Managed and externally managed resources remain distinct ownership modes. Both can supply connections. Only resources owned by BranchBase receive its lifecycle controls.

The initial Alaro acceptance scenario uses one application instance per checkout. Whether multiple simultaneous application instances from the same checkout are supported is a separate implementation decision; it must not force application and infrastructure instance numbers to match.

## Design requirements

### 1. Explicit ports that preserve Alaro behavior

Adapt Alaro's commands to accept BranchBase-provided inputs. Preserve the existing endpoint values:

| Endpoint                     | Instance `0` | Instance `1` |
| ---------------------------- | ------------ | ------------ |
| Application API              | 8000         | 8010         |
| Application worker           | 8001         | 8011         |
| Temporal worker endpoint     | 8002         | 8012         |
| Dashboard                    | 3000         | 3010         |
| Infrastructure Postgres      | 5432         | 5532         |
| Infrastructure OnlyOffice    | 8080         | 8180         |
| Infrastructure MinIO API     | 9000         | 9100         |
| Infrastructure MinIO console | 9001         | 9101         |
| Infrastructure Redis         | 6379         | 6479         |
| Infrastructure Temporal      | 7233         | 7333         |
| Infrastructure Temporal UI   | 8233         | 8333         |

The two sets are independent: application instance `1` may connect to infrastructure instance `0`.

Begin with explicit instance values rather than introducing an arithmetic expression language. Fixed ports require availability and ownership checks. A conflict must produce an actionable error; BranchBase must not silently substitute another port. Dynamic ports can remain available for configurations that request them.

All Alaro-specific choices belong in Alaro's configuration/scripts. BranchBase owns the generic ability to resolve and validate configured ports.

### 2. Resource outputs for connection metadata

Each instance defines its connection description once. For illustration only:

```yaml
instance: "1"
outputs:
  postgres:
    host: localhost
    port: 5532
    database: core-api-1
  minio:
    host: localhost
    port: 9100
    bucket: alaro-local-1
```

Applications explicitly map these outputs to their existing environment variables:

| Application variable       | Value supplied from the selected infrastructure |
| -------------------------- | ----------------------------------------------- |
| `db__DB_HOST`              | Postgres host                                   |
| `db__DB_PORT`              | Postgres port                                   |
| `db__DB_NAME`              | Postgres database name                          |
| `storage__S3_ENDPOINT_URL` | MinIO endpoint URL                              |
| `storage__STORAGE_PATH`    | Storage URI containing the selected bucket      |

Other bindings include Temporal and Redis endpoints and the distinction between host-local addresses and addresses reachable from containers, such as `host.docker.internal`. Do not assume one URL is reachable from every consumer context.

Initially, outputs are configuration-derived. Defer commands that discover outputs dynamically until a concrete resource requires them. The YAML above illustrates the requirement; the implemented JSON schema and interpolation syntax are documented in the managed resources guide.

### 3. A generic lifecycle for managed resources

A managed definition can provide:

- **Build:** optional, explicit preparation.
- **Start:** launch the configured resource instance.
- **Stop:** stop that exact instance while preserving its data.
- **Status/readiness:** determine whether the intended instance is running and usable.
- **Endpoints and outputs:** provide consumers with connection values.

For foreground processes, BranchBase can track the owned process and check readiness. For detached resources such as Docker Compose, it needs a status command or equivalent ownership evidence as well as readiness checks. A port accepting traffic is not sufficient proof that the intended stack is running. Status commands target the selected instance through arguments and environment. Their exit codes report running, stopped, or an observation error; they do not return a BranchBase-specific payload. See the managed resources guide.

Every definition has an explicit execution directory. Definitions may live in a repository or user-level BranchBase configuration. A machine-wide registry records managed instance identity and its authoritative owner/definition. Consumers reference the instance; they do not copy its lifecycle commands into every project.

This allows local resources to be managed independently of the repositories consuming them. It does not require moving all version-controlled configuration into one global file. Do not implicitly run shared-resource commands from the current consumer checkout.

Start resolves the selected instances, starts required managed dependencies if needed, waits for readiness, and then starts the application. Merely viewing a resource or changing a stopped application's connection starts nothing. A running application's connection changes only through an explicit restart/apply operation.

Lifecycle serialization and consumer protection must work across project boundaries. Once the last consumer stops, a resource's idle policy can keep it running or stop it. Idle policy must have one deterministic interpretation for the shared instance rather than conflicting behavior from different consumers; the owner definition supplies this policy.

Stop and destruction are separate operations. This iteration must not map ordinary Stop to Alaro's cleanup command, which deletes volumes.

### 4. Stable identity and configuration revisions

Separate:

1. Stable resource-instance identity.
2. The approved resource-definition/configuration revision.
3. The resolved configuration currently used by a running instance.

Changing an application command must not create a new infrastructure instance. Changing the infrastructure recipe should show that rebuild/restart or an explicit reconciliation is required; it must not silently select a different database or volume identity.

Keep explicit command approval. Separating resource compatibility from the full project fingerprint is not permission to bypass approval when a lifecycle recipe changes.

Capture the resolved instance identity and lifecycle bindings associated with a run. Stop must target that same instance even if the user subsequently changes a profile, edits `.env.instance`, or changes configuration. The implementation must account for changes to referenced scripts and execution directories as well as command arguments; persisting an argument list alone does not freeze the behavior of a mutable script.

### 5. Environment variables remain the application interface

Support both directions with distinct responsibilities:

| Direction | Purpose |
| --- | --- |
| Environment to BranchBase | Explicitly declared inputs such as credentials and user-local overrides. |
| BranchBase to launched command | Resolved ports, resource outputs, and selected connection values. |

For managed launches, inject the resolved values directly into the process environment. Avoid rewriting `.env.instance` whenever a connection changes. Existing file-based workflows may require a compatibility adapter during adoption, but file mutation should not be the core selection model.

The agreed precedence is:

```text
project defaults -> declared local environment inputs -> selected instance bindings
```

An ambient inherited `DB_PORT` must not silently redirect an application away from the infrastructure it selected. Adapt Alaro's wrappers so subsequent dotenv/direnv loading does not overwrite the authoritative instance bindings. Do not assume the daemon inherited the correct interactive shell environment.

Manual commands should be able to obtain the same selected connection context. The CLI resolves that context explicitly:

```sh
branchbase exec --repo /project --worktree WORKTREE_ID --group applications -- pnpm db:migrate
```

The project, worktree, and group identify the application unambiguously. The command receives that application's selected resource bindings.

Migration orchestration is explicitly out of scope for this iteration. Correct connection targeting remains required. Starting an application must not implicitly run that branch's migrations against shared infrastructure.

Credential inputs require an explicit handling policy. Do not expose them as ordinary public outputs or print them in status, previews, or logs. Capturing lifecycle bindings must not be interpreted as a requirement to persist the entire inherited process environment in plaintext.

### 6. Accepted shared-worker behavior

The user accepts that Alaro remains responsible for shared Temporal namespaces and queues in this iteration. Different application ports do not guarantee separate processing or data behavior. BranchBase should accurately describe connections without claiming complete isolation.

Alaro may later choose application-specific namespaces or queue names. Automatically rewriting those settings, creating namespaces, or changing worker routing is not part of this spec.

## Alaro adoption requirements and pitfalls

- Replace implicit selection through `.env.instance` in infrastructure lifecycle commands with explicit instance inputs. Start and Stop must use the same identity.
- Map all required application settings, including database and bucket names, not just HTTP/TCP ports.
- Preserve the existing numbered endpoints while making BranchBase's configured bindings authoritative.
- Account for Docker-to-host callbacks and storage URLs. A host-only friendly URL is not automatically a valid container callback URL.
- Preserve the distinction between `devenv:stop` and `devenv:cleanup`.
- Resolve or explicitly account for the Datadog ports: Compose exposes default TCP 8126 and UDP 8125, but the inspected startup script does not offset them. Two stacks can contend for those ports. The integration must not claim full multi-instance support while ignoring this conflict.
- Update or replace stale environment-loading assumptions: the inspected `scripts/env.sh` loads TOML defaults, while `.envrc.template` loads the environment files.
- Reuse the existing named-instance capability in BranchBase where appropriate. Remove the profile restriction that limits project resources to the default instance, rather than adding another unrelated instance mechanism.
- Extend resource ownership, consumer tracking, and operation serialization beyond repository-local state.

## Acceptance criteria

1. Application instances `0` and `1` can use managed infrastructure `0`, while instances `2` and `3` share managed infrastructure `1`.
2. The relationship works among worktrees and across separately tracked projects with an explicit resource reference.
3. The configured Alaro ports remain unchanged. Conflicting ports fail visibly without fallback allocation.
4. Database, bucket, and endpoint bindings come from the selected infrastructure instance and reach all relevant application processes.
5. Manual commands can receive the same selected connection context without implementing migration orchestration.
6. Changing a stopped application's selection launches nothing. Changing a running application's connection requires an explicit restart/apply operation.
7. Starting a consumer reuses a ready resource or starts it once. Concurrent consumers do not independently create the same resource.
8. Stopping one application does not stop infrastructure used by another. Consumer protection works across projects.
9. Stop targets the instance captured at startup even after local selections change. Ordinary Stop preserves persistent data.
10. Unrelated application configuration changes do not change infrastructure identity. Resource recipe changes remain visible and require appropriate approval/reconciliation.
11. Foreground and detached resource lifecycles have suitable running/readiness evidence; an unrelated listener cannot be mistaken for the intended managed resource.
12. Externally managed resources continue to provide connections without BranchBase taking over their lifecycle.

## Implementation decisions and boundaries

The requirements above are separate from these implementation choices, recorded in [ADR 0007](../adr/0007-independent-managed-resources.md):

- Definitions use versioned JSON, explicit ports, named instance references, and configuration-derived public outputs.
- A machine-wide registry references an authoritative definition file and owner directory. Repository declarations discover those files without starting commands.
- Detached status commands use exit `0` for running and configurable nonzero codes for stopped (default `[1]`); other failures are unknown/error. Commands target the selected native instance explicitly. No returned instance ID or JSON payload is required.
- Approval includes declared lifecycle source files. Changed files require approval; stopping a captured run requires restoring its captured revision. Build is explicit, without automatic staleness caching.
- The owner definition sets the shared instance's idle policy.
- Local secret inputs are file descriptors read at execution time; their values are not persisted in run bindings or command logs.

Multiple simultaneous application instances from one checkout, immutable owner snapshots, dynamic command-derived outputs, data destruction, and migration orchestration remain outside this iteration.
