/**
 * Apply, disable and restore an opencodex provider block in a client's config.
 *
 * Everything here exists to keep one promise: a toggle can always be undone.
 * That means every mutation snapshots first, writes atomically, and journals
 * what it did — and that a mutation refuses rather than guesses whenever the
 * file is not in a state we can reason about. A disable that deletes work the
 * user did after us would be worse than never shipping the feature.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/030 and 031.
 */
import { homedir } from "node:os";
import { dirname } from "node:path";
import { EXPORT_CLIENTS, type ExportModel, type ManagedContribution } from "../clients/config-export";
import { shouldInjectApiAuthHeader } from "../codex/inject";
import type { OcxConfig } from "../types";
import { PARSE_FAILED, defaultIntegrationIO, loadTarget, parseConfig, type IntegrationIO } from "./config-io";
import {
  fingerprint,
  canonicalContribution,
  fragmentPathsOf,
  semanticContribution,
  type OwnershipRecord,
} from "./ownership";
import {
  protectedContributionFingerprint,
  refreshablePathsOf,
  semanticProtectedContributionFingerprint,
} from "./ownership-policy";
import { createdContainerPaths, mergeContribution, removeFragments } from "./merge";
import { INTEGRATION_CLIENTS, isLoopbackOnly, resolveIntegrationPaths, type IntegrationClientId } from "./registry";
import { classifyIntegration, exportContextOf } from "./state";
import type { IntegrationState } from "./state";
import { serializeDocument, UnserializableValueError } from "./serialize";
import { ClientPathError } from "../clients/config-export";
import { matchesOperationResult, newOpId, type JournalEntry } from "./journal";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";
import { patchYamlFragmentSource, sourcePrunableYamlContainers } from "./omp-yaml-source";
import { withIntegrationWriterLock, type IntegrationWriterLockSeams } from "./writer-lock";

export type RefusalReason =
  | "not_installed"
  | "conflict"
  | "unsafe"
  | "non_loopback"
  | "drift_requires_confirm"
  | "snapshot_expired"
  | "write_failed";

export interface WriteOk {
  ok: true;
  changed: boolean;
  state: IntegrationState;
  clientId: IntegrationClientId;
  opId?: string;
  message: string;
}

export interface WriteRefused {
  ok: false;
  reason: RefusalReason;
  state: IntegrationState;
  clientId: IntegrationClientId;
  message: string;
  /** Absolute path of a recoverable snapshot, when one exists. */
  snapshotPath?: string;
  /** True when compensation itself failed and the file is intermediate. */
  residual?: boolean;
}

export type WriteOutcome = WriteOk | WriteRefused;

export interface IntegrationWriteInput {
  clientId: IntegrationClientId;
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  store?: IntegrationStateStore;
  io?: IntegrationIO;
  /** Frozen once by the async coordinator; synchronous callers may omit it. */
  resolvedPaths?: { configPath: string; detectDir: string };
}

export interface IntegrationRestoreInput extends IntegrationWriteInput {
  opId: string;
  confirmDrift?: boolean;
}

function refuse(
  clientId: IntegrationClientId,
  reason: RefusalReason,
  state: IntegrationState,
  message: string,
  snapshotPath?: string,
): WriteRefused {
  return { ok: false, reason, state, clientId, message, ...(snapshotPath ? { snapshotPath } : {}) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CommitArgs {
  io: IntegrationIO;
  store: IntegrationStateStore;
  clientId: IntegrationClientId;
  configPath: string;
  before: string | null;
  nextText: string | null;
  record: OwnershipRecord | null;
  priorRecord: OwnershipRecord | null;
  entry: JournalEntry;
  state: IntegrationState;
  snapshotPath?: string;
}

/**
 * Client file, then ownership record, then journal row.
 *
 * The row is last on purpose: a record without a row is a thin history, while
 * a row without a record would advertise an operation the classifier cannot
 * corroborate. If either bookkeeping step fails we put the file back AND
 * restore the ownership the operation replaced.
 */
function commit(args: CommitArgs): WriteOutcome {
  const { io, clientId, configPath } = args;
  try {
    if (args.nextText === null) io.removeFile(configPath);
    else {
      io.mkdirp(dirname(configPath));
      io.writeText(configPath, args.nextText);
    }
  } catch (error) {
    return refuse(clientId, "write_failed", args.state, messageOf(error), args.snapshotPath);
  }
  try {
    if (args.record) io.putRecord(args.record);
    else io.dropRecord(clientId);
  } catch (error) {
    return compensate(args, error, "could not record ownership");
  }
  try {
    io.appendJournal(args.entry);
  } catch (error) {
    return compensate(args, error, "could not append the journal row");
  }
  return {
    ok: true,
    changed: true,
    state: args.state,
    clientId,
    opId: args.entry.opId,
    message: "ok",
  };
}

function compensate(args: CommitArgs, cause: unknown, what: string): WriteRefused {
  const { io, clientId, configPath } = args;
  try {
    if (args.before === null) io.removeFile(configPath);
    else io.writeText(configPath, args.before);
    if (args.priorRecord) io.putRecord(args.priorRecord);
    else io.dropRecord(clientId);
  } catch {
    // Say so. A false "rolled back" is worse than the original error, because
    // the user would stop looking for the file we left half-written.
    return {
      ok: false,
      reason: "write_failed",
      state: args.state,
      clientId,
      residual: true,
      ...(args.snapshotPath ? { snapshotPath: args.snapshotPath } : {}),
      message: `${what}, and the change could not be rolled back. The file or its ownership record is in an intermediate state; the backup is at ${args.snapshotPath ?? "(none)"}.`,
    };
  }
  return refuse(clientId, "write_failed", args.state, `${what}; the change was rolled back. Cause: ${messageOf(cause)}`, args.snapshotPath);
}

function snapshotAbsPath(store: IntegrationStateStore, entry: JournalEntry): string | undefined {
  const snapshot = store.readSnapshot(entry);
  return snapshot.kind === "stored" ? snapshot.path : undefined;
}

function sourcePreservingFragmentValue(
  contribution: ManagedContribution,
  path: readonly string[],
): unknown | undefined {
  const fragment = contribution.fragments.find(item => (
    item.path.length === path.length
    && item.path.every((key, index) => key === path[index])
  ));
  return fragment?.value;
}

/** Shared preflight: detect, gate, read, parse and classify. */
function preflight(input: IntegrationWriteInput) {
  const store = input.store ?? createIntegrationStateStore();
  const io = input.io ?? defaultIntegrationIO(store);
  const clientId = input.clientId;
  const spec = INTEGRATION_CLIENTS[clientId];
  const exportSpec = EXPORT_CLIENTS[clientId];
  /*
   * Resolution itself can refuse: a relative OPENCLAW_* selector is rejected
   * because we cannot know the gateway's working directory. That is a refusal
   * about the user's configuration, not an internal fault, so it must not
   * escape as an exception — the collection route would answer 500 for the
   * whole Integrations page because one client is misconfigured.
   */
  let configPath: string;
  let detectDir: string;
  try {
    /*
     * Resolve the PAIR, never one half.
     *
     * The coordinated path hands us a frozen pair, but applyIntegration,
     * refreshIntegration and disableIntegration are public and may be called
     * without one. Resolving configPath here and detectDir separately later let
     * an Aside account switch land between the two, so a direct apply could
     * verify account 1 was installed and then write account 0's catalog.
     */
    const resolved = input.resolvedPaths ?? resolveIntegrationPaths(clientId, input.env, input.home);
    configPath = resolved.configPath;
    detectDir = resolved.detectDir;
  } catch (error) {
    if (!(error instanceof ClientPathError)) throw error;
    return { failed: refuse(clientId, "unsafe", "unsafe", error.message) } as const;
  }
  store.retryPendingPrunes();

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return {
      failed: refuse(clientId, "unsafe", "unsafe",
        target.why === "read-failed"
          ? `${configPath} exists but could not be read`
          : `${configPath} is not a regular file`),
    } as const;
  }
  const before = target.before;
  const parsed = parseConfig(before, exportSpec.format);
  if (parsed === PARSE_FAILED) {
    return { failed: refuse(clientId, "unsafe", "unsafe",
      `${configPath} could not be parsed, or holds something opencodex cannot rewrite without changing it (a non-finite number, a large integer or a tiny one a rewrite would round, -0, a duplicate member, or nesting deeper than 1000 levels)`) } as const;
  }
  const contribution = exportSpec.buildContribution(exportContextOf(input));
  // A record proves ownership of the file it was written FOR. Matching only by
  // client id let a record for one home authorize a write to another whose
  // bytes happened to hash the same — which deleted a config we never touched.
  const stored = store.readRecords()[clientId] ?? null;
  const record = stored && stored.clientId === clientId && stored.configPath === configPath
    ? stored
    : null;
  // `configPath`/`clientId` are load-bearing, not decoration: a record proves
  // ownership of ONE file, and the writer mutates whatever path resolves NOW.
  // Without them a record written for another home directory would grant
  // ownership here and disable would delete fragments it never wrote.
  const classified = classifyIntegration({
    fileText: before, fileIsRegular: true, parsed, record, contribution, configPath, clientId,
  });
  return { failed: undefined, store, io, clientId, spec, exportSpec, configPath, detectDir, before, parsed, contribution, record, classified } as const;
}

/**
 * How a conflicted document is treated.
 *
 * `refuse` is the default and the only behavior that existed: a conflict means
 * something we did not write occupies our paths, or our own block was edited,
 * and guessing which one the user meant to keep is how a toggle deletes work.
 *
 * `overwrite` is the explicit escape hatch. It is never reached by a plain
 * apply -- the caller has to ask for it by name -- because the whole value of
 * the refusal is that it cannot be triggered by accident.
 */
type ConflictPolicy = "refuse" | "overwrite";

function applyOrRefreshIntegration(
  input: IntegrationWriteInput,
  allowAbsent: boolean,
  conflictPolicy: ConflictPolicy = "refuse",
): WriteOutcome {
  const pre = preflight(input);
  if (pre.failed) return pre.failed;
  const { store, io, clientId, spec, exportSpec, configPath, detectDir, before, parsed, contribution, record, classified } = pre;

  // The detect directory preflight already resolved, so it cannot name a
  // different account than the config path this operation is about to write.
  if (io.statKind(detectDir) !== "dir") {
    return refuse(clientId, "not_installed", "absent", `${clientId} is not installed`);
  }
  if (isLoopbackOnly(clientId) && shouldInjectApiAuthHeader(input.config)) {
    return refuse(clientId, "non_loopback", classified.state,
      `The generated ${clientId} integration is loopback-only and does not emit the admission header a non-loopback bind requires. Give it loopback access instead, through a tunnel or a local forwarder.`);
  }
  if (classified.state === "conflict") {
    if (conflictPolicy === "refuse") {
      return refuse(clientId, "conflict", "conflict",
        classified.reason === "foreign-edit"
          ? `${configPath} changed after opencodex wrote it`
          : `${configPath} already contains an opencodex block we did not write`);
    }
    /*
     * The caller asked for the overwrite explicitly, so the merge below runs
     * against the document as it stands and our block replaces whatever holds
     * our paths. Everything that makes it recoverable is shared with apply --
     * the snapshot, the atomic write, the compare-before-commit recheck and the
     * journal row all come from the same commit() call -- which is why this is a
     * policy flag on one code path rather than a second implementation.
     */
  }
  /*
   * `unsafe` from the classifier means the document is not one we may write
   * through — today that is a container on our fragment path holding a
   * non-object value the merge would replace with `{}`. Unreadable and
   * unparseable files are caught earlier in preflight; this branch exists
   * because the classifier can also refuse a file it CAN read.
   */
  if (classified.state === "unsafe") {
    return refuse(clientId, "unsafe", "unsafe",
      classified.reason === "blocked-container"
        ? `${configPath} holds a value where opencodex would have to write a section, so applying would replace it`
        : `${configPath} cannot be changed safely`);
  }
  /*
   * An implicit catalog sync is refresh-only. Keeping this decision inside the
   * writer's one preflight closes the read-then-apply race where a user could
   * remove the managed block after a caller classified it as stale and a
   * normal apply would silently recreate it.
   */
  if (classified.state === "absent" && !allowAbsent) {
    return {
      ok: true,
      changed: false,
      state: "absent",
      clientId,
      message: "managed block is absent; refresh did not reconnect it",
    };
  }
  if (classified.state === "current") {
    return { ok: true, changed: false, state: "current", clientId, message: "already applied" };
  }

  // A stale refresh drops what the PREVIOUS record owned before merging: a
  // model that left the catalog would otherwise stay behind as an orphan the
  // new record no longer covers, and disable could never remove it.
  /*
   * The previous record's `createdContainers` has to travel with this removal.
   * Without it the refresh leaves our own empty scaffolding behind in `base`,
   * `createdContainerPaths` then sees the container already present and
   * concludes the user owns it, and the replacement record forgets we made it
   * — so a later disable strands it forever.
   */
  const base = classified.state === "stale" && record
    ? removeFragments(parsed, record.fragmentPaths, new Set(record.createdContainers ?? [])).doc
    : classified.state === "conflict" && record
      /*
       * A forced overwrite of a `foreign-edit` conflict drops what the previous
       * record owned for the same reason a stale refresh does: the replacement
       * record covers the paths we are about to write, so a path the old record
       * owned and the new one does not would be stranded forever, unremovable by
       * any later disable.
       *
       * With NO record -- an `unowned-key` conflict -- there is nothing to drop and
       * the merge runs against the user's document directly. That is correct:
       * createdContainerPaths then attributes every container they already had to
       * them, so a later disable removes our leaves and leaves their structure
       * standing.
       */
      ? removeFragments(parsed, record.fragmentPaths, new Set(record.createdContainers ?? [])).doc
      : parsed;
  // Computed against the document as it stands BEFORE the merge: afterwards
  // every container exists and "did we create this?" is unanswerable.
  const created = createdContainerPaths(base, contribution);
  /*
   * A document can hold a value its own format cannot round-trip through our
   * renderers. That used to throw straight out of the writer and reach the
   * user as a 500 with no path and no advice; it is a refusal like any other,
   * and the file is untouched because this happens before any write.
   */
  const nextDocument = mergeContribution(base, contribution);
  let text: string;
  try {
    if (spec.sourcePreservingYaml && before !== null) {
      const value = sourcePreservingFragmentValue(contribution, spec.sourcePreservingYaml.path);
      const patched = value === undefined
        ? null
        : patchYamlFragmentSource(
            before,
            spec.sourcePreservingYaml.path,
            { kind: "upsert", value },
            nextDocument,
          );
      if (patched === null) {
        return refuse(clientId, "unsafe", "unsafe",
          `${configPath} uses YAML source opencodex cannot patch without risking unrelated comments or formatting, so it was left alone`);
      }
      text = patched;
    } else {
      text = serializeDocument(nextDocument, exportSpec.format);
    }
  } catch (error) {
    if (!(error instanceof UnserializableValueError)) throw error;
    return refuse(clientId, "unsafe", "unsafe",
      `${configPath} contains something opencodex cannot rewrite safely (${error.message}), so it was left alone`);
  }

  // Compare-before-commit: someone may have written between classify and now.
  const recheck = io.readText(configPath);
  const rechecked = recheck.kind === "text" ? recheck.text : recheck.kind === "missing" ? null : undefined;
  if (rechecked === undefined || rechecked !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while applying`);
  }

  const opId = newOpId();
  const snapshot = store.captureSnapshot(clientId, opId, before);
  const at = new Date(io.now()).toISOString();
  const entry: JournalEntry = {
    /*
     * `overwrite` is its own kind rather than reusing `apply`. The rollback list
     * is the one place a user goes after a mistake, and "applied" is a lie about
     * an operation that replaced a block somebody else wrote.
     */
    opId, clientId,
    kind: classified.state === "conflict"
      ? "overwrite"
      : classified.state === "stale" ? "refresh" : "apply",
    at, configPath,
    snapshot, resultFingerprint: fingerprint(text), resultAbsent: false, priorRecord: record,
  };
  const refreshablePaths = refreshablePathsOf(contribution);
  return commit({
    io, store, clientId, configPath, before, nextText: text, state: "current",
    priorRecord: record,
    record: {
      clientId, configPath, fileFingerprint: fingerprint(text),
      blockFingerprint: fingerprint(canonicalContribution(contribution)),
      semanticBlockFingerprint: fingerprint(semanticContribution(contribution)),
      ...(refreshablePaths.length > 0 ? {
        protectedBlockFingerprint: protectedContributionFingerprint(contribution, refreshablePaths),
        semanticProtectedBlockFingerprint: semanticProtectedContributionFingerprint(
          contribution,
          refreshablePaths,
        ),
        refreshablePaths,
      } : {}),
      fragmentPaths: fragmentPathsOf(contribution), createdContainers: created,
      appliedAt: at, opId,
    },
    entry,
    snapshotPath: snapshotAbsPath(store, entry),
  });
}

export function applyIntegration(input: IntegrationWriteInput): WriteOutcome {
  return applyOrRefreshIntegration(input, true);
}

/**
 * Apply over a conflicted config, replacing whatever holds our paths.
 *
 * Separate from `applyIntegration` and never a flag on it: a caller has to name
 * this function to get the behavior, so no existing call site can acquire it by
 * passing a default through.
 *
 * What it does NOT relax. `unsafe` still refuses -- a blocked container means the
 * merge would replace a value it cannot reason about, and a snapshot is not a
 * licence for that. `not_installed` and `non_loopback` still refuse; neither is a
 * conflict. And a non-conflict state behaves exactly as apply does, so calling
 * this on a clean file is not a way to skip any other check.
 */
export function overwriteIntegration(input: IntegrationWriteInput): WriteOutcome {
  return applyOrRefreshIntegration(input, true, "overwrite");
}

/** Refresh an owned stale block, but never create or reconnect an absent one. */
export function refreshIntegration(input: IntegrationWriteInput): WriteOutcome {
  return applyOrRefreshIntegration(input, false);
}

export function disableIntegration(input: IntegrationWriteInput): WriteOutcome {
  const pre = preflight(input);
  if (pre.failed) return pre.failed;
  const { store, io, clientId, spec, exportSpec, configPath, before, parsed, record, classified } = pre;

  if (classified.state === "absent") {
    return { ok: true, changed: false, state: "absent", clientId, message: "not applied" };
  }
  if (classified.state === "conflict") {
    return refuse(clientId, "conflict", "conflict",
      classified.reason === "foreign-edit"
        ? `${configPath} changed after opencodex wrote it; disabling would discard that edit`
        : `${configPath} contains an opencodex block we did not write`);
  }
  /*
   * `unsafe` reaches here the same way it reaches apply, and the code below
   * dereferences `record` on the assumption that anything past this point is
   * `current` or `stale`. A blocked container has no record, so disable threw
   * a TypeError and the route answered 500 — the GUI locks the switch, but the
   * CLI and direct API callers do not.
   */
  if (classified.state === "unsafe") {
    return refuse(clientId, "unsafe", "unsafe",
      classified.reason === "blocked-container"
        ? `${configPath} holds a value where opencodex would have to read a section, so nothing can be removed safely`
        : `${configPath} cannot be changed safely`);
  }

  /*
   * current | stale only. What makes the removal safe is the BLOCK
   * fingerprint, not the file fingerprint: the classifier verified the values
   * at the recorded paths are byte-for-byte what we wrote, so removing them
   * cannot take a user edit with them. The file itself may have drifted — a
   * json client classifies a sibling edit as stale (#1631) — which is why the
   * removal runs against the document as parsed NOW, and the re-serialize is
   * value-safe because non-round-tripping numbers were refused at parse time.
   * Source-preserving YAML clients additionally compute which recorded
   * containers are still source-empty before pruning, so a later sibling or
   * comment makes its ancestor user-owned without protecting our leaf.
   */
  const recordedCreated = record!.createdContainers ?? [];
  const prunableCreated = spec.sourcePreservingYaml && before !== null
    ? sourcePrunableYamlContainers(before, spec.sourcePreservingYaml.path, recordedCreated)
    : recordedCreated;
  if (prunableCreated === null) {
    return refuse(clientId, "unsafe", "unsafe",
      `${configPath} uses YAML source opencodex cannot patch without risking unrelated comments or formatting, so nothing was removed`);
  }
  const { doc, removed } = removeFragments(
    parsed,
    record!.fragmentPaths,
    new Set(prunableCreated),
  );
  if (!removed) {
    return { ok: true, changed: false, state: "absent", clientId, message: "nothing to remove" };
  }
  let text: string;
  try {
    if (spec.sourcePreservingYaml && before !== null) {
      const patched = patchYamlFragmentSource(before, spec.sourcePreservingYaml.path, {
        kind: "remove",
        createdContainers: prunableCreated,
      }, doc);
      if (patched === null) {
        return refuse(clientId, "unsafe", "unsafe",
          `${configPath} uses YAML source opencodex cannot patch without risking unrelated comments or formatting, so nothing was removed`);
      }
      text = patched;
    } else {
      text = serializeDocument(doc, exportSpec.format);
    }
  } catch (error) {
    if (!(error instanceof UnserializableValueError)) throw error;
    return refuse(clientId, "unsafe", "unsafe",
      `${configPath} contains something opencodex cannot rewrite safely (${error.message}), so nothing was removed`);
  }

  const recheck = io.readText(configPath);
  const rechecked = recheck.kind === "text" ? recheck.text : recheck.kind === "missing" ? null : undefined;
  if (rechecked === undefined || rechecked !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while disabling`);
  }

  const opId = newOpId();
  const snapshot = store.captureSnapshot(clientId, opId, before);
  const at = new Date(io.now()).toISOString();
  const entry: JournalEntry = {
    opId, clientId, kind: "disable", at, configPath, snapshot,
    resultFingerprint: fingerprint(text), resultAbsent: false, priorRecord: record,
  };
  return commit({
    io, store, clientId, configPath, before, nextText: text, state: "absent",
    record: null, priorRecord: record, entry,
    snapshotPath: snapshotAbsPath(store, entry),
  });
}

export function restoreIntegration(input: IntegrationRestoreInput): WriteOutcome {
  const store = input.store ?? createIntegrationStateStore();
  const io = input.io ?? defaultIntegrationIO(store);
  const entry = store.findOperation(input.opId);
  if (!entry) throw new Error(`unknown operation ${input.opId}`);
  if (entry.clientId !== input.clientId) throw new Error("restore input names a different client than the operation");

  const clientId = entry.clientId;
  const resolvedPath = input.resolvedPaths?.configPath
    ?? INTEGRATION_CLIENTS[clientId].configPath(input.env, input.home);
  // Restore acts on the path the operation was journaled against. Resolving a
  // different path here would let an operation recorded for one home delete a
  // file in another.
  const configPath = entry.configPath;
  if (resolvedPath !== configPath) {
    return refuse(clientId, "conflict", "conflict",
      `that operation was recorded for ${configPath}, but this client now resolves to ${resolvedPath}`);
  }
  const snapshot = store.readSnapshot(entry);
  if (snapshot.kind === "expired") {
    return refuse(clientId, "snapshot_expired", "absent", "that backup has expired");
  }
  const backupHint = snapshot.kind === "stored" ? snapshot.path : undefined;

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return refuse(clientId, "unsafe", "unsafe",
      target.why === "read-failed"
        ? `${configPath} exists but could not be read; the backup is at ${backupHint ?? "(none)"}`
        : `${configPath} is not a regular file; the backup is at ${backupHint ?? "(none)"}`,
      backupHint);
  }
  const current = target.before;

  /*
   * Drift: the file changed after the operation we are undoing.
   *
   * Through the shared matcher, because `fingerprint(current ?? "")` treated a
   * MISSING file as an empty one — so restoring an operation whose result was
   * absence, with the file still absent, read as drift and demanded a
   * confirmation for edits nobody had made. The journal meanwhile offered the
   * same row as Undo.
   */
  if (!matchesOperationResult(entry, current) && !input.confirmDrift) {
    return refuse(clientId, "drift_requires_confirm", "conflict",
      "this file changed after that operation; confirm to replace it (the current version is backed up first)");
  }

  // Restore is itself journaled and itself undoable: snapshot the CURRENT file
  // first, so a confirmed drift-restore never destroys the newer edits.
  const opId = newOpId();
  const preSnapshot = store.captureSnapshot(clientId, opId, current);
  const restoredText = snapshot.kind === "none" ? null : snapshot.text;

  // Provenance is RESTORED, never re-derived: `priorRecord` described these
  // exact bytes when the snapshot was taken. Re-deriving it from the file would
  // mean guessing which entries are ours, and a wrong guess deletes a user's.
  const restoredRecord = entry.priorRecord;
  const fresh = EXPORT_CLIENTS[clientId].buildContribution(exportContextOf(input));
  /*
   * Does the restored record actually describe the restored bytes?
   *
   * It usually does — `priorRecord` was written for exactly this snapshot. But
   * a CONFIRMED drift-restore snapshots the user's edited file first, and
   * undoing that restore puts those edited bytes back while carrying a record
   * that describes what opencodex had written. Overwriting the record's
   * fingerprint with the restored bytes then laundered a foreign edit into
   * owned content: the state read `current`, and a later disable deleted
   * fields the user had added by hand.
   */
  const restoredFingerprint = restoredText === null ? "" : fingerprint(restoredText);
  const recordDescribesBytes = restoredRecord !== null
    && restoredRecord.fileFingerprint === restoredFingerprint;
  const state: IntegrationState = restoredRecord === null
    ? (restoredText === null ? "absent" : "conflict")
    : !recordDescribesBytes
      ? "conflict"
      : (
        restoredRecord.semanticBlockFingerprint === fingerprint(semanticContribution(fresh))
        || restoredRecord.blockFingerprint === fingerprint(canonicalContribution(fresh))
      )
        ? "current"
        : "stale";

  const at = new Date(io.now()).toISOString();
  const priorRecord = store.readRecords()[clientId] ?? null;
  const restoreEntry: JournalEntry = {
    opId, clientId, kind: "restore", at, configPath, snapshot: preSnapshot,
    resultFingerprint: restoredText === null ? "" : fingerprint(restoredText),
    resultAbsent: restoredText === null,
    priorRecord,
  };
  return commit({
    io, store, clientId, configPath, before: current, nextText: restoredText, state,
    priorRecord,
    /*
     * Keep the record's ORIGINAL `fileFingerprint`. Restoring bytes it does not
     * describe leaves the classifier reading `conflict`, which is the honest
     * answer — we are no longer sure the block on disk is ours, and refusing
     * is what stops a disable from deleting the user's edit.
     */
    record: restoredRecord === null ? null : {
      ...restoredRecord,
      appliedAt: at,
      opId,
    },
    entry: restoreEntry,
    snapshotPath: snapshotAbsPath(store, restoreEntry),
  });
}

export interface CoordinatedIntegrationOptions {
  lockSeams?: IntegrationWriterLockSeams;
}

/** Freeze all mutable resolution seams before the first lock await. */
type FrozenIntegrationInput = IntegrationWriteInput & {
  store: IntegrationStateStore;
  io: IntegrationIO;
  env: NodeJS.ProcessEnv;
  home: string;
  resolvedPaths: { configPath: string; detectDir: string };
};

function freezeIntegrationInput(input: IntegrationWriteInput): FrozenIntegrationInput {
  const env = { ...(input.env ?? process.env) };
  const home = input.home ?? homedir();
  const store = input.store ?? createIntegrationStateStore();
  const io = input.io ?? defaultIntegrationIO(store);
  const spec = INTEGRATION_CLIENTS[input.clientId];
  /*
   * One resolution for both paths. Aside derives them from the account id in
   * its manifest, so two independent calls could verify one account's install
   * and then write another account's catalog if a switch landed between them.
   */
  const resolvedPaths = resolveIntegrationPaths(input.clientId, env, home);
  return { ...input, env, home, store, io, resolvedPaths };
}

function tryFreezeIntegrationInput(input: IntegrationWriteInput):
  | { ok: true; value: FrozenIntegrationInput }
  | { ok: false; refusal: WriteRefused } {
  try {
    return { ok: true, value: freezeIntegrationInput(input) };
  } catch (error) {
    if (!(error instanceof ClientPathError)) throw error;
    return {
      ok: false,
      refusal: refuse(input.clientId, "unsafe", "unsafe", error.message),
    };
  }
}

async function coordinatedWrite(
  input: IntegrationWriteInput,
  operation: (frozen: IntegrationWriteInput) => WriteOutcome,
  options?: CoordinatedIntegrationOptions,
): Promise<WriteOutcome> {
  const prepared = tryFreezeIntegrationInput(input);
  if (!prepared.ok) return prepared.refusal;
  const frozen = prepared.value;
  const spec = INTEGRATION_CLIENTS[frozen.clientId];
  if (!spec.writerLock) return operation(frozen);

  // An absent client home is not created merely to acquire a sibling lock.
  if (frozen.io.statKind(frozen.resolvedPaths.detectDir) !== "dir") {
    return operation(frozen);
  }
  return withIntegrationWriterLock(
    frozen.resolvedPaths.configPath,
    async () => operation(frozen),
    options?.lockSeams,
    spec.writerLock.suffix,
  );
}

export function applyIntegrationCoordinated(
  input: IntegrationWriteInput,
  options?: CoordinatedIntegrationOptions,
): Promise<WriteOutcome> {
  return coordinatedWrite(input, applyIntegration, options);
}

export function refreshIntegrationCoordinated(
  input: IntegrationWriteInput,
  options?: CoordinatedIntegrationOptions,
): Promise<WriteOutcome> {
  return coordinatedWrite(input, refreshIntegration, options);
}

export function overwriteIntegrationCoordinated(
  input: IntegrationWriteInput,
  options?: CoordinatedIntegrationOptions,
): Promise<WriteOutcome> {
  return coordinatedWrite(input, overwriteIntegration, options);
}

export function disableIntegrationCoordinated(
  input: IntegrationWriteInput,
  options?: CoordinatedIntegrationOptions,
): Promise<WriteOutcome> {
  return coordinatedWrite(input, disableIntegration, options);
}

export async function restoreIntegrationCoordinated(
  input: IntegrationRestoreInput,
  options?: CoordinatedIntegrationOptions,
): Promise<WriteOutcome> {
  const prepared = tryFreezeIntegrationInput(input);
  if (!prepared.ok) return prepared.refusal;
  const frozen = prepared.value;
  const spec = INTEGRATION_CLIENTS[frozen.clientId];
  if (!spec.writerLock) return restoreIntegration({ ...frozen, opId: input.opId, confirmDrift: input.confirmDrift });
  if (frozen.io.statKind(frozen.resolvedPaths.detectDir) !== "dir") {
    return refuse(
      frozen.clientId,
      "unsafe",
      "unsafe",
      `${frozen.resolvedPaths.detectDir} is missing; restore will not create the client home`,
    );
  }
  return withIntegrationWriterLock(
    frozen.resolvedPaths.configPath,
    async () => restoreIntegration({ ...frozen, opId: input.opId, confirmDrift: input.confirmDrift }),
    options?.lockSeams,
    spec.writerLock.suffix,
  );
}
