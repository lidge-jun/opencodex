/**
 * Management API for Anthropic OAuth usage-limit reset grants.
 *
 *   GET  /api/anthropic/reset-grants?accountId=...        read one account's grants
 *   POST /api/anthropic/reset-grants/consume              spend one grant
 *
 * Spending uses the user's own subscription benefit, so the POST requires the
 * dashboard session principal (AGENTS.md, "User-consent actions"); the admin token
 * alone is refused. Responses carry fixed codes and fixed messages only: no
 * upstream body, exception text, token, organization id, or email. Nothing here
 * logs. Lazy-loaded by `handleAnthropicResetGrantRoutesOnDemand` in
 * management-api.ts so the core request path never imports it.
 */
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { getValidAccessSnapshotForAccount } from "../../oauth";
import { captureOAuthAccountSelection, listAccounts } from "../../oauth/store";
import {
  ANTHROPIC_RESET_GRANT_ID_RE,
  AnthropicResetGrantError,
  AnthropicResetGrantUnknownOutcome,
  anthropicResetGrantBlocker,
  claimAnthropicResetGrant,
  fetchAnthropicOrganizationUuid,
  fetchAnthropicResetGrantStatus,
} from "../../providers/anthropic-reset-grants";
import {
  AnthropicResetLedgerError,
  anthropicOrgDigest,
  anthropicResetOperationExists,
  beginAnthropicResetOperation,
  pendingAnthropicResetOperation,
  releaseAnthropicResetLease,
  settleAnthropicResetOperation,
} from "../../providers/anthropic-reset-grant-ledger";

const PROVIDER = "anthropic";
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MESSAGES = {
  method_not_allowed: "Method not allowed",
  session_required: "Spending a reset requires a dashboard session.",
  invalid_json: "Request body must be JSON.",
  invalid_grant_id: "grantId is missing or malformed.",
  invalid_operation_id: "operationId must be a UUIDv4.",
  no_account: "No matching Anthropic OAuth account.",
  auth_failed: "Sign in to this Anthropic account again.",
  upstream_unavailable: "Anthropic did not return the reset-grant status.",
  grant_not_usable: "This reset grant cannot be used right now.",
  operation_identity_mismatch: "This operation belongs to another account or grant.",
  in_flight: "This reset is still being processed.",
  unresolved_prior_operation: "An earlier reset attempt for this grant is not confirmed yet.",
  unknown_outcome_expired: "This attempt can no longer be retried; re-read the account.",
  unknown_outcome: "The reset did not answer; its outcome is unknown.",
  journal_write_failed: "The reset answered but could not be recorded; its outcome is unknown here.",
  ledger_busy: "The reset journal is busy. Nothing was used.",
  ledger_unavailable: "The reset journal is unavailable. Nothing was used.",
  ledger_capacity: "The reset journal is full. Nothing was used.",
} as const;
type ErrorCode = keyof typeof MESSAGES;

export interface AnthropicResetGrantRouteDeps {
  fetchFn?: typeof globalThis.fetch;
  journalPath?: string;
  now?: () => number;
  listAccountIds: () => string[];
  activeAccountId: () => string | null;
  accessTokenFor: (accountId: string) => Promise<string>;
}

const defaultDeps: AnthropicResetGrantRouteDeps = {
  listAccountIds: () => listAccounts(PROVIDER).map(account => account.id),
  activeAccountId: () => captureOAuthAccountSelection(PROVIDER)?.accountId ?? null,
  accessTokenFor: async accountId =>
    (await getValidAccessSnapshotForAccount(PROVIDER, accountId, { requireUsableAccount: true })).accessToken,
};

function fail(ctx: ManagementContext, status: number, code: ErrorCode, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: { code, message: MESSAGES[code], ...extra } }, status, ctx.req, ctx.config);
}

function ledgerFailure(ctx: ManagementContext, error: unknown): Response {
  if (error instanceof AnthropicResetLedgerError && error.code === "busy") return fail(ctx, 503, "ledger_busy");
  return fail(ctx, 503, "ledger_unavailable");
}

function readFailure(ctx: ManagementContext, error: unknown): Response {
  if (error instanceof AnthropicResetGrantError && error.code === "auth") return fail(ctx, 401, "auth_failed");
  return fail(ctx, 502, "upstream_unavailable");
}

function resolveAccountId(deps: AnthropicResetGrantRouteDeps, requested: unknown): string | null {
  const ids = deps.listAccountIds();
  if (typeof requested === "string" && requested.trim() !== "") {
    return ids.includes(requested.trim()) ? requested.trim() : null;
  }
  const active = deps.activeAccountId();
  return active && ids.includes(active) ? active : ids[0] ?? null;
}

async function tokenFor(deps: AnthropicResetGrantRouteDeps, accountId: string): Promise<string | null> {
  try {
    return await deps.accessTokenFor(accountId);
  } catch {
    return null;
  }
}

async function handleRead(ctx: ManagementContext, deps: AnthropicResetGrantRouteDeps): Promise<Response> {
  const accountId = resolveAccountId(deps, ctx.url.searchParams.get("accountId") ?? undefined);
  if (!accountId) return fail(ctx, 400, "no_account");
  const accessToken = await tokenFor(deps, accountId);
  if (!accessToken) return fail(ctx, 401, "auth_failed");
  let status;
  try {
    status = await fetchAnthropicResetGrantStatus({ accessToken, fetchFn: deps.fetchFn });
  } catch (error) {
    return readFailure(ctx, error);
  }
  let pendingOperation = null;
  let journalAvailable = true;
  try {
    pendingOperation = pendingAnthropicResetOperation(accountId, { journalPath: deps.journalPath, now: deps.now?.() });
  } catch {
    journalAvailable = false;
  }
  return jsonResponse({ accountId, ...status, pendingOperation, journalAvailable }, 200, ctx.req, ctx.config);
}

async function handleConsume(ctx: ManagementContext, deps: AnthropicResetGrantRouteDeps): Promise<Response> {
  if (ctx.principal !== "gui-session") return fail(ctx, 403, "session_required");
  let body: Record<string, unknown>;
  try {
    const parsed = await ctx.req.json() as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(ctx, 400, "invalid_json");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(ctx, 400, "invalid_json");
  }
  const { grantId, operationId } = body;
  if (typeof grantId !== "string" || !ANTHROPIC_RESET_GRANT_ID_RE.test(grantId)) return fail(ctx, 400, "invalid_grant_id");
  if (typeof operationId !== "string" || !UUID_V4_RE.test(operationId)) return fail(ctx, 400, "invalid_operation_id");
  if (typeof body.accountId !== "string") return fail(ctx, 400, "no_account");
  const accountId = resolveAccountId(deps, body.accountId);
  if (!accountId) return fail(ctx, 400, "no_account");

  const accessToken = await tokenFor(deps, accountId);
  if (!accessToken) return fail(ctx, 401, "auth_failed");
  let organizationUuid: string;
  try {
    organizationUuid = await fetchAnthropicOrganizationUuid({ accessToken, fetchFn: deps.fetchFn });
  } catch (error) {
    return readFailure(ctx, error);
  }
  const ledger = { journalPath: deps.journalPath, now: deps.now?.() };

  // A new operation must pass the spend gate on a fresh read. A same-id retry of
  // an open record skips it: that attempt was already gated, and upstream
  // answers a repeated request id for itself.
  let known: boolean;
  try {
    known = anthropicResetOperationExists(operationId, ledger);
  } catch (error) {
    return ledgerFailure(ctx, error);
  }
  if (!known) {
    let status;
    try {
      status = await fetchAnthropicResetGrantStatus({ accessToken, fetchFn: deps.fetchFn });
    } catch (error) {
      return readFailure(ctx, error);
    }
    const blocker = anthropicResetGrantBlocker(status, grantId);
    if (blocker) return fail(ctx, 409, "grant_not_usable", { reason: blocker });
  }

  let begin;
  try {
    begin = beginAnthropicResetOperation(
      { operationId, accountId, grantId, orgDigest: anthropicOrgDigest(organizationUuid) },
      { journalPath: deps.journalPath, now: deps.now?.() },
    );
  } catch (error) {
    return ledgerFailure(ctx, error);
  }
  switch (begin.kind) {
    case "replay":
      return jsonResponse(
        { code: begin.code, replayed: true, resetsLeft: begin.resetsLeft, accountId, grantId, operationId },
        200, ctx.req, ctx.config,
      );
    case "identity-mismatch": return fail(ctx, 409, "operation_identity_mismatch");
    case "in-flight": return fail(ctx, 409, "in_flight");
    case "expired": return fail(ctx, 409, "unknown_outcome_expired");
    case "unresolved-prior": return fail(ctx, 409, "unresolved_prior_operation", { pendingOperationId: begin.operationId });
    case "capacity": return fail(ctx, 503, "ledger_capacity");
    case "execute": break;
  }

  let answer;
  try {
    answer = await claimAnthropicResetGrant({
      accessToken, organizationUuid, grantId, requestId: operationId, fetchFn: deps.fetchFn,
    });
  } catch {
    try {
      releaseAnthropicResetLease(operationId, { journalPath: deps.journalPath, now: deps.now?.() });
    } catch { /* the lease expires on its own */ }
    return fail(ctx, 502, "unknown_outcome", { operationId, grantId });
  }
  let settled;
  try {
    settled = settleAnthropicResetOperation(
      { operationId, code: answer.code, resetsLeft: answer.resetsLeft },
      { journalPath: deps.journalPath, now: deps.now?.() },
    );
  } catch {
    // Fail closed: the caller must not read this as a durable result.
    return fail(ctx, 500, "journal_write_failed", { operationId, grantId });
  }
  // Report what the journal holds. An overlapping same-id attempt may have
  // settled first; its answer is the canonical one.
  const replayed = settled.code !== answer.code || settled.resetsLeft !== answer.resetsLeft;
  return jsonResponse(
    {
      code: settled.code,
      replayed,
      resetsLeft: settled.resetsLeft,
      cleared: replayed ? [] : answer.cleared,
      accountId,
      grantId,
      operationId,
    },
    200, ctx.req, ctx.config,
  );
}

export async function handleAnthropicResetGrantRoutes(
  ctx: ManagementContext,
  deps: AnthropicResetGrantRouteDeps = defaultDeps,
): Promise<Response | null> {
  const { pathname } = ctx.url;
  if (pathname === "/api/anthropic/reset-grants") {
    if (ctx.req.method !== "GET") return fail(ctx, 405, "method_not_allowed");
    return handleRead(ctx, deps);
  }
  if (pathname === "/api/anthropic/reset-grants/consume") {
    if (ctx.req.method !== "POST") return fail(ctx, 405, "method_not_allowed");
    return handleConsume(ctx, deps);
  }
  return null;
}
