import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { redactSecretString, redactSecrets } from "../lib/redact";
import type { OcxUsage } from "../types";

export const USAGE_DEBUG_ENV = "OPENCODEX_USAGE_DEBUG";
export const USAGE_DEBUG_BODY_SAMPLE_BYTES = 2048;
export const USAGE_DEBUG_MAX_LINES = 200;
export const USAGE_DEBUG_KEEP_LINES = 100;

export type UsageDebugBodyKind = "sse" | "json" | "other" | "none";

export interface UsageDebugRecord {
  ts: number;
  requestId: string;
  provider: string;
  model: string;
  upstreamContentType: string | null;
  upstreamStatus: number;
  bodyKind: UsageDebugBodyKind;
  bodySample: string;
  extractedUsage: OcxUsage | null;
}

export function isUsageDebugEnabled(): boolean {
  return process.env[USAGE_DEBUG_ENV] === "1";
}

export function usageDebugPath(): string {
  return join(getConfigDir(), "usage-debug.jsonl");
}

export function truncateForDebug(text: string, max = USAGE_DEBUG_BODY_SAMPLE_BYTES): string {
  const redacted = redactSecretString(text);
  if (redacted.length <= max) return redacted;
  const cut = redacted.slice(0, max);
  const remaining = redacted.length - max;
  return `${cut}... [+${remaining} more]`;
}

function ensureUsageDebugDir(): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
}

function trimRollingFile(path: string): void {
  const text = readFileSync(path, "utf-8");
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length <= USAGE_DEBUG_MAX_LINES) return;
  const kept = lines.slice(-USAGE_DEBUG_KEEP_LINES).join("\n") + "\n";
  writeFileSync(path, kept, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

export function appendUsageDebug(record: UsageDebugRecord): void {
  try {
    ensureUsageDebugDir();
    const path = usageDebugPath();
    const safeRecord = redactSecrets(record) as UsageDebugRecord;
    appendFileSync(path, `${JSON.stringify(safeRecord)}\n`, { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (existsSync(path)) trimRollingFile(path);
  } catch {
    /* debug capture must never break the proxy */
  }
}
