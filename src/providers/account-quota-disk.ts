/**
 * Last-known per-account provider quota, kept across restarts.
 *
 * The in-memory cache is process-local, so a restart forgets every measurement and the
 * pool opens the next turn with no idea which account has room — exactly the state
 * pre-dispatch selection exists to avoid. Codex solved this for its own pool with a small
 * disk snapshot (`codex/quota.ts`), and this is the same shape for provider accounts.
 *
 * What is written is percentages and reset timestamps. No token, no email, no account
 * label — the account id is the store's own opaque id, which is already what keys the
 * in-memory cache.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import type { ProviderQuota } from "./quota-types";

const FILENAME = "provider-account-quota-cache.json";

/**
 * Older than this and the snapshot is discarded on load.
 *
 * Six hours matches the Codex cache. A stale bar is still better than none for ORDERING —
 * it decides which account to try first, and a wrong guess costs one 429 that rotation
 * already handles — but a day-old reading of a monthly window has drifted far enough that
 * it should not outrank a fresh probe.
 */
const DISK_MAX_AGE_MS = 6 * 60 * 60_000;
const PERSIST_DEBOUNCE_MS = 250;

type DiskFile = {
  version: 1;
  /** provider\u0000accountId -> quota, the same key the in-memory cache uses. */
  rows: Record<string, ProviderQuota>;
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Read the snapshot. Returns an empty map for a missing, corrupt or stale file. */
export function readPersistedAccountQuotas(now = Date.now()): Map<string, ProviderQuota> {
  const rows = new Map<string, ProviderQuota>();
  try {
    const path = join(getConfigDir(), FILENAME);
    if (!existsSync(path)) return rows;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DiskFile;
    if (!parsed || parsed.version !== 1 || !parsed.rows || typeof parsed.rows !== "object") return rows;
    for (const [key, quota] of Object.entries(parsed.rows)) {
      if (!quota || typeof quota !== "object" || typeof quota.updatedAt !== "number") continue;
      if (now - quota.updatedAt > DISK_MAX_AGE_MS) continue;
      rows.set(key, quota);
    }
  } catch {
    // A corrupt cache must never block routing or the dashboard.
  }
  return rows;
}

/** Write the snapshot, debounced. Best-effort: a failed write is not an error. */
export function schedulePersistAccountQuotas(rows: () => Iterable<[string, ProviderQuota]>): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const out: Record<string, ProviderQuota> = {};
      for (const [key, quota] of rows()) out[key] = quota;
      const body: DiskFile = { version: 1, rows: out };
      atomicWriteFile(join(getConfigDir(), FILENAME), `${JSON.stringify(body)}\n`);
    } catch {
      // Best-effort persistence only.
    }
  }, PERSIST_DEBOUNCE_MS);
}

/** Test seam: drop any pending write so a suite cannot leak one into the next file. */
export function cancelPendingAccountQuotaPersist(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}
