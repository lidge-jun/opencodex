import { isMainCodexAccountTarget } from "../account-namespaces";
import { COMBO_NAMESPACE } from "../../combos";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import type { CodexModelEntitlementSnapshot } from "../model-entitlements";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { isNativeAliasCatalogEntry, SUPPORTED_NATIVE_OPENAI_SLUGS } from "./metadata";
import type { RawEntry } from "./parsing";

/** Project authenticated account metadata onto native rows only. */
export function applyNativeAccessPrograms(
  entries: RawEntry[],
  snapshot: CodexModelEntitlementSnapshot,
  accountTargets: ReadonlyMap<string, string>,
): void {
  for (const entry of entries) {
    // A combo may deliberately claim a bare native slug. It is still a routed combo row,
    // so the matching native Codex roster must not project its access programs onto it.
    if (isNativeAliasCatalogEntry(entry)) continue;
    if (entry.owned_by === COMBO_NAMESPACE) {
      delete entry.available_access_programs;
      continue;
    }
    const accountBoundSlug = trustedAccountBoundNativeCatalogSlug(entry);
    const bareSlug = typeof entry.slug === "string" && !entry.slug.includes("/")
      && SUPPORTED_NATIVE_OPENAI_SLUGS.has(entry.slug) ? entry.slug : undefined;
    const slug = accountBoundSlug ?? bareSlug;
    if (!slug) continue;
    const selector = accountBoundSlug && typeof entry.slug === "string"
      ? entry.slug.slice(0, entry.slug.indexOf("/")) : undefined;
    const target = selector === undefined ? MAIN_CODEX_ACCOUNT_ID : accountTargets.get(selector);
    const accountId = target && isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target;
    if (!accountId) {
      delete entry.available_access_programs;
      continue;
    }
    // An old on-disk catalog can contain metadata from a previous credential. Until this
    // account has a confirmed roster, that value is no longer evidence of a grant.
    if (!snapshot.confirmedAccountIds.has(accountId)
      || !snapshot.modelsByAccount.get(accountId)?.has(slug)) {
      delete entry.available_access_programs;
      continue;
    }
    const accountPrograms = snapshot.accessProgramsByAccount?.get(accountId);
    if (accountPrograms?.has(slug)) {
      entry.available_access_programs = accountPrograms.get(slug) ?? null;
    } else {
      delete entry.available_access_programs;
    }
  }
}
