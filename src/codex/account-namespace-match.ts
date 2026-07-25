export function hasCodexAccountNamespace(
  namespaces: unknown,
  namespace: string,
): boolean {
  return !!namespaces
    && typeof namespaces === "object"
    && !Array.isArray(namespaces)
    && Object.hasOwn(namespaces, namespace);
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
