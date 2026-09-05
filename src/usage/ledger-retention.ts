/**
 * Opt-in byte ceiling for the canonical `usage.jsonl` ledger.
 *
 * Default OFF (`enabled` false / unset). The request-history indexer never
 * truncates `usage.jsonl`; this module is the only writer allowed to rewrite
 * it, and only when the operator enabled a ceiling. After a rewrite the
 * derived `routing-history.sqlite` index is deleted so the next open rebuilds
 * from the retained tail (ADR-1/ADR-8: the index is disposable).
 *
 * Older rows are dropped permanently. There is no quarantine copy: the ledger
 * can be many gigabytes, and duplicating it would defeat the cap.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { loadConfig } from "../config";
import { getConfigDir } from "../config/paths";
import { historyIndexPath } from "../routing/history/schema";
import type { UsageLedgerRetention } from "../types/config";

export const DEFAULT_USAGE_LEDGER_MAX_BYTES = 512 * 1024 * 1024;
export const MIN_USAGE_LEDGER_MAX_BYTES = 1024 * 1024;
export const USAGE_LEDGER_FILENAME = "usage.jsonl";

const COPY_CHUNK_BYTES = 1024 * 1024;
const NEWLINE_PROBE_BYTES = 64 * 1024;

export type UsageLedgerRetentionSkip =
  | "disabled"
  | "missing"
  | "under_limit";

export interface UsageLedgerCompactResult {
  skipped?: UsageLedgerRetentionSkip;
  beforeBytes: number;
  afterBytes: number;
  droppedBytes: number;
}

export function defaultUsageLedgerRetention(): UsageLedgerRetention {
  return {
    enabled: false,
    maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES,
  };
}

export function normalizeUsageLedgerRetention(raw: unknown): UsageLedgerRetention {
  const base = defaultUsageLedgerRetention();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const o = raw as Record<string, unknown>;
  const enabled = o.enabled === true;
  let maxBytes = base.maxBytes;
  if (typeof o.maxBytes === "number" && Number.isFinite(o.maxBytes) && Math.floor(o.maxBytes) === o.maxBytes) {
    maxBytes = Math.max(MIN_USAGE_LEDGER_MAX_BYTES, o.maxBytes);
  }
  return { enabled, maxBytes };
}

export function usageLedgerPath(configDir?: string): string {
  const dir = (configDir ?? getConfigDir()).replace(/[\\/]+$/, "");
  return `${dir}/${USAGE_LEDGER_FILENAME}`;
}

export function discardHistoryIndex(configDir?: string): void {
  const db = historyIndexPath(configDir ?? getConfigDir());
  for (const path of [db, `${db}-wal`, `${db}-shm`]) {
    try {
      unlinkSync(path);
    } catch {
      /* absent is the success case */
    }
  }
}

/**
 * Keep the newest complete JSONL rows whose bytes fit in `maxBytes`.
 * No-op when the file is missing or already within the ceiling.
 */
export function compactUsageLedgerToMaxBytes(
  path: string,
  maxBytes: number,
): UsageLedgerCompactResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("usage ledger maxBytes must be a positive integer");
  }
  if (!existsSync(path)) {
    return { skipped: "missing", beforeBytes: 0, afterBytes: 0, droppedBytes: 0 };
  }
  const beforeBytes = statSync(path).size;
  if (beforeBytes <= maxBytes) {
    return { skipped: "under_limit", beforeBytes, afterBytes: beforeBytes, droppedBytes: 0 };
  }

  const fd = openSync(path, "r");
  try {
    let start = beforeBytes - maxBytes;
    if (start > 0) {
      const probeLen = Math.min(NEWLINE_PROBE_BYTES, beforeBytes - start);
      const probe = Buffer.alloc(probeLen);
      const n = readSync(fd, probe, 0, probeLen, start);
      const nl = probe.subarray(0, n).indexOf(0x0a);
      // Drop the possibly-partial first row. If this window has no newline,
      // keep the raw tail rather than deleting the whole ledger.
      if (nl >= 0) start = start + nl + 1;
    } else {
      start = 0;
    }

    const tmp = `${path}.tmp-retention`;
    const out = openSync(tmp, "w", 0o600);
    try {
      const buf = Buffer.alloc(COPY_CHUNK_BYTES);
      let pos = start;
      while (pos < beforeBytes) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        writeSync(out, buf, 0, n);
        pos += n;
      }
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    renameSync(tmp, path);
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  } finally {
    closeSync(fd);
  }

  const afterBytes = existsSync(path) ? statSync(path).size : 0;
  return {
    beforeBytes,
    afterBytes,
    droppedBytes: Math.max(0, beforeBytes - afterBytes),
  };
}

let cachedPolicy: UsageLedgerRetention | null = null;

export function resetUsageLedgerRetentionCacheForTests(): void {
  cachedPolicy = null;
}

function currentPolicy(): UsageLedgerRetention {
  if (cachedPolicy) return cachedPolicy;
  cachedPolicy = normalizeUsageLedgerRetention(loadConfig().usageLedgerRetention);
  return cachedPolicy;
}

/** Startup / post-append hook. Never throws to the request path. */
export function enforceUsageLedgerRetention(configDir?: string): UsageLedgerCompactResult {
  const dir = configDir ?? getConfigDir();
  const policy = currentPolicy();
  const path = usageLedgerPath(dir);
  if (!policy.enabled) {
    return { skipped: "disabled", beforeBytes: 0, afterBytes: 0, droppedBytes: 0 };
  }
  const result = compactUsageLedgerToMaxBytes(path, policy.maxBytes);
  if (!result.skipped) discardHistoryIndex(dir);
  return result;
}
