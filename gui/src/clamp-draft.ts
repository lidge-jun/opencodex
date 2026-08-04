/** Clamp a numeric draft string into [min, max] after applying delta (for NumberStepper). */
export function clampNumberDraft(
  raw: string,
  delta: number,
  min: number,
  max: number,
  step = 1,
): string {
  const trimmed = raw.trim();
  const parsed = trimmed === "" ? NaN : Number(trimmed);
  const base = Number.isFinite(parsed) ? parsed : min;
  const next = Math.min(max, Math.max(min, base + delta));
  // Keep one decimal for GiB-style steps; integers otherwise.
  return step < 1 ? String(Math.round(next * 10) / 10) : String(Math.round(next));
}
