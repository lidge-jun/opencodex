import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { PreservingReplaceError, replaceFilePreservingTarget, restoreFilePreservingTarget } from "../lib/atomic-file-preserving-replace";
import type { NativeProfileContext } from "./native-profile-store";

const JOURNAL = ".opencodex-native-main-refresh.json";
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Journal = {
  version: 1;
  transactionId: string;
  stagedBasename: string;
  previousBasename: string;
  phase: "prepared" | "replaced";
  expectedSha256: string;
  replacementSha256: string;
};

export class NativeMainRefreshPublicationError extends Error {
  constructor() {
    super("Native credential refresh could not be published.");
    this.name = "NativeMainRefreshPublicationError";
  }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fsync(path: string): void {
  const fd = openSync(path, "r");
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
  try { unlinkSync(path); } catch { throw new NativeMainRefreshPublicationError(); }
}

function journalPaths(context: NativeProfileContext, journal: Journal): { staged: string; previous: string } {
  return {
    staged: join(context.codexHome, journal.stagedBasename),
    previous: join(context.codexHome, journal.previousBasename),
  };
}

function cleanup(context: NativeProfileContext, journal: Journal): void {
  const { staged, previous } = journalPaths(context, journal);
  for (const path of [staged, previous, journalPath(context)]) {
    if (existsSync(path)) removeExact(path);
  }
}

/** Recover only a transaction whose exact hashes prove one deterministic outcome. */
export function recoverNativeMainRefreshPublication(context: NativeProfileContext): void {
  const path = journalPath(context);
  if (!existsSync(path)) return;
  let journal: Journal;
  try { journal = JSON.parse(readFileSync(path, "utf8")) as Journal; } catch { throw new NativeMainRefreshPublicationError(); }
  if (!validJournal(journal)) throw new NativeMainRefreshPublicationError();
  const { staged, previous } = journalPaths(context, journal);
  const canonical = readExact(context.authPath);
  const stagedBytes = readExact(staged);
  const previousBytes = readExact(previous);
  if (!canonical) throw new NativeMainRefreshPublicationError();
  if (digest(canonical) === journal.expectedSha256 && stagedBytes && digest(stagedBytes) === journal.replacementSha256) {
    replaceFilePreservingTarget(staged, context.authPath, previous);
    cleanup(context, { ...journal, phase: "replaced" });
    return;
  }
  if (digest(canonical) === journal.replacementSha256
    && ((stagedBytes && digest(stagedBytes) === journal.expectedSha256)
      || (previousBytes && digest(previousBytes) === journal.expectedSha256))) {
    cleanup(context, journal);
    return;
  }
  throw new NativeMainRefreshPublicationError();
}

/** The sole native-main auth.json publisher. */
export function publishNativeMainRefresh(
  context: NativeProfileContext,
  expected: string,
  replacement: string,
): void {
  const tx = randomUUID();
  const stagedBasename = `.opencodex-native-main-refresh.${tx}.new`;
  const previousBasename = `.opencodex-native-main-refresh.${tx}.previous`;
  const journal: Journal = {
    version: 1,
    transactionId: tx,
    stagedBasename,
    previousBasename,
    phase: "prepared",
    expectedSha256: digest(expected),
    replacementSha256: digest(replacement),
  };
  const staged = join(context.codexHome, stagedBasename);
  const previous = join(context.codexHome, previousBasename);
  try {
    if (digest(readFileSync(context.authPath)) !== journal.expectedSha256) throw new NativeMainRefreshPublicationError();
    atomicWriteFile(staged, replacement);
    fsync(staged);
    atomicWriteFile(journalPath(context), `${JSON.stringify(journal)}\n`);
    replaceFilePreservingTarget(staged, context.authPath, previous);
    const displaced = readExact(process.platform === "win32" ? previous : staged);
    if (!displaced || digest(displaced) !== journal.expectedSha256) {
      const canonical = readExact(context.authPath);
      if (canonical && digest(canonical) === journal.replacementSha256) {
        restoreFilePreservingTarget(
          process.platform === "win32" ? previous : staged,
          context.authPath,
          process.platform === "win32" ? staged : previous,
        );
      }
      throw new NativeMainRefreshPublicationError();
    }
    const canonical = readExact(context.authPath);
    if (!canonical || digest(canonical) !== journal.replacementSha256) {
      throw new NativeMainRefreshPublicationError();
    }
    atomicWriteFile(journalPath(context), `${JSON.stringify({ ...journal, phase: "replaced" })}\n`);
    cleanup(context, journal);
  } catch (error) {
    if (error instanceof NativeMainRefreshPublicationError || error instanceof PreservingReplaceError) {
      throw new NativeMainRefreshPublicationError();
    }
    throw new NativeMainRefreshPublicationError();
  }
}

export function nativeMainRefreshJournalBasename(): string {
  return basename(JOURNAL);
}
