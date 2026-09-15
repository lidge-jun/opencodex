import type {
  OcxProviderContinuationOwner,
  OcxProviderContinuationState,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxReasoningReplayIdentity,
  AdapterEvent,
} from "../../types";
import {
  isValidProviderContinuationOwner,
  sameProviderContinuationOwner,
  providerContinuationOwnerFromReplayIdentity,
  providerContinuationRouteScope,
} from "../../responses/provider-continuation";
import {
  reasoningReplayDestinationIdentity,
  reasoningReplayOAuthCredentialIdentity,
  durableReplayCredentialIdentity,
  reasoningReplayCodexCredentialIdentity,
  reasoningReplayKeyCredentialIdentity,
  durableReplayDestinationIdentity,
  bindReasoningReplayScope,
  reasoningReplayServingIdentityChanged,
  reasoningReplayOpaqueBlobRejectionMemoized,
} from "../../responses/reasoning-replay-cache";
import type { OAuthAccessSnapshot } from "../../oauth";
import type { CodexAuthContext } from "../../codex/auth-context";
import { thoughtSignatureReplaySalt } from "../../responses/thought-signature-replay";
import { randomUUID } from "node:crypto";

/**
 * Adapters whose continuation state must survive Codex's store:false requests.
 */
export function adapterNeedsForcedContinuation(name: string): boolean {
  return name === "kiro" || name === "cursor";
}


export type ContinuationOwnerRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; owner: OcxProviderContinuationOwner };


export function readProviderContinuationOwner(
  state: OcxProviderContinuationState | undefined,
): ContinuationOwnerRead {
  if (!state || state.__ocxOwner === undefined) return { kind: "missing" };
  const owner = state.__ocxOwner;
  if (!isValidProviderContinuationOwner(owner)) return { kind: "invalid" };
  return { kind: "valid", owner: { ...owner } };
}


export function providerContinuationPayload(
  state: OcxProviderContinuationState | undefined,
): OcxProviderContinuationState | undefined {
  if (!state) return undefined;
  const cloned = structuredClone(state);
  delete cloned.__ocxOwner;
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}


export function bindProviderContinuationForRoute(
  parsed: OcxParsedRequest,
  currentOwner: OcxProviderContinuationOwner | undefined,
): void {
  const candidate = parsed._providerContinuationCandidate;
  const storedOwner = readProviderContinuationOwner(candidate);
  const mayRestore = storedOwner.kind === "valid"
    && !!currentOwner
    && sameProviderContinuationOwner(storedOwner.owner, currentOwner);
  const restored = mayRestore ? providerContinuationPayload(candidate) : undefined;
  if (restored) parsed._providerContinuation = restored;
  else delete parsed._providerContinuation;
  const cursorConversationId = restored?.cursor?.conversationId;
  if (cursorConversationId) parsed._cursorConversationId = cursorConversationId;
  else delete parsed._cursorConversationId;
  if (currentOwner) parsed._providerContinuationOwner = { ...currentOwner };
  else delete parsed._providerContinuationOwner;
}


export function providerContinuationDestinationIdentity(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
): string | undefined {
  const kiroContext = parsed._kiroAuthContext;
  return reasoningReplayDestinationIdentity(JSON.stringify([
    provider.baseUrl.trim().replace(/\/+$/, ""),
    provider.responsesPath ?? "",
    kiroContext?.profileArn ?? "",
    kiroContext?.apiRegion ?? "",
    kiroContext?.ssoRegion ?? "",
  ]));
}


export function bindRouteReasoningReplayScope(args: {
  parsed: OcxParsedRequest;
  providerName: string;
  provider: OcxProviderConfig;
  adapterName: string;
  oauthCredentialSnapshot?: Pick<OAuthAccessSnapshot, "accountId" | "generation">;
  codexAuthContext?: CodexAuthContext;
  forwardHeaders?: Headers;
}): void {
  const { parsed, providerName, provider, adapterName } = args;
  let credentialIdentity: string | undefined;
  let credentialDurableIdentity: string | undefined;
  const durableSalt = thoughtSignatureReplaySalt();
  if (provider.authMode === "oauth") {
    credentialIdentity = reasoningReplayOAuthCredentialIdentity(
      args.oauthCredentialSnapshot,
      provider.headers,
    );
    // The persisted account-slot id survives token refresh and restarts; the rotating
    // generation deliberately does NOT participate (#1926 design: rotation-safe).
    credentialDurableIdentity = durableReplayCredentialIdentity(
      "oauth",
      args.oauthCredentialSnapshot?.accountId,
      provider.headers,
      durableSalt,
    );
  } else if (provider.authMode === "forward") {
    const poolContext = args.codexAuthContext?.kind === "pool"
      || args.codexAuthContext?.kind === "main-pool"
      ? args.codexAuthContext
      : undefined;
    credentialIdentity = reasoningReplayCodexCredentialIdentity({
      authorization: poolContext
        ? `Bearer ${poolContext.accessToken}`
        : args.forwardHeaders?.get("authorization"),
      chatgptAccountId: poolContext?.chatgptAccountId
        ?? args.forwardHeaders?.get("chatgpt-account-id"),
      accountId: poolContext?.accountId,
      credentialGeneration: poolContext?.kind === "pool"
        ? poolContext.generation
        : undefined,
      writerGeneration: poolContext?.writerGeneration,
      headers: provider.headers,
    });
    // Durable identity requires a STABLE, TRUSTED account handle. Pool context comes from
    // our own account store; a client-supplied chatgpt-account-id header is attacker
    // -influenceable bucket selection and a bearer alone is rotating material — both are
    // refused, so direct-forward turns get no durable scope (fail closed; the in-process
    // cache still covers same-process replay).
    const codexDurableHandle = poolContext?.accountId
      ?? poolContext?.chatgptAccountId
      ?? undefined;
    credentialDurableIdentity = durableReplayCredentialIdentity(
      "codex",
      codexDurableHandle ?? undefined,
      provider.headers,
      durableSalt,
    );
  } else if (provider.authMode !== "local") {
    credentialIdentity = reasoningReplayKeyCredentialIdentity(provider);
    credentialDurableIdentity = durableReplayCredentialIdentity(
      "key",
      nonEmptyProviderApiKey(provider),
      provider.headers,
      durableSalt,
    );
  }
  const providerDestinationIdentity = reasoningReplayDestinationIdentity(provider.baseUrl);
  const replayIdentity: OcxReasoningReplayIdentity | undefined = credentialIdentity && providerDestinationIdentity
    ? {
        providerName,
        providerDestinationIdentity,
        providerDestinationDurableIdentity: durableReplayDestinationIdentity(provider.baseUrl),
        adapterName,
        modelId: parsed.modelId,
        credentialIdentity,
        ...(credentialDurableIdentity ? { credentialDurableIdentity } : {}),
      }
    : undefined;
  const continuationDestinationIdentity = providerContinuationDestinationIdentity(parsed, provider);
  const continuationOwner = providerContinuationOwnerFromReplayIdentity(
    replayIdentity && continuationDestinationIdentity
      ? { ...replayIdentity, providerDestinationIdentity: continuationDestinationIdentity }
      : undefined,
  );
  if (adapterName === "cursor") {
    // The final route owner is authoritative for Cursor and supersedes the account-derived
    // seed assigned before route binding. A Cursor conversation must be scoped to the exact
    // provider/destination/adapter/model/credential that serves it.
    if (continuationOwner) parsed._cursorIdentityScope = providerContinuationRouteScope(continuationOwner);
    else if (!parsed._cursorIdentityScope?.startsWith("cursor-unowned:")) {
      // Prevent the adapter's token-only fallback from recreating a provider-private id after the
      // route owner failed closed. The sentinel is per parsed request and contains no credential.
      parsed._cursorIdentityScope = `cursor-unowned:${randomUUID()}`;
    }
  }
  bindReasoningReplayScope(
    parsed._reasoningReplayScope,
    replayIdentity,
  );
  // Keep this sticky for the whole outbound request: a later auth/key rebind may compare equal
  // after the first mismatch, but it cannot make history minted by the prior route decodable.
  if (reasoningReplayServingIdentityChanged(parsed._reasoningReplayScope)) {
    parsed._stripReasoningEncryptedContent = true;
  }
  if (reasoningReplayOpaqueBlobRejectionMemoized(parsed._reasoningReplayScope)) {
    parsed._stripReasoningEncryptedContent = true;
  }
  bindProviderContinuationForRoute(parsed, continuationOwner);
}


export function adapterResponseReachedServingTerminal(
  events: readonly AdapterEvent[],
  response: Readonly<Record<string, unknown>>,
): boolean {
  return (response.status === "completed" || response.status === "incomplete")
    && events.some(event => event.type === "done" || event.type === "incomplete");
}


export function nonEmptyProviderApiKey(provider: OcxProviderConfig): string | undefined {
  return typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0
    ? provider.apiKey
    : undefined;
}
