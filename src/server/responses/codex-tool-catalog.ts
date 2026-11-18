import { currentTurnWireToolCatalogBody } from "../responses-undeclared-tool-guard";
import { sessionLaneIdFromRequest } from "../request-log-conversation";
import { codeModeRenderedToolNames } from "./code-mode-collab-surface";
import { CODE_MODE_EXEC_TOOL_NAME } from "../../types";

/**
 * Eager MCP definitions at which a Codex request is diagnosed as carrying an expanded catalog.
 * Routed catalog rows advertise deferred discovery, so a Codex client with current model metadata
 * keeps MCP tools deferred; one whose metadata is missing or stale expands every MCP tool into the
 * request. The request is still forwarded unchanged: this is a diagnostic, never an admission
 * rule, because an eager catalog stays a valid request (ADR-0022).
 */
export const EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD = 64;
/**
 * Sessions already warned, least recently sent first. Bounded so a long-lived proxy cannot grow
 * it without limit: the dedupe covers this many sessions and no more, so an operator running more
 * sessions than that can see one repeat warning. Recency refreshes on every request a session
 * sends, so the session being evicted is the one that has been idle longest.
 */
export const WARNED_SESSION_LIMIT = 1024;
const warnedSessions = new Map<string, true>();
/** Logical requests already warned without a session identity; weak so completed requests leave no trace. */
const warnedAnonymousRequests = new WeakSet<object>();
const CODEX_CLIENT_IDENTITY = /^(?:codex|codex_cli_rs|codex_app|codex_work_desktop|codexless_agent|Codex Desktop)(?:\/|$)/i;
// This optional diagnostic has a request-wide work/storage budget, not an admission limit.
const MAX_DIAGNOSTIC_ITEMS = 4_096;
const MAX_DIAGNOSTIC_CHARACTERS = 1 << 20;
interface DiagnosticBudget { items: number; characters: number }

function reserveDiagnosticBudget(budget: DiagnosticBudget, items: number, characters = 0): boolean {
  if (items > budget.items || characters > budget.characters) return false;
  budget.items -= items;
  budget.characters -= characters;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Which wire surface a request is being counted for. Compaction sends its history as `input` rather
 * than as declarations, so only its top-level `tools` are this request's catalog.
 */
export function eagerCodexToolCatalogSurface(
  body: unknown,
  compactionRecoveryKind: string | undefined,
): "responses" | "compact" {
  if (compactionRecoveryKind === "compaction-v1") return "compact";
  const input = isRecord(body) && Array.isArray(body.input) ? body.input : [];
  // An oversized unknown surface is skipped by the count's input budget too.
  if (input.length > MAX_DIAGNOSTIC_ITEMS) return "responses";
  return input.some(item => isRecord(item) && item.type === "compaction_trigger") ? "compact" : "responses";
}

function collectEagerMcpTools(specs: unknown[], names: Set<string>, budget: DiagnosticBudget, namespace?: string): boolean {
  if (!reserveDiagnosticBudget(budget, specs.length)) return false;
  for (const spec of specs) {
    if (!isRecord(spec) || spec.defer_loading === true) continue;
    // Codex namespaces are one level deep. A namespace nested inside another is not a Codex
    // declaration, and recursing into caller-shaped depth could exhaust the stack.
    if (spec.type === "namespace" && typeof spec.name === "string" && Array.isArray(spec.tools)) {
      if (namespace === undefined && !collectEagerMcpTools(spec.tools, names, budget, spec.name)) return false;
      continue;
    }
    const tool = isRecord(spec.function) ? spec.function : spec;
    if (tool.defer_loading === true || typeof tool.name !== "string") continue;
    // `functions` is the reserved unnamespaced group (as in the undeclared-tool guard and parser),
    // so an MCP tool declared inside it keeps its own `mcp__` name.
    const prefix = namespace && namespace !== "functions" ? namespace : undefined;
    const isMcp = prefix === undefined ? tool.name.startsWith("mcp__")
      : prefix === "mcp" || prefix === "mcp_" || prefix.startsWith("mcp__");
    if (isMcp) {
      // Charge every occurrence, including duplicates, before concatenation or Set hashing.
      const length = tool.name.length + (prefix === undefined ? 0 : prefix.length + 2);
      if (!reserveDiagnosticBudget(budget, 0, length)) return false;
      names.add(prefix === undefined ? tool.name : `${prefix}__${tool.name}`);
    }
    // Code Mode renders each enabled, non-deferred nested tool into the exec description. Codex
    // sends exec bare or, on Responses Lite, inside its `functions` namespace.
    if ((namespace === undefined || namespace === "functions") && spec.type === "custom"
      && tool.name === CODE_MODE_EXEC_TOOL_NAME && typeof tool.description === "string") {
      // Reserving the complete description bounds parsing, copies and all names it can render.
      if (!reserveDiagnosticBudget(budget, 0, tool.description.length)) return false;
      const rendered = codeModeRenderedToolNames(tool.name, tool.description);
      if (!reserveDiagnosticBudget(budget, rendered.length)) return false;
      for (const nested of rendered) {
        if (nested.startsWith("mcp__")) names.add(nested);
      }
    }
  }
  return true;
}

/**
 * Responses Lite `additional_tools` the client sent for this request.
 *
 * Codex does not express "current turn" by position: a window resends its base catalog at the head
 * of `input` on every request and appends an incremental `additional_tools` update wherever the
 * change happened, including after a replayed tool call. Both are live declarations that this
 * request pays for, so every client-sent item counts. Only what the proxy itself replayed from
 * stored continuation state is history, and `currentTurnWireToolCatalogBody` removes it before
 * this runs.
 */
function clientSentAdditionalTools(input: unknown[]): unknown[][] {
  const groups: unknown[][] = [];
  for (const item of input) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) groups.push(item.tools);
  }
  return groups;
}

/**
 * Eager MCP definitions a canonical Codex client declared for this request, or 0 for any other
 * client. `replayPrefixLength` is the leading input the proxy restored from stored continuation
 * state; those items are history and grant no declaration for this turn. Compaction reads only
 * top-level `tools`: its `input` is history. Exceeding the diagnostic budget returns 0 rather
 * than a partial count; it neither rejects nor rewrites the request.
 */
export function eagerCodexMcpToolCount(
  body: unknown,
  headers: Headers,
  surface: "responses" | "compact" = "responses",
  replayPrefixLength?: number,
): number {
  if (!headers.has("x-codex-turn-metadata")
    && !CODEX_CLIENT_IDENTITY.test(headers.get("originator") ?? "")
    && !CODEX_CLIENT_IDENTITY.test(headers.get("user-agent") ?? "")) return 0;
  if (!isRecord(body)) return 0;
  const budget = { items: MAX_DIAGNOSTIC_ITEMS, characters: MAX_DIAGNOSTIC_CHARACTERS };
  const input = surface === "responses" && Array.isArray(body.input) ? body.input : undefined;
  if (input !== undefined && !reserveDiagnosticBudget(budget, input.length)) return 0;
  // Bound replay scans/copies before invoking the shared helper, and never spread unrelated
  // request fields or inspect compaction history just to compute an optional diagnostic.
  const current = currentTurnWireToolCatalogBody({ tools: body.tools, input }, replayPrefixLength);
  if (!isRecord(current)) return 0;
  const names = new Set<string>();
  if (Array.isArray(current.tools) && !collectEagerMcpTools(current.tools, names, budget)) return 0;
  if (surface === "responses" && Array.isArray(current.input)) {
    for (const tools of clientSentAdditionalTools(current.input)) {
      if (!collectEagerMcpTools(tools, names, budget)) return 0;
    }
  }
  return names.size;
}

/**
 * Warn once per session when a Codex request carries an eagerly expanded MCP catalog. Only the
 * count and the threshold are logged; tool names, bodies and session identifiers are not.
 *
 * A request without a session identity has no session to warn once per, so the
 * `logicalRequest` scope stands in for one: each logical request warns, and a retry, combo child
 * or compaction replay that shares the scope does not repeat it. Callers that omit the scope fall
 * back to the session only.
 */
export function warnEagerCodexToolCatalog(
  body: unknown,
  headers: Headers,
  options: { surface?: "responses" | "compact"; replayPrefixLength?: number; logicalRequest?: object } = {},
): void {
  const surface = options.surface ?? "responses";
  const session = sessionLaneIdFromRequest(headers);
  if (session !== undefined && warnedSessions.has(session)) {
    // Refresh recency on every request the session sends, eager or not, so an active session is
    // never the one evicted next. An already-warned session needs no count at all.
    warnedSessions.delete(session);
    warnedSessions.set(session, true);
    return;
  }
  // A diagnostic must never change the request it observes: any failure while counting a
  // malformed body skips the warning and lets the request continue exactly as before.
  let count: number;
  try { count = eagerCodexMcpToolCount(body, headers, surface, options.replayPrefixLength); } catch { return; }
  if (count < EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD) return;
  if (session !== undefined) {
    while (warnedSessions.size >= WARNED_SESSION_LIMIT) {
      const oldest = warnedSessions.keys().next().value;
      if (oldest === undefined) break;
      warnedSessions.delete(oldest);
    }
    warnedSessions.set(session, true);
  } else if (options.logicalRequest !== undefined) {
    if (warnedAnonymousRequests.has(options.logicalRequest)) return;
    warnedAnonymousRequests.add(options.logicalRequest);
  }
  console.warn(
    `[codex-catalog] Codex sent ${count} eager MCP tool definitions (warning threshold ${EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD}) `
    + "instead of deferred tool discovery; its model metadata may be missing or stale. The request was forwarded unchanged. "
    + "Restart Codex to reload the catalog ('ocx system codex-restart --yes'; it interrupts running turns). "
    + "Shown once per session, or once per request "
    + "when the client sends no session identity.",
  );
}
