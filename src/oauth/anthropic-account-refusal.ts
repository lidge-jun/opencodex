import { anthropicModelFamily } from "./anthropic-model-quota";
/** Narrow pre-output account recovery, fenced to the bearer that physically sent the turn. */
import { readBoundedResponseBody } from "../lib/bounded-body";
import { classifyAnthropic429, anthropicRetryAfterMs, pauseAnthropicRateAdmission, anthropicRatePauseUntil, ANTHROPIC_SHORT_RETRY_MS, ANTHROPIC_MAX_INLINE_THROTTLE_MS } from "./anthropic-rate-limit-policy";
import { isNonReplayableResponse, sleepWithAbort } from "../lib/upstream-retry";
import { credentialGeneration, getAccountCredentialWithStatus } from "./store";
import type { OAuthAccessSnapshot } from "./index";
import type { OcxConfig } from "../types";
import type { AnthropicRouteDecision } from "./anthropic-model-routes";
import { recordAnthropicAccountRefusal, rotateAnthropicAccountOnRefusal, hasAnthropicFailoverQuorum, isAnthropicAccountPoolEnabled, pickAlternateAnthropicAccount } from "./anthropic-routing";

const responseCredentials = new WeakMap<Response, Pick<OAuthAccessSnapshot, "accountId" | "generation"> & { providerAccountUuid?: string; checkProviderUuid: boolean }>();
const retryStates = new WeakMap<object, { firstAccountId: string; sameAccount: boolean; detour: boolean }>();
const verdicts = new WeakMap<Response, Promise<boolean>>();

/** Called only when the outgoing headers prove ownership of the selected stored bearer. */
export function bindAnthropicRefusalCredential(response: Response, snapshot: OAuthAccessSnapshot, providerAccountUuid?: string): void {
  responseCredentials.set(response, { accountId: snapshot.accountId, generation: snapshot.generation, providerAccountUuid, checkProviderUuid: arguments.length >= 3 });
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

export async function rotateAnthropicAccountOnResponse(
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
  if (options.signal?.aborted || isNonReplayableResponse(response)) return null;
  if (response.status === 429) {
    const sent = responseCredentials.get(response);
    const current = sent && getAccountCredentialWithStatus("anthropic", sent.accountId);
    if (!sent || sent.accountId !== options.accountId || !current || current.needsReauth
      || credentialGeneration(current.credential) !== sent.generation
      || sent.checkProviderUuid && current.credential.accountId !== sent.providerAccountUuid) return null;
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
        const live = getAccountCredentialWithStatus("anthropic", sent.accountId);
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
    const sent = responseCredentials.get(response);
    if (!sent || sent.accountId !== options.accountId) return null;
    let verdict = verdicts.get(response);
    if (!verdict) {
      verdict = isAccountRefusal(response, options.signal);
      verdicts.set(response, verdict);
    }
    if (!await verdict || options.signal?.aborted) return null;
    // A late refusal must not cool a new credential stored while its body was being read.
    const current = getAccountCredentialWithStatus("anthropic", sent.accountId);
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
