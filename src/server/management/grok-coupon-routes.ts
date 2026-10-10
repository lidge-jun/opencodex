/**
 * Management API handlers for Grok quota reset coupons.
 *
 * Exposes inspection and consumption of Grok billing reset coupons via gRPC-Web
 * to Grok ConsumerUiSvc upstream endpoints.
 *
 * Inherits management authentication from requireManagementAuth in management-api.ts.
 * Lazy-loaded by handleGrokCouponRoutesOnDemand to keep startup fast and honor the
 * core-lab boundary contract.
 */

import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { ConfigMutationLockError } from "../../config/mutation-lock";
import { isCodexResetCreditOperationId } from "../../codex/reset-credit-recovery";
import { getValidAccessSnapshotForAccount } from "../../oauth";
import { listAccounts, captureOAuthAccountSelection } from "../../oauth/store";
import {
  getGrokRemainingResets,
  redeemGrokResetCoupon,
  type GrokResetCoupon,
} from "../../grok/reset-coupons";
import {
  getGrokResetCouponOperationAccountId,
  markGrokResetCouponAttempt,
  openGrokResetCouponOperation,
  recordGrokResetCouponSettlement,
  readGrokResetCouponTerminalReplay,
  settleGrokResetCouponPreflightRefusal,
  type GrokResetCouponOperationRecord,
} from "../../grok/reset-coupon-ledger";

export interface GrokResetCouponsResponse {
  accountId: string;
  tokens: Array<{
    tokenId: string;
    validityStart: string;
    validityEnd: string;
  }>;
  remaining: number;
}

export interface GrokConsumeCouponRequestBody {
  accountId?: string;
  tokenId?: string;
  operationId?: string;
}

// A recent attempt can still be in flight. Older attempts may be inspected,
// but a remaining token is not proof that the original request cannot land.
const GROK_COUPON_ATTEMPT_STALE_MS = 90_000;
const grokCouponInFlightAttempts = new Set<string>();

function resolveTargetAccountId(requestedAccountId?: string): string {
  if (requestedAccountId && requestedAccountId.trim() !== "") {
    return requestedAccountId.trim();
  }
  const selection = captureOAuthAccountSelection("xai");
  if (selection?.accountId) {
    return selection.accountId;
  }
  const accounts = listAccounts("xai");
  if (accounts.length > 0) {
    return accounts[0].id;
  }
  throw new Error("No xAI account found or active");
}

export async function handleGrokCouponRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  const { pathname } = url;

  if (pathname === "/api/grok/reset-coupons") {
    if (req.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, req, config);
    }

    const queryAccountId = url.searchParams.get("accountId") ?? undefined;
    let accountId: string;
    try {
      accountId = resolveTargetAccountId(queryAccountId);
    } catch (err) {
      return jsonResponse(
        { error: { code: "no_account", message: err instanceof Error ? err.message : String(err) } },
        400,
        req,
        config,
      );
    }

    let tokenSnapshot;
    try {
      tokenSnapshot = await getValidAccessSnapshotForAccount("xai", accountId, { requireUsableAccount: true });
    } catch (err) {
      return jsonResponse(
        { error: { code: "auth_failed", message: "Failed to resolve valid xAI credentials for account" } },
        401,
        req,
        config,
      );
    }

    try {
      const remainingResult = await getGrokRemainingResets({
        accessToken: tokenSnapshot.accessToken,
      });

      const payload: GrokResetCouponsResponse = {
        accountId,
        tokens: remainingResult.tokens.map((t) => ({
          tokenId: t.tokenId,
          validityStart: t.validityStart,
          validityEnd: t.validityEnd,
        })),
        remaining: remainingResult.tokens.length,
      };

      return jsonResponse(payload, 200, req, config);
    } catch (err) {
      return jsonResponse(
        { error: { code: "upstream_error", message: err instanceof Error ? err.message : String(err) } },
        502,
        req,
        config,
      );
    }
  }

  if (pathname === "/api/grok/reset-coupons/consume") {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, req, config);
    }

    let body: GrokConsumeCouponRequestBody;
    try {
      body = (await req.json()) as GrokConsumeCouponRequestBody;
    } catch {
      return jsonResponse({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400, req, config);
    }

    const { accountId: rawAccountId, tokenId: requestedTokenId, operationId } = body;

    if (requestedTokenId !== undefined && (typeof requestedTokenId !== "string" || requestedTokenId.trim() === "")) {
      return jsonResponse({ error: { code: "invalid_token_id", message: "tokenId must be a non-empty string" } }, 400, req, config);
    }

    if (operationId !== undefined && !isCodexResetCreditOperationId(operationId)) {
      return jsonResponse(
        { error: { code: "invalid_operation_id", message: "operationId must be a valid UUIDv4" } },
        400,
        req,
        config,
      );
    }

    let recordedAccountId: string | undefined;
    if (rawAccountId === undefined && operationId !== undefined) {
      try { recordedAccountId = getGrokResetCouponOperationAccountId(operationId); }
      catch {
        return jsonResponse({ error: { code: "ledger_unavailable", message: "Coupon ledger could not be read or locked; no redemption was attempted" } }, 503, req, config);
      }
    }
    let accountId: string;
    try {
      accountId = resolveTargetAccountId(rawAccountId ?? recordedAccountId);
    } catch (err) {
      return jsonResponse(
        { error: { code: "no_account", message: err instanceof Error ? err.message : String(err) } },
        400,
        req,
        config,
      );
    }

    let tokenSnapshot;
    try {
      tokenSnapshot = await getValidAccessSnapshotForAccount("xai", accountId, { requireUsableAccount: true });
    } catch (err) {
      return jsonResponse(
        { error: { code: "auth_failed", message: "Failed to resolve valid xAI credentials for account" } },
        401,
        req,
        config,
      );
    }

    // Journaling and Idempotency settlement check
    const effectiveOpId = operationId ?? crypto.randomUUID();
    if (grokCouponInFlightAttempts.has(effectiveOpId)) return jsonResponse({ error: {
      code: "attempt_in_progress", message: "This operation still has an active request; retry later",
    } }, 409, req, config);
    let opRecord: GrokResetCouponOperationRecord;
    try {
      opRecord = openGrokResetCouponOperation({ accountId, tokenId: requestedTokenId, operationId: effectiveOpId });
    } catch {
      return jsonResponse({ error: { code: "ledger_unavailable", message: "Coupon ledger could not be read or locked; no redemption was attempted" } }, 503, req, config);
    }

    let resolvedTokenId = requestedTokenId ?? opRecord.tokenId;
    let resolvedTokenValidityEnd: number | undefined;

    if (opRecord.kind === "replay") {
      if (opRecord.code !== undefined) {
        return jsonResponse(
          {
            code: opRecord.code,
            replayed: true,
            tokenId: opRecord.tokenId,
            settledAt: opRecord.settledAt,
          },
          200,
          req,
          config,
        );
      }
      if (opRecord.tokenId === undefined) {
        // Legacy opens may already have dispatched without recording a token.
        return jsonResponse({ operationId: effectiveOpId, error: {
          code: "attempt_unresolved", message: "The prior operation has no recorded token; preserve this operationId and do not create a replacement attempt",
        } }, 409, req, config);
      }
      // "attempted" with no recorded outcome: the spend call fired (or the
      // process died right after the mark) but nothing was settled. Never
      // replay this as a success — reconcile against upstream instead. A
      // Remaining-token availability cannot identify the original request's
      // outcome, and a listed token cannot rule out delayed completion.
      if (requestedTokenId !== undefined && requestedTokenId !== opRecord.tokenId) {
        // The retry names a different coupon than the one marked: spending
        // either of them would surprise the caller — refuse and let them
        // retry with the recorded token and preserve the operationId.
        return jsonResponse(
          {
            error: {
              code: "operation_token_mismatch",
              message: "Operation was attempted with a different coupon; preserve the operationId and retry with the recorded tokenId",
            },
          },
          409,
          req,
          config,
        );
      }
      if (
        opRecord.attemptedAt === undefined ||
        Date.now() - opRecord.attemptedAt < GROK_COUPON_ATTEMPT_STALE_MS
      ) {
        // A fresh attempt may still be in flight in the original request —
        // no additional upstream inspection is needed until that window ends.
        // Older attempts are inspected without another redemption.
        return jsonResponse(
          { operationId: effectiveOpId,
            error: {
              code: "attempt_in_progress",
              message: "A redemption attempt for this operation is recent and may still be running; retry later",
            },
          },
          409,
          req,
          config,
        );
      }
      let remainingTokens: GrokResetCoupon[];
      try {
        const remaining = await getGrokRemainingResets({ accessToken: tokenSnapshot.accessToken });
        remainingTokens = remaining.tokens;
      } catch (err) {
        return jsonResponse(
          { operationId: effectiveOpId, error: { code: "attempt_reconcile_failed", message: err instanceof Error ? err.message : String(err) } },
          502,
          req,
          config,
        );
      }
      // Availability cannot identify which request consumed a coupon. Even a
      // missing, still-valid token does not confirm this operation succeeded.
      const listed = remainingTokens.some((t) => t.tokenId === opRecord.tokenId);
      return jsonResponse({ operationId: effectiveOpId, error: {
        code: "attempt_unresolved",
        message: listed
          ? "The prior redemption may still complete; its listed coupon will not be redeemed again"
          : "The coupon is no longer listed, but this operation's outcome is unconfirmed; no redemption will be repeated",
      } }, 409, req, config);
    }

    if (opRecord.kind === "token-mismatch") return jsonResponse({ error: {
      code: "operation_token_mismatch", message: "Operation ID was previously registered with a different coupon",
    } }, 409, req, config);

    if (opRecord.kind === "identity-mismatch") {
      return jsonResponse(
        {
          error: {
            code: "operation_id_owned_by_another_account",
            message: "Operation ID was previously registered with a different account or token",
          },
        },
        409,
        req,
        config,
      );
    }

    if (opRecord.kind !== "execute") {
      return jsonResponse(
        {
          error: {
            code: opRecord.kind,
            message: "Coupon ledger capacity or unavailable failure",
          },
        },
        503,
        req,
        config,
      );
    }

    const settlePreflightRefusal = (code: string, tokenId?: string): Response | null => {
      try {
        const result = settleGrokResetCouponPreflightRefusal({
          operationId: effectiveOpId, accountId, tokenId, code,
          status: "failed", expectedStatus: "open",
        });
        if (result.kind === "recorded") return null;
        if (result.kind === "replay") return jsonResponse({
          code: result.code, replayed: true, tokenId: result.tokenId, settledAt: result.settledAt,
        }, 200, req, config);
        return jsonResponse({ error: {
          code: "operation_state_changed",
          message: "Another request changed this operation during inspection; retry the same operationId to read its durable state",
        } }, 409, req, config);
      } catch {
        return jsonResponse({ error: {
          code: "ledger_unavailable", message: "Coupon refusal could not be recorded; no redemption was attempted",
        } }, 503, req, config);
      }
    };

    {
      // Always consult the upstream list: it resolves the token when the
      // caller omits one, and — for an explicit tokenId — proves the coupon
      // still exists. Captured validity remains journal metadata, never proof
      // that this operation succeeded during a later reconciliation.
      let tokens: GrokResetCoupon[];
      try {
        const remaining = await getGrokRemainingResets({ accessToken: tokenSnapshot.accessToken });
        tokens = remaining.tokens ?? [];
      } catch (err) {
        return jsonResponse(
          { error: { code: "fetch_resets_failed", message: err instanceof Error ? err.message : String(err) } },
          502,
          req,
          config,
        );
      }
      if (!resolvedTokenId) {
        if (tokens.length === 0) {
          const changed = settlePreflightRefusal("no_coupons_available");
          if (changed) return changed;
          return jsonResponse(
            { error: { code: "no_coupons_available", message: "No reset coupons available to redeem" } },
            400,
            req,
            config,
          );
        }
        resolvedTokenId = tokens[0].tokenId;
      }
      const match = tokens.find((t) => t.tokenId === resolvedTokenId);
      if (!match) {
        // The requested coupon is already consumed or expired upstream —
        // redeeming it would only surface an upstream error.
        const changed = settlePreflightRefusal("coupon_unavailable", resolvedTokenId);
        if (changed) return changed;
        return jsonResponse(
          {
            error: {
              code: "coupon_unavailable",
              message: "The requested reset coupon is no longer available upstream",
            },
          },
          409,
          req,
          config,
        );
      }
      const parsedEnd = Date.parse(match.validityEnd);
      if (!Number.isNaN(parsedEnd)) resolvedTokenValidityEnd = parsedEnd;
    }

    if (resolvedTokenId === undefined) {
      // Unreachable: every path above either resolves a token or returns.
      return jsonResponse(
        { error: { code: "token_unresolved", message: "No reset coupon token could be resolved" } },
        500,
        req,
        config,
      );
    }

    if (grokCouponInFlightAttempts.has(effectiveOpId)) {
      // The original request holding this operation is still running in this
      // process — its upstream spend has not concluded, so nothing may spend
      // on this operationId again regardless of how stale the mark looks.
      return jsonResponse(
        {
          error: {
            code: "attempt_in_progress",
            message: "A redemption attempt for this operation is still running; retry later",
          },
        },
        409,
        req,
        config,
      );
    }

    grokCouponInFlightAttempts.add(effectiveOpId);
    try {
      // Record the attempt BEFORE the spend call: a crash between redemption
      // and settlement must still leave the operation non-open so a retry can
      // never execute it again. The atomic claim admits exactly one contender;
      // a failed mark write aborts here while nothing has been spent.
      try {
        const claimed = markGrokResetCouponAttempt(effectiveOpId, resolvedTokenId, undefined, undefined, resolvedTokenValidityEnd);
        if (!claimed) {
          // A concurrent request may already have reached a definitive outcome;
          // replay it rather than holding the caller on a finished operation.
          // A failed read proves nothing about the winner, so it stays uncertain:
          // reporting a definitive error here would let the caller open a
          // replacement operation while this one may already have spent.
          let winner: ReturnType<typeof readGrokResetCouponTerminalReplay> = null;
          try { winner = readGrokResetCouponTerminalReplay(effectiveOpId, accountId, resolvedTokenId); } catch { winner = null; }
          if (winner) return jsonResponse({
            code: winner.code, replayed: true, tokenId: winner.tokenId, settledAt: winner.settledAt,
          }, 200, req, config);
          return jsonResponse({ error: {
            code: "attempt_in_progress", message: "Another request already claimed this operation; no redemption was attempted",
          } }, 409, req, config);
        }
      } catch (err) {
        return jsonResponse(
          { error: { code: "attempt_mark_failed", message: err instanceof Error ? err.message : String(err) } },
          500,
          req,
          config,
        );
      }

      try {
        await redeemGrokResetCoupon({
          accessToken: tokenSnapshot.accessToken,
          tokenId: resolvedTokenId,
        });
      } catch (err) {
        // A transport error cannot prove that the irreversible request failed.
        // Keep "attempted" so a later retry can inspect without dispatching again.
        return jsonResponse(
          { operationId: effectiveOpId, accountId, tokenId: resolvedTokenId, error: {
            code: "attempt_unresolved",
            message: "Redemption delivery is unconfirmed; reuse this operationId to inspect its state and do not create a replacement attempt",
          } },
          502,
          req,
          config,
        );
      }

      // A confirmed redemption remains successful even when settlement fails.
      // The existing claim protects retries if settlement does not land.
      let settlementRecorded = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          settlementRecorded = recordGrokResetCouponSettlement({
            operationId: effectiveOpId,
            accountId,
            tokenId: resolvedTokenId,
            code: "redeemed",
            status: "success",
            expectedStatus: "attempted",
          });
          break;
        } catch (error) {
          // Retry only transient acquisition contention, never an unsafe or
          // unreadable ledger, a changed claim, or the upstream redemption.
          const cause = error instanceof ConfigMutationLockError ? error.cause : undefined;
          if (!cause || typeof cause !== "object" || !("code" in cause)
            || cause.code !== "SQLITE_BUSY" || attempt === 4) break;
          await Bun.sleep(20);
        }
      }

      return jsonResponse(
        {
          success: true,
          code: "redeemed",
          replayed: false,
          tokenId: resolvedTokenId,
          accountId,
          operationId: effectiveOpId,
          settlementRecorded,
        },
        200,
        req,
        config,
      );
    } finally {
      grokCouponInFlightAttempts.delete(effectiveOpId);
    }
  }

  return null;
}
