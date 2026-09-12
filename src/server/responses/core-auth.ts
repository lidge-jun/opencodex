import type { OcxProviderConfig, OcxConfig } from "../../types";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import type { CodexAuthContext } from "../../codex/auth-context";
import type { RouteResult } from "../../router";
import type { HandleResponsesOptions } from "./core-options";
import {
  hasForwardableCodexBearer,
  validateForwardAdmissionCredential,
  isProxyAdmissionSecret,
  ForwardAdmissionCredentialError,
} from "../auth-cors";
import {
  providerConsumesCallerAuthorization,
  captureCallerDirectAuth,
} from "../../providers/caller-authorization";
import { inspectChatGptDomainClaim } from "../../oauth/chatgpt";
import {
  resolveCodexAuthContext,
  CodexMainProfileDrainingError,
  materializeCodexUpstreamAuthAsync,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  releaseCodexAuthContextProbeLease,
  CodexAuthContextError,
  applyCodexAuthContextToProvider,
  stripCodexRuntimeProviderFields,
} from "../../codex/auth-context";
import { codexAccountSelectionForTurn, tryClaimNativeMainProfileForTurn } from "../lifecycle";
import { isNativeMainTrafficBlocked } from "../../codex/native-profile-startup";
import { formatErrorResponse } from "../../bridge";
import { clientCancelledResponse } from "./core-errors";
import { formatCodexProviderForLog, handOffThreadAffinityGeneration } from "../../codex/routing";
import { mapCodexAuthContextErrorToResponse, nativeMainRefreshFailureResponse } from "./codex-auth-error";
import {
  isTerminalCodexPoolRefreshFailure,
  forceRefreshCodexPoolToken,
  capturePoolQuotaWriter,
} from "../../codex/account-store";
import type { RequestLogContext } from "../request-log";
import { markLocalRequestLogRefusal } from "../request-log";
import { CODEX_POOL_REFRESH_INCOMPLETE_LOG_REASON } from "../../codex/pool-refresh-backoff";
import { codexAuthContextLogLabel } from "../../codex/account-label";
import { forceRefreshMainAccountToken } from "../../codex/main-account";

/** Keep synthesized Claude identity out of request headers reused by policy/combo fallback. */
export function withClaudeNativeSession(headers: Headers, provider: OcxProviderConfig, sessionId?: string): Headers {
  if (!sessionId || !isCanonicalOpenAiForwardProvider(provider)
    || headers.has("session_id") || headers.has("session-id") || headers.has("thread-id")) return headers;
  const forwarded = new Headers(headers);
  forwarded.set("session_id", sessionId);
  return forwarded;
}


export type ResponsesAuthResolution =
  | { ok: true; authCtx: CodexAuthContext; headers: Headers; callerAuthHeaders: Headers; substituteMainCredential: boolean }
  | { ok: false; response: Response };


/**
 * The caller credential the final Codex auth resolution will be given, as far as the ROUTE
 * decides it: a route change that may cross a credential domain drops the raw caller credential,
 * and a trusted Claude-main handoff replaces it.
 *
 * Shared with the lineage preview in `handleResponsesInner`, which has to read a conversation's
 * family under the same authenticated scope the resolution will record it under -- that scope is
 * an HMAC of exactly this Authorization header. Two copies of this rule would put preview and
 * final auth in different scopes the first time one of them changed.
 */
export function codexRouteCredentialDomainHeaders(
  req: Request,
  route: RouteResult,
  options: HandleResponsesOptions,
  credentialDomainWasRewritten: boolean,
): Headers {
  const trustedClaudeMainForFinalRoute = options.stripClaudeMainAuthForNoncanonicalForward === true
    && isCanonicalOpenAiForwardProvider(route.provider)
    ? options.trustedClaudeMainAuth : undefined;
  if (trustedClaudeMainForFinalRoute) {
    const claudeMainHeaders = new Headers(req.headers);
    claudeMainHeaders.set("authorization", trustedClaudeMainForFinalRoute.authorization);
    if (trustedClaudeMainForFinalRoute.chatgptAccountId) {
      claudeMainHeaders.set("chatgpt-account-id", trustedClaudeMainForFinalRoute.chatgptAccountId);
    } else {
      claudeMainHeaders.delete("chatgpt-account-id");
    }
    return claudeMainHeaders;
  }
  // Route-changing recursion retains typed admission, never an unscoped raw
  // caller credential. Bearer admission is substituted or stripped below.
  const routeMayChangeCredentialDomain = options.comboAttempt === true
    || route.routeKind === "policy"
    || credentialDomainWasRewritten;
  if (routeMayChangeCredentialDomain && options.admission?.source !== "bearer") {
    const scoped = new Headers(req.headers);
    scoped.delete("authorization");
    scoped.delete("chatgpt-account-id");
    return scoped;
  }
  return req.headers;
}


/**
 * Does this route substitute OUR stored main credential, and does the caller own the credential
 * this request will authenticate with?
 *
 * Both answers are needed twice: by the resolution below, and by the lineage preview, which must
 * not follow a Pool family binding for a request whose credential never enters Pool state. One
 * implementation, because two copies of this predicate disagreeing is the divergence the preview
 * gate exists to prevent. The reasoning behind the substitution test itself is at its use site
 * below (#1686, #2132).
 */
export function codexRouteCredentialOwnership(
  authInputHeaders: Headers,
  config: OcxConfig,
  route: RouteResult,
  options: HandleResponsesOptions,
): { substituteMainCredential: boolean; requestScopedMainCredential: boolean } {
  const substituteMainCredential = options.admission?.source === "bearer"
    && (route.codexAccountMode !== undefined || isCanonicalOpenAiForwardProvider(route.provider));
  return {
    substituteMainCredential,
    requestScopedMainCredential: route.codexAccountMode !== undefined
      && !substituteMainCredential
      && hasForwardableCodexBearer(authInputHeaders, config),
  };
}


/**
 * Resolve Codex auth for a route. On unusable contexts, releases any probe lease
 * before returning the 401 (nothing reaches upstream).
 */
export async function resolveResponsesCodexAuth(
  req: Request,
  config: OcxConfig,
  route: RouteResult,
  options: HandleResponsesOptions,
  credentialDomainWasRewritten = false,
): Promise<ResponsesAuthResolution> {
  try {
    let authInputHeaders = codexRouteCredentialDomainHeaders(
      req,
      route,
      options,
      credentialDomainWasRewritten,
    );
    // A caller-auth transport that is not canonical OpenAI (keyless Cursor) consumes the
    // caller's Authorization as its own upstream token. Keep that contract only for a clean
    // single bearer with NO ChatGPT-domain marker. A bearer marked for the ChatGPT domain —
    // whether its marker is valid or malformed/conflicting — a combined/malformed value, or
    // the captured explicit OpenAI pair is never a Cursor token; a foreign JWT carrying only
    // a generic organizations claim is not ChatGPT-marked and keeps the legacy contract.
    // chatgpt-account-id has no meaning outside the ChatGPT domain.
    if (!isCanonicalOpenAiForwardProvider(route.provider)
      && providerConsumesCallerAuthorization(route.provider)) {
      const rawAuth = authInputHeaders.get("authorization")?.trim();
      const singleBearer = /^Bearer[\t ]+([^\s,]+)$/i.exec(rawAuth ?? "")?.[1];
      const domainClaim = singleBearer ? inspectChatGptDomainClaim(singleBearer) : { kind: "absent" as const };
      const dropBearer = options.nativeCallerAuth != null || domainClaim.kind !== "absent"
        || (rawAuth !== undefined && singleBearer === undefined);
      if (dropBearer || authInputHeaders.has("chatgpt-account-id")) {
        const scoped = new Headers(authInputHeaders);
        if (dropBearer) scoped.delete("authorization");
        scoped.delete("chatgpt-account-id");
        authInputHeaders = scoped;
      }
    }
    // The caller's own Direct credential may cross an internal route change only to the
    // canonical OpenAI transport, under a predicate deliberately STRICTER than plain
    // unchanged-route Direct forwarding: a clean non-proxy bearer whose ChatGPT-domain
    // marker is valid, with any explicit account header matching that marker. Unchanged
    // routes keep their legacy rules; sidecar enrichment grants no primary authority.
    if (options.callerDirectAuth && isCanonicalOpenAiForwardProvider(route.provider)) {
      const directHeaders = new Headers({
        authorization: options.callerDirectAuth.authorization,
        ...(options.callerDirectAuth.chatgptAccountId
          ? { "chatgpt-account-id": options.callerDirectAuth.chatgptAccountId } : {}),
      });
      if (captureCallerDirectAuth(directHeaders, config)) {
        authInputHeaders = new Headers(authInputHeaders);
        authInputHeaders.set("authorization", options.callerDirectAuth.authorization);
        if (options.callerDirectAuth.chatgptAccountId) {
          authInputHeaders.set("chatgpt-account-id", options.callerDirectAuth.chatgptAccountId);
        } else {
          authInputHeaders.delete("chatgpt-account-id");
        }
      }
    }
    // #1686: a caller that proved admission with a BEARER presented one of our own secrets.
    // Refusing it here is what made the codex-cli `env_key` contract unusable against Direct.
    // Admitting it is only safe because the stored main credential is substituted below, so
    // the admission secret still never leaves this process.
    //
    // #2132: substitution answers "does THIS ROUTE need our stored ChatGPT credential", not
    // "how did the caller authenticate". Only a native Codex route reaches the ChatGPT backend
    // and can consume that credential; a key-authenticated routed provider carries its own and
    // never touches it. Keying on the caller alone made an install that deliberately never
    // logged into ChatGPT fail every routed request with "No usable Codex main credential".
    //
    // But ask that question the way the ADAPTER asks it. `codexAccountMode` is derived from the
    // provider NAME (`providerCodexAccountMode`), while the passthrough adapter decides whether
    // to forward caller credentials from the TRANSPORT — adapter, auth mode, and base URL
    // (`isCanonicalOpenAiForwardProvider`). A row the operator named anything other than
    // `openai`, pointed at the canonical ChatGPT backend with `authMode: "forward"`, satisfies
    // the adapter's test and fails this one, so substitution was skipped and the adapter then
    // forwarded our own admission secret upstream. Two predicates answering one question is the
    // bug; the transport is the authority, because the transport is what actually carries the
    // header. A key-authenticated routed provider is still not canonical-forward, so #2132's
    // no-ChatGPT-login install keeps working.
    const { substituteMainCredential, requestScopedMainCredential } = codexRouteCredentialOwnership(
      authInputHeaders,
      config,
      route,
      options,
    );
    const stripAuthorization = options.admission?.source === "bearer" && !substituteMainCredential;
    if (route.codexAccountMode === "direct" && !substituteMainCredential) {
      validateForwardAdmissionCredential(authInputHeaders, config);
    }
    let authCtx: CodexAuthContext;
    if (route.codexAccountMode) {
      authCtx = await resolveCodexAuthContext(authInputHeaders, config, route.codexAccountMode, {
        admission: options.admission,
        codexAuthPolicy: options.codexAuthPolicy,
        accountId: route.codexAccountId,
        modelId: route.modelId,
        substituteMainCredentialForDirect: substituteMainCredential,
        requestScopedMainCredential,
        beginCodexAccountSelection: codexAccountSelectionForTurn(options.turnAdmissionLease),
        resolveCodexModelEntitlements: options.resolveCodexModelEntitlements,
        signal: options.abortSignal,
        nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
      });
      options.onCodexAuthContextResolved?.(authCtx);
    } else {
      // A custom-named canonical-forward provider has no Codex account mode, but an
      // admission bearer still substitutes the stored main credential below. Claim the
      // same physical profile before synthesizing the main context so transport-based
      // substitution cannot bypass a switch drain.
      if (
        substituteMainCredential
        && (
          isNativeMainTrafficBlocked()
          || !tryClaimNativeMainProfileForTurn(options.turnAdmissionLease)
          || isNativeMainTrafficBlocked()
        )
      ) {
        throw new CodexMainProfileDrainingError();
      }
      authCtx = { kind: "main", accountId: null };
      options.onCodexAuthContextResolved?.(undefined);
    }
    // This resolver also builds a synthetic main context for unrelated keyed routes. Only
    // the actual Codex-forward transport consumes main quota; provider names are not proof
    // (custom-named canonical-forward providers must retain the same protection).
    const mainPolicyConfig = isCanonicalOpenAiForwardProvider(route.provider)
      ? options.codexAuthPolicy ?? config : undefined;
    const headers = await materializeCodexUpstreamAuthAsync(authInputHeaders, authCtx, {
      admission: options.admission,
      config: mainPolicyConfig,
      modelId: route.modelId,
      beginCodexAccountSelection: codexAccountSelectionForTurn(options.turnAdmissionLease),
      substituteMainCredential,
      signal: options.abortSignal,
      nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
    });
    // Awaiting even a cached materialization yields. Preserve the policy error if the live
    // quota/config changed during that yield, before usability could mislabel it as reauth.
    headersForCodexAuthContext(headers, authCtx, mainPolicyConfig, route.modelId, options.admission);
    if (!isCodexAuthContextUsable(authCtx, config)) {
      releaseCodexAuthContextProbeLease(authCtx);
      return {
        ok: false,
        response: formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication"),
      };
    }
    if (stripAuthorization) {
      headers.delete("authorization");
      headers.delete("chatgpt-account-id");
    }
    if (providerConsumesCallerAuthorization(route.provider) && options.admission?.source !== undefined
      && options.admission.source !== "loopback") {
      validateForwardAdmissionCredential(headers, config);
    } else {
      // Even adapters that ignore caller auth must not retain a proxy secret for
      // a later internal hop or a future transport change.
      const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
      if (bearer && isProxyAdmissionSecret(bearer, config)) {
        headers.delete("authorization");
        headers.delete("chatgpt-account-id");
      }
    }
    return {
      ok: true,
      authCtx,
      headers,
      callerAuthHeaders: new Headers(authInputHeaders),
      substituteMainCredential,
    };
  } catch (err) {
    if (options.abortSignal?.aborted || req.signal.aborted) {
      return { ok: false, response: clientCancelledResponse() };
    }
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = route.codexAccountNamespace
        ? `${route.providerName}-${route.codexAccountNamespace}`
        : formatCodexProviderForLog(route.providerName, err.accountId, config);
      console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed; reauthentication required`);
    }
    if (err instanceof ForwardAdmissionCredentialError) {
      return { ok: false, response: formatErrorResponse(401, "authentication_error", err.message) };
    }
    const response = mapCodexAuthContextErrorToResponse(err, {
      accountSelector: route.codexAccountNamespace,
      now: Date.now(),
    });
    if (response) return { ok: false, response };
    throw err;
  }
}


/**
 * Terminal means the grant itself is dead and no retry can help. Everything else —
 * an untyped network failure, a token-endpoint 5xx surfacing as `unknown`, an abort,
 * refresh capacity, lock contention, a superseded flight — is transient, and treating
 * it as terminal would quarantine a healthy account on an upstream blip, which is the
 * defect this path exists to fix (#2887).
 */
export function isTerminalPoolRefreshFailure(error: unknown): boolean {
  // Delegated so "terminal" has ONE definition. A missing record or a missing refresh-grant
  // fingerprint is permanent -- retrying cannot conjure a credential -- and used to be a bare
  // Error, which fell through to the retryable 503 and told the operator to keep retrying a
  // request that could never succeed.
  return isTerminalCodexPoolRefreshFailure(error);
}


/**
 * The refusal an operator meets when a stored pool credential's forced refresh does not complete.
 *
 * A bare "retry this request" reads as a transient fault in the proxy, which is how #4212's
 * reporter spent an afternoon concluding OpenCodex had broken while one of their own accounts was
 * the thing that needed them. It stays a retryable 503 and stays non-quarantining, because the
 * refresh genuinely may succeed and a token-endpoint 5xx must not retire a healthy account
 * (#2887). What it adds is the account and the exit: when retrying stops helping, that account
 * has to be signed in again.
 *
 * The label is a public account selector when the request carried one, otherwise the durable
 * `p`-prefixed log label — never the raw pool id and never the email. Those are the identifiers
 * `responses-compaction-routing.test.ts` and `codex-auth-context.test.ts` already assert must not
 * reach an operator-facing surface, and an error body travels further than a log line, not less.
 * When neither is resolvable the sentence degrades to "the selected Codex pool account" rather
 * than naming something opaque, because a wrong name is worse than no name.
 *
 * The wording says "sign in to that account again" and deliberately does NOT say
 * "reauthentication". `classifyError` runs `isAuthenticationMessage` before it reaches the
 * `status === 503` arm, and that check is status-blind on the bare substring "authentication",
 * which "reauthentication" contains. A body carrying that word is reclassified to
 * `authentication_error` / `invalid_api_key` even though the HTTP status stays 503 — and Codex
 * applies retry-after backoff only for `server_is_overloaded`, so the friendlier sentence would
 * have quietly disabled the retry this refusal exists to ask for. `options.code` cannot buy the
 * classification back; only the wording can.
 */
export function poolCredentialRefreshIncompleteResponse(args: {
  authCtx: CodexAuthContext;
  config: Pick<OcxConfig, "codexAccounts">;
  accountSelector?: string;
  logCtx?: RequestLogContext;
}): Response {
  // The wire contract below is unchanged on purpose, so the record has to carry the origin
  // instead. Without it an operator reads this sentence under a field named "Upstream reason"
  // and goes looking at the provider's status page for a refusal that never left this process.
  if (args.logCtx) markLocalRequestLogRefusal(args.logCtx, CODEX_POOL_REFRESH_INCOMPLETE_LOG_REASON);
  const label = args.accountSelector ?? codexAuthContextLogLabel(args.authCtx, args.config);
  const account = label ? `Codex pool account ${label}` : "the selected Codex pool account";
  const response = formatErrorResponse(
    503,
    "server_busy",
    `Codex credential refresh did not complete for ${account}; retry this request. `
      + "If it keeps failing, sign in to that account again.",
  );
  const headers = new Headers(response.headers);
  headers.set("Retry-After", "1");
  return new Response(response.body, { status: response.status, headers });
}


/**
 * One forced refresh and one same-account rebuild for a stored pool credential that
 * upstream rejected with a pre-stream 401. `quarantine` distinguishes a dead grant,
 * which must retire the account, from a transient failure, which must not.
 */
export async function refreshPoolForwardAuth(args: {
  logCtx?: RequestLogContext;
  req: Request;
  config: OcxConfig;
  route: RouteResult;
  authCtx: CodexAuthContext & { kind: "pool" };
  substituteMainCredential: boolean;
  options: HandleResponsesOptions;
}): Promise<
  | { ok: true; authCtx: CodexAuthContext; provider: OcxProviderConfig; headers: Headers }
  | { ok: false; response: Response; quarantine: boolean; quarantineGeneration?: number }
> {
  const { req, config, route, authCtx, substituteMainCredential, options } = args;
  try {
    const refreshed = await forceRefreshCodexPoolToken(authCtx.accountId, {
      rejectedGeneration: authCtx.generation,
      rejectedAccessToken: authCtx.accessToken,
      signal: options.abortSignal,
    });
    if (!refreshed.rotated) {
      // The store resolved to the same bearer upstream just rejected. Replaying it
      // would spend another upstream call to earn the identical 401. Upstream can do
      // this on a SUCCESSFUL response by rotating only the refresh grant, so the
      // credential generation may already have moved — quarantine has to be fenced on
      // where the credential actually is, not on the generation we started from.
      return {
        ok: false,
        quarantine: true,
        quarantineGeneration: refreshed.generation,
        response: formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication"),
      };
    }
    // Only a CAS this request performed itself proves the new credential descends from
    // the rejected one. Somebody else's replacement may be a different identity, and
    // its affinity must be retired rather than inherited.
    if (refreshed.selfRefreshed) {
      handOffThreadAffinityGeneration(authCtx.accountId, authCtx.generation, refreshed.generation);
    }
    const refreshedAuthCtx: CodexAuthContext = {
      ...authCtx,
      accessToken: refreshed.accessToken,
      chatgptAccountId: refreshed.chatgptAccountId,
      generation: refreshed.generation,
      poolQuotaWriter: capturePoolQuotaWriter(authCtx.accountId, refreshed),
    };
    const provider = applyCodexAuthContextToProvider(
      stripCodexRuntimeProviderFields(route.provider),
      refreshedAuthCtx,
      route.codexAccountMode,
    );
    const headers = await materializeCodexUpstreamAuthAsync(req.headers, refreshedAuthCtx, {
      admission: options.admission,
      config: options.codexAuthPolicy ?? config,
      modelId: route.modelId,
      substituteMainCredential,
      signal: options.abortSignal,
      nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
    });
    return { ok: true, authCtx: refreshedAuthCtx, provider, headers };
  } catch (error) {
    if (isTerminalPoolRefreshFailure(error)) {
      return {
        ok: false,
        quarantine: true,
        response: formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication"),
      };
    }
    return {
      ok: false,
      quarantine: false,
      response: poolCredentialRefreshIncompleteResponse({
        authCtx,
        config,
        accountSelector: route.codexAccountNamespace,
        logCtx: args.logCtx,
      }),
    };
  }
}


export async function refreshNativeMainForwardAuth(args: {
  req: Request;
  config: OcxConfig;
  route: RouteResult;
  authCtx: CodexAuthContext;
  substituteMainCredential: boolean;
  options: HandleResponsesOptions;
}): Promise<
  | { ok: true; authCtx: CodexAuthContext; provider: OcxProviderConfig; headers: Headers }
  | { ok: false; response: Response }
> {
  const { req, config, route, authCtx, substituteMainCredential, options } = args;
  if (authCtx.kind !== "main-pool") {
    return { ok: false, response: formatErrorResponse(401, "authentication_error", "No native main credential to refresh") };
  }
  try {
    const refreshed = await forceRefreshMainAccountToken(authCtx.accessToken, {
      signal: options.abortSignal,
      ...(options.nativeMainRefreshDependencies ?? {}),
    });
    if (!refreshed) {
      return { ok: false, response: formatErrorResponse(401, "authentication_error", "Codex main account needs reauthentication") };
    }
    const refreshedAuthCtx: CodexAuthContext = {
      ...authCtx,
      accessToken: refreshed.accessToken,
      chatgptAccountId: refreshed.chatgptAccountId,
    };
    const provider = applyCodexAuthContextToProvider(
      stripCodexRuntimeProviderFields(route.provider),
      refreshedAuthCtx,
      route.codexAccountMode,
    );
    const headers = await materializeCodexUpstreamAuthAsync(req.headers, refreshedAuthCtx, {
      admission: options.admission,
      config: options.codexAuthPolicy ?? config,
      modelId: route.modelId,
      substituteMainCredential,
      signal: options.abortSignal,
      nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
    });
    return { ok: true, authCtx: refreshedAuthCtx, provider, headers };
  } catch (error) {
    if (options.abortSignal?.aborted || req.signal.aborted) {
      return { ok: false, response: clientCancelledResponse() };
    }
    return { ok: false, response: mapCodexAuthContextErrorToResponse(error, {
      now: Date.now(), accountSelector: route.codexAccountNamespace,
    }) ?? nativeMainRefreshFailureResponse(error) };
  }
}
