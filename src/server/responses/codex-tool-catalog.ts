import { currentTurnWireToolCatalogBody } from "../responses-undeclared-tool-guard";
import { sessionLaneIdFromRequest } from "../request-log-conversation";
import { codeModeRenderedToolNames } from "./code-mode-collab-surface";

/**
 * Eager MCP definitions at which a Codex request is diagnosed as carrying an expanded catalog.
 * Routed catalog rows advertise deferred discovery, so a Codex client with current model metadata
 * keeps MCP tools deferred; one whose metadata is missing or stale expands every MCP tool into the
 * request. The request is still forwarded unchanged: this is a diagnostic, never an admission
 * rule, because an eager catalog stays a valid request (ADR-0022).
 */
export const EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD = 64;
/** Sessions already warned. Bounded so a long-lived proxy cannot grow it without limit. */
const WARNED_SESSION_LIMIT = 1024;
const warnedSessions = new Set<string>();
const CODEX_CLIENT_IDENTITY = /^(?:codex|codex_cli_rs|codex_app|codex_work_desktop|codexless_agent|Codex Desktop)(?:\/|$)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectEagerMcpTools(specs: unknown[], names: Set<string>, namespace?: string): void {
  for (const spec of specs) {
    if (!isRecord(spec) || spec.defer_loading === true) continue;
    if (spec.type === "namespace" && typeof spec.name === "string" && Array.isArray(spec.tools)) {
      collectEagerMcpTools(spec.tools, names, spec.name);
      continue;
    }
    const tool = isRecord(spec.function) ? spec.function : spec;
    if (tool.defer_loading === true || typeof tool.name !== "string") continue;
    const name = namespace ? `${namespace}__${tool.name}` : tool.name;
    if (name.startsWith("mcp__")) names.add(name);
    // Code Mode renders each enabled, non-deferred nested tool into the exec description.
    if (!namespace && spec.type === "custom") {
      for (const nested of codeModeRenderedToolNames(tool.name, tool.description)) {
        if (nested.startsWith("mcp__")) names.add(nested);
      }
    }
  }
}

/** A message that opens a Responses turn ahead of its user input, such as instructions. */
function isTurnPreamble(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (item.type === "additional_tools") return true;
  return (item.type === undefined || item.type === "message") && (item.role === "developer" || item.role === "system");
}

/**
 * Responses Lite `additional_tools` declared by the current turn. A resumed thread resends its
 * whole history, including earlier turns' declarations, so only the declarations directly ahead of
 * the last user input, or after it, belong to this request. Without user input every item counts.
 */
function currentTurnAdditionalTools(input: unknown[]): unknown[][] {
  let start = 0;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item) || item.role !== "user") continue;
    start = index;
    while (start > 0 && isTurnPreamble(input[start - 1])) start -= 1;
    break;
  }
  const groups: unknown[][] = [];
  for (const item of input.slice(start)) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) groups.push(item.tools);
  }
  return groups;
}

/**
 * Eager MCP definitions a canonical Codex client declared for this request, or 0 for any other
 * client. Compaction reads only top-level `tools`: its `input` is history.
 */
export function eagerCodexMcpToolCount(body: unknown, headers: Headers, surface: "responses" | "compact" = "responses"): number {
  if (!headers.has("x-codex-turn-metadata")
    && !CODEX_CLIENT_IDENTITY.test(headers.get("originator") ?? "")
    && !CODEX_CLIENT_IDENTITY.test(headers.get("user-agent") ?? "")) return 0;
  const current = currentTurnWireToolCatalogBody(body, undefined);
  if (!isRecord(current)) return 0;
  const names = new Set<string>();
  if (Array.isArray(current.tools)) collectEagerMcpTools(current.tools, names);
  if (surface === "responses" && Array.isArray(current.input)) {
    for (const tools of currentTurnAdditionalTools(current.input)) collectEagerMcpTools(tools, names);
  }
  return names.size;
}

/**
 * Warn once per session when a Codex request carries an eagerly expanded MCP catalog. Only the
 * count and the threshold are logged; tool names, bodies and session identifiers are not. A
 * request without a session identity shares one anonymous slot.
 */
export function warnEagerCodexToolCatalog(body: unknown, headers: Headers, surface: "responses" | "compact" = "responses"): void {
  const count = eagerCodexMcpToolCount(body, headers, surface);
  if (count < EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD) return;
  const session = sessionLaneIdFromRequest(headers) ?? "";
  if (warnedSessions.has(session)) return;
  if (warnedSessions.size >= WARNED_SESSION_LIMIT) warnedSessions.delete(warnedSessions.values().next().value!);
  warnedSessions.add(session);
  console.warn(
    `[codex-catalog] Codex sent ${count} eager MCP tool definitions (warning threshold ${EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD}) `
    + "instead of deferred tool discovery; its model metadata may be missing or stale. The request was forwarded unchanged. "
    + "Run 'ocx sync --restart-codex' to reload the catalog. Shown once per session.",
  );
}
