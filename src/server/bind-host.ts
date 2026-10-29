/** The public listener's bind spelling, shared with ownership discovery. */
export function normalizeBindHostname(hostname: string | undefined): string {
  const configuredHost = hostname?.trim();
  return !configuredHost || /^localhost\.?$/i.test(configuredHost) ? "127.0.0.1" : configuredHost;
}
