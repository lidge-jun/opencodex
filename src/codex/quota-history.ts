import { isValidCodexAccountId } from "./account-id";
import type { PoolQuotaWriter } from "./quota-types";

export const QUOTA_HISTORY_LIMITS = { perAccount: 200, accounts: 64, samples: 4096, bytes: 2 * 1024 * 1024, ageMs: 30 * 86400_000 } as const;
export interface QuotaHistoryWindow {
  family: "account" | "spark";
  window: "short" | "weekly" | "monthly";
  usedPercent: number;
  resetAtMs?: number;
  windowSeconds?: number;
  monthlyIsPrimaryWindow?: boolean;
}
export interface QuotaHistorySample {
  observedAt: number;
  source: "wham" | "response-header";
  credentialGeneration: number;
  windows: QuotaHistoryWindow[];
}
type Envelope = { identity: string; samples: QuotaHistorySample[] };
type Bucket = Envelope & { costs: number[]; overhead: number };
const encoder = new TextEncoder();
const byteSize = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const identityPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Reconstruct allowlisted data at the disk boundary; malformed windows cannot be partial evidence. */
function parseSample(value: unknown, now: number): QuotaHistorySample | undefined {
  if (!record(value) || !finite(value.observedAt) || value.observedAt > now
    || value.observedAt < now - QUOTA_HISTORY_LIMITS.ageMs
    || !Number.isSafeInteger(value.credentialGeneration) || (value.credentialGeneration as number) < 0
    || (value.source !== "wham" && value.source !== "response-header")
    || !Array.isArray(value.windows) || !value.windows.length || value.windows.length > 5) return undefined;
  const windows: QuotaHistoryWindow[] = [];
  const seen = new Set<string>();
  for (const item of value.windows) {
    if (!record(item) || (item.family !== "account" && item.family !== "spark")
      || (item.window !== "short" && item.window !== "weekly" && item.window !== "monthly")
      || (item.family === "spark" && item.window === "monthly")
      || !finite(item.usedPercent) || item.usedPercent > 100) return undefined;
    const key = `${item.family}:${item.window}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if ((item.resetAtMs !== undefined && !finite(item.resetAtMs))
      || (item.windowSeconds !== undefined && (!finite(item.windowSeconds) || item.windowSeconds === 0))
      || (item.monthlyIsPrimaryWindow !== undefined && typeof item.monthlyIsPrimaryWindow !== "boolean")) return undefined;
    windows.push({ family: item.family, window: item.window, usedPercent: item.usedPercent,
      ...(item.resetAtMs !== undefined ? { resetAtMs: item.resetAtMs as number } : {}),
      ...(item.windowSeconds !== undefined ? { windowSeconds: item.windowSeconds as number } : {}),
      ...(item.monthlyIsPrimaryWindow === true && item.family === "account" && item.window === "monthly" ? { monthlyIsPrimaryWindow: true } : {}),
    });
  }
  return { observedAt: value.observedAt, source: value.source, credentialGeneration: value.credentialGeneration as number, windows };
}

/** Bounded in-process observations. The quota cache owns persistence and credential admission. */
export class CodexQuotaHistory {
  private accounts = new Map<string, Bucket>();
  private bytes = 32;
  private count = 0;

  append(writer: PoolQuotaWriter, sample: QuotaHistorySample, now = Date.now()): void {
    if (!isValidCodexAccountId(writer.accountId) || !identityPattern.test(writer.historyIdentity)
      || sample.credentialGeneration !== writer.credentialGeneration) return;
    const parsed = parseSample(sample, now);
    if (!parsed) return;
    let bucket = this.accounts.get(writer.accountId);
    if (bucket && bucket.identity !== writer.historyIdentity) { this.clear(writer.accountId); bucket = undefined; }
    if (!bucket) {
      const overhead = byteSize(writer.accountId) + byteSize({ identity: writer.historyIdentity, samples: [] }) + 8;
      bucket = { identity: writer.historyIdentity, samples: [], costs: [], overhead };
      this.accounts.set(writer.accountId, bucket);
      this.bytes += overhead;
    }
    const index = bucket.samples.findIndex(row => row.observedAt > parsed.observedAt);
    const position = index < 0 ? bucket.samples.length : index;
    const cost = byteSize(parsed) + 1;
    bucket.samples.splice(position, 0, parsed);
    bucket.costs.splice(position, 0, cost);
    this.bytes += cost;
    this.count++;
    while (bucket.samples.length > QUOTA_HISTORY_LIMITS.perAccount) this.dropFirst(writer.accountId);
    this.prune(now);
  }

  read(accountId: string, identity: string | undefined, now = Date.now(), limit: number = QUOTA_HISTORY_LIMITS.perAccount): { samples: QuotaHistorySample[]; truncated: boolean } {
    this.prune(now);
    const bucket = this.accounts.get(accountId);
    if (!identity || !bucket) return { samples: [], truncated: false };
    if (bucket.identity !== identity) { this.clear(accountId); return { samples: [], truncated: false }; }
    const capped = Math.max(1, Math.min(QUOTA_HISTORY_LIMITS.perAccount, Math.trunc(limit)));
    return { samples: structuredClone(bucket.samples.slice(-capped)), truncated: bucket.samples.length > capped };
  }

  clear(accountId?: string): number {
    if (accountId === undefined) {
      const count = this.accounts.size;
      this.accounts.clear(); this.count = 0; this.bytes = 32;
      return count;
    }
    const bucket = this.accounts.get(accountId);
    if (!bucket) return 0;
    this.bytes -= bucket.overhead + bucket.costs.reduce((a, b) => a + b, 0);
    this.count -= bucket.samples.length;
    this.accounts.delete(accountId);
    return 1;
  }

  reconcile(ids: ReadonlySet<string>): number {
    let removed = 0;
    for (const id of this.accounts.keys()) if (!ids.has(id)) removed += this.clear(id);
    return removed;
  }

  serialize(now = Date.now()): { version: 1; accounts: Record<string, Envelope> } {
    this.prune(now);
    return { version: 1, accounts: Object.fromEntries([...this.accounts].map(([id, bucket]) => [id,
      { identity: bucket.identity, samples: structuredClone(bucket.samples) }])) };
  }

  hydrate(value: unknown, now = Date.now()): void {
    this.clear();
    if (!record(value) || value.version !== 1 || !record(value.accounts) || byteSize(value) > QUOTA_HISTORY_LIMITS.bytes) return;
    const entries = Object.entries(value.accounts);
    if (entries.length > QUOTA_HISTORY_LIMITS.accounts) return;
    let count = 0;
    for (const [id, envelope] of entries) {
      if (!isValidCodexAccountId(id) || !record(envelope) || typeof envelope.identity !== "string"
        || !identityPattern.test(envelope.identity) || !Array.isArray(envelope.samples)
        || envelope.samples.length > QUOTA_HISTORY_LIMITS.perAccount) return;
      count += envelope.samples.length;
      if (count > QUOTA_HISTORY_LIMITS.samples) return;
    }
    for (const [accountId, raw] of entries) {
      const envelope = raw as Envelope;
      for (const sample of envelope.samples) {
        const parsed = parseSample(sample, now);
        if (parsed) this.append({ accountId, historyIdentity: envelope.identity, credentialGeneration: parsed.credentialGeneration }, parsed, now);
      }
    }
  }

  private dropFirst(id: string): void {
    const bucket = this.accounts.get(id)!;
    this.bytes -= bucket.costs.shift()!;
    bucket.samples.shift(); this.count--;
    if (!bucket.samples.length) { this.bytes -= bucket.overhead; this.accounts.delete(id); }
  }

  private prune(now: number): void {
    for (const [id, bucket] of this.accounts) {
      while (bucket.samples.length && bucket.samples[0].observedAt < now - QUOTA_HISTORY_LIMITS.ageMs) this.dropFirst(id);
    }
    while (this.accounts.size > QUOTA_HISTORY_LIMITS.accounts || this.count > QUOTA_HISTORY_LIMITS.samples || this.bytes > QUOTA_HISTORY_LIMITS.bytes) {
      const first = [...this.accounts].sort(([a, x], [b, y]) => x.samples[0].observedAt - y.samples[0].observedAt || a.localeCompare(b))[0];
      if (!first) break;
      this.dropFirst(first[0]);
    }
  }
}
