/**
 * Recovery guidance for Aside profiles whose sync preference is off while their managed block is stale (#6757).
 *
 * Sync refreshes only profiles whose preference is on, and an OFF preference is the operator's decision, so an
 * "off (stale)" profile needs an explicit, reviewed enable. This module renders text only: it issues no request,
 * reads no state and never changes a preference. Sync cannot name real profile IDs without a status read that may
 * run integration maintenance, so its empty result points at status, which already holds the rows.
 */
export const ASIDE_SYNC_EMPTY_LINES: readonly string[] = [
  "No eligible Aside profiles to synchronize. Sync refreshes only profiles whose sync preference is on.",
  "List profiles with: ocx integration client status --client aside",
  "For a profile shown as off (stale), review: ocx integration client preview --client aside --operation apply --profile <N>",
  "Then, if the preview permits the change and you accept it: ocx integration client enable --client aside --profile <N>",
];

function recoveryProfileId(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const { profileId, enabled, state } = row as Record<string, unknown>;
  // Only an explicit OFF beside a stale block qualifies. Conflict and unsafe blocks need inspection, not an enable.
  if (enabled !== false || state !== "stale") return null;
  return typeof profileId === "number" && Number.isSafeInteger(profileId) && profileId >= 0 && !Object.is(profileId, -0)
    ? profileId : null;
}

/** Per-profile preview-then-enable commands for status rows that are off with a stale managed block. */
export function asideProfileRecoveryLines(rows: readonly unknown[]): string[] {
  const ids = [...new Set(rows.map(recoveryProfileId).filter((id): id is number => id !== null))];
  return ids.flatMap(id => [
    `Aside profile ${id} is off (stale). To reconnect it, review: ocx integration client preview --client aside --operation apply --profile ${id}`,
    `Then, if the preview permits the change and you accept it: ocx integration client enable --client aside --profile ${id}`,
  ]);
}

