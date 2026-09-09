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
 * Capture the caller's Direct credential under the forwardable-bearer predicate
 * (hasForwardableCodexBearer): a clean single bearer that is not one of our proxy admission
 * secrets AND carries an account, from the explicit header or the JWT claim. An opaque
 * account-less bearer is NOT captured: after a shadow/thread rewrite it would replay a
 * foreign (for example Cursor) token onto the canonical ChatGPT backend, so that case stays
 * fail-closed. Stricter snapshot rules (matching explicit account) belong to the sidecar
 * capture, not to Direct restore.
 */
export function captureCallerDirectAuth(incomingHeaders: Headers, config: OcxConfig): CallerDirectAuth | null {
  const raw = incomingHeaders.get("authorization")?.trim();
  const bearer = /^Bearer[\t ]+([^\s,]+)$/i.exec(raw ?? "")?.[1];
  if (!bearer || isProxyAdmissionSecret(bearer, config)) return null;
  const accountId = incomingHeaders.get("chatgpt-account-id")?.trim()
    || extractAccountId(undefined, bearer);
  if (!accountId) return null;
  return { authorization: `Bearer ${bearer}`, chatgptAccountId: accountId };
}
