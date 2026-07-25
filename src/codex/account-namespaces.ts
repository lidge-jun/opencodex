import type { OcxConfig } from "../types";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";

/** Public config shorthand for the Codex Desktop/main auth.json account. */
export const MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET = "main";
export const CODEX_ACCOUNT_BOUND_CATALOG_DESCRIPTION = "OpenAI native model bound to a Codex account namespace.";

export function codexAccountNamespaceDisplayName(namespace: string): string {
  return namespace
    .split(/[._-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function accountBoundNativeDisplayName(namespace: string, native: {
  slug?: unknown;
  display_name?: unknown;
}): string {
  const raw = typeof native.display_name === "string"
    ? native.display_name
    : String(native.slug ?? "");
  const model = raw.replace(/^gpt-/i, "").replaceAll("-", " ");
  return `${codexAccountNamespaceDisplayName(namespace)} / ${model}`;
}

export function accountBoundNativeCatalogSlug(entry: {
  slug?: unknown;
  description?: unknown;
}): string | undefined {
  if (entry.description !== CODEX_ACCOUNT_BOUND_CATALOG_DESCRIPTION || typeof entry.slug !== "string") {
    return undefined;
  }
  const slash = entry.slug.indexOf("/");
  return slash > 0 ? entry.slug.slice(slash + 1) : undefined;
}

export function normalizeCodexAccountNamespaceTarget(accountId: string): string {
  return accountId === MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET || accountId === MAIN_CODEX_ACCOUNT_ID
    ? MAIN_CODEX_ACCOUNT_ID
    : accountId;
}

export function codexAccountNamespaceEntries(config: Pick<OcxConfig, "codexAccountNamespaces">): Array<[string, string]> {
  return Object.entries(config.codexAccountNamespaces ?? {})
    .map(([namespace, accountId]) => [namespace, normalizeCodexAccountNamespaceTarget(accountId)]);
}

export function accountBoundNativeModelSlugs(
  config: Pick<OcxConfig, "codexAccountNamespaces">,
  nativeSlugs: Iterable<string>,
): string[] {
  const natives = [...nativeSlugs];
  return codexAccountNamespaceEntries(config)
    .flatMap(([namespace]) => natives.map(slug => `${namespace}/${slug}`));
}
