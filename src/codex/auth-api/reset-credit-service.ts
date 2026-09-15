import { getValidCodexToken, isCodexAccountGenerationLive, readCodexAccountRecord, CodexCredentialGenerationConflictError } from "../account-store";
import { isCompleteCodexQuotaRecoverySnapshot } from "../quota";
import { reconcileMainCodexAccountRuntimeState } from "../account-lifecycle";
import { claimManualResetCooldowns, settleManualResetCooldown } from "../routing";
import type { ManualResetCooldownClaim } from "../routing";
import { readCodexTokens } from "../auth-collision";
import { extractAccountId } from "../../oauth/chatgpt";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { getMainQuotaCredentialGeneration, isMainQuotaWriterLive, matchesMainQuotaCredential, observeMainQuotaCredential } from "../main-account-cache";
import type { OcxConfig } from "../../types";
import { BOUNDED_BODY_MAX_BYTES, readBoundedResponseBody } from "../../lib/bounded-body";
import { cancelBodyOnAbort, signalWithTimeout } from "../../lib/abort";
import { hasLegacyMainCodexPoolAccount, isValidCodexAccountId } from "../account-id";
import { markManualResetCreditOperationAmbiguous, openManualResetCreditOperation, settleManualResetCreditOperation } from "../reset-credit-operation-ledger";
import type { AdmissionLease } from "../../lib/admission";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { jsonResponse, nativeMainProfileBusyResponse, withNativeMainCredentialClaim, isNativeMainClaimUnavailable } from "./http";
import { fetchMainAccountInfoAttempt } from "./main-account-probe";
import type { MainResetQuotaProof } from "./main-account-probe";
import { currentQuotaDispatchSequence, fetchPoolAccountQuota } from "./pool-quota-probe";
import { getRuntimeConfig, configuredPoolAccount } from "./runtime-config";

interface ResetCreditAuth {
  isMain: boolean;
  accessToken: string;
  chatgptAccountId: string;
  nativeMainLease?: AdmissionLease;
  nativeMainSharedClaimHeld?: true;
  poolGeneration?: number;
  mainProof?: MainResetQuotaProof;
}

async function withResetCreditAuth<T>(
  runtimeConfig: OcxConfig,
  accountId: string,
  operation: (auth: ResetCreditAuth) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    if (hasLegacyMainCodexPoolAccount(runtimeConfig.codexAccounts)) {
      return { ok: false, response: jsonResponse({ error: "Remove the legacy __main__ pool row before using the Desktop account" }, 409) };
    }
    const nativeMainLease = tryAcquireNativeMainProfileClaim();
    if (!nativeMainLease) return { ok: false, response: nativeMainProfileBusyResponse() };
    try {
      try {
        return await withNativeMainCredentialClaim(async () => {
          const tokens = readCodexTokens();
          if (!tokens) {
            return { ok: false, response: jsonResponse({ error: "Main Codex account not logged in" }, 401) };
          }
          reconcileMainCodexAccountRuntimeState();
          const physicalId = extractAccountId(tokens.id_token, tokens.access_token) ?? tokens.account_id;
          const writer = physicalId === tokens.account_id
            ? observeMainQuotaCredential(tokens.access_token, tokens.account_id) : undefined;
          return {
            ok: true,
            value: await operation({
              isMain: true,
              ...(writer ? { mainProof: { writer, credentialGeneration: getMainQuotaCredentialGeneration() } } : {}),
              accessToken: tokens.access_token,
              chatgptAccountId: tokens.account_id,
              nativeMainLease,
              nativeMainSharedClaimHeld: true,
            }),
          };
        });
      } catch (error) {
        if (isNativeMainClaimUnavailable(error)) {
          return { ok: false, response: nativeMainProfileBusyResponse() };
        }
        throw error;
      }
    } finally {
      nativeMainLease.release();
    }
  }
  if (!isValidCodexAccountId(accountId)) {
    return { ok: false, response: jsonResponse({ error: "Invalid account id format" }, 400) };
  }
  if (!configuredPoolAccount(runtimeConfig, accountId)) {
    return { ok: false, response: jsonResponse({ error: "Unknown Codex account" }, 404) };
  }
  const cred = await getValidCodexToken(accountId);
  return {
    ok: true,
    value: await operation({
      isMain: false,
      poolGeneration: cred.generation,
      accessToken: cred.accessToken,
      chatgptAccountId: cred.chatgptAccountId,
    }),
  };
}

function safeResetCreditsDto(input: unknown): { credits: { granted_at: string; expires_at: string }[]; available_count?: number } {
  const obj = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const rawCredits = Array.isArray(obj.credits) ? obj.credits : [];
  const credits = rawCredits.flatMap((raw): { granted_at: string; expires_at: string }[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const credit = raw as Record<string, unknown>;
    return typeof credit.granted_at === "string" && typeof credit.expires_at === "string"
      ? [{ granted_at: credit.granted_at, expires_at: credit.expires_at }]
      : [];
  });
  const rawAvailable = (obj.rate_limit_reset_credits as { available_count?: unknown } | null | undefined)?.available_count
    ?? obj.available_count;
  return {
    credits,
    ...(typeof rawAvailable === "number" && Number.isFinite(rawAvailable) ? { available_count: rawAvailable } : {}),
  };
}

function safeResetCreditConsumeDto(input: unknown): { code: string } {
  const obj = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  return { code: typeof obj.code === "string" ? obj.code : "unknown" };
}

/**
 * Background reset-credit access for the auto-redeemer (#822). Goes through the same
 * account/lease wrapper as the management routes, but takes a caller-owned
 * `redeem_request_id` so a journaled id can be replayed idempotently after a crash.
 * Throws on any auth or upstream failure; the caller treats a throw on consume as ambiguous.
 */
export function createResetCreditWhamClient(config: OcxConfig, accountId: string): {
  inspect: () => Promise<{ credits: { granted_at: string; expires_at: string }[] }>;
  consume: (redeemRequestId: string) => Promise<{ code: string }>;
} {
  const run = async <T>(operation: (auth: ResetCreditAuth) => Promise<T>): Promise<T> => {
    const result = await withResetCreditAuth(getRuntimeConfig(config), accountId, operation);
    if (result.ok) return result.value;
    throw new Error(`reset-credit auth unavailable (${result.response.status})`);
  };
  return {
    inspect: () => run(async auth => {
      const resp = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
        headers: { Authorization: `Bearer ${auth.accessToken}`, "ChatGPT-Account-Id": auth.chatgptAccountId },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) { await resp.body?.cancel().catch(() => {}); throw new Error(`upstream ${resp.status}`); }
      const parsed = await readResetCreditJson(resp, AbortSignal.timeout(8000));
      if (!parsed.ok) throw new Error("invalid upstream reset-credit response");
      return { credits: safeResetCreditsDto(parsed.value).credits };
    }),
    consume: redeemRequestId => run(async auth => {
      const resp = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "ChatGPT-Account-Id": auth.chatgptAccountId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ redeem_request_id: redeemRequestId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) { await resp.body?.cancel().catch(() => {}); throw new Error(`upstream ${resp.status}`); }
      return safeResetCreditConsumeDto(await resp.json());
    }),
  };
}

type ResetCreditJsonRead =
  | { ok: true; value: unknown }
  | { ok: false };

function cancelResponseBodyWithoutWaiting(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // Some stream implementations throw synchronously from cancel().
  }
}

async function readResetCreditJson(
  response: Response,
  signal: AbortSignal,
): Promise<ResetCreditJsonRead> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(declaredLength)
    && declaredLength >= 0
    && declaredLength > BOUNDED_BODY_MAX_BYTES) {
    cancelResponseBodyWithoutWaiting(response.body);
    return { ok: false };
  }
  try {
    const body = await readBoundedResponseBody(response, {
      signal,
      maxBytes: BOUNDED_BODY_MAX_BYTES,
      fatalUtf8: true,
    });
    if (!body.displaySafe || body.truncated || !body.text.trim()) return { ok: false };
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: false };
  }
}

function manualResetAuthStillLive(accountId: string, auth: ResetCreditAuth): boolean {
  if (!auth.isMain) {
    const record = readCodexAccountRecord(accountId);
    return auth.poolGeneration !== undefined
      && isCodexAccountGenerationLive(accountId, auth.poolGeneration)
      && record?.credential?.chatgptAccountId === auth.chatgptAccountId;
  }
  const tokens = readCodexTokens();
  return !!auth.mainProof && !!tokens
    && tokens.access_token === auth.accessToken && tokens.account_id === auth.chatgptAccountId
    && isMainQuotaWriterLive(auth.mainProof.writer)
    && auth.mainProof.credentialGeneration === getMainQuotaCredentialGeneration()
    && matchesMainQuotaCredential(auth.accessToken, auth.chatgptAccountId);
}

/** A confirmed spend remains successful even when its optional usage observation fails. */
async function refreshAfterManualReset(
  config: OcxConfig,
  accountId: string,
  auth: ResetCreditAuth,
  claims: ManualResetCooldownClaim[],
  didReset: boolean,
): Promise<number | undefined> {
  const afterDispatchSequence = currentQuotaDispatchSequence();
  try {
    if (!manualResetAuthStillLive(accountId, auth)) return undefined;
    if (auth.isMain) {
      const result = await fetchMainAccountInfoAttempt(true, 1, auth.nativeMainLease,
        auth.nativeMainSharedClaimHeld === true, false);
      const proof = result.resetRecoveryProof;
      const recovered = didReset && manualResetAuthStillLive(accountId, auth)
        && !!proof && !!auth.mainProof
        && proof.dispatchSequence > afterDispatchSequence
        && proof.credentialGeneration === auth.mainProof.credentialGeneration
        && proof.writer.identityKey === auth.mainProof.writer.identityKey
        && proof.writer.identityGeneration === auth.mainProof.writer.identityGeneration
        && isCompleteCodexQuotaRecoverySnapshot(result.freshQuota ?? null, result.info.plan);
      for (const claim of claims) settleManualResetCooldown(getRuntimeConfig(config), claim, recovered);
      return manualResetAuthStillLive(accountId, auth) ? result.freshResetCredits : undefined;
    }
    const account = configuredPoolAccount(getRuntimeConfig(config), accountId);
    if (!account) return undefined;
    // Reuse the just-authenticated consume credential for the first usage request.
    // getValidCodexToken can silently advance a generation without exposing refresh
    // provenance. A 401 here instead uses the existing classified refresh/replay path.
    const resetToken: typeof getValidCodexToken = async () => {
      if (auth.poolGeneration === undefined || !manualResetAuthStillLive(accountId, auth)) {
        throw new CodexCredentialGenerationConflictError();
      }
      return { accessToken: auth.accessToken, chatgptAccountId: auth.chatgptAccountId, generation: auth.poolGeneration };
    };
    // `validatePending` is false here: a manual reset settles cooldown, and finishing deferred
    // registration stays reserved for an explicit dashboard account-list refresh.
    const result = await fetchPoolAccountQuota(accountId, true, account.plan, didReset ? resetToken : getValidCodexToken,
      false, didReset ? afterDispatchSequence : undefined);
    const record = readCodexAccountRecord(accountId);
    const recovered = didReset && record?.credential?.chatgptAccountId === auth.chatgptAccountId
      && (result.quotaProbeAttempted?.dispatchSequence ?? 0) > afterDispatchSequence
      && isCompleteCodexQuotaRecoverySnapshot(result.freshQuota ?? null, result.freshPlan ?? account.plan);
    for (const claim of claims) settleManualResetCooldown(getRuntimeConfig(config), claim, recovered, {
      credentialGeneration: result.freshCredentialGeneration,
      refreshLineage: result.resetRefreshLineage,
    });
    return record?.credential?.chatgptAccountId === auth.chatgptAccountId ? result.freshResetCredits : undefined;
  } catch {
    // The upstream reset already happened. A failed refresh must not invite another spend.
    return undefined;
  }
}

export async function inspectResetCredits(config: OcxConfig, accountId: string, signal: AbortSignal): Promise<Response> {
  const result = await withResetCreditAuth(getRuntimeConfig(config), accountId, async auth => {
    const linkedSignal = signalWithTimeout(8000, signal);
    let detachBodyAbort = () => {};
    try {
      let resp: Response;
      try {
        resp = await fetch(
          "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
          {
            headers: {
              Authorization: `Bearer ${auth.accessToken}`,
              "ChatGPT-Account-Id": auth.chatgptAccountId,
            },
            signal: linkedSignal.signal,
          },
        );
      } catch (error) {
        if (linkedSignal.signal.aborted) {
          return jsonResponse({ error: "Invalid upstream reset-credit response" }, 502);
        }
        throw error;
      }
      // Own the response body before the bounded reader attaches. If the client
      // disconnects in that narrow window, Bun otherwise tears down the native
      // body off the awaited path and can report an unhandled rejection.
      detachBodyAbort = cancelBodyOnAbort(resp.body, linkedSignal.signal);
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        return jsonResponse({ error: `Upstream error ${resp.status}` }, resp.status);
      }
      const parsed = await readResetCreditJson(resp, linkedSignal.signal);
      if (!parsed.ok) {
        return jsonResponse({ error: "Invalid upstream reset-credit response" }, 502);
      }
      return jsonResponse(safeResetCreditsDto(parsed.value));
    } finally {
      detachBodyAbort();
      linkedSignal.cleanup();
    }
  });
  return result.ok ? result.value : result.response;
}

export async function consumeResetCredits(config: OcxConfig, accountId: string, requestedOperationId: string | undefined): Promise<Response> {
  const operation = await withResetCreditAuth(getRuntimeConfig(config), accountId, async auth => {
    // The ledger keys manual operations by the *physical* ChatGPT account, which is
    // only known after the auth wrapper resolves credentials. Open here, not earlier.
    let identity = requestedOperationId === undefined
      ? undefined
      : {
        accountId,
        chatgptAccountId: auth.chatgptAccountId,
        operationId: requestedOperationId,
      } as const;
    let idempotencyKey: string;
    if (identity) {
      const opened = openManualResetCreditOperation(identity);
      if (opened.kind === "terminal") {
        // Durably settled already: replay the recorded outcome instead of
        // trusting upstream idempotency for an irreversible spend. No
        // `remaining` — that field is only reported from a freshly parsed
        // available_count, and a replay has none.
        return jsonResponse({ code: opened.code, replayed: true });
      }
      if (opened.kind === "identity-mismatch") {
        return jsonResponse({
          error: "operation_id_owned_by_another_account",
          code: "identity_mismatch",
        }, 409);
      }
      if (opened.kind !== "execute") {
        // capacity | unavailable -> fail closed. Falling back to a random id
        // would silently reintroduce the double-spend this identity prevents.
        const response = jsonResponse({
          error: opened.kind === "capacity"
            ? "reset_credit_ledger_capacity"
            : "reset_credit_ledger_unavailable",
          code: opened.kind,
        }, 503);
        response.headers.set("Retry-After", "1");
        return response;
      }
      // Canonical id, which an alias join may map to an earlier caller id.
      identity = { ...identity, operationId: opened.operationId };
      idempotencyKey = opened.operationId;
    } else {
      idempotencyKey = crypto.randomUUID();
    }
    const claims = manualResetAuthStillLive(accountId, auth)
      ? claimManualResetCooldowns(getRuntimeConfig(config), accountId, Date.now(), auth.poolGeneration) : [];
    try {
      let resp: Response;
      try {
        resp = await fetch(
          "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${auth.accessToken}`,
              "ChatGPT-Account-Id": auth.chatgptAccountId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ redeem_request_id: idempotencyKey }),
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch (error) {
        // Dispatch outcome unknown: the credit may or may not have been spent.
        // Mark ambiguous so a replay of this same id is never treated as new.
        if (identity) markManualResetCreditOperationAmbiguous(identity);
        throw error;
      }
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        if (identity) markManualResetCreditOperationAmbiguous(identity);
        return jsonResponse({ error: `Upstream error ${resp.status}` }, resp.status);
      }
      const result = safeResetCreditConsumeDto(await resp.json());
      if (identity) {
        // Narrow explicitly rather than casting: `safeResetCreditConsumeDto`
        // normalizes anything unrecognized to "unknown", and settling that
        // would come back as a mismatch and leave the row pending anyway.
        // Settlement failure never downgrades the user-visible outcome: the
        // spend already happened upstream, and reporting failure would invite
        // a manual retry -- the exact double-spend this unit removes.
        if (result.code === "reset" || result.code === "already_redeemed"
          || result.code === "nothing_to_reset" || result.code === "no_credit") {
          settleManualResetCreditOperation(identity, result.code);
        } else {
          markManualResetCreditOperationAmbiguous(identity);
        }
      }
      // After a successful redeem (or an idempotent already_redeemed), refresh WHAM usage
      // and return remaining only when that refresh freshly parsed available_count.
      // Do not fall back to a preserved cached resetCredits (failed/omitted refresh).
      if (result.code === "reset" || result.code === "already_redeemed") {
        const freshResetCredits = await refreshAfterManualReset(
          config, accountId, auth, claims, result.code === "reset",
        );
        return jsonResponse({
          code: result.code,
          ...(typeof freshResetCredits === "number" && Number.isFinite(freshResetCredits)
            ? { remaining: freshResetCredits }
            : {}),
        });
      }
      return jsonResponse(result);
    } finally {
      // Release only this invocation's leases, including every ambiguous/error outcome.
      for (const claim of claims) settleManualResetCooldown(getRuntimeConfig(config), claim, false);
    }
  });
  return operation.ok ? operation.value : operation.response;
}
