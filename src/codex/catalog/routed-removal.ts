import { COMBO_NAMESPACE } from "../../combos";
import { readConfigAdmissionSnapshot, type ConfigAdmissionSnapshot } from "../../config/diagnostics";
import type { OcxConfig } from "../../types";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { isOcxAuthoredRoutedEntry } from "./build-entries";
import { isNativeAliasCatalogEntry } from "./metadata";
import type { RawCatalog, RawEntry } from "./parsing";

/**
 * Routed namespaces a candidate catalog empties of OpenCodex-authored rows only because the config
 * that produced it does not enable them: the "deleted provider" rule in build-entries. That rule is
 * the one way a refresh removes a provider's rows wholesale, so it is the one a config that is not
 * the user's (a missing or unreadable config.json read as defaults, another OPENCODEX_HOME) turns
 * into a silent native-only catalog (#6529).
 */
export interface UnconfiguredRoutedRemoval {
  readonly namespaces: readonly string[];
}

type RoutedNamespaceConfig = Pick<OcxConfig, "providers" | "combos">;

function routedNamespace(entry: RawEntry): string | null {
  if (typeof entry.slug !== "string") return null;
  // Account-bound native rows follow the account pool, not provider config.
  if (trustedAccountBoundNativeCatalogSlug(entry) !== undefined) return null;
  // Foreign rows (Cursor, user tooling) are never removed by the provider rule.
  if (!isOcxAuthoredRoutedEntry(entry)) return null;
  if (isNativeAliasCatalogEntry(entry)) return COMBO_NAMESPACE;
  return entry.slug.slice(0, entry.slug.indexOf("/"));
}

/** OpenCodex-authored routed rows per namespace; foreign and account-bound rows never count. */
export function ocxRoutedNamespaceCounts(catalog: RawCatalog | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of catalog?.models ?? []) {
    const namespace = routedNamespace(entry);
    if (namespace !== null) counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }
  return counts;
}

/** Total OpenCodex-authored routed rows, or null for a value that is not a catalog. */
export function ocxRoutedRowCount(catalog: unknown): number | null {
  if (catalog === null || typeof catalog !== "object" || !Array.isArray((catalog as RawCatalog).models)) return null;
  let total = 0;
  for (const count of ocxRoutedNamespaceCounts(catalog as RawCatalog).values()) total += count;
  return total;
}

/** Whether a config still produces routed rows for a namespace: an enabled provider, or any combo. */
export function configEnablesRoutedNamespace(config: RoutedNamespaceConfig, namespace: string): boolean {
  if (namespace === COMBO_NAMESPACE && Object.keys(config.combos ?? {}).length > 0) return true;
  const provider = config.providers?.[namespace];
  return provider !== undefined && provider.disabled !== true;
}

/**
 * The namespaces whose OpenCodex-authored routed rows are on disk now, absent from the candidate,
 * and not enabled by the driving config; null when the candidate removes no such namespace.
 * Removals inside a namespace the driving config still enables (discovery, selection, a deleted
 * custom model) are the provider's own business and are not reported here.
 */
export function unconfiguredRoutedRemoval(
  active: RawCatalog | null,
  candidate: RawCatalog,
  driving: RoutedNamespaceConfig,
): UnconfiguredRoutedRemoval | null {
  const activeModels = active?.models ?? [];
  if (activeModels.length === 0) return null;
  const kept = new Set((candidate.models ?? []).flatMap(entry => typeof entry.slug === "string" ? [entry.slug] : []));
  const namespaces = new Set<string>();
  for (const entry of activeModels) {
    if (typeof entry.slug === "string" && kept.has(entry.slug)) continue;
    const namespace = routedNamespace(entry);
    if (namespace !== null && !configEnablesRoutedNamespace(driving, namespace)) namespaces.add(namespace);
  }
  return namespaces.size > 0 ? { namespaces: [...namespaces].sort() } : null;
}

/**
 * True when config.json on disk backs every removal: it is a readable, parseable file, and it enables
 * none of the removed namespaces. A missing, unreadable or salvaged file backs nothing, and a file
 * that still enables a namespace shows the driving config was not the one on disk. Read once, at
 * write time, so a config that fell back to defaults while the file was briefly unreadable cannot
 * pass on a later successful read.
 */
export function routedRemovalBackedByConfigFile(
  removal: UnconfiguredRoutedRemoval,
  read: () => ConfigAdmissionSnapshot = readConfigAdmissionSnapshot,
): boolean {
  const snapshot = read();
  if (snapshot.kind !== "read" || snapshot.diagnostics.source !== "file") return false;
  return removal.namespaces.every(namespace => !configEnablesRoutedNamespace(snapshot.diagnostics.config, namespace));
}

/** One line for logs when K refused a writer from another OPENCODEX_HOME; names no path. */
export const FOREIGN_CODEX_HOME_OWNER_MESSAGE = "Codex catalog left unchanged: this Codex home was set up by "
  + "another OpenCodex home (OPENCODEX_HOME), recorded in its opencodex-journal.json. Run opencodex "
  + "from that home, or run `ocx restore` there first.";

/** One line for logs: counts only, never provider names, model ids or paths. */
export function unbackedRoutedRemovalMessage(count: number): string {
  return `Codex catalog left unchanged: this refresh would remove the routed models of ${count} `
    + `provider namespace${count === 1 ? "" : "s"} that config.json still enables, or config.json `
    + "is missing or unreadable. Run `ocx sync` again once config.json is readable; use `ocx restore` "
    + "to remove routed models on purpose.";
}
