/**
 * Session-scoped recall of the last successful combo selection (#3891).
 *
 * When Codex compacts a conversation that was switched to a different combo
 * mid-session, it sends the *bare native model* of the new combo's first
 * target (e.g. "gpt-5.6-terra") rather than the combo/<id> selector it
 * uses for ordinary turns. Without recall, that bare model hits the router
 * and fails with 404 ("requires the canonical openai provider") because no
 * canonical route exists for it.
 *
 * This module remembers, per session lane, which combo last served a
 * successful turn and what its concrete target model was. The compaction
 * entry points then rewrite a bare model back to the remembered
 * combo/<id> selector only when the bare model exactly matches the
 * remembered combo target, so explicit provider/model selectors and
 * unrelated models are never touched.
 */

interface ComboRecallEntry {
  comboId: string;
  targetModel: string;
  at: number;
}

/** Bounded map: stale entries are dropped, oldest evicted at capacity. */
const RECALL_CAPACITY = 256;
const RECALL_TTL_MS = 30 * 60 * 1000;

const recall = new Map<string, ComboRecallEntry>();

export function rememberComboForLane(
  lane: string | undefined,
  comboId: string,
  targetModel: string,
): void {
  if (!lane || !comboId || !targetModel) return;
  // Delete-then-set keeps insertion order fresh for eviction.
  recall.delete(lane);
  recall.set(lane, { comboId, targetModel, at: Date.now() });
  while (recall.size > RECALL_CAPACITY) {
    const oldest = recall.keys().next().value;
    if (oldest === undefined) break;
    recall.delete(oldest);
  }
}

/**
 * Returns the remembered combo id when the incoming bare model exactly
 * matches the combo target that last succeeded on this lane. Returns
 * undefined for explicit provider selectors, stale lanes, and
 * non-matching models: those keep ordinary routing.
 */
export function recallComboForLane(
  lane: string | undefined,
  model: string,
): string | undefined {
  if (!lane || !model) return undefined;
  const entry = recall.get(lane);
  if (!entry) return undefined;
  if (Date.now() - entry.at > RECALL_TTL_MS) {
    recall.delete(lane);
    return undefined;
  }
  if (entry.targetModel !== model) return undefined;
  return entry.comboId;
}

/** Test-only: clear all recall state. */
export function clearComboRecallForTests(): void {
  recall.clear();
}
