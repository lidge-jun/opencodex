import type { OcxConfig, OcxProviderConfig } from "../types";
import { inspectChatGptDomainClaim } from "../oauth/chatgpt";
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
 * rewrite. This restore is intentionally STRICTER than plain unchanged-route Direct
 * forwarding: only a bearer with a VALID ChatGPT-domain claim qualifies (a clean single
 * non-proxy JWT whose ChatGPT-specific account marker is well-formed and unambiguous, with
 * any explicit account header matching it). An opaque bearer, a foreign JWT carrying only a
 * generic organizations claim, and a ChatGPT-marked but malformed/conflicting token are all
 * rejected: after a shadow/thread rewrite a self-asserted header cannot distinguish a
 * caller-owned main credential from a foreign source-route token, so those cases stay
 * fail-closed. Claims are decoded locally as routing markers, not authenticity proof, and
 * unchanged-route Direct forwarding is governed by its own legacy rules.
 */
export function captureCallerDirectAuth(incomingHeaders: Headers, config: OcxConfig): CallerDirectAuth | null {
  const raw = incomingHeaders.get("authorization")?.trim();
  const bearer = /^Bearer[\t ]+([^\s,]+)$/i.exec(raw ?? "")?.[1];
  if (!bearer || isProxyAdmissionSecret(bearer, config)) return null;
  const claim = inspectChatGptDomainClaim(bearer);
  if (claim.kind !== "valid") return null;
  const headerAccount = incomingHeaders.get("chatgpt-account-id")?.trim();
  if (headerAccount && headerAccount !== claim.accountId) return null;
  return { authorization: `Bearer ${bearer}`, chatgptAccountId: claim.accountId };
}
