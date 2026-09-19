import { readConfigAdmissionSnapshot } from "./diagnostics";
import { getConfigPath } from "./paths";
import { canonicalPlainData, copyPlainData, isPlainObject, ownDataKeys } from "../lib/plain-data";
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
  const config = withExecutors(resident);
  if (config === null) return null;
  const admission: ExportConfigAdmission = { config };
  evidence.set(admission, { path, file, data: canonicalPlainData(resident.data), executors: resident.executors });
  return admission;
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
  if (resident === null || canonicalPlainData(resident.data) !== captured.data) return false;
  if (!sameExecutors(resident.executors, captured.executors)) return false;
  const working = detachConfig(admission.config);
  return working !== null
    && canonicalPlainData(working.data) === captured.data
    && sameExecutors(working.executors, captured.executors);
}

/**
 * A plain-data copy of a configuration for a consumer that must not observe later edits, or null.
 *
 * The integration writer is the case this exists for. It freezes every other resolution seam
 * before its first await and then held the configuration by reference, so a plan checked under one
 * configuration could be written from another: the check and the document it authorized were
 * reading the same object at two different moments. One copy taken before the await gives both of
 * them the same configuration.
 *
 * Null rather than the caller's object when the copy cannot be made. Handing back the reference
 * would have been a copy in name only, and the caller would have gone on to describe it as the
 * configuration it checked.
 */
export function detachedConfigSnapshot(config: OcxConfig): OcxConfig | null {
  const detached = detachConfig(config);
  return detached === null ? null : withExecutors(detached);
}

/**
 * The configuration file as an opaque term: its exact bytes, or the distinguished absence of one.
 *
 * This is a byte observation and nothing more. It says the operator's configuration file has not
 * been rewritten since a roster was built; it is not a claim about whether the configuration the
 * process is holding agrees with that file.
 *
 * Null for a file that cannot be read, because then a later read cannot tell whether it changed.
 * Null too for one that is there and does not load cleanly, which is the existing contract for a
 * derived roster rather than an inference about the resident configuration. Before this, a digest
 * was accepted ahead of any look at what the parse produced.
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
 * A configuration as plain data, with the transport executors kept out of it.
 *
 * The copier refuses everything JSON could not have produced, so the one thing that needs handling
 * here is a provider's fetch executor: a caller owns it and the gather uses it instead of the
 * global transport. It is held by reference for the detached copy and compared by reference
 * afterwards, so replacing it invalidates the binding while it is never serialized.
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
      const copied = copyPlainData(value);
      if (!copied.ok) return null;
      data[key] = copied.value;
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
        // The executor exception applies to an executor. A provider entry keeps unknown
        // configuration keys, so a fetch value that is not a function is something an operator
        // wrote into the file, and it is copied and compared as the data it is. Discovery reads it
        // the same way: the outbound transport takes its built-in path unless the value is
        // callable.
        if (field === "fetch" && typeof fieldValue === "function") {
          executors.set(name, fieldValue);
          continue;
        }
        const copied = copyPlainData(fieldValue);
        if (!copied.ok) return null;
        copiedProvider[field] = copied.value;
      }
      providers[name] = copiedProvider;
    }
    data[key] = providers;
  }
  return { data, executors };
}

/** The copy a consumer runs against, with the executors put back by reference. */
function withExecutors(detached: DetachedConfig): OcxConfig | null {
  // A second copy, so what is compared later is never the object handed to a consumer.
  const copied = copyPlainData(detached.data);
  if (!copied.ok) return null;
  const config = copied.value;
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
