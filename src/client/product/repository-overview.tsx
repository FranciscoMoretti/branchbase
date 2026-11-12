import { ArrowRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { appGroupIsRunning } from "../../project/worktree-status-contract";
import type { WorktreeSnapshot } from "../../project/worktree-status-contract";
import { QueryContent } from "./async-state";
import { hrefFor, useActivity } from "./data";
import { Blank } from "./primitives";
import { runtimeSummary } from "./runtime-summary";

export const worktreeNeedsAttention = (worktree: WorktreeSnapshot): boolean =>
  Boolean(
    worktree.configuration.error ||
    !worktree.configuration.trusted ||
    worktree.endpointProfile?.error ||
    worktree.setupState === "failed" ||
    runtimeSummary(worktree).value === "partial"
  );

export const overviewWorktrees = (worktrees: WorktreeSnapshot[]) =>
  worktrees
    .filter(
      (worktree) =>
        worktree.setupState === "running" ||
        worktree.appGroups.some(
          (group) => appGroupIsRunning(group) || group.pending
        )
    )
    .slice(0, 4);

export const OverviewSectionHeading = ({
  title,
  href,
  linkLabel,
}: {
  title: string;
  href: string;
  linkLabel: string;
}) => (
  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
    <h2 className="product-section-title !mb-0">{title}</h2>
    <a className="product-link" href={href}>
      {linkLabel}
      <ArrowRightIcon />
    </a>
  </div>
);

const attentionLabel = (worktree: WorktreeSnapshot) => {
  if (worktree.configuration.error) {
    return "Configuration needs attention";
  }
  if (!worktree.configuration.trusted) {
    return "Review commands";
  }
  if (worktree.endpointProfile?.error) {
    return "Endpoint profile unavailable";
  }
  return runtimeSummary(worktree).label;
};

export const OverviewAttention = ({
  worktrees,
  repoPath,
}: {
  worktrees: WorktreeSnapshot[];
  repoPath: string;
}) => {
  const attention = worktrees.filter(worktreeNeedsAttention);
  if (!attention.length) {
    return null;
  }
  return (
    <section className="mb-8" aria-label="Worktrees needing attention">
      <OverviewSectionHeading
        title={`Needs attention · ${attention.length}`}
        href={hrefFor({ repo: repoPath, view: "worktrees" })}
        linkLabel="All worktrees"
      />
      <div className="divide-y rounded-lg border">
        {attention.slice(0, 4).map((worktree) => (
          <a
            key={worktree.id}
            className="hover:bg-muted/40 flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
            href={hrefFor(
              worktree.appGroups.length
                ? { repo: repoPath, worktree: worktree.id }
                : { repo: repoPath, view: "settings" }
            )}
          >
            <span className="min-w-0 font-medium break-all">
              {worktree.branch}
            </span>
            <span className="text-muted-foreground">
              {attentionLabel(worktree)}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
};

export const RecentActivity = ({ repoPath }: { repoPath: string }) => {
  const activity = useActivity(repoPath);
  const events = (activity.data ?? []).slice(0, 5);
  return (
    <section className="mt-8" aria-label="Recent activity">
      <OverviewSectionHeading
        title="Recent activity"
        href={hrefFor({ repo: repoPath, view: "activity" })}
        linkLabel="View all activity"
      />
      <QueryContent
        label="Recent activity"
        query={activity}
        resetKey={repoPath}
      >
        <div className="divide-y rounded-lg border">
          {events.map((event) => (
            <a
              key={event.id}
              className="hover:bg-muted/40 flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
              href={hrefFor({ repo: repoPath, view: "activity" })}
            >
              <div className="min-w-0 flex-1">
                <p className="break-words">{event.message}</p>
                {event.worktreeName ? (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {event.worktreeName}
                    {event.groupId ? ` · ${event.groupId}` : ""}
                  </p>
                ) : null}
              </div>
              <time
                className="text-muted-foreground text-xs"
                dateTime={event.at}
              >
                {new Date(event.at).toLocaleString(undefined, {
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  month: "short",
                })}
              </time>
            </a>
          ))}
          {events.length === 0 ? (
            <p className="text-muted-foreground px-4 py-5 text-sm">
              Starts, stops, and runtime changes will appear here.
            </p>
          ) : null}
        </div>
      </QueryContent>
    </section>
  );
};

export const OverviewWorktrees = ({
  worktrees,
  repoPath,
  overview,
  children,
}: {
  worktrees: WorktreeSnapshot[];
  repoPath: string;
  overview: boolean;
  children: ReactNode;
}) => {
  if (!overview) {
    return children;
  }
  return (
    <>
      <OverviewAttention worktrees={worktrees} repoPath={repoPath} />
      <OverviewSectionHeading
        title="Active worktrees"
        href={hrefFor({ repo: repoPath, view: "worktrees" })}
        linkLabel={`View all ${worktrees.length} worktrees`}
      />
      {overviewWorktrees(worktrees).length ? (
        children
      ) : (
        <Blank
          title="No active worktrees"
          description="Open Worktrees to start an app group or create a new worktree."
        />
      )}
      <RecentActivity repoPath={repoPath} />
    </>
  );
};
