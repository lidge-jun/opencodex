import { normalizeDeclaredToolName, type AdapterEvent } from "../types";
import { UNDECLARED_TOOL_CALL_ERROR_CODE } from "./errors";
import { releaseTranslatedEvent, type TranslatorBudget } from "./translator-budget";
import { releaseCompactionCiphertextLease } from "../responses/compaction";

/** Snapshot of current-turn declarations when an explicit empty catalog activates enforcement. */
export interface ClientToolCatalogRestriction {
  declaredToolNames: ReadonlySet<string>;
  bareCustomToolNames: ReadonlySet<string>;
}

export function emptyToolCatalogRefusal(
  event: AdapterEvent,
  catalog: ClientToolCatalogRestriction | undefined,
): Extract<AdapterEvent, { type: "error" }> | undefined {
  if (!catalog) return;
  if (event.type === "tool_call_start") {
    const name = normalizeDeclaredToolName(event.name, catalog.declaredToolNames, undefined, catalog.bareCustomToolNames);
    if (catalog.declaredToolNames.has(name)) return;
  } else if (catalog.declaredToolNames.size !== 0
    || (event.type !== "tool_call_delta" && event.type !== "tool_call_end")) return;
  return {
    type: "error", status: 502, errorType: "upstream_error", code: UNDECLARED_TOOL_CALL_ERROR_CODE,
    message: "routed provider emitted a client tool call outside the current request's explicit tool catalog",
  };
}

/** Runs after hosted tool loops, before client delivery and continuation-state folding. */
export async function* guardEmptyToolCatalogStream(
  events: AsyncIterable<AdapterEvent>,
  catalog: ClientToolCatalogRestriction | undefined,
  budget: TranslatorBudget,
): AsyncGenerator<AdapterEvent> {
  for await (const event of events) {
    const refusal = emptyToolCatalogRefusal(event, catalog);
    if (refusal) {
      releaseTranslatedEvent(event, budget);
      releaseCompactionCiphertextLease(event, budget);
    }
    yield refusal ?? event;
    if (refusal) return;
  }
}

export function guardEmptyToolCatalogEvents(
  events: AdapterEvent[],
  catalog: ClientToolCatalogRestriction | undefined,
  budget: TranslatorBudget,
): AdapterEvent[] {
  if (!catalog) return events;
  const index = events.findIndex(event => emptyToolCatalogRefusal(event, catalog) !== undefined);
  if (index < 0) return events;
  const refusal = emptyToolCatalogRefusal(events[index]!, catalog)!;
  for (const event of events.slice(index)) {
    if ((event.type === "done" || event.type === "incomplete" || event.type === "error") && event.usage) {
      refusal.usage = event.usage;
    }
    releaseTranslatedEvent(event, budget);
    releaseCompactionCiphertextLease(event, budget);
  }
  return [...events.slice(0, index), refusal];
}
