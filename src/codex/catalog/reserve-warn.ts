import type { OcxConfig } from "../../types";
import { isEffectiveCodexDesktopAuthless } from "../loopback-target";
import { NATIVE_RESERVE_MODEL } from "./native-models";

/**
 * #4811: why an opted-in install still gets no Luna Reserve row.
 *
 * The Reserve projection is account-qualified — its slug is `<selector>/gpt-reserve` — so it
 * cannot be written without a selector that targets the main Codex account. On a fresh authless
 * install `codexAccountNamespaces` is empty, the account picker is therefore off, no selectors
 * exist, and `createReserveCatalogProjection` returns `undefined`. Nothing downstream can
 * explain that: an omitted row has no place to carry a reason, which is exactly the shape of
 * #4212 for account-gated natives, and the same answer applies — say it once, here, while the
 * inputs that produced the omission are still in scope.
 *
 * Deliberately scoped to an operator who asked for the feature. A default install has
 * `codexDesktopAuthless` unset, wants no Reserve row, and must not be told about one. An install
 * that stores the flag on a bind where it cannot take effect is a different silence, already
 * reported as `inertReason` by `describeCodexDesktopSwitches`, and is not repeated here.
 */
export type ReserveCatalogSuppressionReason =
  | "no-canonical-openai-provider"
  | "account-picker-disabled"
  | "no-account-namespaces"
  | "no-main-account-selector";

type ReserveSuppressionConfig = Pick<
  OcxConfig,
  | "runtimeRole"
  | "hostname"
  | "unauthenticatedLoopbackListener"
  | "codexDesktopAuthless"
  | "codexAccountNamespaces"
  | "codexAccountPickerEnabled"
>;

export interface ReserveSuppressionInput {
  /** Already resolved by the caller; passed in so this module stays off the metadata graph. */
  includeAccountBoundNativeOpenAi: boolean;
  /** Selectors that resolved to the main Codex account. A non-empty list means no suppression. */
  mainSelectors: readonly string[];
}

export function reserveCatalogSuppressionReason(
  config: ReserveSuppressionConfig,
  input: ReserveSuppressionInput,
): ReserveCatalogSuppressionReason | undefined {
  if (!isEffectiveCodexDesktopAuthless(config) || input.mainSelectors.length > 0) return undefined;
  if (!input.includeAccountBoundNativeOpenAi) return "no-canonical-openai-provider";
  // Checked before the empty-map case: when an operator has explicitly turned the picker off,
  // naming the empty map would send them to hand-author selectors that the opt-in generates.
  if (config.codexAccountPickerEnabled === false) return "account-picker-disabled";
  if (Object.keys(config.codexAccountNamespaces ?? {}).length === 0) return "no-account-namespaces";
  return "no-main-account-selector";
}

const SUPPRESSION_TEXT: Readonly<Record<ReserveCatalogSuppressionReason, {
  cause: string;
  action: string;
}>> = {
  "no-canonical-openai-provider": {
    cause: "no enabled canonical OpenAI provider can serve account-qualified native routes",
    action: "Enable the built-in \"openai\" provider with forwarded ChatGPT auth.",
  },
  "account-picker-disabled": {
    cause: "the Codex account picker is turned off (codexAccountPickerEnabled is false)",
    action: "Set codexAccountPickerEnabled to true to generate the default account selectors.",
  },
  "no-account-namespaces": {
    cause: "no Codex account selectors are configured (codexAccountNamespaces is empty)",
    action: "Enable the Codex account picker once to generate the default account selectors.",
  },
  "no-main-account-selector": {
    cause: "no configured selector in codexAccountNamespaces targets the main Codex account",
    action: "Map one selector to the main Codex account.",
  },
};

const warnedReserveSuppression = new Set<string>();

/** Test seam: the warn-once memory is process-global, so a case needs to be able to clear it. */
export function resetReserveSuppressionWarningsForTests(): void {
  warnedReserveSuppression.clear();
}

export function warnReserveSuppressedOnce(reason: ReserveCatalogSuppressionReason): void {
  if (warnedReserveSuppression.has(reason)) return;
  warnedReserveSuppression.add(reason);
  const text = SUPPRESSION_TEXT[reason];
  console.warn(
    `[opencodex] catalog sync: authless Codex Desktop routing is on, but the Luna Reserve row `
      + `(<selector>/${NATIVE_RESERVE_MODEL}) is not being written because ${text.cause}. `
      + `The Reserve projection is account-qualified and needs a selector for the main Codex `
      + `account. ${text.action}`,
  );
}
