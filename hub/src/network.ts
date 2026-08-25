import { isIP } from "node:net";
import type { HubConfig } from "./config";

export const HUB_CLIENT_IP_HEADER = "x-hubapi-client-ip";

function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

/**
 * Resolve the privacy-preserving rate-limit subject at the socket boundary.
 * A forwarded value is trusted only when production explicitly binds the hub
 * to loopback, the direct peer is loopback, and the header is one bare IP.
 */
export function resolveNetworkSubject(config: HubConfig, request: Request, directAddress: string): string | null {
  if (!config.trustLoopbackProxy) return directAddress.trim() || "unknown";
  if (!isLoopbackAddress(directAddress)) return null;
  const forwarded = request.headers.get(HUB_CLIENT_IP_HEADER)?.trim() ?? "";
  if (!forwarded || forwarded.includes(",") || isIP(forwarded) === 0) return null;
  return forwarded.toLowerCase();
}
