/** Safe operator guidance for malformed upstream model lists. */
export function invalidModelDiscoveryHint(diagnostic?: string): string {
  return `${diagnostic ? ` (${diagnostic})` : ""}. New provider model selection stays pending while discovery fails; use a static models list with liveModels: false for gateways publishing invalid rows.`;
}
