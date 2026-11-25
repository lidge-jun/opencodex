/**
 * Disk-backed rows for API-key cooldowns (`<config dir>/api-key-cooldowns.json`).
 *
 * A confirmed quota or billing hold that lives only in memory is forgotten on restart, so a
 * restarted proxy re-offers a key the upstream said to leave alone until its reset. The file
 * stores `{provider, keyId, generation, cooldownUntil}` and nothing else; `generation` is a
 * truncated key fingerprint, so a key replaced under the same id is never held by an old row.
 *
 * Semantics follow the combo cooldown store (`combos/cooldown-store.ts`), because several proxies
 * can share one home:
 * - A flush re-reads the file under the config mutation lock and overlays only rows this process
 *   recorded. For the same key and generation the later expiry wins; a newer generation replaces.
 * - Provider clears and clear-all are the only deletes written, applied to the disk rows before
 *   the overlay so a cooldown recorded after the clear survives it.
 * - A busy lock or I/O failure keeps everything pending and retries with bounded backoff.
 * - Rows load once, at install, and only while unexpired and matching the current key.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { getConfigDir } from "../config/paths";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import type { OcxConfig } from "../types";
import { apiKeyCooldownGeneration, attachApiKeyCooldownPersistence, restoreApiKeyCooldowns } from "./api-key-cooldowns";

export interface ApiKeyCooldownRow { provider: string; keyId: string; generation: string; cooldownUntil: number }
export interface ApiKeyCooldownPersistence {
  record(row: ApiKeyCooldownRow): void;
  clear(provider?: string): void;
}

export const API_KEY_COOLDOWN_FILE = "api-key-cooldowns.json";
const FLUSH_DELAY_MS = 250;
const MAX_FLUSH_DELAY_MS = 4_000;
const SHUTDOWN_ATTEMPTS = 5;
const SHUTDOWN_RETRY_MS = 200;

const rowKey = (row: { provider: string; keyId: string }) => `${row.provider}\0${row.keyId}`;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

/** Valid rows of the file. Missing file or unparsable JSON is empty; other read errors throw. */
export function readApiKeyCooldownRows(path: string): ApiKeyCooldownRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = (parsed as { version?: unknown; rows?: unknown } | null)?.rows;
  if ((parsed as { version?: unknown } | null)?.version !== 1 || !Array.isArray(rows)) return [];
  const out: ApiKeyCooldownRow[] = [];
  for (const value of rows) {
    const row = value as Partial<ApiKeyCooldownRow> | null;
    if (typeof row?.provider !== "string" || typeof row.keyId !== "string" || typeof row.generation !== "string") continue;
    if (typeof row.cooldownUntil !== "number" || !Number.isFinite(row.cooldownUntil)) continue;
    out.push({ provider: row.provider, keyId: row.keyId, generation: row.generation, cooldownUntil: row.cooldownUntil });
  }
  return out;
}

export class ApiKeyCooldownStore implements ApiKeyCooldownPersistence {
  private readonly dirty = new Map<string, ApiKeyCooldownRow>();
  private readonly clearedProviders = new Set<string>();
  private clearAll = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delayMs = FLUSH_DELAY_MS;

  constructor(readonly dir: string) {}

  get path(): string { return join(this.dir, API_KEY_COOLDOWN_FILE); }

  /** Unexpired rows on disk now. Throws on a read error other than a missing file. */
  load(now = Date.now()): ApiKeyCooldownRow[] {
    return readApiKeyCooldownRows(this.path).filter(row => row.cooldownUntil > now);
  }

  record(row: ApiKeyCooldownRow): void {
    const key = rowKey(row);
    const prior = this.dirty.get(key);
    this.dirty.set(key, prior && prior.generation === row.generation && prior.cooldownUntil > row.cooldownUntil ? prior : { ...row });
    this.schedule();
  }

  clear(provider?: string): void {
    if (provider === undefined) {
      this.clearAll = true;
      this.clearedProviders.clear();
      this.dirty.clear();
    } else {
      this.clearedProviders.add(provider);
      for (const [key, row] of this.dirty) if (row.provider === provider) this.dirty.delete(key);
    }
    this.schedule();
  }

  private pending(): boolean {
    return this.clearAll || this.clearedProviders.size > 0 || this.dirty.size > 0;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Write pending changes now. Returns false, keeping them and rescheduling, if the write could not run. */
  flush(now = Date.now()): boolean {
    if (!this.pending()) return true;
    // A running server's config dir exists; a removed one (a test home) has nowhere to persist to.
    if (!existsSync(this.dir)) { this.discardPending(); return true; }
    const path = this.path;
    try {
      withConfigMutationLockSync(() => {
        const out = new Map<string, ApiKeyCooldownRow>();
        if (!this.clearAll) {
          for (const row of readApiKeyCooldownRows(path)) {
            if (row.cooldownUntil > now && !this.clearedProviders.has(row.provider)) out.set(rowKey(row), row);
          }
        }
        for (const [key, own] of this.dirty) {
          if (own.cooldownUntil <= now) continue;
          const other = out.get(key);
          out.set(key, other && other.generation === own.generation && other.cooldownUntil > own.cooldownUntil ? other : own);
        }
        atomicWriteFile(path, JSON.stringify({ version: 1, rows: [...out.values()] }));
      }, this.dir);
    } catch {
      // Lock held by another process or an I/O error: keep everything and retry later.
      this.delayMs = Math.min(this.delayMs * 2, MAX_FLUSH_DELAY_MS);
      this.schedule();
      return false;
    }
    this.discardPending();
    return true;
  }

  private discardPending(): void {
    this.dirty.clear();
    this.clearedProviders.clear();
    this.clearAll = false;
    this.delayMs = FLUSH_DELAY_MS;
  }

  /** Bounded final write for process shutdown; never blocks for more than about a second. */
  flushForShutdown(): void {
    for (let attempt = 0; attempt < SHUTDOWN_ATTEMPTS; attempt += 1) {
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      if (this.flush()) break;
      if (attempt < SHUTDOWN_ATTEMPTS - 1) Bun.sleepSync(SHUTDOWN_RETRY_MS);
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }
}

/** Keep only rows whose pool entry still exists and still carries the key the row was recorded for. */
export function rowsMatchingCurrentKeys(rows: readonly ApiKeyCooldownRow[], config: Pick<OcxConfig, "providers">): ApiKeyCooldownRow[] {
  return rows.filter(row => {
    const entry = config.providers[row.provider]?.apiKeyPool?.find(candidate => candidate.id === row.keyId);
    return entry !== undefined && apiKeyCooldownGeneration(row.provider, row.keyId, entry.key) === row.generation;
  });
}

let installed: { store: ApiKeyCooldownStore; detach: () => void; detachShutdown: () => void } | undefined;

/**
 * Bind persistence to the running server's config dir and restore holds that are unexpired and
 * still belong to the configured key. Called where the live config is installed; repeat calls
 * for the same dir are no-ops. A failed read leaves the server running with in-memory cooldowns.
 */
export function installApiKeyCooldownPersistence(config: Pick<OcxConfig, "providers">, now = Date.now()): ApiKeyCooldownStore {
  const dir = getConfigDir();
  if (installed?.store.dir === dir) return installed.store;
  uninstallApiKeyCooldownPersistence();
  const store = new ApiKeyCooldownStore(dir);
  try {
    restoreApiKeyCooldowns(rowsMatchingCurrentKeys(store.load(now), config), now);
  } catch {
    // An unreadable file restores nothing; later writes still try to persist.
  }
  installed = {
    store,
    detach: attachApiKeyCooldownPersistence(store),
    detachShutdown: registerOptionalShutdownHook("api-key-cooldowns", () => store.flushForShutdown()),
  };
  return store;
}

/** Flush and detach the installed store. Tests and a config-dir change only. */
export function uninstallApiKeyCooldownPersistence(): void {
  if (!installed) return;
  const current = installed;
  installed = undefined;
  current.store.flushForShutdown();
  current.detach();
  current.detachShutdown();
}
