import type { OcxConfig } from "../types";
import {
  CODEX_ACCOUNT_LOG_LABEL_RE,
  createCodexAccountLogLabel,
  fallbackCodexAccountLogLabel,
} from "./account-label";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";

/** Public config shorthand for the Codex Desktop/main auth.json account. */
export const MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET = "main";
export const CODEX_ACCOUNT_BOUND_CATALOG_DESCRIPTION = "OpenAI native model bound to a Codex account namespace.";

const RESERVED_NAMESPACE_KEYS = new Set(["__proto__", "prototype", "constructor", "combo"]);

export function codexAccountPickerIsEnabled(
  config: Pick<OcxConfig, "codexAccountNamespaces" | "codexAccountPickerEnabled">,
): boolean {
  return config.codexAccountPickerEnabled !== false
    && Object.keys(config.codexAccountNamespaces ?? {}).length > 0;
}

export function visibleCodexAccountNamespaces(
  config: Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled">,
): Readonly<Record<string, string>> {
  if (!codexAccountPickerIsEnabled(config)) return {};
  return Object.fromEntries(
    Object.entries(config.codexAccountNamespaces!)
      .filter(([, accountId]) =>
        isMainCodexAccountTarget(accountId)
        || (config.codexAccounts ?? []).some(account => !account.isMain && account.id === accountId)
      ),
  );
}

export function codexAccountPickerHasVisibleRows(
  config: Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled">,
): boolean {
  return Object.keys(visibleCodexAccountNamespaces(config)).length > 0;
}

function generatedNamespace(publicLabel: string): string {
  const normalized = publicLabel.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return normalized && !RESERVED_NAMESPACE_KEYS.has(normalized) ? normalized : "account";
}

function comboAliasNamespaces(config: Pick<OcxConfig, "combos">): string[] {
  return Object.values(config.combos ?? {}).flatMap((combo) => {
    const alias = typeof combo?.alias === "string" ? combo.alias.trim() : "";
    const slash = alias.indexOf("/");
    return slash > 0 ? [alias.slice(0, slash)] : [];
  });
}

function defaultPublicAccountLabel(account: { id: string; alias?: string; logLabel?: string }): string {
  const alias = account.alias?.trim();
  if (alias) return alias;
  if (CODEX_ACCOUNT_LOG_LABEL_RE.test(account.logLabel ?? "")) return account.logLabel!;

  // Legacy or hand-edited account rows may predate persisted random log labels. Generate an
  // independent public selector and persist it in the namespace map; never expose the stable,
  // id-derived fallback that exists only to keep old diagnostic logs redacted.
  return createCodexAccountLogLabel([fallbackCodexAccountLogLabel(account.id)]);
}

/** Build the initial UI-managed map from public labels without exposing stored account ids. */
export function defaultCodexAccountNamespaces(
  config: Pick<OcxConfig, "codexAccounts" | "combos" | "providers">,
): Record<string, string> {
  const namespaces: Record<string, string> = {};
  const used = new Set([
    ...Object.keys(config.providers),
    ...comboAliasNamespaces(config),
    ...RESERVED_NAMESPACE_KEYS,
  ]);
  const claim = (requested: string): string => {
    const base = generatedNamespace(requested);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    used.add(candidate);
    return candidate;
  };

  namespaces[claim("main")] = MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET;
  for (const account of config.codexAccounts ?? []) {
    if (account.isMain || isMainCodexAccountTarget(account.id)) continue;
    namespaces[claim(defaultPublicAccountLabel(account))] = account.id;
  }
  return namespaces;
}

/** Add a newly stored account to an existing UI-managed map without renaming old rows. */
export function appendDefaultCodexAccountNamespace(
  config: Pick<OcxConfig, "codexAccountNamespaces" | "combos" | "providers">,
  account: { id: string; alias?: string; logLabel?: string; isMain: boolean },
): boolean {
  if (account.isMain
    || isMainCodexAccountTarget(account.id)
    || !config.codexAccountNamespaces
    || Object.keys(config.codexAccountNamespaces).length === 0) return false;
  if (Object.values(config.codexAccountNamespaces).includes(account.id)) return false;
  const used = new Set([
    ...Object.keys(config.providers),
    ...comboAliasNamespaces(config),
    ...Object.keys(config.codexAccountNamespaces),
    ...RESERVED_NAMESPACE_KEYS,
  ]);
  const base = generatedNamespace(defaultPublicAccountLabel(account));
  let namespace = base;
  let suffix = 2;
  while (used.has(namespace)) namespace = `${base}-${suffix++}`;
  config.codexAccountNamespaces[namespace] = account.id;
  return true;
}

export function codexAccountNamespaceDisplayName(namespace: string): string {
  return namespace
    .split(/([._-]+)/)
    .map(part => /^[._-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
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

export function isMainCodexAccountTarget(accountId: string): boolean {
  return accountId === MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET || accountId === MAIN_CODEX_ACCOUNT_ID;
}

export function normalizeCodexAccountNamespaceTarget(accountId: string): string {
  return isMainCodexAccountTarget(accountId)
    ? MAIN_CODEX_ACCOUNT_ID
    : accountId;
}

export function codexAccountNamespaceEntries(
  config: Pick<OcxConfig, "codexAccountNamespaces">,
): Array<[string, string]> {
  return Object.entries(config.codexAccountNamespaces ?? {})
    .map(([namespace, accountId]) => [namespace, normalizeCodexAccountNamespaceTarget(accountId)]);
}

export function visibleCodexAccountNamespaceEntries(
  config: Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled">,
): Array<[string, string]> {
  return Object.entries(visibleCodexAccountNamespaces(config))
    .map(([namespace, accountId]) => [namespace, normalizeCodexAccountNamespaceTarget(accountId)]);
}

export function accountBoundNativeModelSlugs(
  config: Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled">,
  nativeSlugs: Iterable<string>,
): string[] {
  const natives = [...nativeSlugs];
  return visibleCodexAccountNamespaceEntries(config)
    .flatMap(([namespace]) => natives.map(slug => `${namespace}/${slug}`));
}
