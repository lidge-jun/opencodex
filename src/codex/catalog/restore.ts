import { readConfigDiagnostics } from "../../config";
import { getCodexHome } from "../paths";
import { readCatalog, readCatalogBackup, readCodexCatalogPath } from "./parsing";
import type { RawEntry } from "./parsing";
import { RETIRED_NATIVE_OPENAI_MODELS, SUPPORTED_NATIVE_OPENAI_SLUGS } from "./metadata";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import {
  withCatalogWriteSerialization,
  type CatalogWritePermit,
} from "../catalog-write-serialization";
import { replaceActiveCodexCatalog } from "../internal/catalog-writer";

function visibleAccountReplacementNatives(
  models: readonly RawEntry[],
  disabledModels: ReadonlySet<string> | null,
): Map<string, boolean> {
  const replacements = new Map<string, boolean>();
  for (const entry of models) {
    const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry);
    if (nativeSlug === undefined || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(nativeSlug)) continue;
    const exactSlug = typeof entry.slug === "string" ? entry.slug : "";
    const visible = entry.visibility === "list"
      || (disabledModels !== null
        && (disabledModels.has(nativeSlug) || disabledModels.has(exactSlug)));
    replacements.set(nativeSlug, (replacements.get(nativeSlug) ?? true) && visible);
  }
  return replacements;
}

function restoreAccountHiddenBareNatives(
  entries: readonly RawEntry[],
  replacementVisibility: ReadonlyMap<string, boolean>,
  disabledModels: ReadonlySet<string> | null,
): RawEntry[] {
  return entries.map(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (
      entry.visibility !== "hide"
      || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)
      || replacementVisibility.get(slug) !== true
      || disabledModels === null
      || disabledModels.has(slug)
    ) {
      return entry;
    }
    return { ...entry, visibility: "list" };
  });
}

function currentDisabledModelsForRestore(): Set<string> | null {
  try {
    const diagnostics = readConfigDiagnostics();
    if (diagnostics.source === "fallback" || diagnostics.error !== null) return null;
    return new Set(diagnostics.config.disabledModels ?? []);
  } catch {
    // An unreadable config cannot safely authorize a visibility change during restore.
    return null;
  }
}

export function restoreCodexCatalogWithPermit(
  permit: CatalogWritePermit,
  owningCodexHome: string,
  /**
   * The catalog this injection actually wrote, when it is known (#1798).
   *
   * Re-resolving from the CURRENT config is wrong after a Codex app rewrite that dropped
   * `model_catalog_json`: that sends restore to the default catalog while the routed file we
   * really wrote is left untouched. The recorded path is the file whose routing is ours.
   */
  injectedCatalogPath?: string | null,
): { removed: number; kept: number; path: string } {
  const catalogPath = injectedCatalogPath ?? readCodexCatalogPath();
  const catalog = readCatalog(catalogPath);
  if (!catalog || !Array.isArray(catalog.models)) return { removed: 0, kept: 0, path: catalogPath };
  const disabledModels = currentDisabledModelsForRestore();
  const replacementVisibility = visibleAccountReplacementNatives(catalog.models, disabledModels);
  const backup = readCatalogBackup(catalogPath);
  if (backup && Array.isArray(backup.models)) {
    const removed = (catalog.models ?? []).filter(m => typeof m.slug === "string"
      && (m.slug.includes("/") || RETIRED_NATIVE_OPENAI_MODELS.has(m.slug))).length;
    const backupSlugs = new Set(backup.models.flatMap(m => typeof m.slug === "string" ? [m.slug] : []));
    const userNativeAdditions = restoreAccountHiddenBareNatives(
      (catalog.models ?? []).filter(m =>
        typeof m.slug === "string" && !m.slug.includes("/") && !backupSlugs.has(m.slug)
        && !RETIRED_NATIVE_OPENAI_MODELS.has(m.slug)
      ),
      replacementVisibility,
      disabledModels,
    );
    const restored = {
      ...backup,
      // A pristine backup predates retirement; it must not revive withdrawn native rows.
      models: [...backup.models.filter(m => typeof m.slug !== "string"
        || !RETIRED_NATIVE_OPENAI_MODELS.has(trustedAccountBoundNativeCatalogSlug(m) ?? m.slug)), ...userNativeAdditions],
    };
    replaceActiveCodexCatalog(permit, owningCodexHome, {
      path: catalogPath,
      content: `${JSON.stringify(restored, null, 2)}\n`,
    });
    return { removed, kept: restored.models.length, path: catalogPath };
  }
  const before = catalog.models.length;
  const native = restoreAccountHiddenBareNatives(
    catalog.models.filter(m => !(typeof m.slug === "string"
      && (m.slug.includes("/") || RETIRED_NATIVE_OPENAI_MODELS.has(m.slug)))),
    replacementVisibility,
    disabledModels,
  );
  const removed = before - native.length;
  if (removed > 0) {
    catalog.models = native;
    replaceActiveCodexCatalog(permit, owningCodexHome, {
      path: catalogPath,
      content: `${JSON.stringify(catalog, null, 2)}\n`,
    });
  }
  return { removed, kept: native.length, path: catalogPath };
}

export function restoreCodexCatalog(): { removed: number; kept: number; path: string } {
  const owningCodexHome = getCodexHome();
  const outcome = withCatalogWriteSerialization(
    owningCodexHome,
    permit => restoreCodexCatalogWithPermit(permit, owningCodexHome),
  );
  return outcome.kind === "completed"
    ? outcome.value
    : { removed: 0, kept: 0, path: readCodexCatalogPath() };
}

/** Force Codex's models_cache stale from the on-disk catalog. Returns whether a cache write occurred. */
