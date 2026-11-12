import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { appGroupStatus } from "../../app-group/status";
import type { ProjectOverview } from "../../project/catalog-contract";
import type { Observation } from "../../project/discovery-contract";
import { appGroupIsRunning } from "../../project/worktree-status-contract";
import type {
  AppGroupSnapshot,
  WorkspaceSnapshot,
  WorktreeSnapshot,
} from "../../project/worktree-status-contract";
import { CreateWorktreeDialog } from "../components/create-worktree-dialog";
import { Button } from "../components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { useCodexIntegration } from "../queries";
import { ActivityPage } from "./activity-page";
import { hrefFor } from "./data";
import type { ProductLocation, ProductRoute } from "./data";
import { DiskUsageMetric } from "./disk-usage-metric";
import { EnvironmentList } from "./environment-list";
import type { GroupControls } from "./environment-list";
import { GroupDetails } from "./group-details";
import { InfrastructurePage } from "./infrastructure-page";
import { DetectedServicesSection } from "./observed-project-page";
import {
  Status,
  Blank,
  PageHeading,
  ResourceUsage,
  Search,
} from "./primitives";
import {
  OverviewWorktrees,
  overviewWorktrees,
  worktreeNeedsAttention as needsAttention,
} from "./repository-overview";
import { runtimeSummary } from "./runtime-summary";
import { SettingsPage } from "./settings-page";
import { useWorktreeControls } from "./use-worktree-controls";
import { WorktreeEndpointProfile } from "./worktree-endpoint-profile";
import { WorktreeProfile } from "./worktree-profile";

const isMissingEnvironment = (
  location: ProductLocation,
  selectedGroup: AppGroupSnapshot | undefined
): boolean =>
  location.view === "workspace" && Boolean(location.worktree) && !selectedGroup;
const isEnvironmentList = (location: ProductLocation): boolean =>
  (location.view === "workspace" ||
    location.view === "worktrees" ||
    location.view === "running") &&
  !location.worktree;

const WorkspaceHeading = ({
  data,
  project,
  view,
  onRefresh,
  onCreate,
}: {
  data: WorkspaceSnapshot;
  project?: ProjectOverview;
  view: ProductLocation["view"];
  onRefresh: () => void;
  onCreate: () => void;
}) => (
  <>
    {view === "running" ? null : (
      <PageHeading
        description={data.repoPath}
        title={
          view === "worktrees" ? "Worktrees" : (project?.name ?? data.repoName)
        }
      >
        <DiskUsageMetric usage={data.disk} aggregate />
        <ResourceUsage usage={data.resources} />
        <Button
          aria-label="Refresh project"
          onClick={onRefresh}
          size="icon"
          variant="outline"
        >
          <RefreshCwIcon />
        </Button>
        <Button onClick={onCreate} variant="default">
          <PlusIcon />
          Create worktree
        </Button>
      </PageHeading>
    )}
    {view === "workspace" ? (
      <dl className="product-overview-summary">
        <div>
          <dt>Worktrees</dt>
          <dd>{data.worktrees.length}</dd>
        </div>
        <div>
          <dt>App groups running</dt>
          <dd>{data.globalRunningCount}</dd>
        </div>
        <div>
          <dt>Needs attention</dt>
          <dd>{data.worktrees.filter(needsAttention).length}</dd>
        </div>
      </dl>
    ) : null}
  </>
);

const WorktreeHeading = ({
  worktree,
  groupId,
  controls,
}: {
  worktree: WorktreeSnapshot;
  groupId: string;
  controls: GroupControls;
}) => (
  <>
    <div className="product-worktree-heading">
      <h1>{worktree.branch}</h1>
      <Status
        value={runtimeSummary(worktree).value}
        label={runtimeSummary(worktree).label}
      />
    </div>
    <p className="product-muted product-detail-path">{worktree.path}</p>
    <DiskUsageMetric usage={worktree.disk} />
    <nav aria-label="App groups" className="product-group-navigation">
      {worktree.appGroups.map((group) => (
        <Button
          key={group.id}
          variant={group.id === groupId ? "secondary" : "ghost"}
          onClick={() => controls.inspect(worktree, group)}
          aria-current={group.id === groupId ? "page" : undefined}
        >
          {group.name}
          <Status value={appGroupStatus(group)} />
        </Button>
      ))}
    </nav>
  </>
);

const selectedAppGroup = (
  worktree: WorktreeSnapshot | undefined,
  groupId: string
) =>
  groupId
    ? worktree?.appGroups.find((group) => group.id === groupId)
    : (worktree?.appGroups.find(
        (group) => group.category === "application" && !group.cleanupOnly
      ) ??
      worktree?.appGroups.find(
        (group) => group.id === worktree.primaryAppGroup
      ) ??
      worktree?.appGroups[0]);

export const WorkspacePage = ({
  observation,
  data,
  project,
  location,
  navigate,
  refresh,
}: {
  observation?: Observation;
  data: WorkspaceSnapshot;
  project?: ProjectOverview;
  location: ProductLocation;
  navigate: (value: ProductRoute) => void;
  refresh: () => void;
}) => {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [create, setCreate] = useState(false);
  const codex = useCodexIntegration(data.repoPath);
  const { actions, controls, trust, onDelete, feedback } = useWorktreeControls({
    data,
    onInspect: (worktree, group, panel = "logs") =>
      navigate({
        group: group.id,
        panel,
        repo: data.repoPath,
        view: "workspace",
        worktree: worktree.id,
      }),
  });
  const selected = data.worktrees.find(
    (worktree) => worktree.id === location.worktree
  );
  const selectedGroup = selectedAppGroup(selected, location.group);
  const active = data.worktrees.filter((worktree) =>
    worktree.appGroups.some(appGroupIsRunning)
  );
  const visible = data.worktrees.filter(
    (worktree) =>
      `${worktree.name} ${worktree.branch} ${codex.data?.worktrees[worktree.id]?.tasks.map((task) => task.title).join(" ") ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      ((location.view !== "running" && filter === "all") ||
        (location.view === "running" &&
          worktree.appGroups.some(appGroupIsRunning)) ||
        (filter === "running" && worktree.appGroups.some(appGroupIsRunning)) ||
        (filter === "attention" && needsAttention(worktree)))
  );
  return (
    <>
      {feedback}
      {location.view === "settings" ? (
        <SettingsPage
          data={data}
          onSectionChange={(section) =>
            navigate({ repo: data.repoPath, section, view: "settings" })
          }
          project={project}
          review={() =>
            trust.requestTrust(
              "Review commands",
              () => {
                // Trust approval does not need a follow-up action.
              },
              {
                approvals: [{ fingerprint: data.trustFingerprint }],
                commands: data.trustCommands,
                trusted: false,
              }
            )
          }
          section={location.section}
        />
      ) : null}
      {location.view === "activity" ? (
        <ActivityPage repoPath={data.repoPath} />
      ) : null}
      {location.view === "infrastructure" ? (
        <InfrastructurePage controls={controls} data={data} />
      ) : null}
      {location.view === "workspace" && selected && selectedGroup ? (
        <>
          <WorktreeHeading
            worktree={selected}
            groupId={selectedGroup.id}
            controls={controls}
          />
          <WorktreeEndpointProfile
            key={JSON.stringify([selected.id, selected.endpointProfile?.id])}
            repoPath={data.repoPath}
            worktree={selected}
          />
          <WorktreeProfile
            key={selected.id}
            repoPath={data.repoPath}
            worktree={selected}
          />
          <GroupDetails
            codex={codex.data}
            codexError={codex.isError && codex.data === undefined}
            controls={controls}
            group={selectedGroup}
            key={`${selected.id}:${selectedGroup.id}`}
            onBack={() => navigate({ repo: data.repoPath, view: "worktrees" })}
            onClearLogs={() =>
              actions.commands.clearLogs.mutate({
                appGroupName: selectedGroup.id,
                repoPath: data.repoPath,
                worktreeId: selected.id,
              })
            }
            onConfigSource={(source) =>
              actions.commands.selectWorktreeConfigSource.mutate({
                repoPath: data.repoPath,
                source,
                worktreeId: selected.id,
              })
            }
            onCreateInstance={(name) =>
              actions.createAppGroupInstance(selected, selectedGroup, name)
            }
            onSelectInstance={(id) =>
              actions.selectAppGroupInstance(selected, selectedGroup, id)
            }
            onTabChange={(panel) =>
              navigate({
                group: selectedGroup.id,
                panel,
                repo: data.repoPath,
                worktree: selected.id,
              })
            }
            project={project}
            repoPath={data.repoPath}
            tab={location.panel}
            worktree={selected}
          />
        </>
      ) : null}
      {isMissingEnvironment(location, selectedGroup) ? (
        <Blank
          description="This link refers to an environment that is no longer in the current configuration."
          title="Worktree or app group no longer available"
        >
          <Button
            onClick={() => navigate({ repo: data.repoPath })}
            variant="outline"
          >
            Back to worktrees
          </Button>
        </Blank>
      ) : null}
      {location.view === "logs" ? (
        <>
          <PageHeading
            title="Logs"
            description="Choose an app group to inspect its managed output."
          />
          <div className="product-log-picker">
            {data.worktrees.map((worktree) => (
              <section key={worktree.id}>
                <h2>{worktree.branch}</h2>
                {worktree.appGroups.map((group) => (
                  <Button
                    key={group.id}
                    variant="outline"
                    onClick={() => controls.inspect(worktree, group, "logs")}
                  >
                    <Status value={appGroupStatus(group)} label={group.name} />
                    View logs
                  </Button>
                ))}
              </section>
            ))}
          </div>
        </>
      ) : null}
      {isEnvironmentList(location) ? (
        <>
          <WorkspaceHeading
            data={data}
            project={project}
            view={location.view}
            onCreate={() => setCreate(true)}
            onRefresh={() => {
              refresh();
              codex.refetch();
            }}
          />
          {location.view === "worktrees" ? (
            <div className="product-filterbar">
              <Search
                onChange={setSearch}
                placeholder="Search worktrees…"
                value={search}
              />
              <ToggleGroup
                aria-label="Filter worktrees"
                className="flex-wrap"
                onValueChange={(values) => {
                  if (values[0]) {
                    setFilter(values[0]);
                  }
                }}
                value={[filter]}
                variant="outline"
              >
                {[
                  ["all", `All ${data.worktrees.length}`],
                  ["running", `Running ${active.length}`],
                  [
                    "attention",
                    `Needs attention ${data.worktrees.filter(needsAttention).length}`,
                  ],
                ].map(([value, label]) => (
                  <ToggleGroupItem key={value} value={value}>
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          ) : null}
          <OverviewWorktrees
            worktrees={data.worktrees}
            repoPath={data.repoPath}
            overview={location.view === "workspace"}
          >
            <EnvironmentList
              codex={codex.data}
              codexError={codex.isError && codex.data === undefined}
              commandActions={actions.commandActions}
              controls={controls}
              onDelete={onDelete}
              worktrees={
                location.view === "workspace"
                  ? overviewWorktrees(data.worktrees)
                  : visible
              }
              runningOnly={location.view === "running"}
            />
          </OverviewWorktrees>
          {location.view === "running" ? null : (
            <DetectedServicesSection data={observation} />
          )}
          <div className="product-footer-link">
            <a
              className="product-link"
              href={hrefFor({ repo: data.repoPath, view: "infrastructure" })}
            >
              Shared infrastructure and instances
            </a>
          </div>
        </>
      ) : null}
      {create ? (
        <CreateWorktreeDialog
          mutation={actions.commands.createWorktree}
          onClose={() => setCreate(false)}
          repoPath={data.repoPath}
          requestRepositoryTrust={trust.requestTrust}
        />
      ) : null}
    </>
  );
};
