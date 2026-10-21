import { hasOwnProvider, isValidProviderName } from "../../config";
import { getKeyCooldownUntil } from "../../providers/key-failover";
import { providerRequestPacingStatus } from "../../providers/request-pacing";
import type { OcxProviderConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

/** Read-only provider/key pacing diagnostics; configuration writes stay in the provider PATCH owner. */
export function handleProviderKeyPacingRoutes(
  { req, url, config }: Pick<ManagementContext, "req" | "url" | "config">,
): Response | null {
  if (url.pathname !== "/api/provider-request-pacing" || req.method !== "GET") return null;
  const statusFor = (name: string, provider: OcxProviderConfig) => {
    const status = providerRequestPacingStatus(name, provider);
    if (status.keys) status.keys = status.keys.map(row => ({ ...row, cooldownUntil: getKeyCooldownUntil(name, row.id) }));
    return status;
  };
  const name = url.searchParams.get("name")?.trim();
  if (name) {
    if (!isValidProviderName(name) || !hasOwnProvider(config.providers, name)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    return jsonResponse(statusFor(name, config.providers[name]!));
  }
  return jsonResponse(Object.fromEntries(
    Object.entries(config.providers).map(([providerName, provider]) => [
      providerName,
      statusFor(providerName, provider),
    ]),
  ));
}
