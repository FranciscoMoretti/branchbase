import { useState } from "react";

import type { WorktreeSnapshot } from "../../project/worktree-status-contract";
import { Button } from "../components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useCommand } from "../mutations";
import { ErrorNotice } from "./primitives";

export const WorktreeEndpointProfile = ({
  repoPath,
  worktree,
}: {
  repoPath: string;
  worktree: WorktreeSnapshot;
}) => {
  const change = useCommand("select-endpoint-profile", repoPath);
  const profile = worktree.endpointProfile;
  const [selection, setSelection] = useState<string | null | undefined>();
  if (!profile || (profile.choices.length === 0 && profile.id === null)) {
    return null;
  }
  const selected = selection === undefined ? profile.id : selection;
  const choice = profile.choices.find((item) => item.id === selected);
  const pins = Object.entries(choice?.ports ?? {}).flatMap(([groupId, apps]) =>
    Object.entries(apps).map(([appId, port]) => (
      <li key={JSON.stringify([groupId, appId])}>
        {groupId} / {appId}: port {port} (required)
      </li>
    ))
  );
  const blocked = profile.changeBlocked;
  return (
    <section
      className="product-settings-panel my-4"
      aria-label="Endpoint profile"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2>Endpoint profile</h2>
          <p className="product-muted">
            Choose this worktree’s local ports. Other worktrees keep their
            assignments.
          </p>
        </div>
        <Select
          value={selected === null ? "default" : `profile:${selected}`}
          disabled={blocked || change.isPending}
          onValueChange={(value) => {
            if (value) {
              setSelection(value === "default" ? null : value.slice(8));
              change.reset();
            }
          }}
        >
          <SelectTrigger aria-label="Choose endpoint profile">
            <SelectValue>
              {choice?.name ??
                (selected === null ? "Project default" : selected)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="default">Project default</SelectItem>
              {profile.choices.map((item) => (
                <SelectItem key={item.id} value={`profile:${item.id}`}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={
            blocked || change.isPending || (selected !== null && !choice)
          }
          onClick={() =>
            change.mutate({
              profileId: selected,
              repoPath,
              worktreeId: worktree.id,
            })
          }
        >
          {change.isPending ? "Applying…" : "Apply endpoints"}
        </Button>
      </div>
      {pins.length > 0 ? <ul className="product-muted">{pins}</ul> : null}
      <p className="product-muted">
        {pins.length > 0 ? "Apps not listed use" : "Apps use"} their configured
        ports or stable automatic assignments.
      </p>
      <p className="product-muted">
        {blocked
          ? "Wait for setup and lifecycle operations, and stop apps using these endpoints before applying."
          : "Applying reserves ports without starting apps. Occupied ports produce a conflict."}
      </p>
      {profile.error ? (
        <p role="alert" className="text-destructive">
          {profile.error}
        </p>
      ) : null}
      <ErrorNotice error={change.error} />
    </section>
  );
};
