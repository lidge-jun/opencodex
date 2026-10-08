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
import { configuredAnthropicInstance, isAnthropicInstanceId, type AnthropicInstanceId } from "../../providers/anthropic-instance";
import { captureAnthropicPhysicalSendOwnership, anthropicPhysicalSendOwnershipIsCurrent } from "../../oauth/anthropic-send-ownership";
import { anthropicCooldownRecoveryFor } from "../../providers/quota/anthropic-cooldown-recovery";
import { captureProviderAccountQuotaEpoch } from "../../providers/quota/account-cache";
import { captureOAuthAccountSelection, getAccountSet, getAccountCredentialWithStatus, listAccounts } from "../../oauth/store";
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
  anthropicResetJournalPathForInstance,
  beginAnthropicResetOperation,
  pendingAnthropicResetOperation,
  releaseAnthropicResetLease,
  settleAnthropicResetOperation,
} from "../../providers/anthropic-reset-grant-ledger";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MESSAGES = {
  method_not_allowed: "Method not allowed",
  session_required: "Spending a reset requires a dashboard session.",
  invalid_json: "Request body must be JSON.",
  invalid_provider: "No matching builtin Anthropic OAuth provider.",
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
  provider?: AnthropicInstanceId;
  isCurrent?: () => boolean;
  forProvider?: (provider: AnthropicInstanceId) => AnthropicResetGrantRouteDeps;
  fetchFn?: typeof globalThis.fetch;
  journalPath?: string;
  now?: () => number;
  listAccountIds: () => string[];
  activeAccountId: () => string | null;
  accessTokenFor: (accountId: string) => Promise<string>;
}

function defaultDepsFor(ctx: ManagementContext, provider: AnthropicInstanceId): AnthropicResetGrantRouteDeps | null {
  // One source: the live management config. A keeps its legacy reach without a providers row;
  // B requires its configured builtin row. A fresh file load here would refuse on any drift.
  const live = ctx.config;
  const target = live.providers?.[provider];
  if (target?.disabled || target && target.authMode !== "oauth" || configuredAnthropicInstance(live, provider) !== provider) return null;
  const identity = JSON.stringify(target ?? null);
  let owner: ReturnType<typeof captureAnthropicPhysicalSendOwnership> = null;
  const targetCurrent = () => configuredAnthropicInstance(live, provider) === provider
    && JSON.stringify(live.providers?.[provider] ?? null) === identity;
  return {
    // Only the journal path: the ledger's numeric `now` option is not the deps clock function.
    provider, journalPath: anthropicResetJournalPathForInstance(provider),
    listAccountIds: () => listAccounts(provider).map(account => account.id),
    activeAccountId: () => captureOAuthAccountSelection(provider)?.accountId ?? null,
    isCurrent: () => {
      if (!targetCurrent() || !owner || !anthropicPhysicalSendOwnershipIsCurrent(owner)) return false;
      const row = getAccountCredentialWithStatus(provider, owner.accountId);
      return !!row && !row.paused && !row.needsReauth;
    },
    accessTokenFor: async accountId => {
      const initial = getAccountSet(provider)?.accounts.find(row => row.id === accountId);
      const recovery = anthropicCooldownRecoveryFor(provider);
      const incarnation = recovery.reserveAnthropicAccountIncarnation(accountId);
      const epoch = captureProviderAccountQuotaEpoch(provider);
      const snapshot = await getValidAccessSnapshotForAccount(provider, accountId, { requireUsableAccount: true });
      const current = getAccountSet(provider)?.accounts.find(row => row.id === accountId);
      if (!initial || !current || initial.loginId !== current.loginId || initial.addedAt !== current.addedAt
        || recovery.anthropicAccountIncarnation(accountId) !== incarnation || captureProviderAccountQuotaEpoch(provider) !== epoch) throw new Error("reset account replaced");
      owner = captureAnthropicPhysicalSendOwnership(snapshot);
      if (!targetCurrent() || !owner) throw new Error("reset owner changed");
      return snapshot.accessToken;
    },
  };
}

function selectDeps(ctx: ManagementContext, requested: unknown, deps?: AnthropicResetGrantRouteDeps): AnthropicResetGrantRouteDeps | null {
  const provider = requested === undefined || requested === null ? "anthropic" : requested;
  if (!isAnthropicInstanceId(provider)) return null;
  const selected = deps?.forProvider?.(provider) ?? deps;
  // Legacy injected dependencies are A-only; B must explicitly bind its own journal.
  if (selected) return (selected.provider ?? "anthropic") === provider
    ? { journalPath: anthropicResetJournalPathForInstance(provider), ...selected, provider } : null;
  return defaultDepsFor(ctx, provider);
}

function fail(ctx: ManagementContext, status: number, code: ErrorCode, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: { code, message: MESSAGES[code], ...extra } }, status, ctx.req, ctx.config);
}

function ledgerFailure(ctx: ManagementContext, error: unknown, extra: Record<string, unknown> = {}): Response {
  if (error instanceof AnthropicResetLedgerError && error.code === "busy") return fail(ctx, 503, "ledger_busy", extra);
  return fail(ctx, 503, "ledger_unavailable", extra);
}

function readFailure(ctx: ManagementContext, error: unknown, extra: Record<string, unknown> = {}): Response {
  if (error instanceof AnthropicResetGrantError && error.code === "auth") return fail(ctx, 401, "auth_failed", extra);
  return fail(ctx, 502, "upstream_unavailable", extra);
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
  const receipt = { provider: deps.provider };
  const accountId = resolveAccountId(deps, ctx.url.searchParams.get("accountId") ?? undefined);
  if (!accountId) return fail(ctx, 400, "no_account", receipt);
  const accessToken = await tokenFor(deps, accountId);
  if (!accessToken) return fail(ctx, 401, "auth_failed", receipt);
  if (deps.isCurrent?.() === false) return fail(ctx, 401, "auth_failed", receipt);
  let status;
  try {
    status = await fetchAnthropicResetGrantStatus({ accessToken, fetchFn: deps.fetchFn });
  } catch (error) {
    return readFailure(ctx, error, receipt);
  }
  if (deps.isCurrent?.() === false) return fail(ctx, 401, "auth_failed", receipt);
  let pendingOperation = null;
  let journalAvailable = true;
  try {
    pendingOperation = pendingAnthropicResetOperation(accountId, { journalPath: deps.journalPath, now: deps.now?.() });
  } catch {
    journalAvailable = false;
  }
  return jsonResponse({ provider: deps.provider, accountId, ...status, pendingOperation, journalAvailable }, 200, ctx.req, ctx.config);
}

async function handleConsume(ctx: ManagementContext, injected?: AnthropicResetGrantRouteDeps): Promise<Response> {
  if (ctx.principal !== "gui-session") return fail(ctx, 403, "session_required");
  let body: Record<string, unknown>;
  try {
    const parsed = await ctx.req.json() as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(ctx, 400, "invalid_json");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(ctx, 400, "invalid_json");
  }
  const deps = selectDeps(ctx, body.provider, injected);
  if (!deps) return fail(ctx, 400, "invalid_provider");
  const provider = deps.provider;
  const operationReceipt = { provider };
  const scopedFail = (status: number, code: ErrorCode, extra: Record<string, unknown> = {}) => fail(ctx, status, code, { ...operationReceipt, ...extra });
  const { grantId, operationId } = body;
  if (typeof grantId !== "string" || !ANTHROPIC_RESET_GRANT_ID_RE.test(grantId)) return scopedFail(400, "invalid_grant_id");
  if (typeof operationId !== "string" || !UUID_V4_RE.test(operationId)) return scopedFail(400, "invalid_operation_id");
  if (typeof body.accountId !== "string") return scopedFail(400, "no_account");
  const accountId = resolveAccountId(deps, body.accountId);
  if (!accountId) return scopedFail(400, "no_account");

  const accessToken = await tokenFor(deps, accountId);
  if (!accessToken || deps.isCurrent?.() === false) return scopedFail(401, "auth_failed");
  let organizationUuid: string;
  try {
    organizationUuid = await fetchAnthropicOrganizationUuid({ accessToken, fetchFn: deps.fetchFn });
  } catch (error) {
    return readFailure(ctx, error, operationReceipt);
  }
  if (deps.isCurrent?.() === false) return scopedFail(401, "auth_failed");
  const ledger = { journalPath: deps.journalPath, now: deps.now?.() };

  // A new operation must pass the spend gate on a fresh read. A same-id retry of
  // an open record skips it: that attempt was already gated, and upstream
  // answers a repeated request id for itself.
  let known: boolean;
  try {
    known = anthropicResetOperationExists(operationId, ledger);
  } catch (error) {
    return ledgerFailure(ctx, error, operationReceipt);
  }
  if (!known) {
    let status;
    try {
      status = await fetchAnthropicResetGrantStatus({ accessToken, fetchFn: deps.fetchFn });
    } catch (error) {
      return readFailure(ctx, error, operationReceipt);
    }
    const blocker = anthropicResetGrantBlocker(status, grantId);
    if (blocker) return scopedFail(409, "grant_not_usable", { reason: blocker });
  }

  let begin;
  if (deps.isCurrent?.() === false) return scopedFail(401, "auth_failed");
  try {
    begin = beginAnthropicResetOperation(
      { operationId, accountId, grantId, orgDigest: anthropicOrgDigest(organizationUuid) },
      { journalPath: deps.journalPath, now: deps.now?.() },
    );
  } catch (error) {
    return ledgerFailure(ctx, error, operationReceipt);
  }
  switch (begin.kind) {
    case "replay":
      return jsonResponse(
        { provider, code: begin.code, replayed: true, resetsLeft: begin.resetsLeft, accountId, grantId, operationId },
        200, ctx.req, ctx.config,
      );
    case "identity-mismatch": return scopedFail(409, "operation_identity_mismatch");
    case "in-flight": return scopedFail(409, "in_flight");
    case "expired": return scopedFail(409, "unknown_outcome_expired");
    case "unresolved-prior": return scopedFail(409, "unresolved_prior_operation", { pendingOperationId: begin.operationId });
    case "capacity": return scopedFail(503, "ledger_capacity");
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
    return scopedFail(502, "unknown_outcome", { operationId, grantId, accountId });
  }
  let settled;
  try {
    settled = settleAnthropicResetOperation(
      { operationId, code: answer.code, resetsLeft: answer.resetsLeft },
      { journalPath: deps.journalPath, now: deps.now?.() },
    );
  } catch {
    // Fail closed: the caller must not read this as a durable result.
    return scopedFail(500, "journal_write_failed", { operationId, grantId, accountId });
  }
  // Report what the journal holds. An overlapping same-id attempt may have
  // settled first; its answer is the canonical one.
  const replayed = settled.code !== answer.code || settled.resetsLeft !== answer.resetsLeft;
  return jsonResponse(
    {
      provider,
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
  deps?: AnthropicResetGrantRouteDeps,
): Promise<Response | null> {
  const { pathname } = ctx.url;
  if (pathname === "/api/anthropic/reset-grants") {
    if (ctx.req.method !== "GET") return fail(ctx, 405, "method_not_allowed");
    const selected = selectDeps(ctx, ctx.url.searchParams.get("provider"), deps);
    return selected ? handleRead(ctx, selected) : fail(ctx, 400, "invalid_provider");
  }
  if (pathname === "/api/anthropic/reset-grants/consume") {
    if (ctx.req.method !== "POST") return fail(ctx, 405, "method_not_allowed");
    return handleConsume(ctx, deps);
  }
  return null;
}
