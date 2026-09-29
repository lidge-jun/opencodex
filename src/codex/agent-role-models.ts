/**
 * The dashboard's write of one Codex agent role's model.
 *
 * Codex overrides the spawn-time model with the root `model` pin in
 * `$CODEX_HOME/agents/<role>.toml`, so that pin is what decides a child's model. This module
 * edits exactly that value and nothing else: every other byte of the file, including the
 * instructions multiline string that usually mentions `model =` in prose, is left as it was.
 * It runs only on an explicit user action; no sync or startup path calls it.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollowUnclaimed } from "../config/atomic-write";
import { assertIntegrationWriteOwnership } from "../integrations/config-io";
import { encodeBasicString, findInvalidCharacter } from "./prompt-layers/encoding";
import { dominantEol } from "./prompt-layers/toml-edit";
import { listCodexAgentRoles, locateTomlModelKey } from "./subagent-model-fallback";

export type AgentRoleModelErrorCode = "unknown_role" | "invalid_model" | "unsupported_model_value" | "unsafe_target";

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

/**
 * Set the root `model` value. An existing value is replaced inside its quotes and keeps its
 * quote style when the new value allows it; a missing key is inserted after the leading
 * comment block with the file's own line ending.
 */
export function setTomlRootModel(content: string, model: string): string {
  const location = locateTomlModelKey(content);
  if (location?.inRootTable) {
    if (!location.span) {
      throw new AgentRoleModelError("unsupported_model_value", "the existing model value is not a one-line string");
    }
    const lines = content.split("\n");
    const line = lines[location.line]!;
    const literal = line[location.span.start] === "'" && !model.includes("'")
      ? `'${model}'`
      : encodeBasicString(model);
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
  const assignment = `model = ${encodeBasicString(model)}`;
  if (offset > content.length) return `${content}${eol}${assignment}${eol}`;
  return `${content.slice(0, offset)}${assignment}${eol}${content.slice(offset)}`;
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

export function writeCodexAgentRoleModel(
  role: string,
  model: string,
  codexHome: string,
): { status: "written" | "unchanged" } {
  requireKnownRole(role, codexHome);
  const path = roleFile(role, codexHome);
  if (!lstatSync(path).isFile()) {
    throw new AgentRoleModelError("unsafe_target", `${role}.toml is not a regular file; edit it where it points`);
  }
  const before = readFileSync(path, "utf8");
  const after = setTomlRootModel(before, validateAgentRoleModel(model));
  if (after === before) return { status: "unchanged" };
  assertIntegrationWriteOwnership(path);
  atomicWriteFileNoFollowUnclaimed(path, after);
  return { status: "written" };
}
