import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type {
  BranchBaseCommandInput,
  BranchBaseCommandName,
} from "../application/command-contract";

type Effect = "none" | "folders" | "catalog" | "project" | "runtime" | "logs";

const effects = {
  "add-development-folder": "folders",
  "approve-managed-resource": "runtime",
  "build-managed-resource": "runtime",
  "clear-logs": "logs",
  "create-app-group-instance": "runtime",
  "create-worktree": "runtime",
  "delete-worktree": "runtime",
  "enable-resource-profiles": "runtime",
  "initialize-repository": "project",
  "operate-managed-resource": "runtime",
  "pick-repository": "none",
  "preview-repository-config": "none",
  "preview-resource-profile": "none",
  "register-managed-resource": "runtime",
  "register-resource": "runtime",
  "release-command-context": "none",
  "remove-development-folder": "folders",
  "remove-project": "project",
  "resource-command-context": "none",
  "restart-apps": "runtime",
  "restart-running-apps": "runtime",
  "retry-apps": "runtime",
  "revoke-trust": "project",
  "save-project": "catalog",
  "scan-development-folders": "folders",
  "select-app-group-instance": "runtime",
  "select-endpoint-profile": "runtime",
  "select-resource-profile": "runtime",
  "select-worktree-config-source": "runtime",
  "setup-all-apps": "runtime",
  "start-all-apps": "runtime",
  "start-apps": "runtime",
  "stop-all-apps": "runtime",
  "stop-apps": "runtime",
  "trust-repository": "project",
  "update-repository-config": "runtime",
} satisfies Record<BranchBaseCommandName, Effect>;

export const invalidateCommandQueries = <Name extends BranchBaseCommandName>(
  client: QueryClient,
  command: Name,
  input: BranchBaseCommandInput<Name>
): void => {
  const effect = effects[command];
  const keys: QueryKey[] = [];
  const repoPath = "repoPath" in input ? input.repoPath : undefined;
  if (effect === "folders") {
    keys.push(["development-folders"], ["projects"]);
  } else if (effect !== "none" && effect !== "logs") {
    keys.push(["projects"]);
  }
  if (repoPath && (effect === "project" || effect === "runtime")) {
    keys.push(
      ["project-status", repoPath],
      ["workspace", repoPath],
      ["observation", repoPath]
    );
  }
  if (repoPath && effect !== "none") {
    keys.push(["activity", repoPath], ["activity", "all"]);
  }
  if (repoPath && (effect === "logs" || effect === "runtime")) {
    // Several worktrees can select the same instance. Its output changes for
    // every alias, including after a partially failed lifecycle command.
    keys.push(["logs", repoPath]);
  }
  // Query refreshes report their own loading/errors; they must not keep a
  // completed command pending (for example, an open profile-switch dialog).
  for (const queryKey of keys) {
    void client.invalidateQueries({ queryKey });
  }
};
