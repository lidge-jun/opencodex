import { createHmac, randomBytes } from "node:crypto";
import type { OcxParsedRequest } from "../../types";

const KEY = randomBytes(32);
const PRINCIPAL = /^[0-9a-f]{64}$/;
const CONVERSATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Bind an in-memory Muse continuation to the ingress-authenticated principal,
 * one conversation, and the resolved physical provider identity. The untrusted
 * thread id is only a namespace inside the authenticated principal, never auth.
 * Keyless loopback, ambiguous shared cohorts, and unbound routes fail closed.
 */
export function museContinuationOwner(parsed: OcxParsedRequest): string | undefined {
  const scope = parsed._reasoningReplayScope;
  const principal = scope?.clientPrincipalId;
  const route = parsed._museNativeRoute ?? scope?.current;
  if (!principal || !PRINCIPAL.test(principal) || !route) return undefined;
  const ownThread = parsed._codexOwnThreadId;
  const conversation = ownThread || (!parsed._promptCacheKeyIsSharedCohort ? scope.clientThreadId : undefined);
  if (!conversation || !CONVERSATION.test(conversation)) return undefined;
  const identity = [route.providerName, route.providerDestinationIdentity, route.adapterName, route.modelId, route.credentialIdentity];
  if (identity.some(value => typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096)) return undefined;
  return createHmac("sha256", KEY).update("opencodex.muse-msp.owner.v1\0")
    .update(JSON.stringify([principal, conversation, ...identity])).digest("hex");
}
