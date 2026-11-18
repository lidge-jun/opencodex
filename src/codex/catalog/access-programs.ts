import { isMainCodexAccountTarget } from "../account-namespaces";
import { COMBO_NAMESPACE } from "../../combos";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import type { CodexModelEntitlementSnapshot, NativeRosterCapabilities } from "../model-entitlements";
import { clampAutoCompactTokenLimit } from "../../providers/auto-compact-budget";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { BUILT_IN_NATIVE_OPENAI_MODELS } from "./native-models";
import {
  isNativeAliasCatalogEntry, NATIVE_OPENAI_CONTEXT_OVERRIDES, nativeOpenAiConfiguredContextLimit,
  pinnedNativeCapabilityFlag, SUPPORTED_NATIVE_OPENAI_SLUGS, type NativeContextLimits,
} from "./metadata";
import type { RawEntry } from "./parsing";

function applyBuiltInCapabilities(
  entry: RawEntry, slug: string, roster: NativeRosterCapabilities | undefined, limits: NativeContextLimits,
): void {
  if (!BUILT_IN_NATIVE_OPENAI_MODELS.includes(slug)) return;
  for (const flag of ["supports_reasoning_effort_updates", "supports_experimental_context"] as const) {
    const value = roster?.[flag] ?? pinnedNativeCapabilityFlag(slug, flag);
    if (value === undefined) delete entry[flag];
    else entry[flag] = value;
  }
  // The merge already applied pinned windows and user policy. Recompute only when
  // the confirmed account supplied a window; an omitted companion uses the pinned value.
  if (roster?.context_window === undefined && roster?.max_context_window === undefined) return;
  const fallback = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug];
  const maximum = roster.max_context_window ?? fallback?.maxContextWindow;
  const defaultWindow = roster.context_window ?? fallback?.contextWindow;
  if (defaultWindow === undefined || maximum === undefined) return;
  const configured = nativeOpenAiConfiguredContextLimit(slug, limits);
  const window = Math.min(configured ?? defaultWindow, maximum);
  const retained = entry.context_window === window ? entry.auto_compact_token_limit : undefined;
  const budget = clampAutoCompactTokenLimit(window, fallback?.maxInputTokens, limits.modelAutoCompactTokenLimits?.[slug]);
  entry.context_window = window;
  entry.max_context_window = Math.min(configured ?? maximum, maximum);
  entry.auto_compact_token_limit = typeof retained === "number" && Number.isSafeInteger(retained) && retained > 0
    ? Math.min(retained, budget) : budget;
}

function nativeRosterTarget(
  entry: RawEntry, snapshot: CodexModelEntitlementSnapshot, accountTargets: ReadonlyMap<string, string>,
) {
  const accountBoundSlug = trustedAccountBoundNativeCatalogSlug(entry);
  const bareSlug = typeof entry.slug === "string" && SUPPORTED_NATIVE_OPENAI_SLUGS.has(entry.slug) ? entry.slug : undefined;
  const slug = accountBoundSlug ?? bareSlug;
  if (!slug) return;
  const selector = accountBoundSlug && typeof entry.slug === "string" ? entry.slug.slice(0, entry.slug.indexOf("/")) : undefined;
  const target = selector === undefined ? MAIN_CODEX_ACCOUNT_ID : accountTargets.get(selector);
  const accountId = target && isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target;
  const confirmedAccount = accountId && snapshot.confirmedAccountIds.has(accountId) && snapshot.modelsByAccount.get(accountId)?.has(slug)
    ? accountId : undefined;
  return { slug, bareSlug, confirmedAccount };
}

/** Used by both on-disk publication and read-only HTTP discovery. */
export function applyNativeRosterCapabilities(
  entries: RawEntry[], snapshot: CodexModelEntitlementSnapshot, accountTargets: ReadonlyMap<string, string>,
  limits: NativeContextLimits = {},
): void {
  for (const entry of entries) {
    if (isNativeAliasCatalogEntry(entry) || entry.owned_by === COMBO_NAMESPACE) continue;
    const target = nativeRosterTarget(entry, snapshot, accountTargets);
    if (!target) continue;
    const capabilities = target.confirmedAccount ? snapshot.capabilitiesByAccount?.get(target.confirmedAccount)?.get(target.slug) : undefined;
    applyBuiltInCapabilities(entry, target.slug, capabilities, limits);
  }
}

/** Project access programs per native account, and availability prompts only onto bare main rows. */
export function applyNativeAccessPrograms(
  entries: RawEntry[], snapshot: CodexModelEntitlementSnapshot, accountTargets: ReadonlyMap<string, string>,
): void {
  for (const entry of entries) {
    // A combo may deliberately claim a bare native slug. It is still a routed combo row,
    // so the matching native Codex roster must not project its access programs onto it.
    if (isNativeAliasCatalogEntry(entry)) {
      delete entry.availability_nux;
      continue;
    }
    if (entry.owned_by === COMBO_NAMESPACE) {
      delete entry.available_access_programs;
      delete entry.availability_nux;
      continue;
    }
    const target = nativeRosterTarget(entry, snapshot, accountTargets);
    if (!target) continue;
    const { slug, bareSlug, confirmedAccount } = target;
    if (!bareSlug) delete entry.availability_nux;
    else {
      entry.availability_nux = confirmedAccount === MAIN_CODEX_ACCOUNT_ID
        ? snapshot.availabilityNuxByAccount?.get(confirmedAccount)?.get(slug) ?? null
        : null;
    }
    // An old on-disk catalog can contain metadata from a previous credential. Until this
    // account has a confirmed roster, that value is no longer evidence of a grant.
    if (!confirmedAccount) {
      delete entry.available_access_programs;
      continue;
    }
    const accountPrograms = snapshot.accessProgramsByAccount?.get(confirmedAccount);
    if (accountPrograms?.has(slug)) {
      entry.available_access_programs = accountPrograms.get(slug) ?? null;
    } else {
      delete entry.available_access_programs;
    }
  }
}

export function applyNativeRosterMetadata(
  entries: RawEntry[], snapshot: CodexModelEntitlementSnapshot, accountTargets: ReadonlyMap<string, string>, limits: NativeContextLimits,
): void {
  applyNativeRosterCapabilities(entries, snapshot, accountTargets, limits);
  applyNativeAccessPrograms(entries, snapshot, accountTargets);
}
