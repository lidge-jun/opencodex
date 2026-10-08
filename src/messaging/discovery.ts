import { MessageBudget } from "./budget";
import { isThreadId, LocalMessagingError, type LocalMetadataClient, type LocalThread } from "./types";

/** No partial directory is returned as complete, even when a matching name was seen. */
export async function discoverLoaded(client: LocalMetadataClient, budget: MessageBudget): Promise<LocalThread[]> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < 20; page++) {
    budget.throwIfEnded();
    const result = await client.loadedPage(cursor);
    for (const id of result.data) {
      if (ids.has(id)) throw new LocalMessagingError("discovery_incomplete", "Loaded-session pagination repeated a thread ID.");
      ids.add(id);
    }
    if (result.nextCursor === null) { complete = true; break; }
    if (cursors.has(result.nextCursor)) throw new LocalMessagingError("discovery_incomplete", "Loaded-session pagination repeated a cursor.");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  if (!complete) throw new LocalMessagingError("discovery_incomplete", "Loaded-session discovery exceeded its page budget.");
  const ordered = [...ids];
  const threads: LocalThread[] = [];
  for (let offset = 0; offset < ordered.length; offset += 4) {
    budget.throwIfEnded();
    // Settle this command's entire batch on failure; no abandoned metadata tasks.
    const batch = await Promise.allSettled(ordered.slice(offset, offset + 4).map(id => client.readThread(id)));
    const failed = batch.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    for (const result of batch) {
      if (result.status === "fulfilled") {
        if (result.value.status === "notLoaded") {
          throw new LocalMessagingError("discovery_incomplete", "A discovered session unloaded during metadata lookup.");
        }
        threads.push(result.value);
      }
    }
  }
  budget.throwIfEnded();
  return threads;
}

/** Resolve one exact ID or unique exact name from a complete discovery result; never guess a route. */
export function resolveLoaded(threads: readonly LocalThread[], selector: { thread?: string; name?: string }): LocalThread {
  if ((selector.thread !== undefined) === (selector.name !== undefined)
    || (selector.thread !== undefined && !isThreadId(selector.thread))
    || (selector.name !== undefined && (!selector.name || selector.name.length > 4096 || /[\x00-\x1f]/.test(selector.name)))) {
    throw new LocalMessagingError("invalid_selector", "Choose exactly one valid thread ID or exact session name.");
  }
  const matches = threads.filter(thread => selector.thread !== undefined ? thread.id === selector.thread : thread.name === selector.name);
  if (matches.length !== 1) {
    throw new LocalMessagingError(matches.length ? "ambiguous_target" : "target_not_loaded",
      matches.length ? "Multiple loaded sessions have this exact name." : "No loaded session matches the exact selector.");
  }
  return matches[0]!;
}
