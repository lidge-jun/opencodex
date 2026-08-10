/**
 * The operation log, its snapshots, and the retention bookkeeping around them.
 *
 * Two ordering rules carry the safety here:
 *
 * 1. `appendOperation` commits the row and NOTHING else. Pruning runs after,
 *    best-effort, because a GC failure that looked like an append failure would
 *    make the writer compensate for an operation that already succeeded.
 * 2. Snapshots can hold the user's own credentials — we copy their file
 *    verbatim — so they go through `atomicWriteFile`, which applies 0600 plus
 *    Windows ACL hardening.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/021 §4.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { atomicWriteFile } from "../config";
import { ensureDir, fingerprint, integrationsDir, type OwnershipRecord } from "./ownership";
import { isIntegrationClientId, type IntegrationClientId } from "./registry";

export type OperationKind = "apply" | "disable" | "refresh" | "restore";

/**
 * Tagged so "the file did not exist" and "the snapshot was collected" stay
 * distinguishable. `null` conflated them, and only one of the two is
 * recoverable — restoring an operation that created a file means deleting it.
 */
export type SnapshotRef =
  | { kind: "none" }
  | { kind: "stored"; relPath: string }
  | { kind: "expired" };

export interface JournalEntry {
  opId: string;
  clientId: IntegrationClientId;
  kind: OperationKind;
  at: string;
  configPath: string;
  snapshot: SnapshotRef;
  /** Fingerprint of the file AFTER this op; "" when the op left no file. */
  resultFingerprint: string;
  /** True when the op's result was file absence — restore then means "delete". */
  resultAbsent: boolean;
  /**
   * Ownership as it stood BEFORE this operation. Restore puts this back
   * alongside the bytes, so provenance always describes the file it came with
   * and is never re-derived from a provider-id prefix — which would silently
   * adopt a user's own `opencodex/...` entry.
   */
  priorRecord: OwnershipRecord | null;
}

export const SNAPSHOT_RETENTION = 10;

/**
 * Does the file on disk still hold what this operation left behind?
 *
 * The one place that answers it, because two places answered differently. An
 * operation whose result was ABSENCE records `resultAbsent: true` and an empty
 * `resultFingerprint`; the route compared a missing file to `""` and called it
 * a match, while restore hashed `""` into a real digest and called the same
 * unchanged absence a drift. So the journal offered Undo and the restore
 * route then demanded a confirmation for edits nobody had made.
 *
 * `currentText` is `null` for a missing file — not `""`, which is a file that
 * exists and is empty. The distinction is the whole point.
 */
export function matchesOperationResult(entry: JournalEntry, currentText: string | null): boolean {
  if (entry.resultAbsent) return currentText === null;
  if (currentText === null) return false;
  return fingerprint(currentText) === entry.resultFingerprint;
}

export function newOpId(): string {
  return randomUUID();
}

function journalPath(dir: string): string {
  return join(dir, "journal.jsonl");
}

/**
 * A snapshot file name must be ONE path component we produced, never a value
 * that walks anywhere. `opId` comes from `randomUUID()` in normal operation,
 * but it also arrives from a persisted journal row, and `relPath` is read
 * straight off disk — a row carrying `../../escaped` would otherwise let
 * capture write outside the store and read-back read an arbitrary file.
 */
function assertSafeComponent(value: string, what: string): string {
  if (value.length === 0 || value === "." || value === ".."
    || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`unsafe ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Resolve `relative` under `root`, refusing anything that escapes it. */
function containedPath(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path escapes the integration store: ${target}`);
  }
  return target;
}

function snapshotDir(clientId: IntegrationClientId, dir: string): string {
  return join(dir, "snapshots", clientId);
}

export function captureSnapshot(
  clientId: IntegrationClientId,
  opId: string,
  text: string | null,
  dir: string = integrationsDir(),
): SnapshotRef {
  if (text === null) return { kind: "none" };
  const target = containedPath(dir, "snapshots", assertSafeComponent(clientId, "clientId"), assertSafeComponent(opId, "opId"));
  ensureDir(target);
  atomicWriteFile(target, text);
  return { kind: "stored", relPath: join("snapshots", clientId, opId) };
}

/** Commit the row. Pruning is post-commit and can never fail the append. */
export function appendOperation(entry: JournalEntry, dir: string = integrationsDir()): void {
  ensureDir(journalPath(dir));
  appendFileSync(journalPath(dir), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    const pruned = pruneSnapshots(entry.clientId, dir);
    if (pruned.ok) clearPruneFailure(entry.clientId, dir);
    else markPruneFailure(entry.clientId, pruned.error, dir);
  } catch (error) {
    console.error(`[integrations] post-commit maintenance failed: ${String(error)}`);
  }
}

/** Newest first. A torn final line (crash mid-append) is skipped, not thrown. */
export function listOperations(
  clientId?: IntegrationClientId,
  limit = 50,
  dir: string = integrationsDir(),
): JournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(journalPath(dir), "utf8");
  } catch {
    return [];
  }
  const rows: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalEntry;
      if (!clientId || parsed.clientId === clientId) rows.push(parsed);
    } catch {
      // Torn line from an interrupted append; the rest of the log is still good.
    }
  }
  return rows.reverse().slice(0, limit);
}

export function findOperation(opId: string, dir: string = integrationsDir()): JournalEntry | null {
  return listOperations(undefined, Number.MAX_SAFE_INTEGER, dir).find(row => row.opId === opId) ?? null;
}

/** Resolves the tag against what is actually on disk now. */
export function readSnapshot(
  entry: JournalEntry,
  dir: string = integrationsDir(),
): { kind: "none" } | { kind: "stored"; text: string; path: string } | { kind: "expired" } {
  if (entry.snapshot.kind === "none") return { kind: "none" };
  if (entry.snapshot.kind === "expired") return { kind: "expired" };
  // Derive the path from validated identifiers rather than trusting the
  // persisted relPath, then verify containment either way.
  const abs = containedPath(dir, entry.snapshot.relPath);
  if (!existsSync(abs)) return { kind: "expired" };
  return { kind: "stored", text: readFileSync(abs, "utf8"), path: abs };
}

/**
 * Snapshot files retained right now — the witness for `retentionDegraded`.
 *
 * `null` means "cannot inspect", which is NOT the same as zero: reporting an
 * unreadable snapshot directory as a healthy empty one would hide the
 * unbounded, credential-bearing pile this field exists to disclose.
 */
export function countSnapshots(
  clientId: IntegrationClientId,
  dir: string = integrationsDir(),
): number | null {
  try {
    return readdirSync(snapshotDir(clientId, dir)).length;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
  }
}

/**
 * Keep the newest N snapshot files per client; journal rows always survive.
 * Structured rather than throwing or swallowing: a swallowed failure would let
 * credential-bearing snapshots pile up while every operation reported success.
 */
export function pruneSnapshots(
  clientId: IntegrationClientId,
  dir: string = integrationsDir(),
): { ok: true } | { ok: false; error: string } {
  /*
   * Filter to rows that HAVE a snapshot first, then take the newest N.
   *
   * Taking the newest N operations and filtering afterwards counted rows that
   * never stored anything: an apply-to-absent records `snapshot: none`, so a
   * client whose history alternates stored and none kept only half the backups
   * the contract promises. The docs say ten backups per client, and this is
   * the code that has to make that true.
   */
  const keep = new Set(
    listOperations(clientId, Number.MAX_SAFE_INTEGER, dir)
      .filter(row => row.snapshot.kind === "stored")
      .slice(0, SNAPSHOT_RETENTION)
      .map(row => row.opId),
  );
  let names: string[];
  try {
    names = readdirSync(snapshotDir(clientId, dir));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true };
    return { ok: false, error: String(error) };
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    try {
      rmSync(join(snapshotDir(clientId, dir), name), { force: true });
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
  return { ok: true };
}

export interface MaintenanceState {
  pruneFailures: Partial<Record<IntegrationClientId, { at: string; error: string }>>;
}

function maintenancePath(dir: string): string {
  return join(dir, "maintenance.json");
}

/**
 * Validates rather than casts: `{}` parses fine and would leave `pruneFailures`
 * undefined, so the next mark/clear would throw AFTER the journal row was
 * committed — producing the phantom row the write ordering exists to prevent.
 */
export function readMaintenance(dir: string = integrationsDir()): MaintenanceState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(maintenancePath(dir), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = (parsed as { pruneFailures?: unknown }).pruneFailures;
      const failures: MaintenanceState["pruneFailures"] = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (!isIntegrationClientId(key)) continue;
          if (!value || typeof value !== "object") continue;
          const { at, error } = value as { at?: unknown; error?: unknown };
          if (typeof at !== "string" || typeof error !== "string") continue;
          failures[key] = { at, error };
        }
      }
      return { pruneFailures: failures };
    }
  } catch {
    // Absent or corrupt: no pending retries known.
  }
  return { pruneFailures: {} };
}

function writeMaintenance(state: MaintenanceState, dir: string): void {
  try {
    ensureDir(maintenancePath(dir));
    atomicWriteFile(maintenancePath(dir), `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    // The marker is an optimization for scheduling retries. `retentionDegraded`
    // is derived from the snapshot count, so losing it costs a retry, not the
    // claim — a durable promise must not depend on a write that can fail.
    console.error(`[integrations] could not record maintenance state: ${String(error)}`);
  }
}

export function markPruneFailure(
  clientId: IntegrationClientId,
  error: string,
  dir: string = integrationsDir(),
): void {
  const state = readMaintenance(dir);
  state.pruneFailures[clientId] = { at: new Date().toISOString(), error };
  writeMaintenance(state, dir);
}

export function clearPruneFailure(
  clientId: IntegrationClientId,
  dir: string = integrationsDir(),
): void {
  const state = readMaintenance(dir);
  if (!(clientId in state.pruneFailures)) return;
  delete state.pruneFailures[clientId];
  writeMaintenance(state, dir);
}

/** Re-attempt every marked client. */
export function retryPendingPrunes(dir: string = integrationsDir()): void {
  for (const clientId of Object.keys(readMaintenance(dir).pruneFailures) as IntegrationClientId[]) {
    if (pruneSnapshots(clientId, dir).ok) clearPruneFailure(clientId, dir);
  }
}
