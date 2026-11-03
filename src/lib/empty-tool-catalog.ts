import { namespacedToolName, normalizeDeclaredToolName, type AdapterEvent } from "../types";
import { UNDECLARED_TOOL_CALL_ERROR_CODE } from "./errors";
import { releaseTranslatedEvent, type TranslatorBudget } from "./translator-budget";
import { releaseCompactionCiphertextLease } from "../responses/compaction";

/** Current-turn names for normalization, with wire-specific membership enforcement. */
export interface ClientToolCatalogRestriction {
  declaredToolNames: ReadonlySet<string>;
  bareCustomToolNames: ReadonlySet<string>;
  canonicalToolNames?: ReadonlySet<string>;
  enforceDeclaredToolNames?: boolean;
}

/** Current declarations may narrow the selection-filtered bridge names, never widen them. */
export function currentTurnToolBridgeMaps<T extends Pick<ClientToolCatalogRestriction, "declaredToolNames" | "bareCustomToolNames"> & {
  toolNsMap: ReadonlyMap<string, { namespace: string; name: string }>;
}>(
  maps: T,
  catalog: ClientToolCatalogRestriction | undefined,
): T {
  if (!catalog) return maps;
  const currentIdentity = (name: string): boolean => {
    const mapped = maps.toolNsMap.get(name);
    // An ambiguous historical bare alias may lack a mapping. Keep only current identities.
    return catalog.canonicalToolNames?.has(mapped ? namespacedToolName(mapped.namespace, mapped.name) : name) ?? true;
  };
  return {
    ...maps,
    declaredToolNames: new Set([...catalog.declaredToolNames].filter(name => maps.declaredToolNames.has(name) && currentIdentity(name))),
    bareCustomToolNames: new Set([...catalog.bareCustomToolNames].filter(name => maps.bareCustomToolNames.has(name) && currentIdentity(name))),
  };
}

export function emptyToolCatalogRefusal(
  event: AdapterEvent,
  catalog: ClientToolCatalogRestriction | undefined,
): Extract<AdapterEvent, { type: "error" }> | undefined {
  if (!catalog || catalog.enforceDeclaredToolNames === false) return;
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
