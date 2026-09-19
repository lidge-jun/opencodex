import { readConfigAdmissionSnapshot } from "./diagnostics";
import { getConfigPath } from "./paths";
import type { OcxConfig } from "../types";

/**
 * A configuration a roster may be built from, detached from the object the caller holds.
 *
 * The detachment is the point. A gather suspends, and while it is suspended a management route can
 * edit the resident configuration in place; gathering from one state and projecting from another
 * would produce rows that belong to neither. Every authoritative pass uses this copy from
 * beginning to end, so what the resident object does in the meantime becomes a question about
 * whether the result may be retained rather than a question about what the result is.
 *
 * What this deliberately does NOT do is require the resident configuration to equal the file on
 * disk. The proxy routes by the configuration it is holding, so that is the configuration a
 * preview and the mutation it authorizes must both describe. A file the operator has edited and
 * the process has not adopted is a supported state rather than a fault: live reconciliation
 * (src/config/live-reconcile.ts) merges persisted state while deliberately retaining live changes
 * and the active listener binding, and can persist a binding the resident object does not have.
 * Demanding equality would make preview permanently unavailable on exactly those configurations
 * while proving nothing about the rows, which come from the resident object either way.
 */
export interface ExportConfigAdmission {
  readonly config: OcxConfig;
}

/**
 * What was true when an admission was captured, kept here rather than on the admission object.
 *
 * None of it is data a consumer has any business reading: the file term is a digest of the
 * operator's configuration file and the canonical form contains their credentials. Holding it in a
 * module WeakMap means an admission can be passed around, and even serialized by a careless
 * caller, without carrying any of it.
 */
interface AdmissionEvidence {
  readonly path: string;
  readonly file: string;
  readonly data: string;
  readonly executors: ReadonlyMap<string, unknown>;
}

const evidence = new WeakMap<ExportConfigAdmission, AdmissionEvidence>();

/**
 * Detach the configuration a roster is about to be built from, and record what it was.
 *
 * Two things are recorded because two things can move independently. The resident configuration is
 * what the rows are derived from, so its complete structure is captured: structurally rather than
 * as a list of the fields that seemed to matter, because such a list is only as complete as
 * whoever last thought about it and this one had already missed export-affecting configuration.
 * The configuration file is recorded beside it, so a roster does not outlive an operator editing
 * the configuration under a process that has not adopted it yet.
 *
 * Null when the file cannot be read, when it is there but the loader would have had to salvage it,
 * and when the configuration object cannot be copied as plain data. Every caller fails closed on
 * it: refusing a preview costs an ordinary load, and serving one that describes a configuration
 * nobody has costs a file the operator did not ask for.
 */
export function captureExportConfigAdmission(live: OcxConfig): ExportConfigAdmission | null {
  const path = getConfigPath();
  const file = admittedFileTerm();
  if (file === null) return null;
  const resident = detachConfig(live);
  if (resident === null) return null;
  const admission: ExportConfigAdmission = { config: withExecutors(resident) };
  evidence.set(admission, { path, file, data: canonical(resident.data), executors: resident.executors });
  return admission;
}

/**
 * A plain-data copy of a configuration for a consumer that must not observe later edits.
 *
 * The integration writer is the case this exists for. It freezes every other resolution seam
 * before its first await and then held the configuration by reference, so a plan checked under one
 * configuration could be written from another: the check and the document it authorizes were
 * reading the same object at two different moments. One copy taken before the await gives both of
 * them the same configuration.
 *
 * A configuration this cannot copy as plain data is returned as the caller's own object. That is
 * deliberate and is never worse than the reference the caller already had; it is the export
 * admission above, not this, that has to refuse what it cannot prove.
 */
export function detachedConfigSnapshot(config: OcxConfig): OcxConfig {
  const detached = detachConfig(config);
  return detached === null ? config : withExecutors(detached);
}

/**
 * Whether an admission still describes the configuration in hand and the file it was taken beside.
 *
 * Three things are checked because three things can move: the file can be rewritten, the resident
 * object can be edited in place, and a consumer of the detached copy can mutate what it was given.
 * The last matters as much as the others, because a pass that edited its own input and then
 * published would be retaining a roster under a state that no longer describes even that input.
 *
 * Passive: it reads the configuration file and nothing else. No credential is resolved, no
 * provider is contacted, no path is hardened and nothing is written.
 */
export function isExportConfigAdmissionCurrent(admission: ExportConfigAdmission, live: OcxConfig): boolean {
  const captured = evidence.get(admission);
  if (captured === undefined) return false;
  // A different configuration home is a different question, not a stale answer to this one.
  if (getConfigPath() !== captured.path) return false;
  const file = admittedFileTerm();
  if (file === null || file !== captured.file) return false;
  const resident = detachConfig(live);
  if (resident === null || canonical(resident.data) !== captured.data) return false;
  if (!sameExecutors(resident.executors, captured.executors)) return false;
  const working = detachConfig(admission.config);
  return working !== null
    && canonical(working.data) === captured.data
    && sameExecutors(working.executors, captured.executors);
}

/**
 * The configuration file as an opaque term: its exact bytes, or the distinguished absence of one.
 *
 * Null for a file that cannot be read, because then a later read cannot tell whether it changed.
 * Null too for one that is there and does not load cleanly: the resident configuration is then a
 * salvage of it rather than its contents, and binding a roster to bytes that describe something
 * else records a relationship that does not hold. Before this, a digest was accepted ahead of any
 * look at what the parse produced.
 *
 * Absence is a configuration rather than the lack of one. No file means defaults, which is an
 * ordinary fresh install and the ordinary state in CI.
 */
function admittedFileTerm(): string | null {
  const snapshot = readConfigAdmissionSnapshot();
  const { source, error } = snapshot.diagnostics;
  if (snapshot.kind === "read") return source === "file" && error === null ? snapshot.contentSha256 : null;
  return source === "default" && error === null ? "absent" : null;
}

interface DetachedConfig {
  readonly data: Record<string, unknown>;
  readonly executors: ReadonlyMap<string, unknown>;
}

/**
 * A plain-data copy of a configuration, plus the transport executors kept out of it.
 *
 * Serializing with JSON is not a safe copier here and using it as one would have been a quiet
 * hole: it drops functions without saying so, and it invokes getters and toJSON, so an object
 * carrying either could decide what this sees. This walks own enumerable string keys, refuses an
 * accessor rather than calling it, refuses any value JSON could not have produced, and refuses a
 * cycle.
 *
 * The one exception is a provider's fetch executor, which a caller owns and the gather uses
 * instead of the global transport. It is kept by reference for the detached copy and compared by
 * reference afterwards, so replacing it invalidates the admission while it is never serialized.
 *
 * Symbol keys are skipped rather than refused. The configuration carries process bookkeeping on
 * symbols by convention, and none of it is the operator's configuration.
 */
function detachConfig(live: OcxConfig): DetachedConfig | null {
  const executors = new Map<string, unknown>();
  const root = live as unknown;
  if (!isPlainObject(root)) return null;
  const data: Record<string, unknown> = {};
  for (const key of ownDataKeys(root)) {
    if (key === null) return null;
    const value = root[key];
    if (value === undefined) continue;
    if (key !== "providers") {
      const copied = plainCopy(value, new Set());
      if (copied === REFUSED) return null;
      data[key] = copied;
      continue;
    }
    if (!isPlainObject(value)) return null;
    const providers: Record<string, unknown> = {};
    for (const name of ownDataKeys(value)) {
      if (name === null) return null;
      const provider = value[name];
      if (provider === undefined) continue;
      if (!isPlainObject(provider)) return null;
      const copiedProvider: Record<string, unknown> = {};
      for (const field of ownDataKeys(provider)) {
        if (field === null) return null;
        const fieldValue = provider[field];
        if (fieldValue === undefined) continue;
        if (field === "fetch") {
          if (typeof fieldValue !== "function") return null;
          executors.set(name, fieldValue);
          continue;
        }
        const copied = plainCopy(fieldValue, new Set());
        if (copied === REFUSED) return null;
        copiedProvider[field] = copied;
      }
      providers[name] = copiedProvider;
    }
    data[key] = providers;
  }
  return { data, executors };
}

/** The copy the gather actually runs against, with the executors put back by reference. */
function withExecutors(detached: DetachedConfig): OcxConfig {
  const config = copyOfData(detached.data);
  const providers = config.providers;
  if (isPlainObject(providers)) {
    for (const [name, executor] of detached.executors) {
      const provider = providers[name];
      if (isPlainObject(provider)) provider.fetch = executor;
    }
  }
  return config as unknown as OcxConfig;
}

function sameExecutors(left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>): boolean {
  if (left.size !== right.size) return false;
  for (const [name, executor] of left) {
    if (!right.has(name) || right.get(name) !== executor) return false;
  }
  return true;
}

const REFUSED = Symbol("refused");

/** Own enumerable string keys, with null in the position of any key that is an accessor. */
function ownDataKeys(value: Record<string, unknown>): Array<string | null> {
  return Object.keys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined ? key : null;
  });
}

function plainCopy(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value as number) ? value : REFUSED;
  if (type !== "object") return REFUSED;
  const object = value as object;
  if (seen.has(object)) return REFUSED;
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const copied: unknown[] = [];
      for (const entry of object) {
        // A hole or an explicit undefined in an array serializes as null, which is what a reader of
        // the persisted configuration would find in that position.
        if (entry === undefined) { copied.push(null); continue; }
        const item = plainCopy(entry, seen);
        if (item === REFUSED) return REFUSED;
        copied.push(item);
      }
      return copied;
    }
    if (!isPlainObject(object)) return REFUSED;
    const copied: Record<string, unknown> = {};
    for (const key of ownDataKeys(object)) {
      if (key === null) return REFUSED;
      const entry = object[key];
      if (entry === undefined) continue;
      const item = plainCopy(entry, seen);
      if (item === REFUSED) return REFUSED;
      copied[key] = item;
    }
    return copied;
  } finally {
    seen.delete(object);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A second copy, so what is compared later is never the object handed to a consumer. */
function copyOfData(data: Record<string, unknown>): Record<string, unknown> {
  const copied = plainCopy(data, new Set());
  return copied === REFUSED ? {} : copied as Record<string, unknown>;
}

/**
 * Key-sorted entry pairs rather than objects, because property order is observable through
 * serialization and two configurations that differ only in it are the same configuration.
 */
function canonical(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => [key, sorted((value as Record<string, unknown>)[key])]);
  }
  return value;
}
