import { EXPORT_CLIENTS } from "../clients/config-export";
import { loadTarget, parseConfig } from "./config-io";
import { matchesOperationResult, type JournalEntry } from "./journal";
import { fingerprint, type OwnershipRecord } from "./ownership";
import { classifyIntegration, exportContextOf } from "./state";
import type { IntegrationStateStore } from "./store";
import { restoreIntegrationCoordinated, type IntegrationWriteInput } from "./writer";
import {
  AsideProfileError, asideProfileFailure, asideProfileScope, asideRootStore, asideWriteInput, assertAsideSnapshotEntry,
  createAsideProfileContext, persistAsidePolicy, runAsideProfileAction, selectAsideProfiles,
  type AsideProfileContext, type AsideProfilesInput, type AsideProfileScope, type AsideProfileWriteOutcome,
} from "./aside-profile-context";

export interface AsideOperation {
  profileId: number;
  entry: JournalEntry;
  store: IntegrationStateStore;
}

function operationRows(ctx: AsideProfileContext, profileId?: number): AsideOperation[] {
  const rows: AsideOperation[] = [];
  const entriesByRoot = new Map<string, JournalEntry[]>();
  for (const profile of selectAsideProfiles(ctx, profileId)) {
    const scope = asideProfileScope(ctx, profile);
    const stores = scope.store.root === ctx.rootStore.root ? [scope.store] : [scope.store, ctx.rootStore];
    for (const store of stores) {
      let entries = entriesByRoot.get(store.root);
      if (entries === undefined) {
        entries = store.listOperations("aside", Number.MAX_SAFE_INTEGER);
        entriesByRoot.set(store.root, entries);
      }
      for (const entry of entries) {
        if (entry.clientId === "aside" && entry.configPath === profile.configPath) {
          assertAsideSnapshotEntry(entry);
          if (typeof entry.at !== "string") throw new AsideProfileError("aside_operation_invalid", 409, "Aside operation timestamp is invalid");
          rows.push({ profileId: profile.id, entry, store });
        }
      }
    }
  }
  // A copied entry retains its original timestamp; import time cannot make it newest.
  return rows.sort((a, b) => b.entry.at.localeCompare(a.entry.at));
}

function uniqueOperations(rows: AsideOperation[]): AsideOperation[] {
  const seen = new Map<string, AsideOperation>();
  for (const row of rows) {
    const previous = seen.get(row.entry.opId);
    if (previous && (previous.profileId !== row.profileId || JSON.stringify(previous.entry) !== JSON.stringify(row.entry))) {
      throw new AsideProfileError("aside_operation_ambiguous", 409, "Aside operation identifies multiple profiles");
    }
    if (!previous) {
      seen.set(row.entry.opId, row);
      continue;
    }
    // Identical journal rows can outlive different snapshot-retention windows.
    const previousSnapshot = previous.store.readSnapshot(previous.entry);
    const candidateSnapshot = row.store.readSnapshot(row.entry);
    if (previousSnapshot.kind === "stored" && candidateSnapshot.kind === "stored"
      && previousSnapshot.text !== candidateSnapshot.text) {
      throw new AsideProfileError("aside_operation_ambiguous", 409, "Aside operation has conflicting snapshot copies");
    }
    if (previousSnapshot.kind === "expired" && candidateSnapshot.kind === "stored") seen.set(row.entry.opId, row);
  }
  return [...seen.values()];
}

export function listAsideOperations(input: AsideProfilesInput, profileId?: number): AsideOperation[] {
  try { return uniqueOperations(operationRows(createAsideProfileContext(input), profileId)); }
  catch (error) {
    if (profileId === undefined && error instanceof AsideProfileError && error.code === "aside_profiles_unavailable") return [];
    throw error;
  }
}

function findOperation(ctx: AsideProfileContext, opId: string, profileId?: number): AsideOperation | null {
  if (typeof opId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(opId)) {
    throw new AsideProfileError("invalid_op_id", 400, "Aside operation ID is invalid");
  }
  const rows = uniqueOperations(operationRows(ctx, profileId));
  const found = rows.find(row => row.entry.opId === opId);
  if (found) return found;
  const legacy = ctx.rootStore.findOperation(opId);
  if (legacy?.clientId === "aside") {
    if (!ctx.profiles.some(profile => profile.configPath === legacy.configPath)) {
      throw new AsideProfileError("aside_profile_not_found", 404, "The operation's Aside profile is no longer registered");
    }
    if (profileId !== undefined) throw new AsideProfileError("aside_operation_profile_mismatch", 409, "Aside operation belongs to a different profile");
  }
  return null;
}

export function findAsideOperation(input: AsideProfilesInput, opId: string, profileId?: number): AsideOperation | null {
  const legacy = asideRootStore(input).findOperation(opId);
  if (profileId === undefined && legacy && legacy.clientId !== "aside") return null;
  try { return findOperation(createAsideProfileContext(input), opId, profileId); }
  catch (error) {
    if (profileId === undefined && !legacy && error instanceof AsideProfileError && error.code === "aside_profiles_unavailable") return null;
    throw error;
  }
}

/** Guarded history projection: never expose profile bytes to API serializers. */
export function asideOperationMatchesCurrent(input: AsideProfilesInput, row: AsideOperation): boolean {
  try {
    const ctx = createAsideProfileContext(input);
    const verified = findOperation(ctx, row.entry.opId, row.profileId);
    if (!verified || verified.entry.configPath !== row.entry.configPath) return false;
    const profile = selectAsideProfiles(ctx, row.profileId)[0]!;
    const scope = asideProfileScope(ctx, profile);
    const target = loadTarget(scope.io, profile.configPath);
    return target.ok && scope.io.statKind(profile.detectDir) === "dir" && matchesOperationResult(verified.entry, target.before);
  } catch { return false; }
}

function requiredOperation(ctx: AsideProfileContext, opId: string, profileId?: number): AsideOperation {
  const row = findOperation(ctx, opId, profileId);
  if (!row) throw new AsideProfileError("integration_operation_not_found", 404, "Aside operation not found");
  return row;
}

function validatePriorRecord(record: OwnershipRecord | null, configPath: string): void {
  if (record === null) return;
  if (!record || record.clientId !== "aside" || record.configPath !== configPath
    || typeof record.fileFingerprint !== "string" || typeof record.blockFingerprint !== "string"
    || typeof record.opId !== "string" || typeof record.appliedAt !== "string"
    || !Array.isArray(record.fragmentPaths) || record.fragmentPaths.length !== 1
    || record.fragmentPaths[0]?.length !== 2 || record.fragmentPaths[0][0] !== "providers"
    || record.fragmentPaths[0][1] !== "opencodex"
    || (record.createdContainers !== undefined && (!Array.isArray(record.createdContainers)
      || !record.createdContainers.every(path => path === "providers")))) {
    throw new AsideProfileError("aside_operation_invalid", 409, "Aside operation ownership metadata is invalid");
  }
}

function snapshotWasOwned(entry: JournalEntry, text: string | null, bound: IntegrationWriteInput): boolean {
  const record = entry.priorRecord;
  if (!record || text === null || record.fileFingerprint !== fingerprint(text)) return false;
  const state = classifyIntegration({
    fileText: text, fileIsRegular: true, parsed: parseConfig(text, EXPORT_CLIENTS.aside.format), record,
    contribution: EXPORT_CLIENTS.aside.buildContribution(exportContextOf(bound)),
    configPath: entry.configPath, clientId: "aside",
  }).state;
  return state === "current" || state === "stale";
}

/** Import only an immutable historical row and its bytes, never the legacy ownership record. */
function importOperation(row: AsideOperation, scope: AsideProfileScope): void {
  if (row.store.root === scope.store.root) return;
  const existing = scope.store.findOperation(row.entry.opId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(row.entry)) {
    throw new AsideProfileError("aside_operation_ambiguous", 409, "Aside operation conflicts with existing profile history");
  }
  const snapshot = row.store.readSnapshot(row.entry);
  if (snapshot.kind === "expired") throw new AsideProfileError("integration_snapshot_expired", 410, "That backup has expired");
  scope.io.statKind(scope.profile.detectDir);
  scope.assertBoundary();
  if (snapshot.kind === "stored") {
    const present = scope.store.readSnapshot(row.entry);
    if (present.kind === "stored" && present.text !== snapshot.text) {
      throw new AsideProfileError("aside_operation_ambiguous", 409, "Aside snapshot conflicts with existing profile history");
    }
    if (present.kind !== "stored") scope.store.captureSnapshot("aside", row.entry.opId, snapshot.text);
  }
  if (!existing) scope.store.appendJournal(structuredClone(row.entry));
}

export function restoreAsideProfile(
  input: AsideProfilesInput,
  request: { opId: string; profileId?: number; confirmDrift?: boolean },
): Promise<AsideProfileWriteOutcome> {
  return runAsideProfileAction<AsideProfileWriteOutcome>(input, request.profileId, `restore:${request.opId}:${Boolean(request.confirmDrift)}`, async ctx => {
    const row = requiredOperation(ctx, request.opId, request.profileId);
    const profile = selectAsideProfiles(ctx, row.profileId)[0]!;
    const scope = asideProfileScope(ctx, profile);
    assertAsideSnapshotEntry(row.entry);
    validatePriorRecord(row.entry.priorRecord, profile.configPath);
    const snapshot = row.store.readSnapshot(row.entry);
    if (snapshot.kind === "expired") {
      return { clientId: "aside", profileId: profile.id, ok: false, reason: "snapshot_expired", state: "absent", message: "That backup has expired" };
    }
    const bound = await asideWriteInput(ctx, scope);
    const target = loadTarget(scope.io, profile.configPath);
    if (!target.ok || scope.io.statKind(profile.detectDir) !== "dir") {
      return asideProfileFailure(profile.id, new AsideProfileError("aside_profile_unsafe", 409, "Aside profile cannot be restored safely"));
    }
    if (!request.confirmDrift && !matchesOperationResult(row.entry, target.before)) {
      return { clientId: "aside", profileId: profile.id, ok: false, reason: "drift_requires_confirm", state: "conflict", message: "This profile changed after that operation; confirm to replace it" };
    }
    const restoredText = snapshot.kind === "stored" ? snapshot.text : null;
    await persistAsidePolicy(ctx, { profileId: profile.id, enabled: snapshotWasOwned(row.entry, restoredText, bound) });
    try {
      scope.assertBoundary();
      const currentSnapshot = row.store.readSnapshot(row.entry);
      if (JSON.stringify(row.store.findOperation(row.entry.opId)) !== JSON.stringify(row.entry)
        || currentSnapshot.kind !== snapshot.kind
        || (currentSnapshot.kind === "stored" && currentSnapshot.text !== restoredText)) {
        throw new AsideProfileError("aside_operation_changed", 409, "Aside operation or snapshot changed while saving preferences");
      }
      importOperation(row, scope);
      return { ...await restoreIntegrationCoordinated({ ...bound, opId: request.opId, confirmDrift: request.confirmDrift }, { lockSeams: input.lockSeams }), profileId: profile.id };
    } catch (error) { return asideProfileFailure(profile.id, error); }
  });
}

export function deleteAsideOperation(
  input: AsideProfilesInput,
  request: { opId: string; profileId?: number; principal?: string },
): Promise<{ ok: true; clientId: "aside"; profileId: number; opId: string; snapshotRemoved: boolean }> {
  return runAsideProfileAction(input, request.profileId, `delete:${request.opId}`, async ctx => {
    const row = requiredOperation(ctx, request.opId, request.profileId);
    const rows = operationRows(ctx, row.profileId);
    if (rows[0]?.entry.opId === request.opId) {
      throw new AsideProfileError("integration_journal_newest_protected", 409, "The newest operation for an Aside profile cannot be deleted");
    }
    await persistAsidePolicy(ctx);
    const stores = new Map(rows.filter(candidate => candidate.entry.opId === request.opId).map(candidate => [candidate.store.root, candidate.store]));
    const tombstone = { tombstone: request.opId, at: new Date(input.io?.now() ?? Date.now()).toISOString(), by: request.principal ?? "management" };
    // Retire every copy before pruning any snapshot; deduped history must not resurrect a source row.
    for (const store of stores.values()) store.retireOperation(tombstone);
    let snapshotRemoved = true;
    for (const store of stores.values()) {
      const pruned = store.pruneSnapshots("aside");
      if (pruned.ok) store.clearPruneFailure("aside");
      else { snapshotRemoved = false; store.markPruneFailure("aside", pruned.error); }
    }
    return { ok: true, clientId: "aside", profileId: row.profileId, opId: request.opId, snapshotRemoved };
  });
}
