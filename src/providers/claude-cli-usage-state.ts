/**
 * The last Claude Code subscription observation, persisted beside the proxy's other state.
 *
 * The read model lives here rather than in `src/adapters/claude-cli/usage-admission.ts` because
 * `/api/provider-quotas` reads it as well, and `src/providers/quota.ts` is statically reachable
 * from `src/server/responses/core.ts`: importing the adapter would drag its token/Keychain and
 * child-process layer into every install. The adapter owns identity resolution and gating; this
 * module owns only the file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";
import type { ProviderQuota } from "./quota-types";

export type ClaudeUsageSnapshot = {
  identity: string;
  checkedAt: number;
  quota?: ProviderQuota;
  refusalUntil?: number;
};

export type ClaudeUsageObservation = Readonly<ClaudeUsageSnapshot>;

const memory = new Map<string, ClaudeUsageSnapshot>();
let signedInIdentity: string | null = null;

/** The adapter records every sign-in read here, so a published report can tell it was superseded. */
export function recordClaudeSignedInIdentity(identity: string | null): void { signedInIdentity = identity; }

/** The hashed key of the last sign-in read, or null when signed out, unreadable or not yet read. */
export function claudeSignedInIdentity(): string | null { return signedInIdentity; }

export function claudeUsageStatePath(statePath?: string): string {
  return statePath ?? join(getConfigDir(), "claude-usage-admission.json");
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

/**
 * The admission file, or undefined when it is missing or any field fails validation. A rejected
 * file reads as "never checked", so a corrupt cache can neither admit nor refuse a launch.
 */
export function loadClaudeUsageSnapshot(path: string): ClaudeUsageSnapshot | undefined {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (typeof saved.identity !== "string" || !Number.isFinite(saved.checkedAt)) return;
    if (saved.refusalUntil !== undefined && !finite(saved.refusalUntil)) return;
    if (saved.quota !== undefined) {
      const q = saved.quota;
      if (!q || typeof q !== "object" || !finite(q.updatedAt)) return;
      for (const field of ["fiveHourPercent", "fiveHourResetAt", "weeklyPercent", "weeklyResetAt"])
        if (q[field] !== undefined && !finite(q[field])) return;
      if (q.customWindows !== undefined && (!Array.isArray(q.customWindows) || !q.customWindows.every((w: unknown) => {
        if (!w || typeof w !== "object") return false;
        const row = w as Record<string, unknown>;
        return typeof row.label === "string" && finite(row.percent) && (row.resetAt === undefined || finite(row.resetAt));
      }))) return;
    }
    return saved;
  } catch { /* Missing or malformed cache is unknown, never proof of capacity. */ }
  return undefined;
}

/**
 * Records the snapshot in memory first, then atomically on disk (temp file plus rename, mode 0600).
 * A failed disk write is swallowed: the in-memory copy still gates this process's launches.
 */
export function saveClaudeUsageSnapshot(path: string, snapshot: ClaudeUsageSnapshot): void {
  memory.set(path, snapshot);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot) + "\n", { mode: 0o600 });
    renameSync(temp, path);
  } catch { /* Memory still suppresses launches; no secrets or upstream text are persisted. */ }
}

/** Every snapshot this process can see for the path: the admission file and the in-memory write. */
export function readClaudeUsageSnapshots(path: string): ClaudeUsageSnapshot[] {
  return [loadClaudeUsageSnapshot(path), memory.get(path)]
    .filter((snapshot): snapshot is ClaudeUsageSnapshot => snapshot !== undefined);
}

/**
 * The newest recorded usage snapshot, from memory or the admission file, optionally only for one
 * account. Read-only: it resolves no sign-in (no Keychain read), runs no probe and writes nothing.
 * `identity` is the admission's own SHA-256 account key, never the account uuid itself.
 */
export function peekClaudeUsageObservation(deps: { statePath?: string; identity?: string } = {}): ClaudeUsageObservation | null {
  const rows = readClaudeUsageSnapshots(claudeUsageStatePath(deps.statePath))
    .filter(row => deps.identity === undefined || row.identity === deps.identity);
  return rows.sort((a, b) => b.checkedAt - a.checkedAt)[0] ?? null;
}
