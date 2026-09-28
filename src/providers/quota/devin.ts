/**
 * Devin (Cognition) account quota from `SeatManagementService/GetUserStatus`.
 *
 * Cognition has no REST usage endpoint; plan, credit balances and the dated quota windows
 * all come back from this one unary Connect RPC. The request carries the long-lived api_key
 * inside the protobuf Metadata, so the host passes the same allowlist every other Devin RPC
 * uses, redirects are refused, and no response body is ever echoed.
 *
 * Field map, confirmed against a live account:
 *
 *   GetUserStatusResponse { #1 UserStatus, #2 PlanInfo }
 *   UserStatus            { #10 teams_tier, #13 PlanStatus }
 *   PlanStatus            { #1 PlanInfo, #3 plan_end (Timestamp),
 *                           #4 available_flex, #5 used_flow, #6 used_prompt, #7 used_flex,
 *                           #8 available_prompt, #9 available_flow (int32; -1 = unlimited),
 *                           #14 daily_remaining_percent, #15 weekly_remaining_percent,
 *                           #16 overage_balance_micros (int64, may be negative),
 *                           #17 daily_reset_unix, #18 weekly_reset_unix }
 *   PlanInfo              { #1 teams_tier, #2 plan_name, #13 monthly_flow, #35 billing_strategy,
 *                           #36 hide_daily_quota, #37 hide_weekly_quota }
 */
import { buildMetadata } from "../../adapters/devin/cloud-direct/metadata";
import { encodeMessage } from "../../adapters/devin/cloud-direct/wire";
import { resolveDevinApiBaseUrl, validateDevinApiBaseUrl } from "../../oauth/devin/api-base";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { epochMillis, QUOTA_RESPONSE_MAX_BYTES, REQUEST_TIMEOUT_MS } from "../quota-wire";
import type { ProviderQuota, ProviderQuotaWindow } from "../quota-types";
import { AUTHORITATIVE_EMPTY_QUOTA, report, TERMINAL_QUOTA_FAILURE, type ProviderQuotaProbeResult } from "./report-cache";

const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const BILLING_STRATEGY_CREDITS = 1;
const RESPONSE_WIRES = new Map([[1, 2], [2, 2]]);
const USER_WIRES = new Map([[10, 0], [13, 2]]);
const STATUS_WIRES = new Map<number, number>([[1, 2], [3, 2], ...[4, 5, 6, 7, 8, 9, 14, 15, 16, 17, 18].map(n => [n, 0] as const)]);
const PLAN_WIRES = new Map([[1, 0], [2, 2], [13, 0], [35, 0], [36, 0], [37, 0]]);
const TIMESTAMP_WIRES = new Map([[1, 0], [2, 0]]);

export interface DevinPlanInfo {
  teamsTier: number;
  planName: string;
  monthlyFlowCredits: number;
  billingStrategy: number;
  hideDailyQuota: boolean;
  hideWeeklyQuota: boolean;
}

export interface DevinUserStatus {
  plan: DevinPlanInfo;
  planEndMs?: number;
  usedPromptCredits: number;
  availablePromptCredits: number;
  usedFlowCredits: number;
  availableFlowCredits: number;
  usedFlexCredits: number;
  availableFlexCredits: number;
  dailyRemainingPercent: number;
  weeklyRemainingPercent: number;
  dailyResetMs?: number;
  weeklyResetMs?: number;
  overageBalanceMicros: number;
  promptCreditBalancePresent: boolean;
}

type Fields = Map<number, bigint | Buffer>;

/**
 * Last occurrence wins. Parse locally so an overlong varint, truncated field, or wrong wire
 * type for a known status field cannot turn a malformed credential-bearing RPC into quota.
 */
function fieldsOf(buf: Buffer | undefined, known: Map<number, number>): Fields | null {
  const out: Fields = new Map();
  if (!buf) return out;
  let offset = 0;
  const varint = (): bigint | null => {
    let value = 0n;
    for (let byte = 0; byte < 10; byte++) {
      if (offset >= buf.length) return null;
      const part = buf[offset++];
      if (byte === 9 && part > 1) return null;
      value |= BigInt(part & 0x7f) << BigInt(byte * 7);
      if (!(part & 0x80)) return value;
    }
    return null;
  };
  while (offset < buf.length) {
    const tag = varint();
    if (tag === null || tag > 0xffffffffn) return null;
    const num = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (num === 0 || (known.has(num) && known.get(num) !== wire)) return null;
    if (wire === 0) {
      const value = varint();
      if (value === null) return null;
      out.set(num, value);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (size > buf.length - offset) return null;
      out.set(num, buf.subarray(offset, offset + size));
      offset += size;
    } else if (wire === 2) {
      const length = varint();
      if (length === null || length > BigInt(buf.length - offset)) return null;
      const end = offset + Number(length);
      out.set(num, buf.subarray(offset, end));
      offset = end;
    } else return null;
  }
  return out;
}

/** int32/int64 on the wire are two's-complement varints; -1 arrives as 2^64-1. */
function int(fields: Fields, num: number): number {
  const value = fields.get(num);
  return typeof value === "bigint" ? Number(BigInt.asIntN(64, value)) : 0;
}

function sub(fields: Fields, num: number): Buffer | undefined {
  const value = fields.get(num);
  return Buffer.isBuffer(value) ? value : undefined;
}

/** Undefined for an absent timestamp; null for one that is present but malformed. */
function timestampMs(buf: Buffer | undefined): number | undefined | null {
  if (!buf) return undefined;
  const f = fieldsOf(buf, TIMESTAMP_WIRES);
  return f ? epochMillis(int(f, 1)) : null;
}

/** Null when neither plan copy is present: a zero-valued plan would read as an exhausted account. */
function decodePlanInfo(buf: Buffer | undefined): DevinPlanInfo | null {
  if (!buf) return null;
  const f = fieldsOf(buf, PLAN_WIRES);
  if (!f) return null;
  return {
    teamsTier: int(f, 1),
    planName: sub(f, 2)?.toString("utf8").trim() ?? "",
    monthlyFlowCredits: int(f, 13),
    billingStrategy: int(f, 35),
    hideDailyQuota: int(f, 36) === 1,
    hideWeeklyQuota: int(f, 37) === 1,
  };
}

/** Null when the response carries no PlanStatus, which is not something a mapper can use. */
export function decodeDevinUserStatus(buf: Buffer): DevinUserStatus | null {
  const response = fieldsOf(buf, RESPONSE_WIRES);
  const user = response && fieldsOf(sub(response, 1), USER_WIRES);
  const statusBuf = user && sub(user, 13);
  if (!statusBuf) return null;
  const status = fieldsOf(statusBuf, STATUS_WIRES);
  if (!status) return null;
  // The top-level PlanInfo is authoritative; the nested copy covers servers that omit it.
  const plan = decodePlanInfo(sub(response, 2) ?? sub(status, 1));
  if (!plan) return null;
  if (!plan.teamsTier) plan.teamsTier = int(user, 10);
  const planEndMs = timestampMs(sub(status, 3));
  if (planEndMs === null) return null;
  const dailyResetMs = epochMillis(int(status, 17));
  const weeklyResetMs = epochMillis(int(status, 18));
  return {
    plan,
    ...(planEndMs !== undefined ? { planEndMs } : {}),
    usedPromptCredits: int(status, 6),
    availablePromptCredits: int(status, 8),
    usedFlowCredits: int(status, 5),
    availableFlowCredits: int(status, 9),
    usedFlexCredits: int(status, 7),
    availableFlexCredits: int(status, 4),
    dailyRemainingPercent: int(status, 14),
    weeklyRemainingPercent: int(status, 15),
    ...(dailyResetMs !== undefined ? { dailyResetMs } : {}),
    ...(weeklyResetMs !== undefined ? { weeklyResetMs } : {}),
    overageBalanceMicros: int(status, 16),
    // proto3 omits a zero balance, so an exhausted pool arrives as `used` alone. Only a
    // status with no balance field at all carries no credit evidence.
    promptCreditBalancePresent: [4, 6, 7, 8].some((field) => status.has(field)),
  };
}

function usedPercent(used: number, available: number): number | undefined {
  // A negative balance is the unlimited sentinel; nothing to measure against.
  if (available < 0 || used < 0 || used + available <= 0) return undefined;
  return Math.min(100, (used / (used + available)) * 100);
}

function remainingToUsed(remaining: number): number {
  return 100 - Math.max(0, Math.min(100, remaining));
}

/**
 * Only DATED percent windows whose reset is still ahead are published. A credit-billed plan
 * leaves the percent fields at their zero default, and a reset already in the past describes
 * a window that has rolled over; either would read as a fully spent window and mark the
 * account exhausted for routing.
 *
 * The credit pool is published only for a credit-billed plan, or for an unknown strategy
 * with both reset fields absent. Expired dated windows still identify a quota plan.
 * A quota-billed plan still reports credit balances, and a zero balance there does not
 * gate anything.
 *
 * Flow credits are decoded but not published. They meter agent tool actions, not chat
 * turns, and account ranking reads the fullest custom window as the account's limit, so an
 * empty flow balance would retire an account that can still serve chat.
 *
 * Credits are measured against the server's own balance rather than the plan grant, so
 * top-ups count. Flex credits back prompt credits once those run out, so both share one
 * pool: an account with prompt credits spent and flex remaining can still serve.
 */
export function devinQuotaFromStatus(status: DevinUserStatus, now = Date.now()): ProviderQuota {
  const quota: ProviderQuota = { updatedAt: now };
  const customWindows: ProviderQuotaWindow[] = [];
  const ahead = (resetMs: number | undefined): resetMs is number => resetMs !== undefined && resetMs > now;
  if (!status.plan.hideDailyQuota && ahead(status.dailyResetMs)) {
    customWindows.push({ label: "Daily", percent: remainingToUsed(status.dailyRemainingPercent), resetAt: status.dailyResetMs });
  }
  if (!status.plan.hideWeeklyQuota && ahead(status.weeklyResetMs)) {
    quota.weeklyPercent = remainingToUsed(status.weeklyRemainingPercent);
    quota.weeklyResetAt = status.weeklyResetMs;
  }
  const strategy = status.plan.billingStrategy;
  const creditBilled = strategy === BILLING_STRATEGY_CREDITS
    || (strategy === 0 && status.dailyResetMs === undefined && status.weeklyResetMs === undefined);
  const available = status.availablePromptCredits + status.availableFlexCredits;
  const credits = !creditBilled || !status.promptCreditBalancePresent
    || status.availablePromptCredits < 0 || status.availableFlexCredits < 0
    || status.usedPromptCredits < 0 || status.usedFlexCredits < 0
    ? undefined
    // A credit-billed plan with nothing used and nothing left has no balance to serve from;
    // leaving it unmeasured would rank it as untested headroom.
    : available === 0 ? 100
    : usedPercent(status.usedPromptCredits + status.usedFlexCredits, available);
  if (credits !== undefined) {
    quota.monthlyPercent = credits;
    if (status.planEndMs !== undefined) quota.monthlyResetAt = status.planEndMs;
  }
  if (customWindows.length > 0) quota.customWindows = customWindows;
  return quota;
}

/**
 * Probe one Devin account. `null` keeps the last-good row (transient failure);
 * `TERMINAL_QUOTA_FAILURE` means the credential or contract is rejected.
 */
export async function fetchDevinQuota(provider: string, apiKey: string, apiBaseUrl: string | undefined, configuredBaseUrl?: string): Promise<ProviderQuotaProbeResult> {
  const base = validateDevinApiBaseUrl(apiBaseUrl)
    ?? (configuredBaseUrl !== undefined || apiBaseUrl === undefined ? resolveDevinApiBaseUrl(configuredBaseUrl) : undefined);
  if (!base || !apiKey.trim()) return null;
  const metadata = buildMetadata({
    apiKey,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  try {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`${base}${GET_USER_STATUS_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
      // GetUserStatusRequest { #1 metadata }
      body: new Uint8Array(encodeMessage(1, metadata)),
      // The body carries the api_key; a redirect would replay it at another host.
      redirect: "error",
      signal: deadline,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      // Only 401 proves the key itself is refused. A 403 can scope this one RPC away from a
      // key that still serves chat, so it keeps the last-good reading like other failures.
      return response.status === 401 ? TERMINAL_QUOTA_FAILURE : null;
    }
    const body = await readBoundedResponseBytes(response, {
      signal: deadline,
      maxBytes: QUOTA_RESPONSE_MAX_BYTES,
      inactivityTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (body.oversized) return null;
    // Inside the try: a truncated varint throws, and a malformed body must keep last-good.
    const status = decodeDevinUserStatus(Buffer.from(body.bytes.buffer, body.bytes.byteOffset, body.bytes.byteLength));
    if (!status) return null;
    // A decoded status with nothing measurable (an unlimited plan, hidden windows) is an
    // authoritative answer, not a failed probe, so it must replace any last-good row.
    return report(provider, "devin:user-status", devinQuotaFromStatus(status)) ?? AUTHORITATIVE_EMPTY_QUOTA;
  } catch {
    return null;
  }
}
