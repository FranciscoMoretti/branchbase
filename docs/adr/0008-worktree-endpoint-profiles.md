# ADR 0008: Select endpoint profiles per worktree

Endpoint profiles in `.branchbase.json` define named sets of exact backing ports for per-worktree application groups. Each worktree locally selects a profile or the Project default. Unspecified ports retain the configuration's literal port or use stable automatic allocation. A profile cannot contradict a literal port, target infrastructure or selectable shared groups, or request the same port for multiple apps.

This extends ADR 0002's local assignments and ADR 0004's local choices without introducing configuration merging. Commands, environment templates, topology, and profile definitions remain in the repository file. Profile definitions participate in the reviewed configuration fingerprint; selecting among those definitions does not authorize new commands. There are no branch-name or directory-name conventions, slot numbers, or automatic branch selection rules.

This narrows ADR 0001's deferral of reserved ports: a worktree can opt into exact backing ports while other worktrees keep automatic allocation. Canonical authentication origins remain a separate decision.

Applying a profile is an explicit lifecycle operation, serialized with Start and Stop. BranchBase verifies the affected instances have no retained runs, managed processes, command contexts, live listeners, or routes. Runs that captured their endpoint bindings also block changes. It checks and reserves all proposed ports before atomically persisting the selection and assignments. Failure leaves the previous selection and port assignments intact. Obsolete assignments belonging to the same worktree and application groups can be retired only after those checks; another worktree's assignments are never stolen, including while stopped.

Exact requests never fall back to a different port. Stop, Restart, and daemon restart retain preferences and assignments. Selecting Project default removes profile pins; unaffected automatic assignments stay stable. A missing selected profile blocks new allocation until the user selects a valid profile or Project default. Captured runs remain stoppable even if their profile disappears.

Startup arguments, environment bindings, readiness, direct URLs, and Friendly URL routing all consume the same assigned endpoints. Binding remains on `127.0.0.1`, and direct URLs continue to use that host. Using `localhost` as an authentication origin is a separate choice: this feature does not make those browser origins interchangeable or configure OAuth callbacks.

The first interface is a worktree-level dashboard selector and the `select-endpoint-profile` command shared with the CLI. Selection never starts or automatically restarts apps. Shared instances, managed resource ownership, and resource connection profiles are unchanged.
