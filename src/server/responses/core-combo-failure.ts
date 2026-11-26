import { recordUpstreamProviderErrorDetail, recordUpstreamValidationDetail, type FailureDetail } from "../request-log-failure-detail";
import { carryProxyErrorPresentation, isProxyError, isProxyQuotaExhaustion } from "../../lib/client-error-body";
import { carryPolicyCandidateRefusal } from "./policy-request-scope";
import { comboFailureEvidence, carryProxyError } from "../../lib/client-error-body";
import { carryWorkflowRefusal } from "../workflow-refusal";
import {
  codexAccountModelRefusal,
  codexAccountModelRefusalHardStopCode,
  coolComboTarget,
  isConfirmedComboExhaustion,
  isMalformedResponseFormatRequest,
  isOpenRouterOpaque400Envelope,
  isUnofferedToolCallRefusal,
  isProviderModerationRefusal,
  isProviderIntakeRefusalBody,
  upstreamEnvelopeRootCode,
  type CodexAccountModelRefusal,
} from "../../combos/failover";
import { parseRetryAfterMs } from "../../combos";
import type { ConsumedComboFailure, HandleResponsesOptions } from "./core-options";
import type { OcxConfig, OcxUsage } from "../../types";
import type { RouteResult } from "../../router";
import { codexQuotaScopeForModel, getCodexQuotaHealthSnapshot } from "../../codex/routing";
import { codexPoolHasConfirmedUsageLimit } from "../../codex/routing/selection";
import { isCodexAccountGenerationLive } from "../../codex/account-store";
import type { CodexAuthContext } from "../../codex/auth-context";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { carryAnthropicRefusalCredential } from "../../oauth/anthropic-account-refusal";
import { carryCodexAccountCooldownResponse } from "../../codex/account-cooldown-response";
import { codexQuotaFailureMessage, codexQuotaOutcomeMeta } from "./core-codex-account";
import {
  isRateLimitOrQuotaFailureMessage,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  CYBER_POLICY_ERROR_CODE,
  CYBER_POLICY_FALLBACK_MESSAGE,
  isModelNotInPlanRefusal,
  isUndeclaredToolCallRefusalResponse,
  markVerifiedModelNotInPlanResponse,
  namesModelNotInPlanCode,
} from "../../lib/errors";
import { normalizeUpstreamErrorText } from "./core-errors";
import { resolveClientRetryAfter } from "../../lib/retry-after";
import { formatErrorResponse } from "../../bridge";
import { upstreamCodeForComboFailure } from "../../bridge/errors";
import { OLLAMA_LATE_ATTRIBUTION_LIMIT_MESSAGE } from "../../adapters/ollama-native";
import { carryReplayRefusal, isNonReplayableResponse, isReplayRefusalResponse, markResponseNonReplayable, UPSTREAM_RESET_REPLAY_REFUSED_CODE } from "../../lib/upstream-retry";
import { MODEL_NOT_ALLOWED_FOR_KEY } from "../admission-model-scope";
import { usageFromResponsesPayload } from "../request-log";
import type { ResponsesTerminalStatus } from "../../bridge";
import { isXaiLegacyPrivacyError, isXaiPrivacyModeRefusal, xaiPrivacyModeRefusal, XAI_LEGACY_PRIVACY_MESSAGE } from "../../providers/xai-privacy-mode";
import { stampMetaMusePlanRefusal } from "../../providers/meta-muse-plan-refusal";
import type { RequestFailureCause } from "../../usage/telemetry-contract";
import { isRewrittenUpstreamError } from "../../adapters/upstream-http-error";
import { configuredAnthropicInstance } from "../../providers/anthropic-instance";
import { comboPickQuotaBinding, type ComboPick } from "../../combos/resolve";
import { getAccountSet } from "../../oauth/store";
import { anthropicRefusalCredentialIsCurrent } from "../../oauth/anthropic-account-refusal";
import { isAnthropicBillingFailure } from "../../providers/anthropic-billing-refusal";
import { anthropicRoutingFor, formatAnthropicProviderForLog } from "../../oauth/anthropic-routing";
import { codexAccountLogLabel, oauthAccountLogLabel } from "../../codex/account-label";
import {
  eligibleFailoverAccounts, hasEligibleGenericOAuthFailoverTarget, isGenericFailoverProvider, rotateGenericOAuthAccountOn429,
} from "../../oauth/generic-account-failover";
import { classifyModelFamilyForQuota } from "../../oauth/account-quota-rank";
import { oauthCredentialSlot } from "../../oauth/credential-siblings";
import { antigravityAccountSupportsModel } from "../../providers/antigravity-account-roster";
import { anthropicRatePolicyFor } from "../../oauth/anthropic-rate-limit-policy";
import type { AnthropicInstanceId } from "../../providers/anthropic-instance-id";
import { isKeyQuotaSpent } from "../../providers/api-key-cooldowns";
import { readQuotaResetAt } from "../../providers/key-failover";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/account-id";
import { providerCodexAccountMode } from "../../providers/registry";
import { baseProviderLabel } from "../../providers/label";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";

export function cooledPoolAccountLabel(config: OcxConfig, providerName: string, modelId: string, label: string | undefined): string | undefined {
  if (!label) return undefined;
  const instance = configuredAnthropicInstance(config, providerName);
  if (instance && config.providers[providerName]?.authMode === "oauth") {
    const matches = getAccountSet(instance)?.accounts.filter(account =>
      formatAnthropicProviderForLog(instance, account.id) === label) ?? [];
    return matches.length === 1 && anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(matches[0]!.id) ? label : undefined;
  }
  const provider = config.providers[providerName];
  if (!provider || !isCanonicalOpenAiForwardProvider(provider)) return undefined;
  const quotaScope = codexQuotaScopeForModel(modelId);
  // The main account logs as `<provider>-main` and is not a `codexAccounts` entry (#8880). In pool
  // mode the pool rotates past a cooled main itself, so its 429 is account evidence exactly like a
  // pool account's, and parking the target would black out the siblings and main's own recovery for
  // the upstream Retry-After (up to 24h). Direct mode serves main without that check, so there the
  // target cooldown stays the only guard against re-sending to a spent account.
  if (label === `${providerName}-main`) {
    return providerCodexAccountMode(providerName, provider) === "pool"
      && getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, quotaScope) ? label : undefined;
  }
  const matches = (config.codexAccounts ?? []).filter(account =>
    `${providerName}-${codexAccountLogLabel(account)}` === label);
  return matches.length === 1
    && getCodexQuotaHealthSnapshot(matches[0]!.id, quotaScope)
    ? label : undefined;
}

/**
 * The generic OAuth pool's counterpart of `cooledPoolAccountLabel`. Its 429 names one account
 * through `accountLogLabel`, but the per-request account budget can end the pool's own rotation
 * before the last refused account is recorded. Hand that account to the pool's rotator, which
 * cools it under the pool's own Retry-After policy, and spare the target only when the pool still
 * has an eligible sibling. The rotator only peeks round-robin here: nothing is sent to that sibling.
 * A lone account or an all-cooled pool returns null and cools the target.
 * The refusal's quota verdict is recorded first, for a quota-only Combo's sibling check.
 */
export function cooledGenericOAuthAccountLabel(
  config: OcxConfig, providerName: string, modelId: string, label: string | undefined, retryAfter: string | undefined,
  quotaExhausted: boolean,
): string | undefined {
  const provider = config.providers[providerName];
  if (!label || !provider || !isGenericFailoverProvider(providerName, provider)) return undefined;
  const base = baseProviderLabel(providerName);
  const matches = getAccountSet(providerName)?.accounts.filter(account =>
    oauthAccountLogLabel(account.id, base) === label) ?? [];
  if (matches.length !== 1) return undefined;
  recordGenericAccountRefusal(providerName, matches[0]!.id, modelId, retryAfter, quotaExhausted);
  return rotateGenericOAuthAccountOn429(config, providerName, matches[0]!.id, retryAfter, Date.now(), modelId, false)
    ? label : undefined;
}

/**
 * Generic OAuth accounts whose last 429 proved a spent quota. The pool records only that an account
 * cooled, so a quota-only Combo reads this to tell a spent sibling from a rate-limited one. A verdict
 * lasts as long as the cooldown the pool derives from the same Retry-After. A later ordinary refusal
 * neither clears nor extends it, because a spent quota does not return before its own deadline.
 */
const genericQuotaVerdicts = new Map<string, number>();
const genericVerdictKey = (providerName: string, accountId: string, modelId: string | null | undefined): string =>
  [oauthCredentialSlot(providerName), accountId, classifyModelFamilyForQuota(providerName, modelId) ?? ""].join("\0");

/** Record what a generic OAuth 429 proved before the pool cools that account. */
export function recordGenericAccountRefusal(
  providerName: string, accountId: string, modelId: string | null | undefined,
  retryAfter: string | null | undefined, quotaExhausted: boolean, now = Date.now(),
): void {
  for (const [key, until] of genericQuotaVerdicts) if (until <= now) genericQuotaVerdicts.delete(key);
  if (!quotaExhausted) return;
  const key = genericVerdictKey(providerName, accountId, modelId);
  // The pool's own defaults for an undated 429 (rotateGenericOAuthAccountOnRefusal).
  const cooldownMs = parseRetryAfterMs(retryAfter, now, { preserveImmediate: true, preserveServerDelay: true })
    ?? (providerName === "kiro" ? 10_000 : 60_000);
  genericQuotaVerdicts.set(key, Math.max(genericQuotaVerdicts.get(key) ?? 0, now + cooldownMs));
}

export function clearGenericAccountQuotaVerdictsForTests(): void {
  genericQuotaVerdicts.clear();
}

/** True while a usable Anthropic account is held by a transient rate pause and by no quota or credit refusal. */
function anthropicAccountOnlyRatePaused(instance: AnthropicInstanceId, now: number): boolean {
  const routing = anthropicRoutingFor(instance);
  const { anthropicRatePauseUntil } = anthropicRatePolicyFor(instance);
  return (getAccountSet(instance)?.accounts ?? []).some(account => account.paused !== true && account.needsReauth !== true
    && anthropicRatePauseUntil(account.id, now) !== undefined && routing.getAnthropicAccountHealthSnapshot(account.id, now) === null);
}

/**
 * True while an account other than the refused one is unavailable with no spent-quota verdict, such as
 * one cooling after a rate limit. It may serve again soon, so a quota-only Combo stays on the pool.
 */
function genericSiblingMayRecover(providerName: string, refusedId: string, now: number, modelId: string): boolean {
  const ready = new Set(eligibleFailoverAccounts(providerName, now, classifyModelFamilyForQuota(providerName, modelId)));
  return (getAccountSet(providerName)?.accounts ?? []).some(account => account.id !== refusedId
    && account.paused !== true && account.needsReauth !== true && !ready.has(account.id)
    // An Antigravity sibling whose roster omits the model cannot serve it once it recovers.
    && (providerName !== "google-antigravity" || antigravityAccountSupportsModel(providerName, account.id, modelId) !== false)
    && (genericQuotaVerdicts.get(genericVerdictKey(providerName, account.id, modelId)) ?? 0) <= now);
}

/**
 * A credit-balance refusal (402, or 400 with the same body) names one Anthropic OAuth account --
 * the evidence the pool already accepts on a 403 -- but the pool rotates only on 401/403/429, so it
 * reaches the combo with that account still selectable. Cool it under the pool's entitlement backoff and spare the target
 * only while a sibling is eligible; a lone account or an exhausted pool still cools the target.
 */
export function creditRefusedAnthropicAccountLabel(
  config: OcxConfig, providerName: string, modelId: string, label: string | undefined,
  message: string, code: string | null | undefined, response: Response,
): string | undefined {
  const instance = configuredAnthropicInstance(config, providerName);
  if (!label || !instance || config.providers[providerName]?.authMode !== "oauth"
    || !isAnthropicBillingFailure(response.status, message, code)) return undefined;
  const routing = anthropicRoutingFor(instance);
  const matches = getAccountSet(instance)?.accounts.filter(account =>
    formatAnthropicProviderForLog(instance, account.id) === label) ?? [];
  return matches.length === 1
    && anthropicRefusalCredentialIsCurrent(response, instance, matches[0]!.id)
    && routing.recordAnthropicAccountRefusal(config, matches[0]!.id, 403, null)
    && routing.getEligibleAnthropicAccounts(Date.now(), modelId).length > 0
    ? label : undefined;
}

/**
 * True only for the Anthropic OAuth pool's OWN "all accounts cooled" 429. Its Retry-After is the
 * earliest per-account cooldown restated (`getAnthropicPoolRetryAfterSeconds`), which the pool
 * keeps enforcing locally, so it must not also park the combo target: an account added, resumed or
 * cleared a minute later would otherwise sit ignored until the target expired, up to the 24h
 * server-delay ceiling.
 *
 * Provenance, not just current state: the target must be the OAuth pool, no account may have been
 * identified for the failure, and the pool must be holding the wait right now. An upstream 429 on
 * a pool account always cools and names that account, and an API-key provider never qualifies, so
 * a genuine upstream Retry-After still parks the target in full.
 */
export function isAnthropicPoolLocalRefusal(
  config: OcxConfig,
  providerName: string,
  status: number,
  failedAccount: string | undefined,
  now = Date.now(),
): boolean {
  const instance = configuredAnthropicInstance(config, providerName);
  return instance !== undefined
    && config.providers[providerName]?.authMode === "oauth"
    && status === 429
    && failedAccount === undefined
    && anthropicRoutingFor(instance).getEligibleAnthropicAccounts(now).length === 0
    && anthropicRoutingFor(instance).getAnthropicPoolRetryAfterSeconds(now) !== null;
}

/**
 * The pick's quota binding names its provider's credential together with the redirects and aliases
 * that resolve its model, so it still describes a route that stayed with that provider.
 */
export function dispatchedComboQuotaBinding(pick: ComboPick, route: RouteResult): string | undefined {
  return pick.target.provider === route.providerName ? comboPickQuotaBinding(pick) : undefined;
}

export function rememberPinnedComboExhaustion(pick: ComboPick, route: RouteResult, failure: ConsumedComboFailure): void {
  const quotaBinding = dispatchedComboQuotaBinding(pick, route);
  if (!quotaBinding || isProxyQuotaExhaustion(failure.response)) return;
  coolComboTarget(pick.comboId, pick.target, {
    quotaBinding, writerGeneration: pick.writerGeneration, status: failure.response.status,
    code: failure.upstreamCode, message: failure.classificationText, retryAfter: failure.retryAfter, resetAt: failure.resetAt,
  });
}

export function confirmedComboExhaustion(failure: ConsumedComboFailure): boolean {
  const { response, upstreamMessage, classificationText, upstreamCode, upstreamType } = failure;
  return !isReplayRefusalResponse(response) && (isProxyQuotaExhaustion(response) || (
    !isProxyError(response) && isConfirmedComboExhaustion(response.status, upstreamMessage ?? classificationText, upstreamCode, upstreamType)
  ));
}

/**
 * Whether a confirmed exhaustion lets a quota-only Combo leave this target. A pool answers for its
 * own accounts, so the Combo advances only once none of them is eligible for the model. A sibling
 * of a generic OAuth pool or a key in a pool must also have proved its quota spent, because one that
 * was only rate-limited serves again when its window passes.
 */
export function comboAccountExhaustionCanAdvance(
  config: OcxConfig, route: RouteResult, response: Response, servedAccountLabel: string | undefined, now: number,
  auth: CodexAuthContext | undefined,
): boolean {
  if (route.codexAccountMode === "pool" && isCanonicalOpenAiForwardProvider(route.provider)) {
    if (route.codexAccountId || codexQuotaScopeForModel(route.modelId) !== "shared") return false;
    const refusedId = !isProxyError(response) && auth?.kind === "pool" && !auth.fixedAccount
      && isCodexAccountGenerationLive(auth.accountId, auth.generation) ? auth.accountId : undefined;
    return codexPoolHasConfirmedUsageLimit(config, now, refusedId);
  }
  const anthropic = route.provider.authMode === "oauth" ? configuredAnthropicInstance(config, route.providerName) : undefined;
  if (anthropic) {
    // The pool marks its own spent verdict. A credit refusal was already recorded on its account, and
    // it advances once no account is eligible or only waiting out a rate pause.
    return isProxyQuotaExhaustion(response) || ((response.status === 400 || response.status === 402)
      && anthropicRoutingFor(anthropic).getEligibleAnthropicAccounts(now, route.modelId).length === 0
      && !anthropicAccountOnlyRatePaused(anthropic, now));
  }
  if (isGenericFailoverProvider(route.providerName, route.provider)) {
    const base = baseProviderLabel(route.providerName);
    const refused = getAccountSet(route.providerName)?.accounts
      .find(account => oauthAccountLogLabel(account.id, base) === servedAccountLabel)?.id;
    return !hasEligibleGenericOAuthFailoverTarget(route.providerName, refused ?? "", now, route.modelId)
      && !genericSiblingMayRecover(route.providerName, refused ?? "", now, route.modelId);
  }
  // A key pool advances once every enabled key refused with a spent quota. A key that was only
  // rate-limited serves again when its window passes, so its cooldown keeps the Combo here.
  const keyPool = route.provider.apiKeyPool ?? [];
  if (keyPool.length > 1) {
    const enabledKeys = keyPool.filter(entry => !entry.disabled);
    return isProxyQuotaExhaustion(response) || (enabledKeys.length > 0
      && enabledKeys.every(entry => isKeyQuotaSpent(route.providerName, entry.id, now)));
  }
  return true;
}

/**
 * Peek a 429's bounded body prefix for the reset it dates and whether it proves a spent quota. A
 * pool records that verdict with the cooldown, so a quota-only Combo can tell a spent key or
 * account from one that is only rate-limited. The returned response replays the same body.
 */
export async function readQuotaRefusal(response: Response, signal?: AbortSignal): Promise<{
  response: Response; at: number | undefined; quotaExhausted: boolean;
}> {
  const peeked = await readQuotaResetAt(response, { signal });
  if (isNonReplayableResponse(response)) markResponseNonReplayable(peeked.response);
  carryReplayRefusal(response, peeked.response);
  carryProxyError(response, peeked.response);
  const refusal = normalizeUpstreamErrorText(peeked.text, "");
  return {
    response: peeked.response,
    at: peeked.at,
    quotaExhausted: isConfirmedComboExhaustion(response.status, refusal.message ?? refusal.safeText, refusal.code, refusal.type),
  };
}

export function sanitizedRetryAfter(value: string | null, now: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return parseRetryAfterMs(trimmed, now) !== undefined ? trimmed : undefined;
}




/** A failure envelope this proxy formatted from a provider body it already consumed. */
function isProxyFormattedFailure(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    const error = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { error?: unknown }).error : undefined;
    const message = error && typeof error === "object" && !Array.isArray(error) ? (error as { message?: unknown }).message : undefined;
    return typeof message === "string" && /^Provider error \d{3}\b/.test(message);
  } catch {
    return false;
  }
}
export async function consumeComboFailure(
  response: Response,
  signal?: AbortSignal,
  now = Date.now(),
  logCtx?: { failureDetail?: FailureDetail; causeHint?: RequestFailureCause },
  /** True only when `response` is the provider's own HTTP answer, so its closed error class is evidence. */
  rawUpstream = false,
  grokOAuth = false,
): Promise<ConsumedComboFailure> {
  // Read before the body: the marker lives on this Response object, and the failure below is
  // rebuilt as a new one that would otherwise lose it.
  const nonReplayable = isNonReplayableResponse(response);
  const replayRefusal = isReplayRefusalResponse(response);
  const fallback = `Provider error ${response.status}`;
  let classificationText = fallback;
  let codexModelRefusal: CodexAccountModelRefusal | undefined;
  let malformedResponseFormat: boolean | undefined;
  let openRouterOpaque400: boolean | undefined;
  let unofferedToolCallRefusal: boolean | undefined;
  let providerModerationRefusal: boolean | undefined;
  // A 413 may hop only once its complete body was read and judged; an oversized, unreadable or
  // aborted body leaves the evidence unknown, and unknown evidence keeps dev's terminal 413.
  let providerIntakeRefusal: boolean | undefined = response.status === 413 ? false : undefined;
  let usage: OcxUsage | undefined;
  let upstreamCode: string | undefined;
  let upstreamRootCode: string | undefined;
  let upstreamMessage: string | undefined;
  let upstreamType: string | undefined;
  // Whether the body itself confirms a quota/rate-limit refusal, computed on the SAME read as
  // the classification below. `shouldRetryCodexPoolAccountQuota` cannot be called here without
  // a second body read, so this mirrors its normalization: raw 402/429, or a 5xx whose intact,
  // display-safe body carries a recognized quota message.
  let quotaConfirmedByBody = false;
  const serverError = response.status >= 500 && response.status < 600;
  // A local key-scope refusal is already the client's answer: rebuilding it as an upstream_error
  // would hide the stable model_not_allowed_for_key type clients branch on.
  let scopeRefusalBody: string | undefined;
  let verifiedPlanRefusal = false;
  // The combo preflight projected this terminal as the undeclared-tool guard's own refusal
  // (#9163): membership, not the bare words, is the provenance. An upstream body that merely
  // repeats the code or message never gains the hop.
  let undeclaredToolCallRefusal = isUndeclaredToolCallRefusalResponse(response) || undefined;
  try {
    const legacy = comboFailureEvidence(response);
    if (legacy !== undefined) void response.body?.cancel().catch(() => undefined);
    const body = await readBoundedResponseBody(legacy === undefined ? response : new Response(legacy), { signal, reportUtf8Validity: serverError });
    // A 5xx body counts as quota or classification evidence only when it decoded as valid
    // UTF-8, matching shouldRetryCodexPoolAccountQuota. A malformed byte keeps the status-only
    // fallback, with one exception: a cyber-policy refusal must still stop the combo, so the
    // replacement-decoded text may carry that verdict and nothing else.
    const utf8Trusted = !serverError || body.utf8Valid === true;
    if (utf8Trusted) usage = usageFromComboFailureText(body.text);
    if (serverError && utf8Trusted && body.displaySafe && !body.truncated) {
      const quotaMessage = codexQuotaFailureMessage(body.text);
      quotaConfirmedByBody = quotaMessage !== undefined
        && isRateLimitOrQuotaFailureMessage(quotaMessage);
    }
    if (body.displaySafe && !body.truncated) {
      if (isXaiPrivacyModeRefusal(response) || (grokOAuth && isXaiLegacyPrivacyError(response.status, body.text))) {
        const refusal = xaiPrivacyModeRefusal(logCtx);
        if (response.headers.get("x-should-retry") === "false") refusal.headers.set("x-should-retry", "false");
        if (nonReplayable) markResponseNonReplayable(refusal);
        return {
          response: refusal,
          ...(nonReplayable ? { nonReplayable: true } : {}),
          classificationText: XAI_LEGACY_PRIVACY_MESSAGE,
          upstreamMessage: XAI_LEGACY_PRIVACY_MESSAGE,
          upstreamType: "permission_error",
          upstreamCode: "permission_denied",
        };
      }
      if (logCtx && rawUpstream) recordUpstreamProviderErrorDetail(logCtx, response.status, body.text, response);
      else if (logCtx) recordUpstreamValidationDetail(logCtx, response.status, body.text);
      // A combo child's row is attributed from the same evidence the parent uses: Meta's Muse
      // Code refusal is a plan restriction, not a rejected credential (#8352).
      if (logCtx) stampMetaMusePlanRefusal(logCtx, response.status, body.text);
      if (response.status === 400) {
        codexModelRefusal = codexAccountModelRefusal(response.status, body.text);
        malformedResponseFormat = isMalformedResponseFormatRequest(response.status, body.text);
        openRouterOpaque400 = isOpenRouterOpaque400Envelope(body.text);
        // The intact bounded body, not the 500-char display prefix: a long refusal envelope
        // would fail the classifier's JSON parse on truncated text and stop the combo.
        unofferedToolCallRefusal = isUnofferedToolCallRefusal(response.status, body.text);
      }
      // Judged on the whole body: the classification text below is cut at 500 characters, and a
      // hard refusal after the cut must still veto a moderation hop.
      if (response.status === 400 || response.status === 422) {
        providerModerationRefusal = isProviderModerationRefusal(response.status, body.text, undefined, true);
      }
      // The same whole-body rule for the provider-413 hop (#9017): a hard refusal or proxy marker
      // past the 500-character cut must still keep the combo from sending the turn elsewhere.
      // A native lane's rewritten envelope (Messages or Chat native) is not the provider's body: its
      // terminal codes and an oversized original are gone, so only the original read may clear it.
      // So is a sidecar loop's (web search, image bridge) envelope, whose message is the proxy's own
      // "Provider error 413" summary of a body it already read.
      if (response.status === 413) {
        providerIntakeRefusal = legacy === undefined && !isRewrittenUpstreamError(response) && !isProxyFormattedFailure(body.text)
          && isProviderIntakeRefusalBody(body.text);
      }
      // Status-independent: the nested record is what normalization selects, so a root verdict
      // beside it has to be captured here or the conflict rule never sees it.
      upstreamRootCode = upstreamEnvelopeRootCode(body.text);
      const normalized = normalizeUpstreamErrorText(body.text, fallback);
      if (utf8Trusted || isCyberPolicyCode(normalized.code) || isCyberPolicyMessage(normalized.safeText)) {
        classificationText = normalized.safeText;
        upstreamCode = codexAccountModelRefusalHardStopCode(response.status, body.text)
          ?? upstreamCodeForComboFailure(response, normalized.code);
        // Only the adapter's own normalized refusal may claim the plan-refusal hop; another
        // upstream echoing the code in any spelling keeps the meaning it had before, which was none.
        if (namesModelNotInPlanCode(upstreamCode) && !isModelNotInPlanRefusal(response, upstreamCode)) upstreamCode = undefined;
        verifiedPlanRefusal = isModelNotInPlanRefusal(response, upstreamCode);
        upstreamMessage = normalized.message;
        upstreamType = normalized.type;
      }
      if (nonReplayable && response.status === 403 && upstreamType === MODEL_NOT_ALLOWED_FOR_KEY) {
        scopeRefusalBody = body.text;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    classificationText = fallback;
  }
  const cyberFailure = isCyberPolicyCode(upstreamCode) || isCyberPolicyMessage(classificationText);
  const normalizedUpstreamCode = cyberFailure ? CYBER_POLICY_ERROR_CODE
    : replayRefusal ? UPSTREAM_RESET_REPLAY_REFUSED_CODE : upstreamCode;
  const message = cyberFailure
    ? upstreamMessage
      ?? (isCyberPolicyCode(upstreamCode) ? CYBER_POLICY_FALLBACK_MESSAGE : classificationText)
    : classificationText === fallback
      ? fallback
      : `${fallback}: ${classificationText}`;
  const upstreamRetryAfter = response.headers.get("retry-after");
  // Past HTTP dates are an immediate retry directive, just like the numeric value zero.
  // Normalize before the client helper discards them and substitutes a default delay.
  const effectiveRetryAfter = parseRetryAfterMs(upstreamRetryAfter, now) === undefined
    && parseRetryAfterMs(upstreamRetryAfter, now, { preserveImmediate: true }) !== undefined
    ? "0"
    : upstreamRetryAfter;
  // Client response may get the synthetic "2" fallback; cooldown metadata must not —
  // otherwise coolComboTarget treats it as a 2s cooldown instead of the 60s default.
  const clientRetryAfter = replayRefusal ? undefined : resolveClientRetryAfter({
    status: response.status,
    message,
    upstreamRetryAfter: effectiveRetryAfter,
    now,
  });
  const cooldownRetryAfter = replayRefusal ? undefined : resolveClientRetryAfter({
    status: response.status,
    message,
    upstreamRetryAfter: effectiveRetryAfter,
    now,
    includeDefault: false,
  });
  const failureResponse = scopeRefusalBody !== undefined
    ? new Response(scopeRefusalBody, { status: 403, headers: { "Content-Type": "application/json" } })
    : formatErrorResponse(
    response.status,
    cyberFailure ? (upstreamType ?? CYBER_POLICY_ERROR_CODE) : "upstream_error",
    message,
    {
      ...(normalizedUpstreamCode !== undefined ? { code: normalizedUpstreamCode } : {}),
      ...(clientRetryAfter !== undefined ? { retryAfter: clientRetryAfter } : {}),
    },
  );
  if (nonReplayable) markResponseNonReplayable(failureResponse);
  carryProxyError(response, failureResponse);
  carryWorkflowRefusal(response, failureResponse);
  carryReplayRefusal(response, failureResponse);
  carryProxyErrorPresentation(response, failureResponse);
  carryPolicyCandidateRefusal(response, failureResponse);
  if (verifiedPlanRefusal) markVerifiedModelNotInPlanResponse(failureResponse);
  carryAnthropicRefusalCredential(response, failureResponse);
  carryCodexAccountCooldownResponse(response, failureResponse);
  return {
    response: failureResponse,
    ...(nonReplayable ? { nonReplayable: true } : {}),
    ...(verifiedPlanRefusal ? { verifiedPlanRefusal: true } : {}),
    ...(undeclaredToolCallRefusal ? { undeclaredToolCallRefusal: true } : {}),
    classificationText,
    ...(codexModelRefusal !== undefined ? { codexModelRefusal } : {}),
    ...(malformedResponseFormat !== undefined ? { malformedResponseFormat } : {}),
    ...(openRouterOpaque400 !== undefined ? { openRouterOpaque400 } : {}),
    ...(unofferedToolCallRefusal !== undefined ? { unofferedToolCallRefusal } : {}),
    ...(providerModerationRefusal !== undefined ? { providerModerationRefusal } : {}),
    ...(providerIntakeRefusal !== undefined ? { providerIntakeRefusal } : {}),
    ...(normalizedUpstreamCode !== undefined ? { upstreamCode: normalizedUpstreamCode } : {}),
    // A rewritten identity (policy, replay refusal) is the whole verdict; the root's own code
    // would only re-open a decision that rewrite already settled.
    ...(!cyberFailure && !replayRefusal && upstreamRootCode !== undefined ? { upstreamRootCode } : {}),
    ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
    ...(upstreamType !== undefined ? { upstreamType } : {}),
    ...(!cyberFailure && cooldownRetryAfter !== undefined ? { retryAfter: cooldownRetryAfter } : {}),
    // The EFFECTIVE classification decides, not the raw status. An upstream that wraps a quota
    // refusal in a 5xx still carries `x-codex-*-reset-at`, and gating on 402/429 alone threw
    // those away, so the combo target came back up immediately instead of waiting for the
    // window it was told about. `cyberFailure` stays excluded: a policy block is not a quota.
    ...(!cyberFailure && !replayRefusal
      && (response.status === 429 || response.status === 402 || quotaConfirmedByBody)
      ? { resetAt: codexQuotaOutcomeMeta(response).resetAt }
      : {}),
    ...(usage ? { usage } : {}),
  };
}




export function usageFromComboFailureText(text: string): OcxUsage | undefined {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const nested = payload.response;
    const source = nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : payload;
    return usageFromResponsesPayload(source.usage);
  } catch {
    return undefined;
  }
}




export function createChildPassthroughCallbackGate(options: HandleResponsesOptions) {
  type Pending =
    | { kind: "terminal"; status: ResponsesTerminalStatus }
    | { kind: "cancel" };
  let state: "pending" | "committed" | "discarded" = "pending";
  let pending: Pending | undefined;
  let accepted = false;
  let pendingModel: string | undefined;
  let completionAccepted = false;
  let completionRejected = false;
  const publish = (value: Pending): void => {
    if (value.kind === "terminal") options.onNativePassthroughTerminal?.(value.status);
    else options.onNativePassthroughCancel?.();
  };
  const publishCompletion = (): void => {
    if (state !== "committed" || completionRejected || pendingModel === undefined) return;
    const model = pendingModel;
    pendingModel = undefined;
    options.onResponseComplete?.(model);
  };
  const receive = (value: Pending): void => {
    if (state === "discarded" || accepted) return;
    accepted = true;
    if (value.kind === "cancel" || value.status !== "completed") {
      completionRejected = true;
      pendingModel = undefined;
    }
    if (state === "committed") return publish(value);
    pending ??= value;
  };
  return {
    onTerminal: (status: ResponsesTerminalStatus) => receive({ kind: "terminal", status }),
    onCancel: () => receive({ kind: "cancel" }),
    onResponseComplete: (model: string) => {
      if (state === "discarded" || completionRejected || completionAccepted || !model.trim()) return;
      completionAccepted = true;
      pendingModel = model;
      publishCompletion();
    },
    commit: () => {
      if (state !== "pending") return;
      state = "committed";
      if (pending) publish(pending);
      pending = undefined;
      publishCompletion();
    },
    discard: () => {
      state = "discarded";
      pending = undefined;
      pendingModel = undefined;
    },
  };
}



export function buildComboChildHeaders(parentHeaders: HeadersInit): Headers {
  const childHeaders = new Headers(parentHeaders);
  // A provisional caller credential is not authoritative for a Combo child.
  childHeaders.delete("authorization");
  childHeaders.delete("chatgpt-account-id");
  // Combo children re-serialize already-decoded JSON. Keeping transport metadata from
  // the parent would make the child decoder treat plain JSON as compressed bytes.
  childHeaders.delete("content-length");
  childHeaders.delete("content-encoding");
  return childHeaders;
}

/**
 * A member's local Ollama late-attribution refusal: the exact proxy-owned constant on the exact
 * local wire shape, from a replayable attempt. The caller replaces only the client response with
 * the literal constant envelope; classification inputs are never rewritten.
 */
export function isLateAttributionRefusal(failure: ConsumedComboFailure): boolean {
  return !failure.nonReplayable
    && failure.response.status === 413
    && failure.upstreamCode === "request_too_large"
    && failure.upstreamMessage === OLLAMA_LATE_ATTRIBUTION_LIMIT_MESSAGE;
}
