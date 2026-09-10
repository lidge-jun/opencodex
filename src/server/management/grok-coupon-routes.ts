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
import { isCodexResetCreditOperationId } from "../../codex/reset-credit-recovery";
import { getValidAccessSnapshotForAccount } from "../../oauth";
import { listAccounts, captureOAuthAccountSelection } from "../../oauth/store";
import {
  getGrokRemainingResets,
  redeemGrokResetCoupon,
  type GrokResetCoupon,
} from "../../grok/reset-coupons";
import {
  openGrokResetCouponOperation,
  recordGrokResetCouponSettlement,
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

    if (operationId !== undefined && !isCodexResetCreditOperationId(operationId)) {
      return jsonResponse(
        { error: { code: "invalid_operation_id", message: "operationId must be a valid UUIDv4" } },
        400,
        req,
        config,
      );
    }

    let accountId: string;
    try {
      accountId = resolveTargetAccountId(rawAccountId);
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
    const opRecord = openGrokResetCouponOperation({
      accountId,
      tokenId: requestedTokenId,
      operationId: effectiveOpId,
    });

    if (opRecord.kind === "replay") {
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

    let resolvedTokenId = requestedTokenId;
    if (!resolvedTokenId) {
      try {
        const remaining = await getGrokRemainingResets({ accessToken: tokenSnapshot.accessToken });
        if (!remaining.tokens || remaining.tokens.length === 0) {
          recordGrokResetCouponSettlement({
            operationId: effectiveOpId,
            code: "no_coupons_available",
            status: "failed",
          });
          return jsonResponse(
            { error: { code: "no_coupons_available", message: "No reset coupons available to redeem" } },
            400,
            req,
            config,
          );
        }
        resolvedTokenId = remaining.tokens[0].tokenId;
      } catch (err) {
        return jsonResponse(
          { error: { code: "fetch_resets_failed", message: err instanceof Error ? err.message : String(err) } },
          502,
          req,
          config,
        );
      }
    }

    try {
      const redeemResult = await redeemGrokResetCoupon({
        accessToken: tokenSnapshot.accessToken,
        tokenId: resolvedTokenId,
      });

      recordGrokResetCouponSettlement({
        operationId: effectiveOpId,
        tokenId: resolvedTokenId,
        code: "redeemed",
        status: "success",
      });

      return jsonResponse(
        {
          success: true,
          code: "redeemed",
          replayed: false,
          tokenId: resolvedTokenId,
          accountId,
          operationId: effectiveOpId,
        },
        200,
        req,
        config,
      );
    } catch (err) {
      recordGrokResetCouponSettlement({
        operationId: effectiveOpId,
        tokenId: resolvedTokenId,
        code: "redeem_failed",
        status: "failed",
      });
      return jsonResponse(
        { error: { code: "redeem_failed", message: err instanceof Error ? err.message : String(err) } },
        502,
        req,
        config,
      );
    }
  }

  return null;
}
