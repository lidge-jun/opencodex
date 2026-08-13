import type { CodexAccount, OcxConfig } from "../types";
import { COMBO_NAMESPACE } from "../combos/types";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import {
  POLICY_NAMESPACE,
  routingProfileAliasNamespacePrefixes,
} from "../routing/profile-namespace";
import {
  CODEX_ACCOUNT_LOG_LABEL_RE,
  createCodexAccountLogLabel,
  fallbackCodexAccountLogLabel,
} from "./account-label";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import {
  codexAccountIdNamespaceCollisionError,
  codexProviderNamespaceKey,
  MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET,
} from "./account-namespace-match";

export { isValidCodexAccountNamespaceTarget } from "./account-namespace-match";

const RESERVED_NAMESPACE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  COMBO_NAMESPACE,
  OPENAI_CODEX_PROVIDER_ID,
  POLICY_NAMESPACE,
].map(codexProviderNamespaceKey));
const PUBLIC_ACCOUNT_SELECTOR_MAX_ATTEMPTS = 16;

function comboAliasNamespaces(config: Pick<OcxConfig, "combos">): string[] {
  return Object.values(config.combos ?? {}).flatMap((combo) => {
    const alias = typeof combo?.alias === "string" ? combo.alias.trim() : "";
    const slash = alias.indexOf("/");
    return slash > 0 ? [alias.slice(0, slash)] : [];
  });
}

function privateAccountSelectorCandidates(accountIds: Iterable<string>): Set<string> {
  const candidates = new Set<string>();
  for (const accountId of accountIds) {
    candidates.add(accountId);
    candidates.add(fallbackCodexAccountLogLabel(accountId));
  }
  return candidates;
}

function defaultPublicAccountSelector(
  account: Pick<CodexAccount, "id" | "logLabel">,
  allPrivateCandidates: ReadonlySet<string>,
): string {
  const privateCandidates = new Set(allPrivateCandidates);
  privateCandidates.add(account.id);
  privateCandidates.add(fallbackCodexAccountLogLabel(account.id));
  if (CODEX_ACCOUNT_LOG_LABEL_RE.test(account.logLabel ?? "")
    && !privateCandidates.has(account.logLabel!)) return account.logLabel!;

  // Legacy or hand-edited rows may predate persisted random log labels. Allocate a fresh public
  // selector rather than exposing the stable, id-derived fallback used only to redact old logs.
  for (let attempt = 0; attempt < PUBLIC_ACCOUNT_SELECTOR_MAX_ATTEMPTS; attempt += 1) {
    const selector = createCodexAccountLogLabel(privateCandidates);
    if (!privateCandidates.has(selector)) return selector;
  }
  throw new Error("Unable to allocate a unique Codex account selector");
}

function claimNamespace(requested: string, used: Set<string>): string {
  let namespace = requested;
  let suffix = 2;
  while (used.has(namespace)) namespace = `${requested}-${suffix++}`;
  used.add(namespace);
  return namespace;
}

/** Collect every public namespace that a generated account selector must not claim. */
function occupiedNamespaces(
  config: Pick<OcxConfig, "combos" | "providers" | "routingProfiles">,
): Set<string> {
  return new Set([
    ...Object.keys(config.providers).map(codexProviderNamespaceKey),
    ...comboAliasNamespaces(config),
    ...routingProfileAliasNamespacePrefixes(config),
    ...RESERVED_NAMESPACE_KEYS,
  ]);
}

/** Build an initial account-selector map without deriving public selectors from aliases or ids. */
export function defaultCodexAccountNamespaces(
  config: Pick<OcxConfig, "codexAccounts" | "combos" | "providers" | "routingProfiles">,
): Record<string, string> {
  const namespaces: Record<string, string> = {};
  const used = occupiedNamespaces(config);
  const accounts = config.codexAccounts ?? [];
  const privateCandidates = privateAccountSelectorCandidates(
    accounts
      .filter(account => account.id !== MAIN_CODEX_ACCOUNT_ID)
      .map(account => account.id),
  );
  for (const candidate of privateCandidates) used.add(candidate);

  namespaces[claimNamespace("main", used)] = MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET;
  for (const account of accounts) {
    if (account.isMain || !isValidCodexAccountId(account.id)) continue;
    const namespace = claimNamespace(defaultPublicAccountSelector(account, privateCandidates), used);
    namespaces[namespace] = account.id;
  }
  return namespaces;
}

/**
 * Initialize generated selectors only for an explicit opt-in with no existing bindings.
 * A true result means the map was replaced and the caller must persist the updated config.
 */
export function initializeDefaultCodexAccountNamespaces(
  config: Pick<
    OcxConfig,
    | "codexAccountPickerEnabled"
    | "codexAccountNamespaces"
    | "codexAccounts"
    | "combos"
    | "providers"
    | "routingProfiles"
  >,
): boolean {
  if (config.codexAccountPickerEnabled !== true
    || Object.keys(config.codexAccountNamespaces ?? {}).length > 0) return false;

  const namespaces = defaultCodexAccountNamespaces(config);
  config.codexAccountNamespaces = namespaces;
  return true;
}

/**
 * Add one account to a generated map without renaming or replacing explicit existing entries.
 * The account-creation layer must reject a new id that already equals an existing selector key.
 * A true result means the map was mutated in place; callers must persist the updated config.
 */
export function appendDefaultCodexAccountNamespace(
  config: Pick<
    OcxConfig,
    "codexAccountNamespaces" | "codexAccounts" | "combos" | "providers" | "routingProfiles"
  >,
  account: Pick<CodexAccount, "id" | "isMain" | "logLabel">,
): boolean {
  const namespaces = config.codexAccountNamespaces;
  if (account.isMain
    || !isValidCodexAccountId(account.id)
    || !namespaces
    || Object.keys(namespaces).length === 0
    || codexAccountIdNamespaceCollisionError(namespaces, account.id)
    || Object.values(namespaces).includes(account.id)) return false;

  const used = occupiedNamespaces(config);
  for (const namespace of Object.keys(namespaces)) used.add(namespace);
  const privateCandidates = privateAccountSelectorCandidates([
    ...(config.codexAccounts ?? [])
      .filter(existing => existing.id !== MAIN_CODEX_ACCOUNT_ID)
      .map(existing => existing.id),
    ...Object.values(namespaces),
    account.id,
  ]);
  for (const candidate of privateCandidates) used.add(candidate);
  const namespace = claimNamespace(defaultPublicAccountSelector(account, privateCandidates), used);
  namespaces[namespace] = account.id;
  return true;
}

export function isMainCodexAccountTarget(accountId: string): boolean {
  return accountId === MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET || accountId === MAIN_CODEX_ACCOUNT_ID;
}

function normalizeCodexAccountNamespaceTarget(accountId: string): string {
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

/**
 * Whether generated account-qualified rows are enabled for catalog discovery.
 * A non-empty hand-written map predating the explicit override remains enabled.
 */
export function codexAccountPickerEnabled(
  config: Pick<OcxConfig, "codexAccountNamespaces" | "codexAccountPickerEnabled">,
): boolean {
  return (config.codexAccountPickerEnabled === undefined || config.codexAccountPickerEnabled === true)
    && Object.keys(config.codexAccountNamespaces ?? {}).length > 0;
}
