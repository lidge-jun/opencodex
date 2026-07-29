import { isValidCodexAccountId } from "./account-id";

/** Config-only sentinel for the Codex Desktop account; outside the pool-account id grammar. */
export const MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET = "@main";

export const CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR =
  "combo alias must not use a configured Codex account namespace";

const CODEX_ACCOUNT_ID_NAMESPACE_COLLISION_ERROR =
  "account id must not collide with a configured Codex account namespace";

/** Provider ids are compared case-insensitively at namespace admission boundaries. */
export function codexProviderNamespaceKey(value: string): string {
  return value.toLowerCase();
}

export function hasCodexAccountNamespace(
  namespaces: unknown,
  namespace: string,
): boolean {
  return !!namespaces
    && typeof namespaces === "object"
    && !Array.isArray(namespaces)
    && Object.hasOwn(namespaces, namespace);
}

export function codexAccountNamespaceProviderCollisionError(
  namespaces: unknown,
  providerName: string,
): string | undefined {
  const normalizedProvider = codexProviderNamespaceKey(providerName);
  const collides = !!namespaces
    && typeof namespaces === "object"
    && !Array.isArray(namespaces)
    && Object.keys(namespaces)
      .some(namespace => codexProviderNamespaceKey(namespace) === normalizedProvider);
  return collides
    ? "provider name must not collide with a configured Codex account namespace"
    : undefined;
}

export function codexAccountIdNamespaceCollisionError(
  namespaces: unknown,
  accountId: string,
): string | undefined {
  return hasCodexAccountNamespace(namespaces, accountId)
    ? CODEX_ACCOUNT_ID_NAMESPACE_COLLISION_ERROR
    : undefined;
}

export function codexAccountNamespaceForModel(
  namespaces: unknown,
  modelId: string,
): string | undefined {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return undefined;
  const namespace = modelId.slice(0, slash);
  return hasCodexAccountNamespace(namespaces, namespace) ? namespace : undefined;
}

export function isValidCodexAccountNamespaceTarget(accountId: unknown): accountId is string {
  return accountId === MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET || isValidCodexAccountId(accountId);
}
