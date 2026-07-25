import type { OcxConfig } from "../types";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";

/** Public config shorthand for the Codex Desktop/main auth.json account. */
export const MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET = "main";
export const CODEX_ACCOUNT_BOUND_CATALOG_DESCRIPTION = "OpenAI native model bound to a Codex account namespace.";

const RESERVED_NAMESPACE_KEYS = new Set(["__proto__", "prototype", "constructor", "combo"]);

function generatedNamespace(label: string): string {
  const normalized = label.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return normalized && !RESERVED_NAMESPACE_KEYS.has(normalized) ? normalized : "account";
}

/** Build the initial UI-managed namespace map without exposing account ids to the browser. */
export function defaultCodexAccountNamespaces(
  config: Pick<OcxConfig, "codexAccounts" | "providers">,
): Record<string, string> {
  const namespaces: Record<string, string> = {};
  const used = new Set([...Object.keys(config.providers), ...RESERVED_NAMESPACE_KEYS]);
  const claim = (requested: string): string => {
    const base = generatedNamespace(requested);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    used.add(candidate);
    return candidate;
  };

  namespaces[claim("personal")] = MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET;
  for (const account of config.codexAccounts ?? []) {
    if (account.isMain) continue;
    namespaces[claim(account.alias || account.id)] = account.id;
  }
  return namespaces;
}

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
  const model = raw
    .replace(/^gpt-/i, "")
    .split("-")
    .filter(Boolean)
    .map(part => /^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(" ");
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
