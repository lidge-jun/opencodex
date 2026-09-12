import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { renameAtomicFile } from "../../lib/windows-atomic-replace";
import { TRASH_DIR, TRASH_EPOCH_DIR, chmodPrivatePath } from "./paths";

/** Accepted destination paths from every valid in-progress restore marker under `.trash`. */
export function collectRestorePendingAcceptedDestRels(codexHome: string): Set<string> {
  const out = new Set<string>();
  const trashRoot = join(codexHome, TRASH_DIR);
  if (!existsSync(trashRoot)) return out;
  for (const name of readdirSync(trashRoot)) {
    if (!TRASH_EPOCH_DIR.test(name)) continue;
    const read = readRestorePending(join(trashRoot, name));
    if (read.status !== "valid") continue;
    for (const rel of read.state.acceptedDestRels) out.add(rel);
  }
  return out;
}

/** Marks an incomplete restore so retries can accept dest files and resume metadata. */
export const RESTORE_PENDING_FILE = "restore-pending.json";

export interface RestorePendingSections {
  state: boolean;
  logs: boolean;
  memories: boolean;
  goals: boolean;
}

export interface RestorePendingState {
  version: 1;
  filesRestored: true;
  /**
   * Planned CODEX_HOME-relative destinations for this restore attempt.
   * Written before moves so a mid-loop failure can still accept placed dests
   * on resume while finishing files that remain staged.
   */
  acceptedDestRels: string[];
  /** Sections that still need reconciliation on retry. */
  pending: RestorePendingSections;
}

type RestorePendingRead =
  | { status: "missing" }
  | { status: "valid"; state: RestorePendingState }
  | { status: "invalid" };

let _restorePendingSeq = 0;

function parseRestorePendingState(raw: unknown): RestorePendingState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || o.filesRestored !== true) return null;
  if (!Array.isArray(o.acceptedDestRels)) return null;
  const acceptedDestRels = o.acceptedDestRels.filter((r): r is string => typeof r === "string");
  if (acceptedDestRels.length !== o.acceptedDestRels.length) return null;
  const pendingRaw = o.pending;
  if (!pendingRaw || typeof pendingRaw !== "object" || Array.isArray(pendingRaw)) return null;
  const p = pendingRaw as Record<string, unknown>;
  if (
    typeof p.state !== "boolean"
    || typeof p.logs !== "boolean"
    || typeof p.memories !== "boolean"
    || typeof p.goals !== "boolean"
  ) {
    return null;
  }
  return {
    version: 1,
    filesRestored: true,
    acceptedDestRels,
    pending: {
      state: p.state,
      logs: p.logs,
      memories: p.memories,
      goals: p.goals,
    },
  };
}

/**
 * Distinguish a missing marker from a present-but-malformed one. An invalid marker
 * must never be treated as a fresh restore (that would ignore already-moved files).
 */
export function readRestorePending(stageDir: string): RestorePendingRead {
  const path = join(stageDir, RESTORE_PENDING_FILE);
  if (!existsSync(path)) return { status: "missing" };
  try {
    const state = parseRestorePendingState(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (!state) return { status: "invalid" };
    return { status: "valid", state };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * Atomically replace restore-pending.json: private temp in the stage, fsync, then rename.
 * An interrupted update leaves the previous valid marker intact.
 */
export function writeRestorePending(
  stageDir: string,
  state: RestorePendingState,
  options?: { failBeforeRename?: boolean; failWrite?: boolean },
): void {
  if (options?.failWrite) throw new Error("test_fail_pending_write");
  const dest = join(stageDir, RESTORE_PENDING_FILE);
  const tmp = join(stageDir, `${RESTORE_PENDING_FILE}.${process.pid}.${++_restorePendingSeq}.tmp`);
  const payload = JSON.stringify(state);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, payload, null, "utf8");
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* */ }
    try { unlinkSync(tmp); } catch { /* */ }
    throw error;
  }
  closeSync(fd);
  chmodPrivatePath(tmp, 0o600);
  if (options?.failBeforeRename) {
    try { unlinkSync(tmp); } catch { /* */ }
    throw new Error("test_fail_pending_rename");
  }
  try {
    renameAtomicFile(tmp, dest, undefined, "storage-cleanup");
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* */ }
    throw error;
  }
}
