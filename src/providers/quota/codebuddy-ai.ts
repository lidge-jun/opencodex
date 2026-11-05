import type { OAuthCredentials } from "../../oauth/types";
import { codeBuddyAiApi, CodeBuddyAiApiError } from "../../oauth/codebuddy-ai";
import { codeBuddyAiHeaders } from "../codebuddy-ai";
import { parseWorkBuddyCredits, workBuddyCapacity, workBuddyRecord, type WorkBuddyCreditBalance } from "../workbuddy-credit-balance";
import { REQUEST_TIMEOUT_MS } from "../quota-wire";
import { TERMINAL_QUOTA_FAILURE, type ProviderQuotaProbeResult } from "./report-cache";

/** The CodeBuddy and WorkBuddy billing meters share one wire shape. */
function packageEnd(row: Record<string, unknown>): number | undefined {
  const deduction = workBuddyCapacity(row.DeductionEndTime);
  if (deduction && Number.isFinite(new Date(deduction).getTime())) return deduction;
  for (const value of [row.ExpiredTime, row.CycleEndTime]) {
    if (typeof value !== "string") continue;
    const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(" ", "T")}+08:00` : value;
    const parsed = Date.parse(date);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

export function codeBuddyAiExpiringCredits(packages: unknown[], codes: ReadonlySet<string>, now: number): WorkBuddyCreditBalance["expiring"] {
  let at = Infinity, amount = 0;
  for (const raw of packages) {
    const row = workBuddyRecord(raw);
    if (typeof row.PackageCode !== "string" || !codes.has(row.PackageCode) || String(row.CapacityType) === "4") continue;
    const remaining = workBuddyCapacity(row.CycleCapacityRemainPrecise || row.CycleCapacityRemain);
    const end = packageEnd(row);
    if (!remaining || !end || end <= now) continue;
    if (end < at) { at = end; amount = remaining; }
    else if (end === at) amount += remaining;
  }
  return Number.isFinite(at) && Number.isFinite(amount) ? { amount, at } : undefined;
}

async function expiringCredits(summary: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal, now: number) {
  const packages = Array.isArray(summary.Packages) ? summary.Packages : [];
  const codes = [...new Set(packages.map(raw => workBuddyRecord(raw).PackageCode)
    .filter((code): code is string => typeof code === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(code)))];
  if (!codes.length) return undefined;
  const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const lists = await Promise.all(["paid", "free"].map(async kind => {
    const accounts: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await codeBuddyAiApi(`/billing/meter/get-user-resource-${kind}-packages`, headers, signal, true, {
        PageNumber: page, PageSize: 200, Status: [0, 3], PackageCodes: codes,
        ...(kind === "paid" ? { NeedRenewInfo: true }
          : { SlicePeriodStartTime: `${day} 00:00:00`, SlicePeriodEndTime: `${day} 23:59:59` }),
      });
      if (!Array.isArray(data.Accounts) || data.Accounts.length > 200) throw new Error("Invalid CodeBuddy package list");
      accounts.push(...data.Accounts);
      const total = workBuddyCapacity(data.TotalCount);
      if (data.Accounts.length < 200 || total !== undefined && accounts.length >= total) return accounts;
    }
    throw new Error("CodeBuddy package list exceeded page limit");
  }));
  return codeBuddyAiExpiringCredits(lists.flat(), new Set(codes), now);
}

export async function fetchCodeBuddyAiQuota(provider: string, credential: OAuthCredentials): Promise<ProviderQuotaProbeResult> {
  if (!credential.codeBuddyAi) return null;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS), now = Date.now();
  try {
    const headers = codeBuddyAiHeaders(credential.access, credential.codeBuddyAi);
    const summary = await codeBuddyAiApi("/billing/meter/get-user-resource-summary", headers, signal, true);
    let credits = parseWorkBuddyCredits(summary);
    if (credential.codeBuddyAi.enterpriseId && (!credits || credits.total === 0)) {
      const team = await codeBuddyAiApi("/billing/meter/get-enterprise-user-usage", headers, signal, true);
      const total = workBuddyCapacity(team.limitNum), used = workBuddyCapacity(team.credit);
      if (total === undefined || used === undefined) return null;
      credits = { total, used, remaining: Math.max(0, total - used), frozen: 0, groups: [] };
    }
    if (!credits) return null;
    if (credits.remaining > 0) {
      // Optional expiry failures must not erase a successful balance reading.
      credits.expiring = await expiringCredits(summary, headers, signal, now).catch(() => undefined);
    }
    const updatedAt = Date.now();
    return { provider, label: "CodeBuddy AI", source: "CodeBuddy credits", updatedAt,
      reverseEngineered: true, quota: { updatedAt, workbuddyCredits: credits } };
  } catch (error) {
    return error instanceof CodeBuddyAiApiError && error.status === 401 ? TERMINAL_QUOTA_FAILURE : null;
  }
}
