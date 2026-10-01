/**
 * The dashboard's write of one Codex agent role's model, and optionally its reasoning effort.
 *
 * Codex overrides the spawn-time model with the root `model` pin in
 * `$CODEX_HOME/agents/<role>.toml`, so that pin is what decides a child's model. This module
 * edits exactly that value, plus the root `model_reasoning_effort` when a caller passes one, and
 * nothing else: every other byte of the file, including the instructions multiline string that
 * usually mentions `model =` in prose, is left as it was.
 * It runs only on an explicit user action; no sync or startup path calls it.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollowUnclaimed } from "../config/atomic-write";
import { assertIntegrationWriteOwnership } from "../integrations/config-io";
import { encodeBasicString, findInvalidCharacter } from "./prompt-layers/encoding";
import { dominantEol } from "./prompt-layers/toml-edit";
import { isDeclaredReasoningEffort } from "../reasoning-effort";
import {
  listCodexAgentRoles,
  locateTomlModelKey,
  locateTomlReasoningEffortKey,
  type TomlModelKeyLocation,
} from "./subagent-model-fallback";

export type AgentRoleModelErrorCode =
  | "unknown_role"
  | "invalid_model"
  | "invalid_effort"
  | "unsupported_model_value"
  | "unsafe_target"
  | "invalid_role_file";

export class AgentRoleModelError extends Error {
  constructor(readonly code: AgentRoleModelErrorCode, message: string) {
    super(message);
  }
}

export interface CodexAgentRoleModel {
  readonly role: string;
  readonly model: string | null;
}

export function validateAgentRoleModel(model: unknown): string {
  if (typeof model !== "string") throw new AgentRoleModelError("invalid_model", "model must be a string");
  const trimmed = model.trim();
  if (trimmed === "") throw new AgentRoleModelError("invalid_model", "model must not be empty");
  if (trimmed.includes("\n") || findInvalidCharacter(trimmed) !== null) {
    throw new AgentRoleModelError("invalid_model", "model must not contain control characters");
  }
  return trimmed;
}

export function validateAgentRoleEffort(effort: unknown): string {
  if (typeof effort !== "string" || !isDeclaredReasoningEffort(effort)) {
    throw new AgentRoleModelError("invalid_effort", "effort must be a reasoning effort level such as low, medium or high");
  }
  return effort;
}

/**
 * Set a root string key. An existing value is replaced inside its quotes and keeps its
 * quote style when the new value allows it; a missing key is inserted after the leading
 * comment block with the file's own line ending.
 */
function setTomlRootString(content: string, location: TomlModelKeyLocation | null, key: string, value: string): string {
  if (location?.inRootTable) {
    if (!location.span) {
      throw new AgentRoleModelError("unsupported_model_value", `the existing ${key} value is not a one-line string`);
    }
    const lines = content.split("\n");
    const line = lines[location.line]!;
    const literal = line[location.span.start] === "'" && !value.includes("'")
      ? `'${value}'`
      : encodeBasicString(value);
    lines[location.line] = line.slice(0, location.span.start) + literal + line.slice(location.span.end);
    return lines.join("\n");
  }
  const eol = dominantEol(content);
  const bom = content.startsWith("\ufeff") ? 1 : 0;
  const lines = content.slice(bom).split("\n");
  let offset = bom;
  for (const line of lines) {
    if (!/^\s*#/.test(line)) break;
    offset += line.length + 1;
  }
  const assignment = `${key} = ${encodeBasicString(value)}`;
  if (offset > content.length) return `${content}${eol}${assignment}${eol}`;
  return `${content.slice(0, offset)}${assignment}${eol}${content.slice(offset)}`;
}

export function setTomlRootModel(content: string, model: string): string {
  return setTomlRootString(content, locateTomlModelKey(content), "model", model);
}

export function setTomlRootReasoningEffort(content: string, effort: string): string {
  return setTomlRootString(content, locateTomlReasoningEffortKey(content), "model_reasoning_effort", effort);
}

export function readCodexAgentRoleEffort(role: string, codexHome: string): string | null {
  try {
    const location = locateTomlReasoningEffortKey(readFileSync(roleFile(role, codexHome), "utf8"));
    return location?.inRootTable ? location.value : null;
  } catch {
    return null;
  }
}

function roleFile(role: string, codexHome: string): string {
  return join(codexHome, "agents", `${role}.toml`);
}

function requireKnownRole(role: string, codexHome: string): void {
  // Membership in the directory listing is the whole path check: a name with a separator or
  // `..` can never equal a listed file stem.
  if (!listCodexAgentRoles(codexHome).includes(role)) {
    throw new AgentRoleModelError("unknown_role", `no Codex agent role named ${JSON.stringify(role)}`);
  }
}

export function listCodexAgentRoleModels(codexHome: string): CodexAgentRoleModel[] {
  return listCodexAgentRoles(codexHome).sort().map(role => {
    let model: string | null = null;
    try {
      const location = locateTomlModelKey(readFileSync(roleFile(role, codexHome), "utf8"));
      model = location?.inRootTable ? location.value : null;
    } catch { /* an unreadable role reports no pin */ }
  return { role, model };
  });
}

/**
 * Codex refuses a role file that is not valid TOML. Editing one anyway could turn a role that
 * Codex rejects into one it loads, so both the original and the edited document must parse.
 */
function assertValidRoleToml(role: string, text: string, stage: "before" | "after"): void {
  try {
    Bun.TOML.parse(text);
  } catch {
    throw new AgentRoleModelError(
      "invalid_role_file",
      stage === "before"
        ? `${role}.toml is not valid TOML; fix it before setting a model`
        : `setting the model would leave ${role}.toml invalid; the file was not changed`,
    );
  }
}

export function writeCodexAgentRoleModel(
  role: string,
  model: string,
  codexHome: string,
  effort?: string,
): { status: "written" | "unchanged" } {
  requireKnownRole(role, codexHome);
  const path = roleFile(role, codexHome);
  if (!lstatSync(path).isFile()) {
    throw new AgentRoleModelError("unsafe_target", `${role}.toml is not a regular file; edit it where it points`);
  }
  const before = readFileSync(path, "utf8");
  assertValidRoleToml(role, before, "before");
  const withModel = setTomlRootModel(before, validateAgentRoleModel(model));
  const after = effort === undefined
    ? withModel
    : setTomlRootReasoningEffort(withModel, validateAgentRoleEffort(effort));
  if (after === before) return { status: "unchanged" };
  assertValidRoleToml(role, after, "after");
  assertIntegrationWriteOwnership(path);
  atomicWriteFileNoFollowUnclaimed(path, after);
  return { status: "written" };
}
