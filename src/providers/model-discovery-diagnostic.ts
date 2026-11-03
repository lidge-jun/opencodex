/** Safe operator guidance for malformed upstream model lists. */
export function invalidModelDiscoveryHint(diagnostic?: string): string {
  return `${diagnostic ? ` (${diagnostic})` : ""}. A newly added API-key provider can keep its model selection pending while discovery fails; a static models list with liveModels: false avoids discovery for gateways publishing invalid rows.`;
}
