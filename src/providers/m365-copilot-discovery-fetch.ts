import { M365_COPILOT_BASE_URL } from "./m365-copilot-models";
import { M365_COPILOT_WEB_URL, normalizeM365WebSession, readM365ModelBootstrap } from "./m365-copilot-discovery";
import { m365CopilotClaims } from "../oauth/m365-copilot";
import { providerOutboundGet } from "../lib/provider-outbound";
import type { OAuthAccessSnapshot } from "../oauth";
import type { OcxProviderConfig } from "../types";

export async function fetchM365ModelRoster(name: string, provider: OcxProviderConfig, auth: Pick<OAuthAccessSnapshot, "accessToken" | "m365"> | undefined, signal: AbortSignal, beforeSend?: () => boolean) {
  const session = normalizeM365WebSession(auth?.m365);
  if (name !== "m365-copilot" || provider.disabled || provider.adapter !== "m365-copilot" || provider.authMode !== "oauth"
    || provider.baseUrl.replace(/\/+$/, "") !== M365_COPILOT_BASE_URL || !auth?.accessToken || !session) throw new Error("Microsoft 365 Copilot model discovery requires web sign-in");
  const claims = m365CopilotClaims(auth.accessToken);
  if (session.accountId.toLowerCase() !== (claims.oid + "@" + claims.tid).toLowerCase()) throw new Error("Microsoft 365 Copilot model discovery account mismatch");
  const response = await providerOutboundGet(name, provider, M365_COPILOT_WEB_URL, { headers: { cookie: session.cookie }, signal }, { beforeSend });
  if (!response.ok || response.status >= 300) { await response.body?.cancel(); throw new Error("Microsoft 365 Copilot web sign-in expired; retry login"); }
  return readM365ModelBootstrap(response, session.accountId, signal);
}
