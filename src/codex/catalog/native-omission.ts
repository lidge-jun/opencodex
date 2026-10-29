import type { OcxConfig } from "../../types";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "./native-models";
import { hasOcxRoutedAuthorship } from "./ownership";
import { hasOrdinaryNativeOpenAiRow } from "./control-plane";
import { isCodexControlPlaneModel } from "../control-plane-models";
import type { RawEntry } from "./parsing";

/** Final projection also covers exact selector disables and observed account-native ids. */
export function omitDisabledNativeCatalogEntries(
  entries: RawEntry[],
  config: Pick<OcxConfig, "omitDisabledNativeModels" | "disabledModels">,
): RawEntry[] {
  if (config.omitDisabledNativeModels !== true) return entries;
  const disabled = new Set(config.disabledModels ?? []);
  const visible = entries.filter(entry => {
    if (entry.opencodex_catalog_kind === CODEX_NATIVE_ALIAS_CATALOG_KIND) return true;
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const accountNative = trustedAccountBoundNativeCatalogSlug(entry);
    if (accountNative) return !disabled.has(slug) && !disabled.has(accountNative);
    return !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug) || hasOcxRoutedAuthorship(entry) || !disabled.has(slug);
  });
  // Nothing omitted: the flag must not change the catalog, control-plane rows included.
  if (visible.length === entries.length) return entries;
  return hasOrdinaryNativeOpenAiRow(visible)
    ? visible : visible.filter(entry => !isCodexControlPlaneModel(entry.slug));
}
