import type { BranchBaseAppGroup } from "./branchbase-schema";

const TOKEN_PATTERN = /\{(?<token>[^{}]+)\}/u;
const BRACE_PATTERN = /[{}]/u;

export interface ResolvedTemplateApp {
  directUrl?: string;
  host?: string;
  port?: number;
  url?: string;
}

export interface BranchBaseTemplateContext {
  appGroups: Record<
    string,
    {
      apps: Record<string, ResolvedTemplateApp>;
      instanceId?: string;
      instanceName?: string;
      outputs?: Record<string, string>;
      worktreeId?: string;
    }
  >;
  currentGroup: string;
}

interface TemplateValue {
  ambiguous: boolean;
  value: string | null;
}

interface TemplateApp {
  directUrl?: string;
  host?: string;
  port?: number;
  protocol?: "http" | "tcp";
  url?: string;
}

const addTemplateValue = (
  values: Map<string, TemplateValue>,
  token: string,
  value: string | null
): void => {
  const existing = values.get(token);
  values.set(token, {
    ambiguous: existing !== undefined,
    value: existing?.value ?? value,
  });
};

const addAppTemplateValues = (
  values: Map<string, TemplateValue>,
  groupId: string,
  currentGroup: string,
  appId: string,
  app: TemplateApp,
  resolved: boolean
): void => {
  const isHttp = resolved ? app.url !== undefined : app.protocol === "http";
  const prefixes = [`appGroups.${groupId}.apps.${appId}`];
  if (groupId === currentGroup) {
    prefixes.push(`apps.${appId}`);
  }
  for (const prefix of prefixes) {
    addTemplateValue(
      values,
      `{${prefix}.host}`,
      resolved ? (app.host ?? null) : null
    );
    addTemplateValue(
      values,
      `{${prefix}.port}`,
      resolved ? String(app.port) : null
    );
    if (isHttp) {
      addTemplateValue(
        values,
        `{${prefix}.directUrl}`,
        resolved ? (app.directUrl ?? null) : null
      );
      addTemplateValue(
        values,
        `{${prefix}.url}`,
        resolved ? (app.url ?? null) : null
      );
    }
  }
};

const templateValues = (
  appGroups: Record<
    string,
    BranchBaseAppGroup | BranchBaseTemplateContext["appGroups"][string]
  >,
  currentGroup: string,
  resolved: boolean
): Map<string, TemplateValue> => {
  const values = new Map<string, TemplateValue>();
  const current = appGroups[currentGroup];
  addTemplateValue(
    values,
    "{instance.id}",
    current && "instanceId" in current ? (current.instanceId ?? null) : null
  );
  addTemplateValue(
    values,
    "{worktree.id}",
    current && "worktreeId" in current ? (current.worktreeId ?? null) : null
  );
  addTemplateValue(
    values,
    "{instance.name}",
    current && "instanceName" in current ? (current.instanceName ?? null) : null
  );
  for (const [groupId, group] of Object.entries(appGroups)) {
    for (const [name, output] of Object.entries(group.outputs ?? {})) {
      addTemplateValue(
        values,
        `{appGroups.${groupId}.outputs.${name}}`,
        output
      );
      if (groupId === currentGroup) {
        addTemplateValue(values, `{outputs.${name}}`, output);
      }
    }
    for (const [appId, app] of Object.entries(group.apps)) {
      addAppTemplateValues(values, groupId, currentGroup, appId, app, resolved);
    }
  }
  return values;
};

const replaceKnownTokens = (
  template: string,
  values: Map<string, TemplateValue>,
  render: boolean
): { error: string | null; value: string } => {
  let value = template;
  const tokens = [...values.keys()].toSorted(
    (left, right) => right.length - left.length
  );
  for (const token of tokens) {
    if (!value.includes(token)) {
      continue;
    }
    const resolved = values.get(token);
    if (!resolved || resolved.ambiguous) {
      return { error: `Ambiguous template token ${token}`, value };
    }
    if (render && resolved.value === null) {
      return { error: `Unsupported template token ${token}`, value };
    }
    value = value.replaceAll(token, render ? (resolved.value ?? "") : "");
  }
  const unknown = value.match(TOKEN_PATTERN)?.[0];
  if (unknown) {
    return { error: `Unsupported template token ${unknown}`, value };
  }
  if (BRACE_PATTERN.test(value)) {
    return {
      error: "Environment template contains an unmatched or unsupported brace",
      value,
    };
  }
  return { error: null, value };
};

export const branchbaseTemplateError = (
  template: string,
  appGroups: Record<string, BranchBaseAppGroup>,
  currentGroup: string
): string | null =>
  replaceKnownTokens(
    template,
    templateValues(appGroups, currentGroup, false),
    false
  ).error;

export const renderBranchBaseTemplate = (
  template: string,
  context: BranchBaseTemplateContext
): string => {
  const rendered = replaceKnownTokens(
    template,
    templateValues(context.appGroups, context.currentGroup, true),
    true
  );
  if (rendered.error) {
    throw new Error(rendered.error);
  }
  return rendered.value;
};

/** Groups whose endpoint bindings a command receives, including through outputs. */
export const referencedTemplateGroups = (
  appGroups: Record<string, BranchBaseAppGroup>,
  currentGroup: string,
  templates: readonly string[]
): Set<string> => {
  const groups = new Set([currentGroup]);
  const visitedOutputs = new Set<string>();
  const visit = (template: string, owner: string): void => {
    for (const [groupId, group] of Object.entries(appGroups)) {
      const values = new Map<string, TemplateValue>();
      for (const [appId, app] of Object.entries(group.apps)) {
        addAppTemplateValues(values, groupId, owner, appId, app, false);
      }
      if ([...values.keys()].some((token) => template.includes(token))) {
        groups.add(groupId);
      }
      for (const [name, output] of Object.entries(group.outputs ?? {})) {
        const token = `{appGroups.${groupId}.outputs.${name}}`;
        if (
          !template.includes(token) &&
          !(groupId === owner && template.includes(`{outputs.${name}}`))
        ) {
          continue;
        }
        groups.add(groupId);
        if (!visitedOutputs.has(token)) {
          visitedOutputs.add(token);
          visit(output, groupId);
        }
      }
    }
  };
  for (const template of templates) {
    visit(template, currentGroup);
  }
  return groups;
};

export const renameBranchBaseAppTemplateReferences = (
  template: string,
  groupId: string,
  previousId: string,
  nextId: string
): string =>
  template
    .replaceAll(`{apps.${previousId}.`, `{apps.${nextId}.`)
    .replaceAll(
      `{appGroups.${groupId}.apps.${previousId}.`,
      `{appGroups.${groupId}.apps.${nextId}.`
    );

export const renameBranchBaseAppGroupTemplateReferences = (
  template: string,
  previousId: string,
  nextId: string
): string =>
  template.replaceAll(`{appGroups.${previousId}.`, `{appGroups.${nextId}.`);
