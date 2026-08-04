import type { TFn } from "../i18n/shared";
import type { ProviderDiscoverySummary } from "../models-groups";
import { modelVisible, type ProviderModelMap } from "../model-visibility";

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function discoveryFailureLabel(
  t: TFn,
  discovery: Extract<ProviderDiscoverySummary, { status: "failed" }>,
): string {
  switch (discovery.reason) {
    case "http":
      return t("models.discoveryFailedHttp", { status: discovery.httpStatus });
    case "blocked":
      return t("models.discoveryFailedBlocked");
    case "invalid_response":
      return t("models.discoveryFailedInvalidResponse");
    case "network":
      return t("models.discoveryFailedNetwork");
    case "provider":
      return t("models.discoveryFailedProvider");
    default:
      return t("models.discoveryFailedGeneric");
  }
}

export interface ModelRow {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  native?: boolean;
  custom?: boolean;
  customId?: string;
  displayName?: string;
  inputModalities?: string[];
  contextWindow?: number;
  contextCap?: number;
  contextCapped?: boolean;
}

export interface ProviderContextCapsResponse {
  cap?: number;
  value?: number;
  caps?: Record<string, number>;
}

export interface V2Status {
  enabled: boolean;
  agentsMaxThreadsConflict: boolean;
  maxConcurrentThreadsPerSession?: number | null;
  multiAgentMode?: "v1" | "default" | "v2";
}

export interface ShadowCallData {
  enabled: boolean;
  model: string;
  /** Source models the runtime actually intercepts. Older runtimes omit it. */
  sourceModels?: string[];
}

export const CAP_OPTIONS = Array.from({ length: 18 }, (_, i) => 100_000 + i * 50_000); // 100k … 950k
export const CAP_OPTION_SET = new Set(CAP_OPTIONS);
export const CUSTOM_OPTION = "custom";
export const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128, 256, 500, 1000];
export const THREAD_OPTION_SET = new Set(THREAD_OPTIONS);
export const PAGE = 60; // rows rendered per provider before a "show more"

export const COLLAPSED_KEY_V2 = "ocx-models-collapsed:v2";
export const COMBOS_OPEN_KEY_V1 = "ocx-models-combos-open:v1";
export const COMBOS_OPEN_KEY_LEGACY = "ocx-models-combos-open";

/** Compact token display (350k) — unit is technical, not prose. */
export function fmtK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  return n % 1000 === 0 ? `${n / 1000}k` : n.toLocaleString();
}

export function collectDisabledNamespaced(rows: ModelRow[]): Set<string> {
  const next = new Set<string>();
  for (const m of rows) {
    if (m.disabled) next.add(m.namespaced);
  }
  return next;
}

export function activeModelOptions(
  models: ModelRow[],
  disabled: Set<string>,
  selected: ProviderModelMap,
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (const m of models) {
    const blocked = disabled.has(m.id) || disabled.has(m.namespaced);
    if (modelVisible(selected, m.provider, m.id, m.native === true, blocked)) {
      options.push({ value: m.namespaced, label: m.namespaced });
    }
  }
  return options;
}

/** `null` = no preference yet → caller should default to all groups collapsed. */
export function readCollapsedProviders(storage: StorageLike = localStorage): Set<string> | null {
  try {
    // v2 only — older keys defaulted to "all open".
    const saved = storage.getItem(COLLAPSED_KEY_V2);
    if (saved === null) return null;
    const parsed = JSON.parse(saved) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : null;
  } catch {
    return null;
  }
}

export function writeCollapsedProviders(collapsed: Set<string>, storage: StorageLike = localStorage): void {
  try {
    storage.setItem(COLLAPSED_KEY_V2, JSON.stringify([...collapsed]));
  } catch {
    /* quota / private-mode */
  }
}

export function readCombosOpen(storage: StorageLike = localStorage): boolean {
  try {
    const saved = storage.getItem(COMBOS_OPEN_KEY_V1) ?? storage.getItem(COMBOS_OPEN_KEY_LEGACY);
    return saved === "1";
  } catch {
    return false;
  }
}

export function writeCombosOpen(open: boolean, storage: StorageLike = localStorage): void {
  try {
    storage.setItem(COMBOS_OPEN_KEY_V1, open ? "1" : "0");
  } catch {
    /* quota / private-mode */
  }
}
