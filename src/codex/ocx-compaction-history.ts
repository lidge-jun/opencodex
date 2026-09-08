import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { getConfigDir } from "../config";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import { renameAtomicFile } from "../lib/windows-atomic-replace";
import {
  decodeCompactionSummary,
  isCompactionItemType,
  SUMMARY_PREFIX,
} from "../responses/compaction";
import { resolveCodexHomeDir } from "./home";
import { resolveCodexStateDbPath } from "./paths";

export interface OcxCompactionRewriteResult {
  content: string;
  replaced: number;
}

export interface OcxCompactionHistoryRecoveryResult {
  rolloutPath: string;
  backupPath: string | null;
  replaced: number;
}

export interface OcxCompactionHistoryRecoveryOptions {
  threadId: string;
  codexHome?: string;
  stateDbPath?: string;
  backupRoot?: string;
  now?: () => Date;
}

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveOwnedRolloutPath(codexHome: string, rawPath: string): string {
  const candidate = resolve(isAbsolute(rawPath) ? rawPath : join(codexHome, rawPath));
  const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]
    .filter(existsSync)
    .map(root => realpathSync.native(root));
  const entry = lstatSync(candidate);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("the referenced rollout is not a regular file");
  }
  const canonical = realpathSync.native(candidate);
  if (!roots.some(root => pathInside(root, canonical))) {
    throw new Error("the referenced rollout is outside Codex session storage");
  }
  return canonical;
}

function writePrivateFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600);
    else hardenSecretPath(path, { required: true, timeoutMemoKey: path });
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function safeRemovePrivateFile(path: string): void {
  try { truncateSync(path, 0); } catch { /* best effort before unlink */ }
  try { unlinkSync(path); } catch { /* caller reports the original failure */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lowerCompactionItem(item: unknown): { item: unknown; changed: boolean } {
  if (!isRecord(item) || !isCompactionItemType(item.type)) {
    return { item, changed: false };
  }
  if (typeof item.encrypted_content !== "string") {
    return { item, changed: false };
  }
  const summary = decodeCompactionSummary(item.encrypted_content);
  if (summary === null) return { item, changed: false };
  return {
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }],
    },
    changed: true,
  };
}

function rewriteJsonlLine(line: string): { line: string; replaced: number } {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return { line, replaced: 0 };
  }
  if (!isRecord(record) || record.type !== "compacted" || !isRecord(record.payload)) {
    return { line, replaced: 0 };
  }
  const history = record.payload.replacement_history;
  if (!Array.isArray(history)) return { line, replaced: 0 };

  let replaced = 0;
  const replacementHistory = history.map(item => {
    const lowered = lowerCompactionItem(item);
    if (lowered.changed) replaced += 1;
    return lowered.item;
  });
  if (replaced === 0) return { line, replaced: 0 };

  return {
    line: JSON.stringify({
      ...record,
      payload: { ...record.payload, replacement_history: replacementHistory },
    }),
    replaced,
  };
}

/**
 * Convert OpenCodeX-owned `ocx1:` compaction items into ordinary replayable user messages.
 *
 * Only the authoritative `compacted.payload.replacement_history` snapshot is changed. Earlier
 * response-item events are historical output and are deliberately preserved byte-for-byte.
 * Native opaque compactions are also untouched because OpenCodeX cannot decode them safely.
 */
export function rewriteOcxCompactionsForNativeReplay(content: string): OcxCompactionRewriteResult {
  const parts = content.split(/(\r?\n)/);
  let replaced = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    if (!line) continue;
    const rewritten = rewriteJsonlLine(line);
    if (rewritten.replaced === 0) continue;
    parts[index] = rewritten.line;
    replaced += rewritten.replaced;
  }
  return replaced === 0
    ? { content, replaced: 0 }
    : { content: parts.join(""), replaced };
}

/**
 * Repair one explicitly selected Codex rollout for direct native replay.
 *
 * The original bytes are copied to an owner-private backup before the rollout is atomically
 * replaced. A last-moment digest check refuses a concurrent Codex append instead of losing it.
 */
export function recoverOcxCompactionHistory(
  options: OcxCompactionHistoryRecoveryOptions,
): OcxCompactionHistoryRecoveryResult {
  if (!THREAD_ID_RE.test(options.threadId)) throw new Error("thread id must be a UUID");
  const codexHome = realpathSync.native(options.codexHome ?? resolveCodexHomeDir());
  const stateDbPath = options.stateDbPath ?? resolveCodexStateDbPath({ codexHome });
  if (!existsSync(stateDbPath)) throw new Error("Codex state database was not found");

  const db = new Database(stateDbPath, { readonly: true });
  let rawRolloutPath: string | undefined;
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    rawRolloutPath = db.query<{ rollout_path: string }, [string]>(
      "SELECT rollout_path FROM threads WHERE id = ? LIMIT 1",
    ).get(options.threadId)?.rollout_path;
  } finally {
    db.close();
  }
  if (!rawRolloutPath) throw new Error("thread was not found in the Codex state database");

  const rolloutPath = resolveOwnedRolloutPath(codexHome, rawRolloutPath);
  const originalBytes = readFileSync(rolloutPath);
  const original = originalBytes.toString("utf8");
  if (!Buffer.from(original, "utf8").equals(originalBytes)) {
    throw new Error("the rollout is not valid UTF-8 and cannot be repaired safely");
  }
  const rewritten = rewriteOcxCompactionsForNativeReplay(original);
  if (rewritten.replaced === 0) {
    return { rolloutPath, backupPath: null, replaced: 0 };
  }

  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const backupDir = resolve(options.backupRoot ?? join(getConfigDir(), "history-recovery-backups", options.threadId));
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = join(backupDir, `${basename(rolloutPath)}.${stamp}.bak`);
  writePrivateFile(backupPath, original);

  const tempPath = `${rolloutPath}.ocx-repair-${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    writePrivateFile(tempPath, rewritten.content);
    if (digest(readFileSync(rolloutPath)) !== digest(originalBytes)) {
      throw new Error("the rollout changed while it was being repaired; close Codex and retry");
    }
    renameAtomicFile(tempPath, rolloutPath);
  } catch (error) {
    safeRemovePrivateFile(tempPath);
    throw error;
  }
  return { rolloutPath, backupPath, replaced: rewritten.replaced };
}
