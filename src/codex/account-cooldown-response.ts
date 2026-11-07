// Local quota advice is not an upstream target-wide retry directive. Response identity keeps
// this distinction private to the process: headers, body copies and HTTP hops cannot mint it.
const accountCooldownResponses = new WeakSet<Response>();

/** Minted only by mapCodexAuthContextErrorToResponse for an ordinary CodexAccountCooldownError. */
export function markCodexAccountCooldownResponse(response: Response): Response {
  accountCooldownResponses.add(response);
  return response;
}

export function isCodexAccountCooldownResponse(response: Response): boolean {
  return accountCooldownResponses.has(response);
}

/** Preserve provenance across the combo's bounded error-body reconstruction. */
export function carryCodexAccountCooldownResponse(from: Response, to: Response): void {
  if (accountCooldownResponses.has(from)) accountCooldownResponses.add(to);
}
