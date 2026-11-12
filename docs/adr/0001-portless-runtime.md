# ADR 0001: Use Portless as the local routing runtime

Status: Accepted on 2026-07-18.

This decision defines BranchBase's Portless ownership, endpoint, route, lifecycle, and environment semantics. The slot-free `.branchbase.json` and user-local state shapes are defined separately in [ADR 0002](./0002-repository-schema-and-local-state.md).

## Decision

Portless is an always-available implementation dependency, but it remains behind BranchBase's local-routing seam. BranchBase owns application identity, route names, backing endpoint allocation, readiness, lifecycle, and reconciliation. Portless only proxies an exact hostname to a backing endpoint.

The implementation uses a BranchBase-exclusive Portless state directory. This keeps route ownership unambiguous. Routes are explicit aliases rather than names inferred from commands or paths.

BranchBase uses Portless's public proxy API in a detached worker, launched with the packaged Node.js runtime. The worker reads the route store for each request, and BranchBase serializes route mutations within its exclusive state directory. Alias changes do not restart the shared proxy or disconnect existing applications.

This replaces the CLI proxy's filesystem-watcher cache. Browser testing and real routing tests exposed aliases remaining indefinitely stale despite successful route-file updates; relying on watcher delivery or retrying mutations did not provide a reliable publication guarantee. Portless still owns HTTP and WebSocket proxying, while BranchBase owns the worker's lifecycle and verifies publication independently. The dependency remains pinned to the existing fork commit, but production route freshness no longer depends on its watcher.

## Runtime constraints

- HTTP and WebSocket traffic, including Vite HMR, work through exact aliases.
- Route activation and deactivation are asynchronous and must be observed.
- A configured alias must be removed before its backing port can be released; otherwise a later foreign listener could receive traffic for the stale name.
- BranchBase uses the packaged Node.js runtime for the proxy worker and legacy Portless CLI compatibility. Running the proxy under Bun is not part of the supported contract.
- BranchBase does not depend on Portless's human-readable CLI output as a stable status protocol. It owns the state directory and verifies observable routes.
- HTTPS, an owned development domain, reserved literal localhost origins, and richer structured diagnostics remain follow-up capabilities.

Authentication providers do not consistently accept arbitrary `*.localhost` callback URLs. BranchBase therefore treats provider-constrained callback origins as a separate compatibility capability rather than weakening the normal per-worktree Friendly URL model. A canonical authentication origin or reserved literal `localhost:<port>` may be added after the lifecycle and isolation rules are proven in [issue #43](https://github.com/FranciscoMoretti/BranchBase/issues/43).

## Ownership boundary

BranchBase owns endpoint identity, route naming, Backing endpoint allocation, repository command trust, process lifecycle, environment construction, readiness, logs, and runtime reconciliation. Portless is an always-available local routing engine controlled through BranchBase-exclusive state. It owns proxying a configured hostname to a Backing endpoint, not application discovery or lifecycle.

BranchBase must not infer product identity from Portless process names, paths, ports, or aliases.

## Stable identity and names

BranchBase persists opaque local identities for each repository, worktree, App-group instance, and app endpoint. Display names, branches, and generated slugs are not identity. Stable logical app-group and app IDs in `.branchbase.json` associate checked-in definitions with their local identities.

Changing a display name does not change identity or an assigned Friendly URL. Changing a logical group or app ID is delete-and-create unless an explicit migration reconnects it. The first implementation uses canonical paths to associate repositories and worktrees, so moving one may require adding it again; stronger move detection is deferred.

Every Friendly URL includes a repository route label:

```text
http://<app>.<instance>.<repository>.localhost
```

The three labels are assigned once and persisted. A route label is the slug stored for one identity and used as its hostname segment. Repository route labels are unique within BranchBase's local routing namespace, instance route labels are unique within their repository, and app route labels are unique within their instance. A per-worktree instance reuses its worktree's route label; a selectable instance derives one from its user-visible name. A readable slug is used when available; if it is already reserved by a different identity in that scope, BranchBase appends a stable identity-derived suffix. Allocation must reject rather than overwrite any remaining duplicate hostname.

This makes URL allocation deterministic for an identity and removes the order-dependent rule where the first repository received an unqualified hostname.

## Backing endpoint allocation

Before Start, BranchBase materializes all Backing endpoints needed by every App-group instance selected for the worktree. Allocation is dynamic but stable for the lifetime of the local instance record, so ports do not change across Stop and Restart. BranchBase verifies availability before executing repository code and retains the assignment after route deactivation.

The normal model has no slots, stride, or required base ports. A repository may explicitly request a literal `port` or a `portFromEnv` dotenv value resolved from the worktree owning the run. Missing file values use the literal fallback or normal stable automatic assignment. Invalid values and conflicts fail before repository commands execute. BranchBase does not infer slot numbers or port arithmetic from names or paths.

A changed file-configured port may replace a stopped instance's Backing endpoint after the new port is reserved. Active runs retain their endpoints; changing a literal fixed port still requires explicit reconciliation. Friendly URL identity remains stable across a stopped file-port change.

## Independent runtime dimensions

BranchBase observes independent runtime dimensions rather than collapsing or persisting them as one health value:

- Process state: `stopped | starting | running | stopping | exited | failed`
- Per-app readiness: `waiting | ready | unready`
- Per-app route: `inactive | activating | active | deactivating | conflict | unavailable`

An active Lifecycle operation supplies transient Starting or Stopping state. Dashboard summaries such as Running, Partial, Stopped, Failed, and Routing error are live projections of operations, processes, listeners, readiness, and routes; BranchBase does not persist them as desired or observed status.

## Start

Start follows this order:

1. Verify that the controlled Portless runtime is available.
2. Allocate and durably record every Backing endpoint for the app group.
3. Construct the complete app-group environment.
4. Launch the repository-wide trusted command.
5. Verify each app's listener and configured readiness condition.
6. Activate an exact Friendly URL route only for a ready app.
7. Observe that Portless has published the exact hostname for the expected Backing endpoint.
8. Expose Open and Copy URL actions for that app.

Start and Open are separate actions. Knowing a Friendly URL before launch does not make it clickable before readiness and route activation are observed.

If only some apps become ready, BranchBase keeps the group process running, marks the group Partial, exposes links only for ready apps, and offers logs, retry, Restart, and Stop. It does not automatically terminate a useful partial process.

## Stop and Restart

Stop follows this order:

1. Deactivate each Friendly URL route.
2. Observe that each route is inactive.
3. Run the trusted repository Stop command when one is configured.
4. Terminate any surviving BranchBase-managed starter process.
5. Verify that app listeners have disappeared.
6. Retain the instance's stable Backing endpoint assignments for a future Start.

If route deactivation or a repository Stop command fails, BranchBase still terminates its managed process so Stop remains under user control. It keeps routes disabled where possible, quarantines any affected or still-listening Backing port, and does not make that port available to another process until both the route and listener are observed inactive. The app group reports a Stop failure that the dashboard can surface and retry.

Restart completes Stop before performing Start. It reconstructs the environment from stable Backing endpoints unless a declared dotenv port changed while the group was stopped. Endpoint identity and Friendly URLs remain stable, and the run captures its cross-group instance selections.

## Crash and recovery

A process crash changes the next live observation; BranchBase does not retain a Desired-running flag and does not auto-restart repository commands. Durable logs and BranchBase-created ownership records may explain the failure, but they are not a persisted Running or Failed status.

After BranchBase itself restarts, it may re-adopt a surviving managed process after verifying its identity, ownership, listeners, and routes. After a machine reboot, BranchBase does not automatically execute repository commands. Absent processes and listeners are simply observed as Stopped, and stale BranchBase-owned allocations are reconciled safely.

The routing worker also survives a daemon restart. Adoption verifies its persisted PID, process-start identity, runtime version, and proxy port; mismatched ownership fails closed. Startup failures clean up only the newly launched worker's resources.

A legacy CLI proxy without verifiable worker metadata must be stopped before the new runtime can start. BranchBase reports this condition instead of terminating an unverified PID automatically.

## Readiness and route verification

The default readiness condition is an owned TCP listener on the allocated Backing port. A repository may configure an HTTP readiness path and accepted status codes per app. TCP remains the default because valid development applications may return authentication, redirect, or not-found responses at `/`.

Readiness proves the application is accepting traffic on its Backing endpoint. Route activation separately proves that Portless owns the exact Friendly URL and has loaded the alias for the expected Backing endpoint. A route is `active` only after that publication is observed; successful completion of a Portless CLI command alone is insufficient.

Publication observation must not require a healthy upstream HTTP response. A registered alias whose backing app resets connections, times out, or returns `502` still counts as published once an independent Portless proxy probe confirms the proxy itself is answering. Upstream health remains a readiness concern. An unregistered Portless hostname does not.

## Environment

BranchBase determines the complete environment before launching the app-group command. Every binding is explicit in repository configuration. An app may expose:

- its Backing port;
- its direct URL; and
- its stable Friendly URL.

Friendly URLs are allocated before launch and may therefore be passed to peer applications even though dashboard links remain unavailable until routes are active. In configuration templates, an app's `url` denotes its Friendly URL and `directUrl` denotes its Backing URL.

BranchBase does not inject a generic `PORT` or `PORTLESS_URL` unless repository configuration explicitly maps that variable to one app binding. Provider variables such as a local certificate path are injected only when required and must not silently overwrite an explicit repository value. Changing the resolved environment requires Restart; BranchBase never mutates a running process environment.

## Portless failures

If Portless preflight fails, Start fails before BranchBase executes untrusted repository code.

If Portless becomes unavailable after the process launches, BranchBase keeps the process running, records a Degraded routing state, preserves logs, exposes direct endpoints for diagnostics, and offers route retry and normal lifecycle actions. It does not kill the process merely because local ingress failed.
