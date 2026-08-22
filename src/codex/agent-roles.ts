/**
 * Named subagent role catalog: validate, render `{{roles}}`, and union models
 * into the 5-slot spawn picker roster.
 *
 * Roles are user-authored specialists. The parent still decides whether to
 * spawn; this module never inspects spawn task text.
 */
import { isCodexReasoningEffort } from "../reasoning-effort";
import { codexAccountNamespaceForModel } from "./account-namespace-match";
import type { OcxConfig, OcxSubagentRole } from "../types";

export const SUBAGENT_ROLE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const SUBAGENT_ROLE_MAX_COUNT = 8;
export const SUBAGENT_ROLE_MAX_UNIQUE_MODELS = 5;
export const SUBAGENT_ROLE_DESCRIPTION_MAX = 240;
export const SUBAGENT_ROLE_INSTRUCTIONS_MAX = 8000;
export const SUBAGENT_ROLE_MODEL_MAX = 128;

export type SubagentRoleParseResult =
  | { ok: true; role: OcxSubagentRole }
  | { ok: false; error: string; index?: number };

export type SubagentRolesParseResult =
  | { ok: true; roles: OcxSubagentRole[] }
  | { ok: false; error: string; index?: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, field: string, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = field === "developerInstructions" ? value : value.trim();
  const candidate = field === "developerInstructions" ? value : trimmed;
  if (candidate.length < min || candidate.length > max) return null;
  if (field === "developerInstructions" && candidate.trim().length === 0) return null;
  return field === "developerInstructions" ? candidate : trimmed;
}

export function parseSubagentRole(value: unknown, index?: number): SubagentRoleParseResult {
  const prefix = index === undefined ? "subagentRoles" : `subagentRoles[${index}]`;
  const row = asRecord(value);
  if (!row) return { ok: false, error: `${prefix} must be an object`, index };

  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!SUBAGENT_ROLE_ID_RE.test(id)) {
    return { ok: false, error: `${prefix}.id must match [a-z][a-z0-9-]{0,31}`, index };
  }
  const description = boundedString(row.description, "description", 1, SUBAGENT_ROLE_DESCRIPTION_MAX);
  if (description === null) {
    return { ok: false, error: `${prefix}.description must be a string of 1..${SUBAGENT_ROLE_DESCRIPTION_MAX} characters`, index };
  }
  const model = typeof row.model === "string" ? row.model.trim() : "";
  if (!model || model.length > SUBAGENT_ROLE_MODEL_MAX) {
    return {
      ok: false,
      error: `${prefix}.model must be a non-empty string of at most ${SUBAGENT_ROLE_MODEL_MAX} characters`,
      index,
    };
  }
  let effort: string | undefined;
  if (row.effort !== undefined && row.effort !== null && row.effort !== "") {
    if (typeof row.effort !== "string" || !isCodexReasoningEffort(row.effort)) {
      return { ok: false, error: `${prefix}.effort must be a Codex reasoning ladder value`, index };
    }
    effort = row.effort;
  }
  const developerInstructions = boundedString(
    row.developerInstructions,
    "developerInstructions",
    1,
    SUBAGENT_ROLE_INSTRUCTIONS_MAX,
  );
  if (developerInstructions === null) {
    return {
      ok: false,
      error: `${prefix}.developerInstructions must be a string of 1..${SUBAGENT_ROLE_INSTRUCTIONS_MAX} characters`,
      index,
    };
  }
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") {
    return { ok: false, error: `${prefix}.enabled must be a boolean`, index };
  }

  const role: OcxSubagentRole = {
    id,
    description,
    model,
    developerInstructions,
    enabled: row.enabled !== false,
  };
  if (effort) role.effort = effort;
  return { ok: true, role };
}

export function parseSubagentRoles(value: unknown): SubagentRolesParseResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: "subagentRoles must be an array" };
  }
  if (value.length > SUBAGENT_ROLE_MAX_COUNT) {
    return { ok: false, error: `subagentRoles: at most ${SUBAGENT_ROLE_MAX_COUNT} roles are allowed` };
  }
  const roles: OcxSubagentRole[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const parsed = parseSubagentRole(value[index], index);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.role.id)) {
      return { ok: false, error: `subagentRoles: duplicate id "${parsed.role.id}"`, index };
    }
    seen.add(parsed.role.id);
    roles.push(parsed.role);
  }
  return { ok: true, roles };
}

export function salvageSubagentRoles(value: unknown): { roles: OcxSubagentRole[] | undefined; warnings: string[] } {
  if (value === undefined) return { roles: undefined, warnings: [] };
  if (!Array.isArray(value)) {
    return { roles: undefined, warnings: ["subagentRoles ignored: expected an array"] };
  }
  const roles: OcxSubagentRole[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    if (roles.length >= SUBAGENT_ROLE_MAX_COUNT) {
      warnings.push(`subagentRoles truncated: at most ${SUBAGENT_ROLE_MAX_COUNT} roles are kept`);
      break;
    }
    const parsed = parseSubagentRole(value[index], index);
    if (!parsed.ok) {
      warnings.push(`${parsed.error} — ignored`);
      continue;
    }
    if (seen.has(parsed.role.id)) {
      warnings.push(`subagentRoles[${index}]: duplicate id "${parsed.role.id}" ignored`);
      continue;
    }
    seen.add(parsed.role.id);
    roles.push(parsed.role);
  }
  if (value.length === 0) return { roles: [], warnings };
  return { roles, warnings };
}

export function enabledSubagentRoles(roles: readonly OcxSubagentRole[] | undefined): OcxSubagentRole[] {
  return (roles ?? []).filter(role => role.enabled !== false);
}

export function renderRolesCatalog(
  roles: readonly OcxSubagentRole[],
  options: { maxDescriptionChars?: number } = {},
): string {
  const parts: string[] = [];
  for (const role of enabledSubagentRoles(roles)) {
    const modelBit = role.effort ? `${role.model}, ${role.effort}` : role.model;
    const max = options.maxDescriptionChars;
    if (max === 0) {
      parts.push(`${role.id} (${modelBit})`);
      continue;
    }
    const description = max === undefined ? role.description : role.description.slice(0, max);
    if (!description) {
      parts.push(`${role.id} (${modelBit})`);
      continue;
    }
    parts.push(`${role.id} (${modelBit}) for ${description}`);
  }
  return parts.join("; ");
}

/** Shorten, then drop trailing roles, then omit the catalog so it fits `budget`. */
export function compactRolesCatalog(
  roles: readonly OcxSubagentRole[],
  budget: number,
): string {
  if (budget <= 0) return "";
  const enabled = enabledSubagentRoles(roles);
  if (enabled.length === 0) return "";
  for (const descBudget of [undefined, 80, 40, 0] as const) {
    const options = descBudget === undefined ? {} : { maxDescriptionChars: descBudget };
    for (let count = enabled.length; count > 0; count--) {
      const text = renderRolesCatalog(enabled.slice(0, count), options);
      if (text.length <= budget) return text;
    }
  }
  return "";
}

export function unionRoleModelsIntoRoster(
  existing: string[] | undefined,
  roles: readonly OcxSubagentRole[],
): { models: string[]; droppedRoleIds: string[] } {
  const enabled = enabledSubagentRoles(roles);
  const roleModels: string[] = [];
  for (const role of enabled) {
    if (!roleModels.includes(role.model)) roleModels.push(role.model);
  }
  const base = [...new Set(existing ?? [])];
  const rest = base.filter(model => !roleModels.includes(model));
  const combined = [...roleModels, ...rest];
  const models = combined.slice(0, SUBAGENT_ROLE_MAX_UNIQUE_MODELS);
  const kept = new Set(models);
  const droppedRoleIds = enabled.filter(role => !kept.has(role.model)).map(role => role.id);
  return { models, droppedRoleIds };
}

/** Slash models that are not a configured Codex account-qualified native row. */
export function isRoutedRoleModel(model: string, namespaces?: unknown): boolean {
  const slash = model.indexOf("/");
  if (slash <= 0) return false;
  return !codexAccountNamespaceForModel(namespaces, model);
}

export function routedOnV2Warnings(
  roles: readonly OcxSubagentRole[],
  config: Pick<OcxConfig, "multiAgentMode" | "keepNativeChatGptOnV1" | "codexAccountNamespaces">,
): string[] {
  if (config.multiAgentMode !== "v2" || config.keepNativeChatGptOnV1 === true) return [];
  const routed = enabledSubagentRoles(roles).filter(role =>
    isRoutedRoleModel(role.model, config.codexAccountNamespaces),
  );
  if (routed.length === 0) return [];
  const ids = routed.map(role => role.id).join(", ");
  return [
    `Role model(s) ${ids} are routed while multiAgentMode is v2 without keepNativeChatGptOnV1; ChatGPT-native v2 parents encrypt child tasks (#92).`,
  ];
}
