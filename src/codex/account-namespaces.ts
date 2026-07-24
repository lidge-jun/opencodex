import type { OcxConfig } from "../types";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";

/** Public config shorthand for the Codex Desktop/main auth.json account. */
export const MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET = "main";
export const CODEX_ACCOUNT_BOUND_CATALOG_DESCRIPTION = "OpenAI native model bound to a Codex account namespace.";

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
