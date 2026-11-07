/** Private, bounded Anthropic affinity snapshots. No session or credential bytes reach disk. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { trackBackgroundWork } from "../lib/background-work";
import { getAccountSet } from "./store";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";

export const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
export const MAX_AFFINITY_ENTRIES = 2_000;
export const MAX_AFFINITY_FILE_BYTES = 1_048_576;
const TOUCH_DELAY_MS = 1_000;
type Entry = { accountId: string; lastUsedAt: number; loginFence?: string };
type AccountSnapshot = ReturnType<typeof getAccountSet>;
type Fences = ReadonlyMap<string, string | undefined>;
type Scope = { home: string; rows: Map<string, Entry>; dirty: boolean; active: boolean; revision: number;
  timer?: ReturnType<typeof setTimeout>; pending?: Promise<void> };
const owners = new Set<AnthropicSessionAffinityStore>();
const digest = (domain: string, value: string) => createHash("sha256").update(`${domain}\0${value}`).digest("hex");
export function anthropicAffinityDigest(instance: AnthropicInstanceId, normalizedKey: string): string {
  return normalizedKey ? digest(`opencodex/anthropic-affinity/session/v1/${instance}`, normalizedKey) : "";
}
export function anthropicAffinityPath(home: string, instance: AnthropicInstanceId): string {
  return join(home, `anthropic-affinity-${digest("opencodex/anthropic-affinity/instance/v1", instance)}.json`);
}
function warn(): void { console.warn("[anthropic-affinity] snapshot persistence failed; using runtime affinity"); }

export class AnthropicSessionAffinityStore implements Iterable<[string, Entry]> {
  private scope?: Scope;
  constructor(private readonly instance: AnthropicInstanceId, private readonly write = atomicWriteFileNoFollow) { owners.add(this); }
  private fences(snapshot: AccountSnapshot = getAccountSet(this.instance)): Fences {
    const fences = new Map<string, string | undefined>();
    for (const account of snapshot?.accounts ?? []) {
      if (account.paused || account.needsReauth) continue;
      // Legacy accounts without a persistent login identity remain memory-only until next login.
      fences.set(account.id, account.loginId ? digest("opencodex/anthropic-affinity/login/v1", account.loginId) : undefined);
    }
    return fences;
  }
  private valid(entry: Entry, fences: Fences): boolean {
    return fences.has(entry.accountId) && fences.get(entry.accountId) === entry.loginFence;
  }
  private current(fences?: Fences): Scope {
    const home = getConfigDir();
    if (this.scope?.home === home) return this.scope;
    this.resetMemory();
    const scope: Scope = { home, rows: new Map(), dirty: false, active: true, revision: 0 };
    this.scope = scope;
    // Starts synchronously; retained ACL children are joined by the tracked writer.
    registerOptionalShutdownHook(`anthropic-affinity:${this.instance}`, () => { void this.flush(); });
    try {
      const bytes = readBoundedRegularFileSync(anthropicAffinityPath(home, this.instance), MAX_AFFINITY_FILE_BYTES);
      const snapshot = JSON.parse(bytes.toString("utf8"));
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.entries)) return scope;
      fences ??= this.fences();
      const now = Date.now();
      for (const row of snapshot.entries) {
        if (!row || typeof row.sessionDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.sessionDigest)
          || typeof row.accountId !== "string" || row.accountId.length > 512
          || typeof row.loginFence !== "string" || !/^[a-f0-9]{64}$/.test(row.loginFence)
          || !Number.isFinite(row.lastUsedAt) || row.lastUsedAt > now
          || now - row.lastUsedAt > AFFINITY_IDLE_TTL_MS || !this.valid(row, fences)) continue;
        const previous = scope.rows.get(row.sessionDigest);
        if (!previous || previous.lastUsedAt < row.lastUsedAt) scope.rows.set(row.sessionDigest, {
          accountId: row.accountId, lastUsedAt: row.lastUsedAt, loginFence: row.loginFence,
        });
      }
      this.trim(scope);
      if (scope.rows.size !== snapshot.entries.length) this.changed(scope);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[anthropic-affinity] snapshot unavailable or invalid; using runtime affinity");
      }
    }
    return scope;
  }
  private trim(scope: Scope): void {
    if (scope.rows.size <= MAX_AFFINITY_ENTRIES) return;
    const ordered = [...scope.rows].sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
    for (const [key] of ordered.slice(MAX_AFFINITY_ENTRIES)) scope.rows.delete(key);
  }
  private changed(scope: Scope, touch = false): void {
    scope.dirty = true;
    scope.revision++;
    if (touch) {
      scope.timer ??= setTimeout(() => { scope.timer = undefined; void this.flushScope(scope); }, TOUCH_DELAY_MS);
      scope.timer.unref();
    } else { void this.flushScope(scope); }
  }
  private flushSync(scope: Scope): void {
    if (!scope.active || !scope.dirty || this.scope !== scope) return;
    if (getConfigDir() !== scope.home) { this.resetMemory(); return; }
    try {
      const entries = [...scope.rows].filter(([, row]) => row.loginFence).map(([sessionDigest, row]) => ({ sessionDigest, ...row }));
      this.write(anthropicAffinityPath(scope.home, this.instance), JSON.stringify({ version: 1, entries }));
      scope.dirty = false;
    } catch { warn(); }
  }
  async flush(): Promise<void> {
    const scope = this.scope;
    if (scope) await this.flushScope(scope);
  }
  private async flushScope(scope: Scope): Promise<void> {
    if (!scope?.active) return;
    if (getConfigDir() !== scope.home) { if (this.scope === scope) this.resetMemory(); return; }
    if (scope.timer) { clearTimeout(scope.timer); scope.timer = undefined; }
    if (scope.pending) return scope.pending;
    if (!scope.dirty) return;
    let attemptedRevision = scope.revision;
    scope.pending = trackBackgroundWork("anthropic-affinity-write", withConfigDirHardeningSettled(scope.home, () => {
      attemptedRevision = scope.revision;
      this.flushSync(scope);
    }).catch(() => { warn(); }).finally(() => {
      scope.pending = undefined;
      // A mutation after publication but before settlement still needs its own write.
      if (scope.active && scope.dirty && scope.revision !== attemptedRevision) return this.flushScope(scope);
    }));
    return scope.pending;
  }
  resetMemory(): void {
    if (this.scope) {
      this.scope.active = false;
      if (this.scope.timer) clearTimeout(this.scope.timer);
    }
    this.scope = undefined;
  }
  get size(): number { return this.current().rows.size; }
  get(key: string, snapshot: AccountSnapshot = getAccountSet(this.instance), now = Date.now()): Entry | undefined {
    const fences = this.fences(snapshot);
    const scope = this.current(fences);
    const row = scope.rows.get(key);
    if (row && (!this.valid(row, fences) || now - row.lastUsedAt > AFFINITY_IDLE_TTL_MS)) {
      scope.rows.delete(key); this.changed(scope); return undefined;
    }
    return row;
  }
  set(key: string, value: Entry, snapshot: AccountSnapshot = getAccountSet(this.instance)): void {
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(value.lastUsedAt)) return;
    const fences = this.fences(snapshot);
    const scope = this.current(fences);
    if (!fences.has(value.accountId)) { this.delete(key); return; }
    const previous = scope.rows.get(key);
    const loginFence = fences.get(value.accountId);
    scope.rows.set(key, { accountId: value.accountId, lastUsedAt: value.lastUsedAt, loginFence });
    this.trim(scope);
    this.changed(scope, previous?.accountId === value.accountId && previous.loginFence === loginFence);
  }
  /** Roster mutations validate every binding once, against one captured auth generation. */
  invalidate(snapshot: AccountSnapshot = getAccountSet(this.instance), keep: (accountId: string) => boolean = () => true): number {
    const fences = this.fences(snapshot);
    const scope = this.current(fences);
    const now = Date.now();
    let removed = 0;
    for (const [key, row] of scope.rows) {
      if (this.valid(row, fences) && keep(row.accountId)
        && row.lastUsedAt <= now && now - row.lastUsedAt <= AFFINITY_IDLE_TTL_MS) continue;
      scope.rows.delete(key); removed++;
    }
    if (removed) this.changed(scope);
    return removed;
  }
  delete(key: string): boolean {
    const scope = this.current();
    const deleted = scope.rows.delete(key);
    if (deleted) this.changed(scope);
    return deleted;
  }
  clear(): void { const scope = this.current(); scope.rows.clear(); this.changed(scope); }
  *entries(): IterableIterator<[string, Entry]> { yield* this.current().rows; }
  [Symbol.iterator](): IterableIterator<[string, Entry]> { return this.entries(); }
}
export async function flushAnthropicSessionAffinity(): Promise<void> {
  for (const owner of owners) await owner.flush();
}
