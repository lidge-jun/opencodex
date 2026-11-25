/**
 * Disk-backed rows for API-key cooldowns (`<config dir>/api-key-cooldowns.json`).
 *
 * A confirmed quota or billing hold that lives only in memory is forgotten on restart, so a
 * restarted proxy re-offers a key the upstream said to leave alone until its reset. Each row is
 * `{provider, keyId, generation, cooldownUntil, recordedAt}` and nothing else; `generation` is a
 * truncated fingerprint of the pool entry's key, so a key replaced under the same id is never held
 * by an old row.
 *
 * Only inline keys are persisted. A `${ENV}`, `$ENV` or `keychain:` reference names a secret whose
 * value can change behind an unchanged reference, so its holds stay in memory, as before. An
 * inline key is already in `config.json` next to this file, so its fingerprint discloses nothing
 * the directory does not already hold.
 *
 * Several proxies can share one home, so a flush re-reads the file under the config mutation lock
 * and merges instead of replacing:
 * - Rows are kept per generation. A peer still holding an old key's row cannot overwrite the
 *   current key's row; restore picks the row whose generation matches the configured key.
 * - For one provider, key id and generation the later expiry wins.
 * - A manual clear is written as a dated marker (per provider, or for every provider). A row
 *   recorded before the marker is dropped on every later flush, including a peer's delayed one,
 *   while a cooldown recorded after the clear survives it.
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
import { providerKeyStoreKind } from "./api-key-resolve";
import { apiKeyCooldownGeneration, attachApiKeyCooldownPersistence, restoreApiKeyCooldowns } from "./api-key-cooldowns";

export interface ApiKeyCooldownRow { provider: string; keyId: string; generation: string; cooldownUntil: number; recordedAt: number }
export interface ApiKeyCooldownPersistence {
  /** Whether a hold for this configured key value may be written to disk. */
  persists(credential: string): boolean;
  record(row: ApiKeyCooldownRow): void;
  clear(provider?: string, at?: number): void;
}
interface StoredState { rows: ApiKeyCooldownRow[]; clears: Record<string, number>; clearedAllAt: number }

export const API_KEY_COOLDOWN_FILE = "api-key-cooldowns.json";
const FLUSH_DELAY_MS = 250;
const MAX_FLUSH_DELAY_MS = 4_000;
const SHUTDOWN_ATTEMPTS = 5;
const SHUTDOWN_RETRY_MS = 200;
/** A clear marker only has to outlive peers' pending flushes, which retry within seconds. */
const CLEAR_MARKER_TTL_MS = 24 * 60 * 60_000;

const rowKey = (row: ApiKeyCooldownRow) => `${row.provider}\0${row.keyId}\0${row.generation}`;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

/** Valid content of the file. Missing file or unparsable JSON is empty; other read errors throw. */
export function readApiKeyCooldownState(path: string): StoredState {
  const empty: StoredState = { rows: [], clears: {}, clearedAllAt: 0 };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return empty;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return empty; }
  const file = parsed as { version?: unknown; rows?: unknown; clears?: unknown; clearedAllAt?: unknown } | null;
  if (file?.version !== 1) return empty;
  const state: StoredState = { rows: [], clears: {}, clearedAllAt: isTime(file.clearedAllAt) ? file.clearedAllAt : 0 };
  for (const value of Array.isArray(file.rows) ? file.rows : []) {
    const row = value as Partial<ApiKeyCooldownRow> | null;
    if (typeof row?.provider !== "string" || typeof row.keyId !== "string" || typeof row.generation !== "string") continue;
    if (!isTime(row.cooldownUntil) || !isTime(row.recordedAt)) continue;
    state.rows.push({ provider: row.provider, keyId: row.keyId, generation: row.generation,
      cooldownUntil: row.cooldownUntil, recordedAt: row.recordedAt });
  }
  if (file.clears && typeof file.clears === "object" && !Array.isArray(file.clears)) {
    for (const [provider, at] of Object.entries(file.clears as Record<string, unknown>)) if (isTime(at)) state.clears[provider] = at;
  }
  return state;
}

function laterRow(a: ApiKeyCooldownRow | undefined, b: ApiKeyCooldownRow): ApiKeyCooldownRow {
  if (!a) return b;
  return { ...(a.cooldownUntil >= b.cooldownUntil ? a : b), recordedAt: Math.max(a.recordedAt, b.recordedAt) };
}

export class ApiKeyCooldownStore implements ApiKeyCooldownPersistence {
  private readonly dirty = new Map<string, ApiKeyCooldownRow>();
  private readonly clears = new Map<string, number>();
  private clearedAllAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delayMs = FLUSH_DELAY_MS;

  constructor(readonly dir: string) {}

  get path(): string { return join(this.dir, API_KEY_COOLDOWN_FILE); }

  /** Unexpired rows on disk now, with recorded clears applied. Throws on a read error other than a missing file. */
  load(now = Date.now()): ApiKeyCooldownRow[] {
    const state = readApiKeyCooldownState(this.path);
    return state.rows.filter(row => row.cooldownUntil > now
      && row.recordedAt > Math.max(state.clearedAllAt, state.clears[row.provider] ?? 0));
  }

  persists(credential: string): boolean {
    return providerKeyStoreKind({ apiKey: credential }) === "file";
  }

  record(row: ApiKeyCooldownRow): void {
    const key = rowKey(row);
    this.dirty.set(key, laterRow(this.dirty.get(key), { ...row }));
    this.schedule();
  }

  clear(provider?: string, at = Date.now()): void {
    if (provider === undefined) {
      this.clearedAllAt = Math.max(this.clearedAllAt, at);
      for (const [key, row] of this.dirty) if (row.recordedAt <= at) this.dirty.delete(key);
    } else {
      this.clears.set(provider, Math.max(this.clears.get(provider) ?? 0, at));
      for (const [key, row] of this.dirty) if (row.provider === provider && row.recordedAt <= at) this.dirty.delete(key);
    }
    this.schedule();
  }

  private pending(): boolean {
    return this.clearedAllAt > 0 || this.clears.size > 0 || this.dirty.size > 0;
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
        const disk = readApiKeyCooldownState(path);
        const clearedAllAt = Math.max(disk.clearedAllAt, this.clearedAllAt);
        const clears: Record<string, number> = {};
        for (const [provider, at] of [...Object.entries(disk.clears), ...this.clears]) {
          if (at > clearedAllAt && at > now - CLEAR_MARKER_TTL_MS) clears[provider] = Math.max(clears[provider] ?? 0, at);
        }
        const out = new Map<string, ApiKeyCooldownRow>();
        for (const row of [...disk.rows, ...this.dirty.values()]) {
          if (row.cooldownUntil <= now || row.recordedAt <= Math.max(clearedAllAt, clears[row.provider] ?? 0)) continue;
          out.set(rowKey(row), laterRow(out.get(rowKey(row)), row));
        }
        atomicWriteFile(path, JSON.stringify({
          version: 1,
          rows: [...out.values()],
          clears,
          ...(clearedAllAt > now - CLEAR_MARKER_TTL_MS ? { clearedAllAt } : {}),
        }));
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
    this.clears.clear();
    this.clearedAllAt = 0;
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

/** Keep only rows whose pool entry still exists and still carries the inline key the row was recorded for. */
export function rowsMatchingCurrentKeys(rows: readonly ApiKeyCooldownRow[], config: Pick<OcxConfig, "providers">): ApiKeyCooldownRow[] {
  return rows.filter(row => {
    const entry = config.providers[row.provider]?.apiKeyPool?.find(candidate => candidate.id === row.keyId);
    return entry !== undefined && providerKeyStoreKind({ apiKey: entry.key }) === "file"
      && apiKeyCooldownGeneration(row.provider, row.keyId, entry.key) === row.generation;
  });
}

let installed: { store: ApiKeyCooldownStore; detach: () => void; detachShutdown: () => void } | undefined;

/**
 * Bind persistence to the running server's config dir and restore holds that are unexpired and
 * still belong to the configured key. Only server startup calls this (through
 * `setLiveStateStoreConfig(config, { persistApiKeyCooldowns: true })`); repeat calls for the same
 * dir are no-ops. A failed read leaves the server running with in-memory cooldowns.
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
