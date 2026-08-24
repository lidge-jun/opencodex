import type { TFn, TKey } from "../i18n/shared";
import type { ProviderDiscoverySummary } from "../models-groups";
import { modelVisible, type ProviderModelMap } from "../model-visibility";
import { formatNamespacedModelId } from "../provider-icons";

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

export type ModelMetadataSource =
  | "live"
  | "registry"
  | "snapshot"
  | "config_fallback"
  | "unknown"
  | "derived";

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
  /** Pre-cap discovered window when the API still has it; used for "1.05M detected · capped at 350k". */
  detectedContextWindow?: number;
  metadataSource?: ModelMetadataSource;
  metadataObservedAt?: string;
  metadataStale?: boolean;
  /** Stored custom-row override (not the inherited ladder); only present on custom rows. */
  reasoningEfforts?: string[];
}

/** Codex strict-parser placeholder; never shown as a claimed discovered window. */
export const COMPATIBILITY_CONTEXT_WINDOW = 128_000;

/**
 * Reasoning-effort labels offered in the custom-model dialog. The full set of real
 * `reasoning_effort` values (none, minimal, low, medium, high, xhigh, max). Deliberately
 * excludes `ultra`: that is a Codex catalog label for the multi-agent collab surface, not a
 * real `reasoning_effort` value — codex-rs converts it to `max` before any provider
 * request, and the catalog writer appends it to every non-empty ladder anyway.
 */
export const REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
  keepNativeChatGptOnV1?: boolean;
}

export interface ShadowCallData {
  enabled: boolean;
  model: string;
  /** Source models the runtime actually intercepts. Older runtimes omit it. */
  sourceModels?: string[];
}

export const CAP_OPTIONS = Array.from({ length: 18 }, (_, i) => 100_000 + i * 50_000); // 100k … 950k
export const CAP_OPTION_SET = new Set(CAP_OPTIONS);
/**
 * Cap presets for the Codex-login native group.
 *
 * Deliberately three values, not the generic 100k…950k ladder: these are the windows the
 * native GPT-5.6 family actually has a contract for — 272,000 (what the live catalog
 * reports), 372,000 (the previous opencodex contract), and 922,000 (the current advertised
 * cap, measured; see devlog/_plan/260817_native_gpt56_1m_context). A cap only ever lowers a
 * window, so listing a value above the advertised one would be an inert choice.
 * Anything else goes through "Custom".
 */
export const NATIVE_GPT56_DEFAULT_WINDOW = 272_000;
export const NATIVE_GPT56_OPT_IN_WINDOW = 922_000;
export const NATIVE_CAP_OPTIONS = [NATIVE_GPT56_DEFAULT_WINDOW, 372_000, NATIVE_GPT56_OPT_IN_WINDOW];
export const NATIVE_CAP_OPTION_SET = new Set(NATIVE_CAP_OPTIONS);
export const CUSTOM_OPTION = "custom";
export const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128, 256, 500, 1000];
export const THREAD_OPTION_SET = new Set(THREAD_OPTIONS);
export const PAGE = 60; // rows rendered per provider before a "show more"

export const COLLAPSED_KEY_V2 = "ocx-models-collapsed:v2";

/**
 * Compact token display (350k, 1.05M) — the unit suffix is technical notation, not prose,
 * so it is not an i18n string (same rule the "k" suffix has always followed).
 */
export function fmtK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  if (n % 1000 !== 0) return n.toLocaleString();
  // Past a million "1050k" stops reading as a size. Trailing zeros are dropped so
  // 1,000,000 renders as "1M" rather than "1.00M".
  // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- unit suffix, not prose
  if (n >= 1_000_000) return Number((n / 1_000_000).toFixed(2)) + "M";
  return `${n / 1000}k`;
}

type ContextRow = Pick<
  ModelRow,
  | "contextWindow"
  | "contextCap"
  | "contextCapped"
  | "detectedContextWindow"
  | "metadataSource"
  | "metadataObservedAt"
  | "metadataStale"
  | "native"
>;

function positiveWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sourceClaimsWindow(source: ModelRow["metadataSource"]): boolean {
  return source === "live" || source === "registry" || source === "snapshot" || source === "derived";
}

/** Window the UI may display as a real size. Compatibility 128k and `unknown` are omitted. */
export function claimedContextWindow(row: ContextRow): number | undefined {
  const window = positiveWindow(row.contextWindow);
  if (window === undefined) return undefined;
  if (row.metadataSource === "unknown") return undefined;
  if (window === COMPATIBILITY_CONTEXT_WINDOW) {
    if (sourceClaimsWindow(row.metadataSource)) return window;
    if (row.native === true) return window;
    if (row.metadataSource === undefined || row.metadataSource === "config_fallback") {
      return undefined;
    }
  }
  return window;
}

export function modelContextSourceChipKey(
  row: Pick<ModelRow, "metadataSource"> & Partial<Pick<ModelRow, "provider">>,
): TKey | undefined {
  switch (row.metadataSource) {
    case "live":
      return "models.contextMetadataLive";
    case "registry":
      return row.provider === "cursor" ? "models.contextMetadataCursorStatic" : "models.contextMetadataRegistry";
    case "snapshot":
      return "models.contextMetadataSnapshot";
    case "config_fallback":
      return "models.contextMetadataFallback";
    case "derived":
      return "models.contextMetadataDerived";
    default:
      return undefined;
  }
}

export function formatMetadataAge(iso: string | undefined, t: TFn, now = Date.now()): string {
  if (!iso) return t("time.notChecked");
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return t("time.notChecked");
  const elapsedMs = Math.max(0, now - then);
  const days = Math.floor(elapsedMs / 86_400_000);
  if (days === 1) return t("models.contextYesterday");
  if (days >= 2) return t("time.daysAgo", { n: days });
  const hours = Math.floor(elapsedMs / 3_600_000);
  if (hours >= 1) return t("time.hoursAgo", { n: hours });
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes >= 1) return t("time.minutesAgo", { n: minutes });
  return t("time.justNow");
}

export function formatModelContextTooltip(row: ContextRow, t: TFn, now = Date.now()): string | undefined {
  const cap = row.contextCapped === true ? positiveWindow(row.contextCap) : undefined;
  const detected = positiveWindow(row.detectedContextWindow);
  if (cap !== undefined && detected !== undefined && detected > cap) {
    return t("models.contextTooltipCapped", { detected: fmtK(detected), cap: fmtK(cap) });
  }

  const claimed = claimedContextWindow(row);
  if (claimed === undefined) {
    if (row.metadataSource === "unknown" || positiveWindow(row.contextWindow) === COMPATIBILITY_CONTEXT_WINDOW) {
      return t("models.contextTooltipUnknown");
    }
    return undefined;
  }

  if (cap !== undefined) {
    return t("models.contextTooltipCapped", {
      detected: fmtK(detected ?? claimed),
      cap: fmtK(cap),
    });
  }

  if (row.metadataStale === true) {
    return t("models.contextTooltipStale", {
      value: fmtK(claimed),
      when: t("models.contextLastChecked", {
        when: formatMetadataAge(row.metadataObservedAt, t, now),
      }),
    });
  }

  if (row.metadataSource === "live") {
    return t("models.contextTooltipDetected", { value: fmtK(claimed) });
  }

  const sourceKey = modelContextSourceChipKey(row);
  if (sourceKey) return t("models.contextTooltipSource", { value: fmtK(claimed), source: t(sourceKey) });
  return fmtK(claimed);
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
  t?: TFn,
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (const m of models) {
    const blocked = disabled.has(m.id) || disabled.has(m.namespaced);
    if (modelVisible(selected, m.provider, m.id, m.native === true, blocked)) {
      // Friendly label (display-name provider prefix) while the raw route stays the value.
      options.push({ value: m.namespaced, label: t ? formatNamespacedModelId(m.namespaced, t) : m.namespaced });
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
