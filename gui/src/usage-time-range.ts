export interface UsageTimeWindow {
  since: number;
  until: number;
}

export type UsageRangeError = "required" | "invalid" | "reversed";

function localMinute(value: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  const date = new Date(`${value}:00`);
  const timestamp = date.getTime();
  // Reject calendar overflow and nonexistent local times (including DST gaps).
  if (!Number.isSafeInteger(timestamp) || timestamp < 0
    || date.getFullYear() !== year || date.getMonth() !== month - 1
    || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) return null;
  return timestamp;
}

export function parseUsageTimeRange(start: string, end: string):
  | { ok: true; window: UsageTimeWindow }
  | { ok: false; error: UsageRangeError } {
  if (!start || !end) return { ok: false, error: "required" };
  const since = localMinute(start);
  const endMinute = localMinute(end);
  if (since === null || endMinute === null) return { ok: false, error: "invalid" };
  if (since > endMinute) return { ok: false, error: "reversed" };
  // Both bounds are inclusive: the selected end minute includes its final millisecond.
  return { ok: true, window: { since, until: endMinute + 59_999 } };
}
