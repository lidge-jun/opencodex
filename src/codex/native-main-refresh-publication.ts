import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFile, resolveWriteTarget } from "../config/atomic-write";
import { PreservingReplaceError, replaceFilePreservingTarget, restoreFilePreservingTarget } from "../lib/atomic-file-preserving-replace";
import type { NativeProfileContext } from "./native-profile-store";

const JOURNAL = ".opencodex-native-main-refresh.json";
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Journal = {
  version: 1;
  transactionId: string;
  targetPath: string;
  stagedBasename: string;
  previousBasename: string;
  phase: "prepared" | "replaced";
  expectedSha256: string;
  replacementSha256: string;
};

export class NativeMainRefreshPublicationError extends Error {
  constructor(options?: ErrorOptions) {
    super("Native credential refresh could not be published.", options);
    this.name = "NativeMainRefreshPublicationError";
  }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fsync(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function journalPath(context: NativeProfileContext): string {
  return join(context.codexHome, JOURNAL);
}

function validJournal(value: unknown): value is Journal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const transactionId = typeof item.transactionId === "string" ? item.transactionId : "";
  return item.version === 1
    && TRANSACTION_ID.test(transactionId)
    && typeof item.targetPath === "string"
    && item.targetPath.length > 0
    && item.stagedBasename === `.opencodex-native-main-refresh.${transactionId}.new`
    && item.previousBasename === `.opencodex-native-main-refresh.${transactionId}.previous`
    && (item.phase === "prepared" || item.phase === "replaced")
    && /^[0-9a-f]{64}$/.test(String(item.expectedSha256))
    && /^[0-9a-f]{64}$/.test(String(item.replacementSha256))
    && item.expectedSha256 !== item.replacementSha256;
}

function readExact(path: string): Buffer | null {
  try { return readFileSync(path); } catch { return null; }
}

function removeExact(path: string): void {
  try { unlinkSync(path); } catch (cause) { throw new NativeMainRefreshPublicationError({ cause }); }
}

function resolveAuthTarget(context: NativeProfileContext): string {
  try {
    return resolveWriteTarget(context.authPath);
  } catch (cause) {
    throw new NativeMainRefreshPublicationError({ cause });
  }
}

function assertAuthTarget(context: NativeProfileContext, expectedTarget: string): void {
  if (resolveAuthTarget(context) !== expectedTarget) throw new NativeMainRefreshPublicationError();
}

function journalPaths(journal: Journal): { staged: string; previous: string } {
  const targetDir = dirname(journal.targetPath);
  return {
    staged: join(targetDir, journal.stagedBasename),
    previous: join(targetDir, journal.previousBasename),
  };
}

function cleanup(context: NativeProfileContext, journal: Journal): void {
  const { staged, previous } = journalPaths(journal);
  for (const path of [staged, previous, journalPath(context)]) {
    if (existsSync(path)) removeExact(path);
  }
}

/** Recover only a transaction whose exact hashes prove one deterministic outcome. */
export function recoverNativeMainRefreshPublication(context: NativeProfileContext): void {
  const path = journalPath(context);
  if (!existsSync(path)) return;
  let journal: Journal;
  try { journal = JSON.parse(readFileSync(path, "utf8")) as Journal; } catch (cause) { throw new NativeMainRefreshPublicationError({ cause }); }
  if (!validJournal(journal)) throw new NativeMainRefreshPublicationError();
  assertAuthTarget(context, journal.targetPath);
  const { staged, previous } = journalPaths(journal);
  const canonical = readExact(journal.targetPath);
  const stagedBytes = readExact(staged);
  const displacedPath = process.platform === "win32" ? previous : staged;
  const rollbackPath = process.platform === "win32" ? staged : previous;
  const displacedBytes = readExact(displacedPath);
  if (!canonical) throw new NativeMainRefreshPublicationError();
  if (digest(canonical) === journal.expectedSha256 && stagedBytes && digest(stagedBytes) === journal.replacementSha256) {
    try {
      replaceFilePreservingTarget(staged, journal.targetPath, previous);
      cleanup(context, { ...journal, phase: "replaced" });
    } catch (cause) {
      throw new NativeMainRefreshPublicationError({ cause });
    }
    return;
  }
  if (digest(canonical) === journal.replacementSha256) {
    if (journal.phase === "prepared") {
      if (!displacedBytes) throw new NativeMainRefreshPublicationError();
      if (digest(displacedBytes) !== journal.expectedSha256) {
        try {
          restoreFilePreservingTarget(displacedPath, journal.targetPath, rollbackPath);
          const restored = readExact(journal.targetPath);
          if (!restored || !restored.equals(displacedBytes)) throw new NativeMainRefreshPublicationError();
          cleanup(context, journal);
        } catch (cause) {
          throw new NativeMainRefreshPublicationError({ cause });
        }
        return;
      }
    }
    try { cleanup(context, journal); } catch (cause) { throw new NativeMainRefreshPublicationError({ cause }); }
    return;
  }
  throw new NativeMainRefreshPublicationError();
}

/** The sole native-main auth.json publisher. */
export function publishNativeMainRefresh(
  context: NativeProfileContext,
  targetPath: string,
  expected: string,
  replacement: string,
): void {
  const tx = randomUUID();
  const stagedBasename = `.opencodex-native-main-refresh.${tx}.new`;
  const previousBasename = `.opencodex-native-main-refresh.${tx}.previous`;
  const journal: Journal = {
    version: 1,
    transactionId: tx,
    targetPath,
    stagedBasename,
    previousBasename,
    phase: "prepared",
    expectedSha256: digest(expected),
    replacementSha256: digest(replacement),
  };
  const { staged, previous } = journalPaths(journal);
  try {
    assertAuthTarget(context, targetPath);
    if (digest(readFileSync(targetPath)) !== journal.expectedSha256) throw new NativeMainRefreshPublicationError();
    atomicWriteFile(staged, replacement);
    fsync(staged);
    atomicWriteFile(journalPath(context), `${JSON.stringify(journal)}\n`);
    assertAuthTarget(context, targetPath);
    if (digest(readFileSync(targetPath)) !== journal.expectedSha256) throw new NativeMainRefreshPublicationError();
    replaceFilePreservingTarget(staged, targetPath, previous);
    const displaced = readExact(process.platform === "win32" ? previous : staged);
    if (!displaced || digest(displaced) !== journal.expectedSha256) {
      const canonical = readExact(targetPath);
      if (canonical && digest(canonical) === journal.replacementSha256) {
        restoreFilePreservingTarget(
          process.platform === "win32" ? previous : staged,
          targetPath,
          process.platform === "win32" ? staged : previous,
        );
        cleanup(context, journal);
      }
      throw new NativeMainRefreshPublicationError();
    }
    const canonical = readExact(targetPath);
    if (!canonical || digest(canonical) !== journal.replacementSha256) {
      throw new NativeMainRefreshPublicationError();
    }
    atomicWriteFile(journalPath(context), `${JSON.stringify({ ...journal, phase: "replaced" })}\n`);
    cleanup(context, journal);
  } catch (cause) {
    if (cause instanceof NativeMainRefreshPublicationError) throw cause;
    if (cause instanceof PreservingReplaceError) throw new NativeMainRefreshPublicationError({ cause });
    throw new NativeMainRefreshPublicationError({ cause });
  }
}

export function nativeMainRefreshJournalBasename(): string {
  return basename(JOURNAL);
}
