/** Privacy-safe completion state shared by account mutation UI flows. */
export interface CodexAccountMutationCompletion {
  catalogRefreshPending: boolean;
  validationPending?: boolean;
}

/** Project only the public completion flag from an account mutation response. */
export function codexAccountMutationCompletion(value: unknown): CodexAccountMutationCompletion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { catalogRefreshPending: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "catalogRefreshPending");
  const validation = Object.getOwnPropertyDescriptor(value, "validationPending");
  return {
    ...(validation && "value" in validation && validation.value === true ? { validationPending: true } : {}),
    catalogRefreshPending: descriptor !== undefined
      && "value" in descriptor
      && descriptor.value === true,
  };
}
