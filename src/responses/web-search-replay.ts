/**
 * Parse-time rebuild of a replayed hosted `web_search_call` cell for routed providers (#7269).
 *
 * Codex replays the cell it was shown, which carries the query and at most a source list, never the
 * result text. Dropping the cell made a routed model forget it had searched: after a client tool
 * call ended the turn, the next request carried no trace of the search, so the model searched and
 * ran its tools again in a loop. The parser now rebuilds the cell as a `web_search` call/result
 * pair. This module renders the fallback result from the cell alone; the web-search sidecar swaps
 * in the result text it recorded for that cell when one is available
 * (src/web-search/sidecar-search-replay.ts).
 */
import { isObj } from "./parser-content";

const MAX_FIELD_CHARS = 2048;
const MAX_LIST_ENTRIES = 20;

function capped(value: string): string {
  return value.length <= MAX_FIELD_CHARS ? value : `${value.slice(0, MAX_FIELD_CHARS)}…`;
}

export interface ReplayedWebSearchCall {
  /** The call/result pair id: the cell's own id, or a request-local one when it has none. */
  id: string;
  arguments: Record<string, unknown>;
  /** Fallback tool-result text built from the replayed cell alone. */
  result: string;
  failed: boolean;
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

/** Rebuild one replayed search cell; `fallbackId` names a cell that carries no usable id. */
export function replayedWebSearchCall(item: Record<string, unknown>, fallbackId: string): ReplayedWebSearchCall {
  const action = isObj(item.action) ? item.action : {};
  const id = typeof item.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.id) ? item.id : fallbackId;
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
  const args: Record<string, unknown> = queries.length > 1 ? { queries } : { query: queries[0] ?? "" };
  return { id, arguments: args, result: lines.join("\n"), failed };
}
