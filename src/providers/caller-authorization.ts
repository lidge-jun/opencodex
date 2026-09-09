import type { OcxConfig, OcxProviderConfig } from "../types";
import { extractAccountId } from "../oauth/chatgpt";
import { isProxyAdmissionSecret } from "../server/auth-cors";
import { isCanonicalOpenAiForwardProvider } from "./openai-tiers";

/** The caller's own ChatGPT-domain credential as plain Direct forwarding would use it. */
export type CallerDirectAuth = Readonly<{ authorization: string; chatgptAccountId?: string }>;

/** Whether this transport can consume the request's Authorization as its upstream credential. */
export function providerConsumesCallerAuthorization(provider: OcxProviderConfig): boolean {
  return isCanonicalOpenAiForwardProvider(provider)
    || (provider.adapter === "cursor" && provider.authMode !== "oauth" && !provider.apiKey?.trim());
}

/**
 * Capture the caller's Direct credential for a canonical-route restore after an internal
 * rewrite. Only a bearer that PROVABLY belongs to the ChatGPT domain qualifies: a clean
 * single non-proxy JWT carrying a ChatGPT account claim, with any explicit account header
 * matching that claim. An opaque bearer is not captured even with a self-asserted account
 * header: after a shadow/thread rewrite that header cannot distinguish a caller-owned main
 * credential from a foreign source-route token, so that case stays fail-closed.
 */
export function captureCallerDirectAuth(incomingHeaders: Headers, config: OcxConfig): CallerDirectAuth | null {
  const raw = incomingHeaders.get("authorization")?.trim();
  const bearer = /^Bearer[\t ]+([^\s,]+)$/i.exec(raw ?? "")?.[1];
  if (!bearer || isProxyAdmissionSecret(bearer, config)) return null;
  const claim = extractAccountId(undefined, bearer);
  if (!claim) return null;
  const headerAccount = incomingHeaders.get("chatgpt-account-id")?.trim();
  if (headerAccount && headerAccount !== claim) return null;
  return { authorization: `Bearer ${bearer}`, chatgptAccountId: claim };
}
