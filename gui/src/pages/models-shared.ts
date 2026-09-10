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

export interface ModelRow {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  initialSelectionPending?: boolean;
  native?: boolean;
  custom?: boolean;
  customId?: string;
  displayName?: string;
  displayNameOverride?: string;
  displayNameSource?: "operator" | "provider" | "fallback";
  manualPricing?: boolean;
  /**
   * Listed but currently unable to serve, because every usable target is quota-exhausted
   * (#1711). Distinct from `disabled`, which is the operator's own choice, and from visibility:
   * the row is still offered.
   */
  quotaInactiveReason?: "no_credit";
  /**
   * Provider-published cost class from model discovery (#3666). Absent means unknown — either
   * the provider publishes no per-token rates, or the row was cached by a build that predates
   * the field. Absent is never treated as free.
   */
  pricingStatus?: "free" | "paid";
  inputModalities?: string[];
  contextWindow?: number;
  contextCap?: number;
  contextCapped?: boolean;
  /** Stored custom-row override (not the inherited ladder); only present on custom rows. */
  reasoningEfforts?: string[];
}

/** The pricing shape both Free-only consumers read; keeps the helpers usable from either page. */
export type PricedRow = { pricingStatus?: "free" | "paid" };

/**
 * Whether a Free-only control should be offered for this set of rows at all (#3666).
 *
 * A provider that publishes no per-token prices — Ollama, a static catalog, anything whose
 * /models rows carry no usable rate pair — leaves every row unclassified, so a Free switch
 * there could only ever empty the list. That reads as a broken filter rather than as "this
 * provider does not say", so the control is hidden instead.
 */
export function modelPricingKnown(rows: readonly PricedRow[]): boolean {
  return rows.some(row => row.pricingStatus !== undefined);
}

/**
 * Apply the Free-only narrowing (#3666).
 *
 * Absent `pricingStatus` is never free: the discovery classifier omits the field exactly when
 * the provider's rates were missing, one-sided, non-numeric, or negative, and a cached row from
 * an older build has no field either. Both consumers call this BEFORE their own search, sort,
 * and page slice, or free models stay stranded behind Show more on a long provider list.
 */
export function filterFreeModelRows<T extends PricedRow>(rows: readonly T[], freeOnly: boolean): T[] {
  return freeOnly ? rows.filter(row => row.pricingStatus === "free") : [...rows];
}

/**
 * Whether the Free-only narrowing is actually in force for this set of rows.
 *
 * The switch is offered only where discovery returned prices, but the operator's choice is
 * component state that outlives the rows it was made against. When the evidence goes away —
 * a refresh that comes back without pricing, a re-auth, a discovery fallback to a static
 * catalog — the control disappears while the stale `true` keeps filtering, and every row is
 * unclassified, so the list empties with no visible way to turn it off. Gate the filter on the
 * same condition that gates the switch and the narrowing lapses with the control.
 */
export function freeOnlyInForce(freeOnly: boolean, rows: readonly PricedRow[]): boolean {
  return freeOnly && modelPricingKnown(rows);
}

function containsDisplayNameControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029;
  });
}

/** Mirror the server display-name contract for immediate form feedback. */
export function modelDisplayNameValidationKey(value: string): TKey | null {
  const trimmed = value.trim();
  if (!trimmed) return "models.displayNameRequired";
  if (trimmed.length > 128) return "models.displayNameTooLong";
  if (trimmed.includes("/")) return "models.displayNameNoSlash";
  if (containsDisplayNameControlCharacter(trimmed)) return "models.displayNameNoControl";
  return null;
}

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
  values?: Record<string, number>;
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
