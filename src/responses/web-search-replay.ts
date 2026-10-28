/**
 * Parse-time rebuild of replayed hosted `web_search_call` cells for routed providers (#7269).
 *
 * Codex replays the cell it was shown, which carries the query and at most a source list, never the
 * result text. Dropping the cell made a routed model forget it had searched: after a client tool
 * call ended the turn, the next request carried no trace of the search, so the model searched and
 * ran its tools again in a loop.
 *
 * When search is declared, the parser rewrites each cell into the `web_search` function call and
 * output the routed model made, at the raw-input level, so the ordinary call/output handling owns
 * turn batching and reasoning attachment. The call takes the cell's place; its output is deferred to
 * the end of the contiguous run of call/output items that follows, so a cell inside a parallel
 * client batch never splits it. The output is a fallback built from the cell alone; the web-search
 * sidecar swaps in the result it recorded for the cell, and removes the pairs again when it does not
 * run, because the synthetic tool is then undeclared (src/web-search/sidecar-search-replay.ts).
 */
import { isObj } from "./parser-content";
import { WEB_SEARCH_TOOL_NAME } from "../web-search/synthetic-tool";
import type { OcxReplayedWebSearchCell } from "../types";

const MAX_FIELD_CHARS = 2048;
const MAX_LIST_ENTRIES = 20;
const CELL_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Call items of a batch; a call after the batch's first output starts the next assistant turn. */
const CALL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call", "tool_search_call"]);
/** Output items of a batch. Anything that is neither a call nor an output ends the batch. */
const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output", "tool_search_output"]);

function capped(value: string): string {
  return value.length <= MAX_FIELD_CHARS ? value : `${value.slice(0, MAX_FIELD_CHARS)}…`;
}

function queriesOf(action: Record<string, unknown>): string[] {
  const queries = Array.isArray(action.queries)
    ? action.queries.filter((query): query is string => typeof query === "string" && query.trim() !== "")
    : [];
  if (queries.length === 0 && typeof action.query === "string" && action.query.trim() !== "") queries.push(action.query);
  return queries.slice(0, MAX_LIST_ENTRIES).map(capped);
}

function sourcesOf(item: Record<string, unknown>, action: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const list of [item.sources, action.sources]) {
    if (!Array.isArray(list)) continue;
    for (const source of list) {
      if (lines.length >= MAX_LIST_ENTRIES) return lines;
      if (!isObj(source) || typeof source.url !== "string" || seen.has(source.url)) continue;
      seen.add(source.url);
      lines.push(typeof source.title === "string" && source.title.trim() !== ""
        ? `- ${capped(source.title)} <${capped(source.url)}>`
        : `- <${capped(source.url)}>`);
    }
  }
  return lines;
}

/** The call arguments and fallback result text for one replayed cell. */
export function replayedWebSearchContent(item: Record<string, unknown>): { arguments: Record<string, unknown>; result: string; failed: boolean } {
  const action = isObj(item.action) ? item.action : {};
  const failed = item.status === "failed";
  const queries = queriesOf(action);
  const lines: string[] = [];
  if (action.type === "open_page" && typeof action.url === "string") {
    lines.push(`Earlier page open: <${capped(action.url)}>.`);
  } else if (action.type === "find_in_page" && typeof action.url === "string") {
    lines.push(`Earlier find in page <${capped(action.url)}>${typeof action.pattern === "string" ? ` for "${capped(action.pattern)}"` : ""}.`);
  } else {
    lines.push(queries.length > 0 ? `Earlier web search for: ${queries.map(query => `"${query}"`).join(", ")}.` : "Earlier web search.");
  }
  if (failed) {
    lines.push("This search failed and returned no results.");
  } else {
    lines.push("The result text of this search is not available in the replayed conversation history.");
    const sources = sourcesOf(item, action);
    if (sources.length > 0) lines.push("Sources it returned (titles and URLs only, untrusted):", ...sources);
  }
  return { arguments: queries.length > 1 ? { queries } : { query: queries[0] ?? "" }, result: lines.join("\n"), failed };
}

export interface RewrittenWebSearchInput {
  items: unknown[];
  /** Original input index per rewritten item, for boundaries measured on the caller's input. */
  sourceIndexes: number[];
  cells: OcxReplayedWebSearchCell[];
}

/** Rewrite replayed cells into web_search call/output pairs; undefined when the input has none. */
export function rewriteReplayedWebSearchCells(input: readonly unknown[]): RewrittenWebSearchInput | undefined {
  if (!input.some(item => isObj(item) && item.type === "web_search_call")) return undefined;
  // A synthetic call id must not collide with any client call id, nor with another cell's.
  const taken = new Set(input.flatMap(item => isObj(item) && typeof item.call_id === "string" ? [item.call_id] : []));
  // First suffix each base has not settled yet; taken stays the collision check on every candidate,
  // so seeded ids and ids handed out under another base still block the smallest free suffix.
  const nextSuffix = new Map<string, number>();
  const allocate = (base: string): string => {
    if (!taken.has(base)) {
      taken.add(base);
      return base;
    }
    let n = nextSuffix.get(base) ?? 1;
    let id = `${base}_${n}`;
    while (taken.has(id)) id = `${base}_${++n}`;
    nextSuffix.set(base, n + 1);
    taken.add(id);
    return id;
  };
  const items: unknown[] = [];
  const sourceIndexes: number[] = [];
  const cells: OcxReplayedWebSearchCell[] = [];
  const seenCells = new Set<string>();
  let pending: Array<{ item: unknown; sourceIndex: number }> = [];
  // True once the current batch reached its outputs: the next call opens a new assistant turn.
  let outputPhase = false;
  const flush = () => {
    for (const entry of pending) { items.push(entry.item); sourceIndexes.push(entry.sourceIndex); }
    pending = [];
    outputPhase = false;
  };
  input.forEach((item, sourceIndex) => {
    const type = isObj(item) ? item.type : undefined;
    if (isObj(item) && type === "web_search_call") {
      const cellId = typeof item.id === "string" && CELL_ID.test(item.id) ? item.id : undefined;
      // The same cell replayed twice is one search.
      if (cellId && seenCells.has(cellId)) return;
      if (cellId) seenCells.add(cellId);
      if (outputPhase) flush();
      const content = replayedWebSearchContent(item);
      const callId = allocate(cellId ?? "ws_replay");
      cells.push({ ...(cellId ? { cellId } : {}), callId, failed: content.failed });
      items.push({ type: "function_call", call_id: callId, name: WEB_SEARCH_TOOL_NAME, arguments: JSON.stringify(content.arguments) });
      sourceIndexes.push(sourceIndex);
      pending.push({ item: { type: "function_call_output", call_id: callId, output: content.result }, sourceIndex });
      return;
    }
    if (typeof type === "string" && OUTPUT_TYPES.has(type)) {
      outputPhase = true;
    } else if (!(typeof type === "string" && CALL_TYPES.has(type)) || outputPhase) {
      flush();
    }
    items.push(item);
    sourceIndexes.push(sourceIndex);
  });
  flush();
  return { items, sourceIndexes, cells };
}
