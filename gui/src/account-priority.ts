import type { TFn } from "./i18n/shared";

/**
 * Account selection order. Higher numbers are picked earlier; 0 is the unset default.
 *
 * User-visible copy never says "priority": the presets read as a sequence (First,
 * Earlier, Normal, Later, Last) so the control describes WHEN an account is used
 * rather than how important it is. Only identifiers use the internal name.
 */

export const ACCOUNT_PRIORITY_PRESETS: readonly number[] = [2, 1, 0, -1, -2] as const;

export const DEFAULT_ACCOUNT_PRIORITY = 0;
export const MIN_ACCOUNT_PRIORITY = -100;
export const MAX_ACCOUNT_PRIORITY = 100;

/** i18n keys for the preset names. Kept here so the select stays copy-free. */
export type AccountPriorityPresetKey =
  | "accountPool.priorityFirst"
  | "accountPool.priorityEarlier"
  | "accountPool.priorityNormal"
  | "accountPool.priorityLater"
  | "accountPool.priorityLast";

const PRESET_LABEL_KEYS = new Map<number, AccountPriorityPresetKey>([
  [2, "accountPool.priorityFirst"],
  [1, "accountPool.priorityEarlier"],
  [0, "accountPool.priorityNormal"],
  [-1, "accountPool.priorityLater"],
  [-2, "accountPool.priorityLast"],
]);

export function normalizeAccountPriority(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_ACCOUNT_PRIORITY
    && value <= MAX_ACCOUNT_PRIORITY
    ? value
    : DEFAULT_ACCOUNT_PRIORITY;
}

/**
 * Signed rendering with an ASCII hyphen: "+2", "0", "-1". The number is always part of
 * the label, so an operator can map the words back to what the API and CLI report.
 */
export function formatAccountPriority(value: unknown): string {
  const normalized = normalizeAccountPriority(value);
  return normalized > 0 ? `+${normalized}` : String(normalized);
}

export function isAccountPriorityPreset(value: number): boolean {
  return PRESET_LABEL_KEYS.has(value);
}

/** Label key for a preset, or null for a value only the API or CLI can produce. */
export function accountPriorityPresetKey(value: number): AccountPriorityPresetKey | null {
  return PRESET_LABEL_KEYS.get(value) ?? null;
}

/** "First (+2)" for presets, "Custom (+7)" for anything else. */
export function accountPriorityLabel(t: TFn, value: number): string {
  const normalized = normalizeAccountPriority(value);
  const presetKey = accountPriorityPresetKey(normalized);
  return t("accountPool.priorityOption", {
    name: t(presetKey ?? "accountPool.priorityCustom"),
    value: formatAccountPriority(normalized),
  });
}
