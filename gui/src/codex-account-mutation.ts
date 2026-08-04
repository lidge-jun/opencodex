export interface CodexAccountMutationCompletion {
  catalogRefreshPending: boolean;
}

/** Project the public completion flag without forwarding account or error details. */
export function codexAccountMutationCompletion(value: unknown): CodexAccountMutationCompletion {
  const payload = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return { catalogRefreshPending: payload.catalogRefreshPending === true };
}
