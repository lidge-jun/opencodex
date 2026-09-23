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
  reasoningReplayItemStoreChanged,
  reasoningReplayOpaqueBlobRejectionMemoized,
} from "../../responses/reasoning-replay-cache";
import type { OAuthAccessSnapshot } from "../../oauth";
import type { CodexAuthContext } from "../../codex/auth-context";
import { thoughtSignatureReplaySalt } from "../../responses/thought-signature-replay";
import { randomUUID } from "node:crypto";
import { requiresPlaintextReasoningReplay } from "../../adapters/openai-responses/passthrough";

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
  const replayIdentity = routeReasoningReplayIdentity({
    ...args,
    modelId: parsed.modelId,
  });
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
    // Only a different destination or credential makes the replayed item ids unresolvable; a
    // model change on the same store keeps them.
    if (reasoningReplayItemStoreChanged(parsed._reasoningReplayScope)) {
      parsed._dropForeignReasoningItemIds = true;
    }
  }
  if (reasoningReplayOpaqueBlobRejectionMemoized(parsed._reasoningReplayScope)) {
    parsed._stripReasoningEncryptedContent = true;
    parsed._dropForeignReasoningItemIds = true;
  }
  bindProviderContinuationForRoute(parsed, continuationOwner);
}


function routeReasoningReplayIdentity(args: {
  providerName: string;
  provider: OcxProviderConfig;
  adapterName: string;
  modelId: string;
  oauthCredentialSnapshot?: Pick<OAuthAccessSnapshot, "accountId" | "generation">;
  codexAuthContext?: CodexAuthContext;
  forwardHeaders?: Headers;
}): OcxReasoningReplayIdentity | undefined {
  const { providerName, provider, adapterName, modelId } = args;
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
  return credentialIdentity && providerDestinationIdentity
    ? {
        providerName,
        providerDestinationIdentity,
        providerDestinationDurableIdentity: durableReplayDestinationIdentity(provider.baseUrl),
        adapterName,
        modelId,
        credentialIdentity,
        ...(credentialDurableIdentity ? { credentialDurableIdentity } : {}),
      }
    : undefined;
}


/**
 * Whether this exact route cannot satisfy its documented plaintext reasoning replay contract.
 *
 * A generic plaintext-preserving gateway is not made ineligible. Unknown serving provenance also
 * stays eligible; only a proven route mismatch may suppress a combo candidate.
 */
export function mandatoryResponsesReasoningReplayUnavailable(args: {
  body: unknown;
  clientThreadId: string | undefined;
  providerName: string;
  provider: OcxProviderConfig;
  adapterName: string;
  modelId: string;
}): boolean {
  const { body, clientThreadId, provider, adapterName } = args;
  if (
    adapterName !== "openai-responses"
    || !requiresPlaintextReasoningReplay(provider)
    || !clientThreadId
    || !requestCarriesTools(body)
    || !hasOpaqueOnlyReasoningItem(body)
  ) return false;

  const current = routeReasoningReplayIdentity(args);
  return reasoningReplayServingIdentityChanged({ clientThreadId, current });
}


function requestCarriesTools(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return Array.isArray((body as { tools?: unknown }).tools)
    && (body as { tools: unknown[] }).tools.length > 0;
}


function hasOpaqueOnlyReasoningItem(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) return false;
  return input.some(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const reasoning = item as Record<string, unknown>;
    if (reasoning.type !== "reasoning" || typeof reasoning.encrypted_content !== "string") return false;
    const content = reasoning.content;
    const hasPlaintext = Array.isArray(content) && content.some(part =>
      !!part && typeof part === "object" && !Array.isArray(part)
      && (part as Record<string, unknown>).type === "reasoning_text"
      && typeof (part as Record<string, unknown>).text === "string"
      && ((part as Record<string, unknown>).text as string).length > 0
    );
    return !hasPlaintext;
  });
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
