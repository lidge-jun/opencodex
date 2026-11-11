import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { parseStrictSemver } from "../lib/strict-semver";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { PLAN_RUNTIME_OWNERS, type InstallKind, type PlanRuntimeOwner, type UpdateRoute } from "./child-update-contract";
import { childObservationsPath } from "./paths";
import { readLinkStore } from "./store";

/**
 * What the Home last learned about each Child, keyed by link id, in <configDir>/link/child-observations.json.
 * A cache, not a trust boundary: unlike links.json's strict record keys, unknown keys are dropped, an invalid entry is
 * dropped and a damaged or foreign file reads as empty, so a downgraded Home ignores it and links.json never changes.
 */
export const CHILD_OBSERVATIONS_SCHEMA = "ocx.link.child-observations/1";
export const CHILD_OBSERVATIONS_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CHILD_OBSERVATIONS = 256;
export type ChildOp = "observe" | "sync" | "restart-codex" | "update";
/** The persisted slice of a wp3 job item. */
export interface ChildOperationSummary {
  op: ChildOp; jobId: string; state: string; reason: string | null;
  fromVersion?: string; toVersion?: string; finishedAt: string;
}
export interface ChildObservation {
  observedAt: string; source: "plan" | "inspect" | "peer";
  installedVersion: string | null; installKind: InstallKind; runtimeOwner: PlanRuntimeOwner | null;
  updateRoute: UpdateRoute; updateReason: string | null; targetVersion: string | null;
  catalogPulledAt: number | null; lastOperation: ChildOperationSummary | null; suppressedTarget: string | null;
  /** Etag of the catalog bytes served with the pull at catalogPulledAt. Display verdict only. */
  catalogPulledEtag: string | null;
  /** Home catalog etag current when a Home-run pinned sync of this Child last reported synced. Fan-out eligibility
   *  uses this field, never catalogPulledAt: a GET of /v1/catalog only proves a fetch. */
  catalogSyncedEtag: string | null;
  /** Counted automatic update attempts for one target; survives a Home restart. */
  autoUpdateAttempts: { target: string; count: number } | null;
  /** plan.updateInFlight from the last ocx.update.plan/1 probe; null when the observation did not come from a plan.
   *  Not a carried field: every observe replaces it. */
  updateInFlight: boolean | null;
  /** An update whose result is unknown. A record carrying desktopRequestId is cleared only by the Desktop route's
   *  status reconciliation or by expiry, never by a sync. */
  pendingUpdateRecovery: { target: string; since: string; until: string; desktopRequestId?: string } | null;
}
/** Fields an operation or the Home owns; a fresh observe never overwrites them. Missing in an older file ⇒ null. */
export const CARRIED_OBSERVATION_FIELDS = ["catalogPulledAt", "catalogPulledEtag", "catalogSyncedEtag", "lastOperation",
  "suppressedTarget", "autoUpdateAttempts", "pendingUpdateRecovery"] as const;
export interface ChildObservationsFile {
  schema: typeof CHILD_OBSERVATIONS_SCHEMA;
  homeCatalog: { etag: string; changedAt: number } | null;
  children: Record<string, ChildObservation>;
}

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const REASON = /^[a-z][a-z0-9:-]{0,79}$/;
const STATE = /^[a-z][a-z0-9-]{0,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SOURCES: ReadonlySet<string> = new Set(["plan", "inspect", "peer"]);
const OPS: ReadonlySet<string> = new Set<ChildOp>(["observe", "sync", "restart-codex", "update"]);
const INSTALL_KINDS: ReadonlySet<string> = new Set<InstallKind>(["npm", "pnpm", "bun", "source", "mise", "desktop-app", "goat", "standalone", "ocx-child", "unknown"]);
const ROUTES: ReadonlySet<string> = new Set<UpdateRoute>(["orchestrated", "desktop-request", "owner-action", "replant", "none"]);

/** Thrown inside a field reader; the entry that holds the field is dropped. */
class Drop extends Error {}
const drop = (): never => { throw new Drop(); };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const version = (value: unknown): string => typeof value === "string" && value.length <= 128 && parseStrictSemver(value) ? value : drop();
const nullable = <T>(value: unknown, read: (value: unknown) => T): T | null => value === null || value === undefined ? null : read(value);
const time = (value: unknown): string => typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : drop();
const epoch = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : drop();
const token = (pattern: RegExp) => (value: unknown): string => typeof value === "string" && pattern.test(value) ? value : drop();
const member = <T extends string>(set: ReadonlySet<string>) => (value: unknown): T => typeof value === "string" && set.has(value) ? value as T : drop();
// Etags are quoted opaque strings; anything printable and bounded is kept.
const etag = (value: unknown): string => typeof value === "string" && value.length >= 1 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value) ? value : drop();

function summary(value: unknown): ChildOperationSummary {
  if (!isObject(value)) return drop();
  return {
    op: member<ChildOp>(OPS)(value.op), jobId: token(OPAQUE_ID)(value.jobId), state: token(STATE)(value.state),
    reason: nullable(value.reason, token(REASON)),
    ...(value.fromVersion === undefined ? {} : { fromVersion: version(value.fromVersion) }),
    ...(value.toVersion === undefined ? {} : { toVersion: version(value.toVersion) }),
    finishedAt: time(value.finishedAt),
  };
}
function attempts(value: unknown): { target: string; count: number } {
  if (!isObject(value)) return drop();
  const count = value.count;
  return { target: version(value.target), count: typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : drop() };
}
function recovery(value: unknown): NonNullable<ChildObservation["pendingUpdateRecovery"]> {
  if (!isObject(value)) return drop();
  return { target: version(value.target), since: time(value.since), until: time(value.until),
    ...(value.desktopRequestId === undefined ? {} : { desktopRequestId: token(OPAQUE_ID)(value.desktopRequestId) }) };
}
function observation(value: unknown): ChildObservation {
  if (!isObject(value)) return drop();
  return {
    observedAt: time(value.observedAt), source: member<ChildObservation["source"]>(SOURCES)(value.source),
    installedVersion: nullable(value.installedVersion, version), installKind: member<InstallKind>(INSTALL_KINDS)(value.installKind),
    runtimeOwner: nullable(value.runtimeOwner, member<PlanRuntimeOwner>(PLAN_RUNTIME_OWNERS)),
    updateRoute: member<UpdateRoute>(ROUTES)(value.updateRoute), updateReason: nullable(value.updateReason, token(REASON)),
    targetVersion: nullable(value.targetVersion, version), catalogPulledAt: nullable(value.catalogPulledAt, epoch),
    lastOperation: nullable(value.lastOperation, summary), suppressedTarget: nullable(value.suppressedTarget, version),
    catalogPulledEtag: nullable(value.catalogPulledEtag, etag), catalogSyncedEtag: nullable(value.catalogSyncedEtag, etag),
    autoUpdateAttempts: nullable(value.autoUpdateAttempts, attempts),
    updateInFlight: nullable(value.updateInFlight, item => typeof item === "boolean" ? item : drop()),
    pendingUpdateRecovery: nullable(value.pendingUpdateRecovery, recovery),
  };
}
function homeCatalog(value: unknown): ChildObservationsFile["homeCatalog"] {
  if (!isObject(value)) return null;
  try { return { etag: etag(value.etag), changedAt: epoch(value.changedAt) }; } catch (error) {
    if (error instanceof Drop) return null;
    throw error;
  }
}

export function emptyChildObservations(): ChildObservationsFile {
  return { schema: CHILD_OBSERVATIONS_SCHEMA, homeCatalog: null, children: {} };
}

export function withoutCarriedFields(value: ChildObservation): Partial<ChildObservation> {
  const copy: Partial<ChildObservation> = { ...value };
  for (const field of CARRIED_OBSERVATION_FIELDS) delete copy[field];
  return copy;
}

/** Tolerant: unknown keys dropped, an invalid entry dropped, an invalid file or wrong schema reads as empty. */
export function parseChildObservations(text: string): ChildObservationsFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return emptyChildObservations(); }
  if (!isObject(raw) || raw.schema !== CHILD_OBSERVATIONS_SCHEMA) return emptyChildObservations();
  const file: ChildObservationsFile = { schema: CHILD_OBSERVATIONS_SCHEMA, homeCatalog: homeCatalog(raw.homeCatalog), children: {} };
  if (!isObject(raw.children)) return file;
  for (const [linkId, entry] of Object.entries(raw.children)) {
    if (!LINK_ID.test(linkId)) continue;
    try { file.children[linkId] = observation(entry); } catch (error) {
      if (!(error instanceof Drop)) throw error;
    }
  }
  return file;
}

/** Missing, unreadable, larger than 1 MiB or damaged → empty. Never throws for content. */
export function readChildObservations(path: string = childObservationsPath()): ChildObservationsFile {
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch { return emptyChildObservations(); }
  if (bytes.length > CHILD_OBSERVATIONS_MAX_BYTES) return emptyChildObservations();
  return parseChildObservations(bytes.toString("utf8"));
}

/** Keep the most recently observed entries when the file holds more than maxEntries. */
function capEntries(file: ChildObservationsFile, maxEntries: number): void {
  const entries = Object.entries(file.children);
  if (entries.length <= maxEntries) return;
  entries.sort(([, a], [, b]) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  file.children = Object.fromEntries(entries.slice(0, Math.max(0, maxEntries)));
}

/**
 * Read–mutate–write under withConfigMutationLockSync. Inside the lock it reads links.json and drops entries whose link
 * id is absent; a damaged links.json disables pruning for that write only. Dir 0700 (hardenSecretDir on Windows), file
 * written with atomicWriteFile then chmod 0600, as writeLinkStore. Throws ConfigMutationLockError on contention
 * (busy_timeout=0); callers decide whether to retry.
 */
export function updateChildObservations(mutate: (file: ChildObservationsFile) => void,
  deps: { path?: string; storePath?: string; maxEntries?: number } = {}): ChildObservationsFile {
  const path = deps.path ?? childObservationsPath();
  const dir = dirname(path), configDir = dirname(dir);
  assertNotRealHomeUnderTest(configDir);
  return withConfigMutationLockSync(() => {
    const current = readChildObservations(path);
    mutate(current);
    const next = parseChildObservations(JSON.stringify(current));
    let linkIds: Set<string> | null = null;
    try { linkIds = new Set(readLinkStore(deps.storePath ?? join(dir, "links.json")).links.map(link => link.id)); } catch { linkIds = null; }
    if (linkIds) for (const linkId of Object.keys(next.children)) if (!linkIds.has(linkId)) delete next.children[linkId];
    capEntries(next, deps.maxEntries ?? DEFAULT_MAX_CHILD_OBSERVATIONS);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") hardenSecretDir(dir, { required: true });
    else chmodSync(dir, 0o700);
    atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return next;
  }, configDir);
}

/**
 * Merge a patch into one Child's entry and stamp observedAt with now. A patch of carried fields only (a catalog pull,
 * an operation summary) keeps an existing entry's observedAt, so install facts never read fresher than they are.
 * A Child never observed before starts as an unknown "inspect" record with every field null, so an operation summary
 * can be stored before the first observe; that new entry is stamped.
 */
export function patchChildObservation(file: ChildObservationsFile, linkId: string, patch: Partial<ChildObservation>, now: Date): void {
  const existing = file.children[linkId];
  const base: ChildObservation = existing ?? {
    observedAt: now.toISOString(), source: "inspect", installedVersion: null, installKind: "unknown", runtimeOwner: null,
    updateRoute: "none", updateReason: null, targetVersion: null, catalogPulledAt: null, lastOperation: null, suppressedTarget: null,
    catalogPulledEtag: null, catalogSyncedEtag: null, autoUpdateAttempts: null, updateInFlight: null, pendingUpdateRecovery: null,
  };
  const carriedOnly = Object.keys(patch).every(key => (CARRIED_OBSERVATION_FIELDS as readonly string[]).includes(key));
  file.children[linkId] = { ...base, ...patch, observedAt: carriedOnly && existing ? base.observedAt : now.toISOString() };
}

