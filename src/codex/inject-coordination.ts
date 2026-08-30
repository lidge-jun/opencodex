/**
 * Coordination helpers for the native Codex write section.
 *
 * Split out of `inject.ts` so the injection function keeps reading as the
 * sequence it is, rather than doubling in length around the lock.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";

import { atomicWriteFile } from "../config";
import type { CodexWriteLockResult } from "./codex-write-lock";
import { inspectCodexCoordinatorPath } from "./coordinator-doctor";
import { JOURNAL_PATH } from "./journal";
import { updateIntegrationRecord } from "./integration-record";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH } from "./paths";
import type {
  CodexArtifactId,
  CodexProvenanceEntry,
  CodexProvenanceLedger,
} from "./convergence-types";
import {
  codexWriteCoordination,
  type CodexWriteCandidate,
  type CodexWriteCoordination,
  type CodexWriteEvidence,
} from "./write-coordination";

/** Bounded so a stuck holder cannot wedge `ocx start` indefinitely. */
export const DEFAULT_INJECT_LOCK_TIMEOUT_MS = 5_000;

/**
 * Can this home be coordinated at all, decided BEFORE any lock attempt?
 *
 * The order matters and is not stylistic. `assertInitialStateCanBeCreated`
 * refuses to create the first coordinator row while native routing residue
 * exists (`transition-state.ts:268-280`) — correctly, because installing
 * `{0,null}` over routed bytes would erase the only evidence that an
 * interrupted transition needs salvage. But "already routed, no coordinator
 * row" is the state of every install predating this substrate, so a "try the
 * lock, fall back on refusal" shape would attempt acquisition on the entire
 * installed base. Deciding first means that refusal path is never entered.
 *
 * `legacy-uncoordinated` is a temporary boundary, not a design: the
 * compatibility-adoption contract (`005_contract.md:709-779`) records an
 * existing routed home into the coordinator, and once that lands this branch
 * narrows to homes not yet adopted.
 */
export type CodexWriteCoordinationEligibility =
  | { kind: "coordinated" }
  | { kind: "adopt" }
  | { kind: "legacy-uncoordinated"; reason: string }
  | { kind: "refused"; reason: string };

/**
 * A live SQLite creator exposes a zero-byte pathname before BEGIN IMMEDIATE.
 * Requiring a settled filesystem age makes that scheduling window remain on
 * the coordinated path while old crash remnants can use the legacy boundary.
 */
export const STABLE_ZERO_BYTE_COORDINATOR_AGE_MS = 1_000;

export function codexWriteCoordinationEligibility(deps: {
  coordinatorPath: () => string;
  residue: () => { kind: string };
  integrationRecord: () => { kind: string };
  nowMs?: () => number;
}): CodexWriteCoordinationEligibility {
  let coordinatorExists: boolean;
  let coordinatorIsStableZeroByte = false;
  try {
    const path = deps.coordinatorPath();
    coordinatorExists = existsSync(path);
    if (coordinatorExists) {
      const entry = lstatSync(path);
      if (entry.isFile() && !entry.isSymbolicLink() && entry.size === 0) {
        const diagnostic = inspectCodexCoordinatorPath(path);
        if (diagnostic.kind === "zero-byte") {
          const lastIdentityChange = Math.max(diagnostic.identity.mtimeMs, diagnostic.identity.ctimeMs);
          coordinatorIsStableZeroByte = (deps.nowMs?.() ?? Date.now()) - lastIdentityChange
            >= STABLE_ZERO_BYTE_COORDINATOR_AGE_MS;
        }
      }
    }
  } catch (error) {
    return { kind: "refused", reason: `the coordinator path could not be resolved: ${String(error)}` };
  }

  // Every existing coordinator remains authoritative unless it is proven to be
  // an old, immutable SQLite-empty remnant. The age gate is part of that proof:
  // a live creator exposes the same zero-byte pathname briefly before taking N,
  // and sending that fresh file down the legacy path would bypass its lock.
  // Non-empty, fresh, unsafe, changed, unversioned, and rowless files therefore
  // stay coordinated and are validated/refused by the transaction owner.
  //
  // We do NOT initialize or adopt it here. Clean homes still enter the
  // coordinated path, whose SQLite transaction safely initializes it. Routed
  // or indeterminate legacy homes keep the same uncoordinated compatibility
  // boundary they would have had if the remnant pathname were absent.
  if (coordinatorExists && !coordinatorIsStableZeroByte) return { kind: "coordinated" };

  const record = deps.integrationRecord();
  if (record.kind === "invalid") {
    return { kind: "refused", reason: "the Codex integration record is invalid" };
  }

  const residue = deps.residue();
  if (residue.kind === "clean") return { kind: "coordinated" };
  if (residue.kind === "residue" && !coordinatorIsStableZeroByte) return { kind: "adopt" };
  /*
   * Everything else keeps the path it has always had.
   *
   * `residue` is a pre-substrate routed home; `indeterminate` means the
   * classifier could not read what is there — a profile it cannot parse, for
   * instance, which is an ordinary re-injection over an older file rather than
   * a hazard.
   *
   * Neither may CREATE a coordinator row: doing that over unclassified or
   * routed bytes would erase the evidence an interrupted transition needs. But
   * refusing the injection outright, which an earlier draft of this function
   * did for `indeterminate`, breaks re-injection on homes that work today —
   * caught by the shipped restore tests rather than by review. Declining to
   * coordinate is the correct scope of the refusal; declining to write is not.
   */
  return {
    kind: "legacy-uncoordinated",
    reason: coordinatorIsStableZeroByte
      ? "the coordinator is a zero-byte non-authoritative remnant and this routed home has not been adopted yet"
      : residue.kind === "residue"
      ? "this home was routed before write coordination existed and has not been adopted yet"
      : "the existing native Codex state could not be classified, so it cannot seed a coordinator row",
  };
}

/** The transition row rejected this publication; a conflict, not an exception. */
export class CodexWriteConflictError extends Error {
  readonly code = "CODEX_WRITE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "CodexWriteConflictError";
  }
}

/**
 * A write failed AND its compensation failed.
 *
 * Carries which surfaces are unrestored, never their contents — this reaches
 * logs and HTTP responses, and config bytes carry credentials.
 */
export class CodexPartialWriteError extends Error {
  readonly code = "CODEX_PARTIAL_WRITE";
  constructor(readonly unrestored: readonly string[]) {
    super(`Native Codex files are in a partial state; unrestored: ${unrestored.join(", ")}.`);
    this.name = "CodexPartialWriteError";
  }
}

function contentIdentity(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 32);
  } catch {
    return existsSync(path) ? "unreadable" : "absent";
  }
}

export interface CodexPreImages {
  readonly config: string | null;
  readonly profile: string | null;
  readonly journal: string | null;
}

/** `null` means the file was ABSENT, which restoration must reproduce exactly. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function captureCodexPreImages(): CodexPreImages {
  return {
    config: readOrNull(CODEX_CONFIG_PATH),
    profile: readOrNull(CODEX_PROFILE_PATH),
    journal: readOrNull(JOURNAL_PATH),
  };
}

/**
 * How many transactions of evidence the ledger keeps.
 *
 * Each transaction appends three entries, and a `present` baseline embeds the artifact's exact
 * bytes as base64 — a 25 KB `config.toml` is ~34 KB per entry, so roughly 100 KB per transaction.
 * A machine that syncs on every start would grow this file without limit, and it is re-read and
 * re-serialized on every append, so the cost is quadratic rather than merely large.
 *
 * A ledger is evidence, not an archive. The most recent transactions are the ones anyone
 * diagnoses against, so the window keeps those and drops the oldest.
 */
export const CODEX_PROVENANCE_MAX_TRANSACTIONS = 16;

/**
 * How many serialized bytes of evidence the ledger keeps.
 *
 * The transaction window alone bounds the ledger only if each transaction is small, and a
 * baseline embeds the artifact's exact bytes. Those artifacts sit outside this proxy's trust
 * boundary: a native `config.toml` grown to hundreds of megabytes is copied into the record as
 * base64 and re-serialized on every append, so a single oversized file turns a 16-transaction
 * window into a multi-gigabyte write.
 *
 * The size is derived from the window above rather than picked: the 25 KB `config.toml` that
 * comment describes measures 100.8 KiB per transaction, so a full 16-transaction window is
 * 1.58 MiB. 4 MiB leaves that ordinary window untouched with room to spare while still refusing
 * the pathological case, and a regression test pins the ordinary window so the two cannot drift
 * apart silently.
 */
export const CODEX_PROVENANCE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Measure the representation the integration-record writer actually emits.
 *
 * The minimal wrapper reproduces the final indentation depth of `provenance.entries`, including
 * structured unknown extension fields preserved from older records. Its fixed wrapper makes this
 * slightly conservative as a ledger-only ceiling, which is preferable to admitting an entry that
 * expands past the limit when `JSON.stringify(record, null, 2)` writes it.
 */
function serializedProvenanceBytes(
  entries: readonly CodexProvenanceEntry[],
  ledger: CodexProvenanceLedger | undefined,
): number {
  return Buffer.byteLength(`${JSON.stringify({
    version: 1,
    provenance: { ...ledger, entries },
  }, null, 2)}\n`, "utf-8");
}

function provenanceBaseline(bytes: string | null): CodexProvenanceEntry["baseline"] {
  if (bytes === null) return { kind: "absent" };
  return {
    kind: "present",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytesBase64: Buffer.from(bytes).toString("base64"),
  };
}

function provenancePostImage(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Keep the newest transactions that fit both the transaction window and the byte ceiling, whole.
 *
 * Trimming by ENTRY count would cut a transaction in half and leave evidence that says a
 * transaction touched two artifacts when it touched three — worse than dropping it outright,
 * because a partial record still reads as complete. Order is preserved; only whole transactions
 * are removed.
 *
 * The byte ceiling applies the same rule: a transaction that does not fit is omitted whole,
 * including the newest one — a record silently truncated to fit would be read as a faithful
 * pre-image. An oversized transaction is skipped rather than ending the scan, so one pathological
 * artifact cannot erase the smaller transactions that still fit and are still diagnosable.
 */
export function boundProvenanceEntries(
  entries: readonly CodexProvenanceEntry[],
  maxTransactions = CODEX_PROVENANCE_MAX_TRANSACTIONS,
  maxBytes = CODEX_PROVENANCE_MAX_BYTES,
  ledger?: CodexProvenanceLedger,
): readonly CodexProvenanceEntry[] {
  const transactions = new Map<string, CodexProvenanceEntry[]>();
  for (const entry of entries) {
    const transaction = transactions.get(entry.txId);
    if (transaction) transaction.push(entry);
    else transactions.set(entry.txId, [entry]);
  }
  const order = [...transactions.keys()];
  if (order.length <= maxTransactions) {
    const baselineBytes = entries.reduce(
      (total, entry) => total + (entry.baseline.kind === "present" ? entry.baseline.bytesBase64.length : 0),
      0,
    );
    if (
      baselineBytes <= maxBytes
      && serializedProvenanceBytes(entries, ledger) <= maxBytes
    ) return entries;
  }
  // Newest first, so the transactions anyone diagnoses against are the ones that fit.
  const keep = new Set<string>();
  let baselineBytes = 0;
  for (let i = order.length - 1; i >= 0 && keep.size < maxTransactions; i--) {
    const txId = order[i]!;
    const txEntries = transactions.get(txId)!;
    // Measure the embedded pre-images first: a pathological baseline is refused without
    // serializing it, so the ceiling does not itself allocate the payload it exists to reject.
    const transactionBaselineBytes = txEntries.reduce(
      (total, entry) => total + (entry.baseline.kind === "present" ? entry.baseline.bytesBase64.length : 0),
      0,
    );
    if (baselineBytes + transactionBaselineBytes > maxBytes) continue;
    const candidateKeep = new Set(keep);
    candidateKeep.add(txId);
    // Reuse the already-grouped transactions: this avoids another full-ledger filter on each
    // iteration while preserving the original transaction and entry order.
    const candidateEntries = order.flatMap(id =>
      candidateKeep.has(id) ? transactions.get(id)! : []
    );
    if (serializedProvenanceBytes(candidateEntries, ledger) > maxBytes) continue;
    baselineBytes += transactionBaselineBytes;
    keep.add(txId);
  }
  if (keep.size === order.length) return entries;
  return entries.filter(entry => keep.has(entry.txId));
}

/** Append evidence for an already-committed native transaction, best-effort. */
export function recordCodexNativeTransactionProvenance(
  preImages: CodexPreImages,
  txId: string,
) {
  const at = new Date().toISOString();
  const surfaces: readonly [CodexArtifactId, string, string | null][] = [
    [{ kind: "config" }, CODEX_CONFIG_PATH, preImages.config],
    [{ kind: "generated-profile" }, CODEX_PROFILE_PATH, preImages.profile],
    [{ kind: "injection-journal" }, JOURNAL_PATH, preImages.journal],
  ];
  const entries: readonly CodexProvenanceEntry[] = surfaces.map(([artifact, path, baseline]) => ({
    artifact,
    baseline: provenanceBaseline(baseline),
    postImage: provenancePostImage(path),
    txId,
    at,
  }));
  return updateIntegrationRecord(record => {
    const previousLedger = record.provenance;
    // Unknown ledger extensions are forward-compatible and must be preserved. If those fixed
    // fields alone exceed the ceiling, no entry selection can make the write compliant. Keep the
    // existing record byte-for-byte instead of deleting all known evidence and rewriting the
    // same oversized extension on every native transaction.
    if (
      previousLedger
      && serializedProvenanceBytes([], previousLedger) > CODEX_PROVENANCE_MAX_BYTES
    ) return record;
    return {
      ...record,
      provenance: {
        ...previousLedger,
        entries: boundProvenanceEntries(
          [...(previousLedger?.entries ?? []), ...entries],
          CODEX_PROVENANCE_MAX_TRANSACTIONS,
          CODEX_PROVENANCE_MAX_BYTES,
          previousLedger,
        ),
      },
    };
  });
}

/**
 * Put back exactly what was there, and report honestly when that fails.
 *
 * Every surface is attempted even after one fails: a second failure is worth
 * knowing about, and stopping early would leave more unrestored than necessary.
 */
export function restoreCodexPreImages(
  pre: CodexPreImages,
): { complete: boolean; unrestored: readonly string[] } {
  const unrestored: string[] = [];
  const surfaces: readonly [string, string, string | null][] = [
    ["config", CODEX_CONFIG_PATH, pre.config],
    ["profile", CODEX_PROFILE_PATH, pre.profile],
    ["journal", JOURNAL_PATH, pre.journal],
  ];
  for (const [name, path, bytes] of surfaces) {
    try {
      if (bytes === null) {
        // Absent before, so absent after. A leftover file is not a restoration.
        if (existsSync(path)) require("node:fs").unlinkSync(path);
      } else if (readOrNull(path) !== bytes) {
        atomicWriteFile(path, bytes);
      }
    } catch {
      unrestored.push(name);
    }
  }
  return { complete: unrestored.length === 0, unrestored };
}

export function buildInjectWitness(
  candidate: CodexWriteCandidate,
  nativeInput: string,
  persistedIdentity: string,
  generation: CodexWriteEvidence["generation"],
  observedOwnership: CodexWriteCoordination["observedOwnership"],
): CodexWriteCoordination {
  return codexWriteCoordination(
    candidate,
    {
      nativeInputIdentity: createHash("sha256").update(nativeInput).digest("hex"),
      persistedIdentity,
      generation,
      journalIdentity: contentIdentity(JOURNAL_PATH),
      canonicalTargets: {
        config: CODEX_CONFIG_PATH,
        profile: CODEX_PROFILE_PATH,
        journal: JOURNAL_PATH,
      },
    },
    observedOwnership,
  );
}

/**
 * The under-lock re-read.
 *
 * The candidate bytes are fixed — they were computed before acquisition and do
 * not change — so what is re-read is the EVIDENCE: the native input on disk, the
 * journal, the generation from the open transaction. A comparison that copied
 * those forward would match itself and prove nothing.
 */
export function recomputeInjectWitness(options: {
  candidate: CodexWriteCandidate;
  canonicalTargets: CodexWriteEvidence["canonicalTargets"];
  persistedIdentity: string;
  generation: CodexWriteEvidence["generation"];
  observedOwnership: CodexWriteCoordination["observedOwnership"];
}): CodexWriteCoordination {
  const nativeInput = readOrNull(options.canonicalTargets.config) ?? "";
  return codexWriteCoordination(
    options.candidate,
    {
      nativeInputIdentity: createHash("sha256").update(nativeInput).digest("hex"),
      persistedIdentity: options.persistedIdentity,
      generation: options.generation,
      journalIdentity: contentIdentity(options.canonicalTargets.journal),
      canonicalTargets: options.canonicalTargets,
    },
    options.observedOwnership,
  );
}

/** Project a non-acquired lock result into the injection result shape. */
export function codexInjectLockOutcome(
  result: Exclude<CodexWriteLockResult<unknown>, { status: "acquired" }>,
): { success: false; message: string; retryable: boolean } | {
  success: true; status: "skipped"; skippedReason: "desired_disabled" | "desired_enabled"; message: string;
} {
  if (result.status === "skipped") {
    return {
      success: true,
      status: "skipped",
      skippedReason: result.reason,
      message: result.reason === "desired_disabled"
        ? "Codex integration is OFF; no Codex config, catalog, cache, or history was changed."
        : "Codex integration was re-enabled; native restore was skipped.",
    };
  }
  if (result.status === "busy") {
    return {
      success: false,
      retryable: true,
      message: `Another process is writing Codex configuration right now (waited ${result.waitedMs}ms). Retry shortly.`,
    };
  }
  return {
    success: false,
    retryable: false,
    message: `Codex configuration was not written: ${result.message}`,
  };
}
