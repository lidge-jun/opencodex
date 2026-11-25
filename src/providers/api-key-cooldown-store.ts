/**
 * Disk-backed rows for API-key cooldowns (`<config dir>/api-key-cooldowns.json`).
 *
 * A confirmed quota or billing hold that lives only in memory is forgotten on restart, so a
 * restarted proxy re-offers a key the upstream said to leave alone until its reset. Each row is
 * `{provider, keyId, generation, cooldownUntil, epoch, allEpoch}` and nothing else; `generation`
 * is a truncated fingerprint of the pool entry's key, so a key replaced under the same id is never
 * held by an old row.
 *
 * Only inline keys are persisted. A value the key resolver reads from the environment (any value
 * starting with `$`), a `keychain:` reference or a `gcp-sa:` marker names a secret that can change
 * behind an unchanged value, so its holds stay in memory, as before. An inline key is already in
 * `config.json` next to this file, so its fingerprint discloses nothing the directory lacks.
 *
 * Several proxies can share one home, so a flush re-reads the file under the config mutation lock
 * and merges instead of replacing:
 * - Rows are kept per generation. A peer still holding an old key's row cannot overwrite the
 *   current key's row; restore picks the row whose generation matches the configured key.
 * - A manual clear increments a counter (per provider, or one for every provider) stored in the
 *   file. Each row carries the counters its process knew when it recorded the hold, and only rows
 *   carrying the current counters survive a flush or a load. A peer that recorded before learning
 *   of a clear, however late it flushes, therefore cannot revive the hold; at worst a hold it
 *   recorded just after a peer's clear is not persisted and stays in that process's memory.
 *   Within one process the counter orders a clear and a later hold exactly.
 * - Among surviving rows of one provider, key id and generation the later expiry wins.
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
import { GCP_CREDENTIAL_MARKER_PREFIX, isKeychainReference } from "./api-key-resolve";
import {
  apiKeyCooldownGeneration,
  attachApiKeyCooldownPersistence,
  resetLocalApiKeyCooldowns,
  restoreApiKeyCooldowns,
} from "./api-key-cooldowns";

export interface ApiKeyCooldownHold { provider: string; keyId: string; generation: string; cooldownUntil: number }
export interface ApiKeyCooldownRow extends ApiKeyCooldownHold { epoch: number; allEpoch: number }
export interface ApiKeyCooldownPersistence {
  /** Whether a hold for this configured key value may be written to disk. */
  persists(credential: string): boolean;
  record(hold: ApiKeyCooldownHold): void;
  clear(provider?: string): void;
}
interface StoredState { rows: ApiKeyCooldownRow[]; epochs: Record<string, number>; allEpoch: number }

export const API_KEY_COOLDOWN_FILE = "api-key-cooldowns.json";
const FLUSH_DELAY_MS = 250;
const MAX_FLUSH_DELAY_MS = 4_000;
const SHUTDOWN_ATTEMPTS = 5;
const SHUTDOWN_RETRY_MS = 200;

const holdKey = (row: ApiKeyCooldownHold) => `${row.provider}\0${row.keyId}\0${row.generation}`;
const taggedKey = (row: ApiKeyCooldownRow) => `${holdKey(row)}\0${row.epoch}\0${row.allEpoch}`;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Mirrors `resolveProviderApiKey`: a `keychain:` value reads the OS keychain and `resolveEnvValue`
 * reads the environment for ANY value starting with `$`, so only a value matching neither is the
 * credential itself. A `gcp-sa:` marker is excluded too.
 */
export function isInlineApiKey(credential: string): boolean {
  return credential.length > 0 && !credential.startsWith("$") && !credential.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)
    && !isKeychainReference(credential);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

/** Valid content of the file. Missing file or unparsable JSON is empty; other read errors throw. */
export function readApiKeyCooldownState(path: string): StoredState {
  const empty: StoredState = { rows: [], epochs: {}, allEpoch: 0 };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return empty;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return empty; }
  const file = parsed as { version?: unknown; rows?: unknown; epochs?: unknown; allEpoch?: unknown } | null;
  if (file?.version !== 1) return empty;
  const state: StoredState = { rows: [], epochs: {}, allEpoch: isCount(file.allEpoch) ? file.allEpoch : 0 };
  if (file.epochs && typeof file.epochs === "object" && !Array.isArray(file.epochs)) {
    for (const [provider, epoch] of Object.entries(file.epochs as Record<string, unknown>)) if (isCount(epoch)) state.epochs[provider] = epoch;
  }
  for (const value of Array.isArray(file.rows) ? file.rows : []) {
    const row = value as Partial<ApiKeyCooldownRow> | null;
    if (typeof row?.provider !== "string" || typeof row.keyId !== "string" || typeof row.generation !== "string") continue;
    if (!isTime(row.cooldownUntil) || !isCount(row.epoch) || !isCount(row.allEpoch)) continue;
    state.rows.push({ provider: row.provider, keyId: row.keyId, generation: row.generation,
      cooldownUntil: row.cooldownUntil, epoch: row.epoch, allEpoch: row.allEpoch });
  }
  return state;
}

/** Rows that postdate every recorded clear and have not expired, one per provider/key/generation. */
function liveRows(rows: Iterable<ApiKeyCooldownRow>, epochs: Record<string, number>, allEpoch: number, now: number): ApiKeyCooldownRow[] {
  const out = new Map<string, ApiKeyCooldownRow>();
  for (const row of rows) {
    if (row.cooldownUntil <= now || row.allEpoch !== allEpoch || row.epoch !== (epochs[row.provider] ?? 0)) continue;
    const prior = out.get(holdKey(row));
    if (!prior || row.cooldownUntil > prior.cooldownUntil) out.set(holdKey(row), row);
  }
  return [...out.values()];
}

export class ApiKeyCooldownStore implements ApiKeyCooldownPersistence {
  /**
   * Pending holds, each tagged with the counters this process knew when it recorded them. One
   * entry per provider, key, generation and counters (the longest expiry), so a write that keeps
   * failing holds at most one entry per configured key.
   */
  private readonly dirty = new Map<string, ApiKeyCooldownRow>();
  /** Whether counters were ever read from disk; a later increase is a peer's clear. */
  private adopted = false;
  /** Counters as last read from disk, plus this process's own unwritten clears. */
  private readonly epochs = new Map<string, number>();
  private allEpoch = 0;
  private readonly bumped = new Set<string>();
  private bumpedAll = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delayMs = FLUSH_DELAY_MS;

  constructor(readonly dir: string) {}

  get path(): string { return join(this.dir, API_KEY_COOLDOWN_FILE); }

  /** Pending holds not yet written (diagnostics and tests). */
  get pendingHolds(): number { return this.dirty.size; }

  /** Live rows on disk now, adopting the file's clear counters. Throws on a read error other than a missing file. */
  load(now = Date.now()): ApiKeyCooldownRow[] {
    const state = readApiKeyCooldownState(this.path);
    this.adopt(state);
    return liveRows(state.rows, state.epochs, state.allEpoch, now);
  }

  /**
   * Take the file's counters. A counter that moved past what this process knew is another
   * process's clear: this process's own in-memory holds for it are dropped too, so a later refusal
   * starts a fresh hold instead of extending the cleared one.
   */
  private adopt(state: StoredState): void {
    if (!this.bumpedAll) {
      if (this.adopted && state.allEpoch > this.allEpoch) resetLocalApiKeyCooldowns();
      this.allEpoch = state.allEpoch;
    }
    for (const [provider, epoch] of Object.entries(state.epochs)) {
      if (this.bumped.has(provider)) continue;
      if (this.adopted && epoch > (this.epochs.get(provider) ?? 0)) resetLocalApiKeyCooldowns(provider);
      this.epochs.set(provider, epoch);
    }
    this.adopted = true;
  }

  persists(credential: string): boolean {
    return isInlineApiKey(credential);
  }

  record(hold: ApiKeyCooldownHold): void {
    const row: ApiKeyCooldownRow = { ...hold, epoch: this.epochs.get(hold.provider) ?? 0, allEpoch: this.allEpoch };
    const prior = this.dirty.get(taggedKey(row));
    if (!prior || row.cooldownUntil > prior.cooldownUntil) this.dirty.set(taggedKey(row), row);
    this.schedule();
  }

  clear(provider?: string): void {
    if (provider === undefined) {
      this.allEpoch += 1;
      this.bumpedAll = true;
      this.dirty.clear();
    } else {
      this.epochs.set(provider, (this.epochs.get(provider) ?? 0) + 1);
      this.bumped.add(provider);
      for (const [key, row] of this.dirty) if (row.provider === provider) this.dirty.delete(key);
    }
    this.schedule();
  }

  private pending(): boolean {
    return this.bumpedAll || this.bumped.size > 0 || this.dirty.size > 0;
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
    let written: StoredState | undefined;
    try {
      withConfigMutationLockSync(() => {
        const disk = readApiKeyCooldownState(path);
        // A clear of ours lands strictly after every clear already on disk; holds we recorded after
        // it move to the counter actually written. Anything else keeps the counter it was recorded with.
        const allEpoch = this.bumpedAll ? Math.max(disk.allEpoch + 1, this.allEpoch) : disk.allEpoch;
        const epochs: Record<string, number> = { ...disk.epochs };
        for (const provider of this.bumped) epochs[provider] = Math.max((disk.epochs[provider] ?? 0) + 1, this.epochs.get(provider) ?? 0);
        const own = [...this.dirty.values()].map(row => ({
          ...row,
          epoch: this.bumped.has(row.provider) && row.epoch === this.epochs.get(row.provider) ? epochs[row.provider]! : row.epoch,
          allEpoch: this.bumpedAll && row.allEpoch === this.allEpoch ? allEpoch : row.allEpoch,
        }));
        const rows = liveRows([...disk.rows, ...own], epochs, allEpoch, now);
        atomicWriteFile(path, JSON.stringify({ version: 1, rows, epochs, allEpoch }));
        written = { rows, epochs, allEpoch };
      }, this.dir);
    } catch {
      // Lock held by another process or an I/O error: keep everything and retry later.
      this.delayMs = Math.min(this.delayMs * 2, MAX_FLUSH_DELAY_MS);
      this.schedule();
      return false;
    }
    this.discardPending();
    if (written) this.adopt(written);
    return true;
  }

  private discardPending(): void {
    this.dirty.clear();
    this.bumped.clear();
    this.bumpedAll = false;
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
export function rowsMatchingCurrentKeys<T extends ApiKeyCooldownHold>(rows: readonly T[], config: Pick<OcxConfig, "providers">): T[] {
  return rows.filter(row => {
    const entry = config.providers[row.provider]?.apiKeyPool?.find(candidate => candidate.id === row.keyId);
    return entry !== undefined && isInlineApiKey(entry.key)
      && apiKeyCooldownGeneration(row.provider, row.keyId, entry.key) === row.generation;
  });
}

let installed: { store: ApiKeyCooldownStore; detach: () => void; detachShutdown: () => void } | undefined;
/** The config home the in-memory holds were last restored for; it outlives an uninstall. */
let localHome: string | undefined;

/**
 * Bind persistence to the running server's config dir and restore holds that are unexpired and
 * still belong to the configured key. The server background lifecycle calls this when a server
 * starts and `uninstallApiKeyCooldownPersistence` when the last one stops; repeat calls for the
 * same dir are no-ops. Installing for another dir than the last one first drops the in-memory
 * holds, which belong to the previous home, even when its server has already stopped. A failed read leaves the server running with in-memory cooldowns.
 */
export function installApiKeyCooldownPersistence(config: Pick<OcxConfig, "providers">, now = Date.now()): ApiKeyCooldownStore {
  const dir = getConfigDir();
  if (installed?.store.dir === dir) return installed.store;
  uninstallApiKeyCooldownPersistence();
  // Holds restored or recorded for another home, even one whose server already stopped, are not this home's.
  if (localHome !== undefined && localHome !== dir) resetLocalApiKeyCooldowns();
  localHome = dir;
  const store = new ApiKeyCooldownStore(dir);
  try {
    restoreApiKeyCooldowns(rowsMatchingCurrentKeys(store.load(now), config), now);
  } catch {
    // An unreadable file restores nothing; later writes still try to persist.
  }
  installed = {
    store,
    detach: attachApiKeyCooldownPersistence(store),
    detachShutdown: registerOptionalShutdownHook("api-key-cooldowns", () => uninstallApiKeyCooldownPersistence()),
  };
  return store;
}

/** Flush and detach the installed store: the last server stopped, the process exits, or the home changed. */
export function uninstallApiKeyCooldownPersistence(): void {
  if (!installed) return;
  const current = installed;
  installed = undefined;
  current.detach();
  current.detachShutdown();
  current.store.flushForShutdown();
}
