import { antigravityUserAgent } from "../adapters/client-fingerprint";
import { antigravityHostCandidates } from "../adapters/google-antigravity-hosts";
import { readProviderQuotaJsonForTests } from "./quota";
import type { ProviderQuota, ProviderQuotaWindow } from "./quota";

const LIVE_QUOTA_PATH = "/v1internal:retrieveUserQuota";
const LIVE_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";

type FetchImpl = typeof fetch;

export interface AntigravityLiveQuotaArgs {
  accessToken: string;
  projectId: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
}

interface QuotaCandidate {
  record: Record<string, unknown>;
  path: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizePercent(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric === undefined ? undefined : Math.max(0, Math.min(100, numeric));
}

function resetAt(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined && numeric > 0) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function remainingPercent(record: Record<string, unknown>): number | undefined {
  const fraction = finiteNumber(record.remainingFraction);
  if (fraction !== undefined) return normalizePercent(fraction * 100);
  const percentage = finiteNumber(
    record.remainingPercentage
      ?? record.remainingPercent
      ?? record.remaining_percent,
  );
  if (percentage !== undefined) return normalizePercent(percentage <= 1 ? percentage * 100 : percentage);
  return undefined;
}

function usedPercent(record: Record<string, unknown>): number | undefined {
  const remaining = remainingPercent(record);
  return remaining === undefined ? undefined : normalizePercent(100 - remaining);
}

function recordResetAt(record: Record<string, unknown>): number | undefined {
  return resetAt(record.resetTime ?? record.resetAt ?? record.resetsAt ?? record.reset_time ?? record.nextReset);
}

function collectCandidates(value: unknown, path: string[] = [], output: QuotaCandidate[] = []): QuotaCandidate[] {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) collectCandidates(item, [...path, String(index)], output);
    return output;
  }
  const record = asRecord(value);
  if (!record) return output;
  output.push({ record, path });
  for (const [key, child] of Object.entries(record)) {
    if (child && typeof child === "object") collectCandidates(child, [...path, key], output);
  }
  return output;
}

function candidateModelName(candidate: QuotaCandidate): string {
  const { record, path } = candidate;
  const explicit = record.modelId ?? record.model_id ?? record.modelName ?? record.model ?? record.name;
  return `${typeof explicit === "string" ? explicit : ""} ${path.join(" ")}`.toLowerCase();
}

function parseGeminiWindow(payload: unknown): ProviderQuotaWindow | undefined {
  for (const candidate of collectCandidates(payload)) {
    if (!candidateModelName(candidate).includes("gemini")) continue;
    const percent = usedPercent(candidate.record);
    if (percent === undefined) continue;
    const reset = recordResetAt(candidate.record);
    return {
      label: "Gem",
      percent,
      ...(reset !== undefined ? { resetAt: reset } : {}),
    };
  }
  return undefined;
}

function isWeeklyPath(path: string[]): boolean {
  return path.some(part => /weekly|week|seven[_-]?day/i.test(part));
}

function parseWeeklyWindow(payload: unknown): { percent: number; resetAt?: number } | undefined {
  const candidates = collectCandidates(payload);
  const ordered = [
    ...candidates.filter(candidate => isWeeklyPath(candidate.path)),
    ...candidates.filter(candidate => !isWeeklyPath(candidate.path)),
  ];
  for (const candidate of ordered) {
    const percent = usedPercent(candidate.record);
    if (percent === undefined) continue;
    const reset = recordResetAt(candidate.record);
    return { percent, ...(reset !== undefined ? { resetAt: reset } : {}) };
  }
  return undefined;
}

async function readJson(response: Response, timeoutMs: number): Promise<unknown> {
  return await readProviderQuotaJsonForTests(response, timeoutMs);
}

async function fetchRpc(
  fetchImpl: FetchImpl,
  host: string,
  method: "retrieveUserQuota" | "retrieveUserQuotaSummary",
  args: AntigravityLiveQuotaArgs,
): Promise<unknown> {
  const path = method === "retrieveUserQuota" ? LIVE_QUOTA_PATH : LIVE_SUMMARY_PATH;
  const response = await fetchImpl(`${host}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
      Authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify({ project: args.projectId }),
    redirect: "error",
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!response.ok) throw new Error(`Antigravity quota RPC failed: ${response.status}`);
  return readJson(response, args.timeoutMs);
}

async function fetchHostQuota(
  fetchImpl: FetchImpl,
  host: string,
  args: AntigravityLiveQuotaArgs,
): Promise<ProviderQuota | null> {
  try {
    const [quotaPayload, summaryPayload] = await Promise.all([
      fetchRpc(fetchImpl, host, "retrieveUserQuota", args),
      fetchRpc(fetchImpl, host, "retrieveUserQuotaSummary", args),
    ]);
    const gem = parseGeminiWindow(quotaPayload);
    const weekly = parseWeeklyWindow(summaryPayload);
    if (!gem && !weekly) return null;
    return {
      ...(gem ? { customWindows: [gem] } : {}),
      ...(weekly ? {
        weeklyPercent: weekly.percent,
        ...(weekly.resetAt !== undefined ? { weeklyResetAt: weekly.resetAt } : {}),
      } : {}),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function fetchAntigravityLiveQuota(
  args: AntigravityLiveQuotaArgs,
): Promise<ProviderQuota | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  for (const host of antigravityHostCandidates(args.baseUrl)) {
    const quota = await fetchHostQuota(fetchImpl, host, args);
    if (quota) return quota;
  }
  return null;
}
