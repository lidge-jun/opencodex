/**
 * Disk-backed cooldown map for combo targets.
 *
 * A cooldown that lives only in memory is forgotten on every restart, so a freshly restarted proxy
 * re-offers a target that upstream said to leave alone until its reset. This Map subclass loads
 * `<config dir>/combo-cooldowns.json` on first read and writes the live entries back (debounced) on
 * every mutation. Expiry is stored as an absolute epoch, so reset-aware cooldowns stay correct across
 * restarts. Pattern adopted from Hermes-agent (MIT, NousResearch): rate-limit state persisted per
 * (provider, model) so a restart does not retry a known-exhausted route.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";

export interface PersistableCooldown { cooldownUntil: number; revision: number; status?: number }

const FILE = "combo-cooldowns.json";
const FLUSH_DELAY_MS = 250;

export class PersistedCooldownMap<V extends PersistableCooldown> extends Map<string, V> {
  private loadedFor: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextRevision: () => number;

  constructor(nextRevision: () => number) {
    super();
    this.nextRevision = nextRevision;
  }

  private path(): string { return join(getConfigDir(), FILE); }

  private ensureLoaded(): void {
    const dir = getConfigDir();
    if (this.loadedFor === dir) return;
    this.loadedFor = dir;
    try {
      if (!existsSync(this.path())) return;
      const rows = JSON.parse(readFileSync(this.path(), "utf8")) as Record<string, { cooldownUntil?: unknown; status?: unknown }>;
      const now = Date.now();
      for (const [key, row] of Object.entries(rows)) {
        if (typeof row?.cooldownUntil !== "number" || row.cooldownUntil <= now || super.has(key)) continue;
        super.set(key, { cooldownUntil: row.cooldownUntil, revision: this.nextRevision(), ...(typeof row.status === "number" ? { status: row.status } : {}) } as V);
      }
    } catch { /* a corrupt file simply starts empty; the next write replaces it */ }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, FLUSH_DELAY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  flush(): void {
    const now = Date.now();
    const rows: Record<string, { cooldownUntil: number; status?: number }> = {};
    for (const [key, v] of super.entries()) {
      if (v.cooldownUntil > now) rows[key] = { cooldownUntil: v.cooldownUntil, ...(v.status !== undefined ? { status: v.status } : {}) };
    }
    try {
      mkdirSync(getConfigDir(), { recursive: true });
      atomicWriteFile(this.path(), JSON.stringify(rows));
    } catch { /* best effort: memory stays authoritative for this process */ }
  }

  override get(key: string): V | undefined { this.ensureLoaded(); return super.get(key); }
  override has(key: string): boolean { this.ensureLoaded(); return super.has(key); }
  override get size(): number { this.ensureLoaded(); return super.size; }
  override keys(): MapIterator<string> { this.ensureLoaded(); return super.keys(); }
  override values(): MapIterator<V> { this.ensureLoaded(); return super.values(); }
  override entries(): MapIterator<[string, V]> { this.ensureLoaded(); return super.entries(); }
  override [Symbol.iterator](): MapIterator<[string, V]> { this.ensureLoaded(); return super[Symbol.iterator](); }
  override set(key: string, value: V): this { this.ensureLoaded(); super.set(key, value); this.schedule(); return this; }
  override delete(key: string): boolean { this.ensureLoaded(); const r = super.delete(key); if (r) this.schedule(); return r; }
  override clear(): void { this.ensureLoaded(); super.clear(); this.schedule(); }
}
