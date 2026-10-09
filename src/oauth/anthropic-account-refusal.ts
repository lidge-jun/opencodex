import { anthropicModelFamily } from "./anthropic-model-quota";
/** Narrow pre-output account recovery, fenced to the bearer that physically sent the turn. */
import { readBoundedResponseBody } from "../lib/bounded-body";
import { classifyAnthropic429, anthropicRetryAfterMs, anthropicRatePolicyFor, ANTHROPIC_SHORT_RETRY_MS, ANTHROPIC_MAX_INLINE_THROTTLE_MS } from "./anthropic-rate-limit-policy";
import { isNonReplayableResponse, sleepWithAbort } from "../lib/upstream-retry";
import { credentialGeneration, getAccountCredentialWithStatus, markAccountNeedsReauthIfGeneration } from "./store";
import type { OAuthAccessSnapshot } from "./index";
import type { OcxConfig } from "../types";
import type { AnthropicRouteDecision } from "./anthropic-model-routes";
import { anthropicRoutingFor } from "./anthropic-routing";
import { configuredAnthropicInstance } from "../providers/anthropic-instance";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import { captureAnthropicPhysicalSendOwnership, anthropicPhysicalSendOwnershipIsCurrent,
  type AnthropicPhysicalSendOwnership } from "./anthropic-send-ownership";

const responseCredentials = new WeakMap<Response, AnthropicPhysicalSendOwnership & { providerAccountUuid?: string; checkProviderUuid: boolean }>();
type RetryState = { firstAccountId: string; sameAccount: boolean; detour: boolean };
const retryStatesByInstance = new Map<AnthropicInstanceId, WeakMap<object, RetryState>>();
const verdicts = new WeakMap<Response, Promise<boolean>>();

/** Legacy compatibility only; physical callers must capture ownership before fetch and use ForSend. */
export function bindAnthropicRefusalCredential(response: Response, snapshot: OAuthAccessSnapshot, providerAccountUuid?: string): void {
  const owner = captureAnthropicPhysicalSendOwnership(snapshot);
  if (!owner) { responseCredentials.delete(response); return; }
  if (arguments.length >= 3) bindAnthropicRefusalCredentialForSend(response, owner, providerAccountUuid);
  else bindAnthropicRefusalCredentialForSend(response, owner);
}

/** Retain the pre-send owner even when stale; binding a returned response cannot renew its authority. */
export function bindAnthropicRefusalCredentialForSend(response: Response, owner: AnthropicPhysicalSendOwnership, providerAccountUuid?: string): void {
  responseCredentials.set(response, Object.freeze({ ...owner, providerAccountUuid, checkProviderUuid: arguments.length >= 3 }));
}

async function isRevokedOAuthToken(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal, fatalUtf8: true });
    if (!body.displaySafe || body.truncated) return false;
    const payload: unknown = JSON.parse(body.text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || !("type" in payload) || payload.type !== "error" || !("error" in payload)) return false;
    const error = payload.error;
    return !!error && typeof error === "object" && !Array.isArray(error)
      && "type" in error && error.type === "authentication_error"
      && "message" in error && error.message === "OAuth access token has been revoked."
      && (!("code" in error) || error.code == null);
  } catch { return false; }
}

async function isAccountRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    if (!body.displaySafe || body.truncated) return false;
    const payload: unknown = JSON.parse(body.text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("error" in payload)) return false;
    const error = payload.error;
    if (!error || typeof error !== "object" || Array.isArray(error) || !("type" in error) || !("message" in error)
      || typeof error.message !== "string") return false;
    // Whole-message patterns: request-policy/model/resource refusals and quoted diagnostics
    // must not acquire account authority merely by containing entitlement keywords.
    if ("code" in error && error.code != null
      && (typeof error.code !== "string" || !["subscription_required", "insufficient_quota", "permission_denied"].includes(error.code))) return false;
    const message = error.message.trim();
    if (error.type === "permission_error" && /^(?:Your account does not have access to Claude Code|Your (?:Claude )?subscription (?:has expired|is (?:expired|inactive))|Your account does not have an active subscription)[.!]?$/i.test(message)) return true;
    return (error.type === "billing_error" || error.type === "permission_error")
      && /^Your credit balance is too low to access the Anthropic API\.(?: Please go to Plans & Billing to upgrade or purchase credits\.)?$/i.test(message);
  } catch {
    // Malformed, over-limit, interrupted and unreadable error bodies are never authority.
    return false;
  }
}

export async function rotateAnthropicAccountOnResponseForInstance(
  instance: AnthropicInstanceId,
  response: Response,
  options: {
    config: OcxConfig;
    accountId: string;
    model?: string;
    sessionKey?: string | null;
    decision?: AnthropicRouteDecision | null;
    signal?: AbortSignal;
    canRetry: boolean;
    /** Shared by main, continuation and sidecar consumers of one logical request. */
    requestKey?: object;
    allow429Recovery?: boolean;
    allowAccountRefusal?: boolean;
    /** Applies to alternate ranking only; the shared same-account throttle remains allowed. */
    excludedAccountIds?: ReadonlySet<string>;
    /** Native dispatch re-reads operator policy after asynchronous classification/waits. */
    currentDecision?: () => AnthropicRouteDecision | null;
  },
): Promise<string | null> {
  if (options.signal?.aborted || isNonReplayableResponse(response)
    || configuredAnthropicInstance(options.config, instance) !== instance) return null;
  const sent = responseCredentials.get(response);
  if (!sent || sent.provider !== instance || sent.accountId !== options.accountId) return null;
  const routing = anthropicRoutingFor(instance);
  const { pauseAnthropicRateAdmission, anthropicRatePauseUntil } = anthropicRatePolicyFor(instance);
  const { recordAnthropicAccountRefusal, rotateAnthropicAccountOnRefusal,
    hasAnthropicFailoverQuorum, isAnthropicAccountPoolEnabled, pickAlternateAnthropicAccount } = routing;
  const ownedCurrent = () => {
    if (configuredAnthropicInstance(options.config, instance) !== instance
      || !anthropicPhysicalSendOwnershipIsCurrent(sent)) return undefined;
    const row = getAccountCredentialWithStatus(instance, sent.accountId);
    return row && !row.needsReauth && row.credential.access === sent.accessToken
      && credentialGeneration(row.credential) === sent.generation
      && (!sent.checkProviderUuid || row.credential.accountId === sent.providerAccountUuid) ? row : undefined;
  };
  if (response.status === 401) {
    if (options.allowAccountRefusal === false) return null;
    let verdict = verdicts.get(response);
    if (!verdict) { verdict = isRevokedOAuthToken(response, options.signal); verdicts.set(response, verdict); }
    if (!await verdict || options.signal?.aborted || !ownedCurrent()) return null;
    options.currentDecision?.();
    let marked: boolean;
    try {
      marked = await markAccountNeedsReauthIfGeneration(instance, sent.accountId, sent.generation, undefined, undefined, store => {
        const row = store[instance]?.accounts.find(account => account.id === sent.accountId);
        return !options.signal?.aborted && configuredAnthropicInstance(options.config, instance) === instance
          && anthropicPhysicalSendOwnershipIsCurrent(sent, store)
          && (!sent.checkProviderUuid || row?.credential.accountId === sent.providerAccountUuid);
      });
    } catch { return null; }
    if (!marked || configuredAnthropicInstance(options.config, instance) !== instance
      || !anthropicPhysicalSendOwnershipIsCurrent(sent)) return null;
    routing.clearAnthropicSessionAffinityForAccount(sent.accountId);
    if (!options.canRetry || options.signal?.aborted) return null;
    const decision = options.currentDecision ? options.currentDecision() : options.decision ?? null;
    return pickAlternateAnthropicAccount(options.config, sent.accountId, Date.now(), decision, options.model, options.excludedAccountIds);
  }
  if (response.status === 429) {
    const current = ownedCurrent();
    if (!current) return null;
    options.currentDecision?.();
    const kind = classifyAnthropic429(response.headers);
    if (kind === "family-quota") {
      if (anthropicModelFamily(options.model) !== "Fable" || !options.canRetry || options.allow429Recovery === false) return null;
      return pickAlternateAnthropicAccount(options.config, sent.accountId, Date.now(), (options.currentDecision ? options.currentDecision() : options.decision ?? null), options.model, options.excludedAccountIds);
    }
    if (kind !== "shared-quota") {
      if (!isAnthropicAccountPoolEnabled(options.config) && !hasAnthropicFailoverQuorum() && !current.paused) return null;
      const now = Date.now();
      const delay = anthropicRetryAfterMs(response.headers.get("retry-after"), now) ?? ANTHROPIC_SHORT_RETRY_MS;
      if (kind === "transient-rate") pauseAnthropicRateAdmission(sent.accountId, now + delay);
      if (!options.canRetry || options.allow429Recovery === false || !options.requestKey) return null;
      let retryStates = retryStatesByInstance.get(instance);
      if (!retryStates) { retryStates = new WeakMap(); retryStatesByInstance.set(instance, retryStates); }
      let state = retryStates.get(options.requestKey);
      if (!state) { state = { firstAccountId: sent.accountId, sameAccount: false, detour: false }; retryStates.set(options.requestKey, state); }
      // A concurrent committed selection may have moved the same-account proposal.
      if (state.firstAccountId !== sent.accountId) state.detour = true;
      const wait = Math.max(delay, (anthropicRatePauseUntil(sent.accountId) ?? now) - now);
      if (!state.sameAccount && wait <= ANTHROPIC_MAX_INLINE_THROTTLE_MS && !current.paused) {
        state.sameAccount = true;
        // Millisecond rounding can wake just before this deadline; later extensions still bind.
        const retryAt = now + wait;
        try { await sleepWithAbort(wait, options.signal); } catch { return null; }
        const live = ownedCurrent();
        if (!live || live.paused || live.needsReauth || options.signal?.aborted
          || credentialGeneration(live.credential) !== sent.generation
          || sent.checkProviderUuid && live.credential.accountId !== sent.providerAccountUuid
          || anthropicRatePauseUntil(sent.accountId, Math.max(Date.now(), retryAt))) return null;
        options.currentDecision?.();
        return sent.accountId;
      }
      if (kind === "transient-rate" && !state.detour) {
        state.detour = true;
        return pickAlternateAnthropicAccount(options.config, sent.accountId, Date.now(), (options.currentDecision ? options.currentDecision() : options.decision ?? null), options.model, options.excludedAccountIds);
      }
      return null;
    }
    if (options.allow429Recovery === false) {
      options.currentDecision?.();
      recordAnthropicAccountRefusal(options.config, options.accountId, 429, response.headers.get("retry-after"), Date.now(), response.headers);
      return null;
    }
  } else {
    if (response.status !== 403 || options.allowAccountRefusal === false) return null;
    let verdict = verdicts.get(response);
    if (!verdict) {
      verdict = isAccountRefusal(response, options.signal);
      verdicts.set(response, verdict);
    }
    if (!await verdict || options.signal?.aborted) return null;
    // A late refusal must not cool a new credential stored while its body was being read.
    const current = ownedCurrent();
    if (!current || current.paused || current.needsReauth || credentialGeneration(current.credential) !== sent.generation
      || sent.checkProviderUuid && current.credential.accountId !== sent.providerAccountUuid) return null;
  }
  const decision = options.currentDecision ? options.currentDecision() : options.decision;
  const status = response.status === 429 ? 429 : 403;
  if (!options.canRetry) {
    recordAnthropicAccountRefusal(options.config, options.accountId, status,
      response.headers.get("retry-after"), Date.now(), response.headers);
    return null;
  }
  return rotateAnthropicAccountOnRefusal(options.config, options.accountId, status,
    response.headers.get("retry-after"), options.sessionKey, Date.now(), response.headers, decision, options.model, options.excludedAccountIds);
}

/** Compatibility entrypoint: legacy consumers always recover inside the primary pool. */
export function rotateAnthropicAccountOnResponse(
  response: Response,
  options: Parameters<typeof rotateAnthropicAccountOnResponseForInstance>[2],
): Promise<string | null> {
  return rotateAnthropicAccountOnResponseForInstance("anthropic", response, options);
}
