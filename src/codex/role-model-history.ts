/**
 * Every role model write the omo tab and `ocx agent roles set` make, so a role can be put back.
 * The integration journal cannot hold these: it snapshots one client config per operation, and a
 * role write spans `$CODEX_HOME/agents/<role>.toml` and LazyCodex's omo.jsonc mirror. So the
 * values are recorded rather than bytes, and a restore is an ordinary write of the earlier values.
 * Writes made in one action (auto-assign's Apply all) share a batch and are restored together.
 * The server hands out batch ids and a write joins a batch only while the history still holds it whole,
 * so an id compaction dropped can never start over and pass for the beginning of a batch. Every row
 * carries its number in its batch, which keeps the cap durable and lets a read tell a whole batch
 * from a cut one, which is never listed or restored.
 * The file sits under the opencodex config directory, which outlives a switch of Codex home, so every
 * row names the canonical Codex home it was written in and only that home's rows are listed or restored.
 * The file is bounded three ways: a batch holds at most ROLE_HISTORY_LIMIT rows, an append that takes
 * the file past ROLE_HISTORY_MAX_BYTES rewrites it to its newest whole batches, and a read looks at
 * no more than that many bytes and ROLE_HISTORY_MAX_ROWS rows from the end.
 */
import { appendFileSync, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { ensureDir, integrationsDir } from "../integrations/ownership";

export interface RoleSetting {
  readonly model: string | null;
  readonly effort: string | null;
}

export interface RoleModelChange {
  readonly at: string;
  readonly batch: string;
  readonly role: string;
  readonly before: RoleSetting;
  readonly after: RoleSetting;
}

interface StoredRoleModelChange extends RoleModelChange {
  readonly codexHome: string;
  /** This row's number in its batch, from 1: a batch is whole when it holds rows 1 to its highest. */
  readonly n: number;
  /** The batch this row's write restored, so compaction keeps that batch while the Restore is kept. */
  readonly restores?: string;
}

/** The batch a write is recorded in and its row number there. */
export interface BatchSlot {
  readonly batch: string;
  readonly n: number;
}

/** Rows one listing returns, and rows one batch may hold, so a whole batch always fits a listing. */
export const ROLE_HISTORY_LIMIT = 50;
export const ROLE_HISTORY_MAX_BYTES = 256 * 1024;
export const ROLE_HISTORY_MAX_ROWS = 1000;
const BATCH_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function historyPath(dir: string): string {
  return join(dir, "codex-agent-roles.jsonl");
}

export function isRoleHistoryBatch(value: unknown): value is string {
  return typeof value === "string" && BATCH_PATTERN.test(value);
}

/** `codexHome` is the canonical path `getCodexHome()` returns, so two spellings of one home match. */
export function recordRoleModelChange(codexHome: string, change: RoleModelChange & { readonly n: number; readonly restores?: string }, dir: string = integrationsDir()): void {
  ensureDir(historyPath(dir));
  const stored: StoredRoleModelChange = { ...change, codexHome };
  // Capture the complete source before this append can move its first row outside either tail limit.
  const tail = tailRows(historyPath(dir));
  // An interrupted JSONL suffix must not swallow the first record returned after restart.
  appendFileSync(historyPath(dir), `${tail.unterminated ? "\n" : ""}${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
  if (statSync(historyPath(dir)).size <= ROLE_HISTORY_MAX_BYTES && tail.lines < ROLE_HISTORY_MAX_ROWS) return;
  try {
    compact(dir, wholeBatches([stored, ...tail.rows]));
  } catch (cause) {
    // Reads stay bounded without the trim; the next append retries it.
    throw new Error("recorded the change but could not trim the history file", { cause });
  }
}

/**
 * Rewrite the file to its newest rows within half the byte budget and the row budget, so the next
 * compaction is many saves away. A batch the cut falls inside is dropped whole, for every Codex home,
 * so no home is left with part of an Apply all to restore. A kept Restore keeps the batch it restores
 * whole when the Restore and its sources fit both read limits; protected rows displace older batches.
 */
function compact(dir: string, rows: StoredRoleModelChange[]): void {
  const batches = new Map<string, StoredRoleModelChange[]>();
  for (const row of rows) {
    const key = batchKey(row);
    batches.set(key, [...(batches.get(key) ?? []), row]);
  }
  const keep = new Set<string>();
  let bytes = 0;
  let count = 0;
  for (const key of batches.keys()) {
    if (keep.has(key)) continue;
    const needed = new Set([key]);
    // Include source dependencies before admitting a batch, so they share its byte and row budgets.
    for (const dependency of needed) {
      for (const row of batches.get(dependency) ?? []) {
        if (row.restores) {
          const source = batchKey({ ...row, batch: row.restores });
          if (batches.has(source) && !keep.has(source)) needed.add(source);
        }
      }
    }
    const added = rows.filter(row => needed.has(batchKey(row)));
    const addedBytes = added.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
    if (bytes + addedBytes > ROLE_HISTORY_MAX_BYTES || count + added.length > ROLE_HISTORY_MAX_ROWS) break;
    // Ordinary batches stay within the half-budget target; Restore sources may use the headroom.
    if (bytes + addedBytes > ROLE_HISTORY_MAX_BYTES / 2 && !added.some(row => row.restores)) break;
    for (const dependency of needed) keep.add(dependency);
    bytes += addedBytes;
    count += added.length;
    if (bytes >= ROLE_HISTORY_MAX_BYTES / 2) break;
  }
  const whole = rows.filter(row => keep.has(batchKey(row))).reverse();
  atomicWriteFile(historyPath(dir), whole.map(row => `${JSON.stringify(row)}\n`).join(""));
}

function batchKey(row: Pick<StoredRoleModelChange, "codexHome" | "batch">): string {
  return `${row.codexHome}\n${row.batch}`;
}

function isSetting(value: unknown): value is RoleSetting {
  const setting = value as RoleSetting | null;
  return typeof setting === "object" && setting !== null
    && (setting.model === null || typeof setting.model === "string")
    && (setting.effort === null || typeof setting.effort === "string");
}

function parseRow(line: string): StoredRoleModelChange | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const change = value as StoredRoleModelChange | null;
  return typeof change === "object" && change !== null && typeof change.codexHome === "string"
    && typeof change.at === "string" && typeof change.role === "string"
    && isRoleHistoryBatch(change.batch) && isSetting(change.before) && isSetting(change.after)
    && Number.isSafeInteger(change.n) && change.n >= 1
    && (change.restores === undefined || isRoleHistoryBatch(change.restores))
    ? change
    : null;
}

/**
 * Every Codex home's rows, newest first, from at most the last ROLE_HISTORY_MAX_BYTES of the file and
 * at most ROLE_HISTORY_MAX_ROWS of them. When the read starts mid-file, its first partial line is
 * skipped; a batch that continues above the read is left for `wholeBatches` to drop.
 */
function tailRows(path: string): { rows: StoredRoleModelChange[]; lines: number; unterminated: boolean } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], lines: 0, unterminated: false };
    throw error;
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    // Windows opens a directory for reading, so the type is checked rather than left to the read.
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    const size = stat.size;
    const start = Math.max(0, size - ROLE_HISTORY_MAX_BYTES - 1);
    const bytes = Buffer.alloc(size - start);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, start + length);
      if (count === 0) break;
      length += count;
    }
    const read = bytes.subarray(0, length);
    text = (start > 0 ? read.subarray(read.indexOf(10) + 1) : read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n").filter(line => line.trim()).slice(-ROLE_HISTORY_MAX_ROWS);
  const rows = lines.flatMap(line => {
    const row = parseRow(line);
    return row ? [row] : [];
  }).reverse();
  return { rows, lines: lines.length, unterminated: text.length > 0 && !text.endsWith("\n") };
}

/**
 * The rows of every batch that holds each of its rows 1 to its highest, so a batch the read or a
 * compaction cut into is never offered as if it were whole.
 */
function wholeBatches(rows: StoredRoleModelChange[]): StoredRoleModelChange[] {
  const numbers = new Map<string, Set<number>>();
  const highest = new Map<string, number>();
  for (const row of rows) {
    const key = batchKey(row);
    numbers.set(key, (numbers.get(key) ?? new Set()).add(row.n));
    highest.set(key, Math.max(highest.get(key) ?? 0, row.n));
  }
  return rows.filter(row => numbers.get(batchKey(row))!.size === highest.get(batchKey(row)));
}

function forHome(rows: StoredRoleModelChange[], codexHome: string): RoleModelChange[] {
  return rows.flatMap(({ codexHome: home, n: _n, restores: _restores, ...change }) => home === codexHome ? [change] : []);
}

/**
 * This Codex home's changes, newest first, in whole batches and never more than `limit` rows: batches
 * are taken newest first until the next would not fit, so Restore never puts back part of an Apply all.
 * A batch larger than `limit` (written before batches were capped) can never be listed whole and is
 * skipped. A torn or foreign line, and a row another Codex home wrote, is skipped, the way the
 * integration journal reads its own.
 */
export function listRoleModelChanges(codexHome: string, limit: number = ROLE_HISTORY_LIMIT, dir: string = integrationsDir()): RoleModelChange[] {
  const newestFirst = forHome(wholeBatches(tailRows(historyPath(dir)).rows), codexHome);
  const sizes = new Map<string, number>();
  for (const change of newestFirst) sizes.set(change.batch, (sizes.get(change.batch) ?? 0) + 1);
  const listed = new Set<string>();
  let count = 0;
  for (const [batch, size] of sizes) {
    if (size > limit) continue;
    if (count + size > limit) break;
    listed.add(batch);
    count += size;
  }
  return newestFirst.filter(change => listed.has(change.batch));
}

/**
 * Where a write in this Codex home is recorded. Without `batch` it starts a new batch under a fresh id.
 * With one, it joins that batch only while this home's retained history holds the batch whole, and is
 * refused once the batch holds ROLE_HISTORY_LIMIT rows. An id compaction dropped, or one the server
 * never handed out, is closed: it cannot take a row and pass for the start of a batch.
 */
export function claimBatchRow(codexHome: string, batch: string | undefined, dir: string = integrationsDir()): BatchSlot | "batch_closed" | "batch_full" {
  if (batch === undefined) return { batch: crypto.randomUUID(), n: 1 };
  const held = wholeBatches(tailRows(historyPath(dir)).rows).filter(row => row.codexHome === codexHome && row.batch === batch);
  if (held.length === 0) return "batch_closed";
  return held.length >= ROLE_HISTORY_LIMIT ? "batch_full" : { batch, n: held.length + 1 };
}

/**
 * The setting a Restore of `batch` may put back on `role` in this Codex home: the role's earliest
 * `before` in that batch, or null when this home's retained history has no such change. The server
 * checks a restore against it, so a dashboard still showing another home's history cannot write
 * that home's earlier models here. It reads every retained batch rather than the 50-row listing,
 * because a Restore's own rows push the batch it restores out of that listing before it finishes.
 */
export function restorableSetting(codexHome: string, batch: string, role: string, dir: string = integrationsDir()): RoleSetting | null {
  const changes = forHome(wholeBatches(tailRows(historyPath(dir)).rows), codexHome).filter(change => change.batch === batch && change.role === role);
  return changes.at(-1)?.before ?? null;
}
