export const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;

export type AutoSwitchFetch = (input: string, init: RequestInit) => Promise<Response>;

export function normalizeAutoSwitchThreshold(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 100
    ? value
    : DEFAULT_AUTO_SWITCH_THRESHOLD;
}

export function parseEnabledAutoSwitchThreshold(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const threshold = Number(trimmed);
  return threshold >= 1 && threshold <= 100 ? threshold : null;
}

export function nextAutoSwitchThreshold(current: number, lastEnabled: number): number {
  if (current > 0) return 0;
  return Number.isInteger(lastEnabled) && lastEnabled >= 1 && lastEnabled <= 100
    ? lastEnabled
    : DEFAULT_AUTO_SWITCH_THRESHOLD;
}

export type AutoSwitchThresholdReadDisposition = "apply" | "defer" | "ignore";

export function autoSwitchThresholdReadDisposition(
  editing: boolean,
  saving: boolean,
  startedRevision: number,
  currentRevision: number,
): AutoSwitchThresholdReadDisposition {
  if (startedRevision !== currentRevision) return "ignore";
  return editing || saving ? "defer" : "apply";
}

export interface AutoSwitchTogglePlan {
  threshold: number;
  lastEnabled: number;
}

/**
 * Disabling is one server write. A valid dirty draft becomes the page-lifetime
 * restore value, so re-enabling can persist it without a partial two-write
 * failure state.
 */
export function planAutoSwitchToggleWrite(
  current: number,
  draft: string,
  lastEnabled: number,
): AutoSwitchTogglePlan | null {
  if (current <= 0) {
    const threshold = nextAutoSwitchThreshold(current, lastEnabled);
    return { threshold, lastEnabled: threshold };
  }
  const parsedDraft = parseEnabledAutoSwitchThreshold(draft);
  if (parsedDraft === null) return null;
  return { threshold: 0, lastEnabled: parsedDraft };
}

export async function putAutoSwitchThreshold(
  apiBase: string,
  threshold: number,
  fetchImpl: AutoSwitchFetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) return false;
  try {
    const response = await fetchImpl(`${apiBase}/api/codex-auth/auto-switch`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
