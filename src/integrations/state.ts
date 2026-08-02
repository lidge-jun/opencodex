/**
 * "What is on disk, and did we put it there?"
 *
 * The classifier is deliberately ordered, and the order is load-bearing: an
 * unreadable file can never be reported as absent, and a foreign edit can never
 * be reported as ordinary drift. Getting that wrong would let `disable` delete
 * a user's own edits.
 *
 * Design of record: devlog/_plan/260802_client_toggle_api/021 §3.
 */
import { EXPORT_CLIENTS, opencodeProxyBaseUrl, type ExportModel, type ManagedContribution } from "../clients/config-export";
import type { OcxConfig } from "../types";
import { PARSE_FAILED, loadTarget, parseConfig, type IntegrationIO } from "./config-io";
import { SNAPSHOT_RETENTION } from "./journal";
import { canonicalContribution, fingerprint, type OwnershipRecord } from "./ownership";
import { INTEGRATION_CLIENTS, type IntegrationClientId } from "./registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";

export type IntegrationState = "absent" | "current" | "stale" | "conflict" | "unsafe";
export type StateReason =
  | "unparseable"
  | "not-regular-file"
  | "foreign-edit"
  | "unowned-key"
  /** A container we would have to write through holds a non-object value. */
  | "blocked-container";

export interface IntegrationStatus {
  clientId: IntegrationClientId;
  state: IntegrationState;
  installed: boolean;
  configPath: string;
  appliedAt?: string;
  lastOpId?: string;
  reason?: StateReason;
  /** Snapshot files retained for this client; -1 when they cannot be inspected. */
  snapshotCount: number;
  /** Pruning is behind, so older (possibly credential-bearing) snapshots remain. */
  retentionDegraded: boolean;
}

export function readPath(doc: unknown, path: readonly string[]): unknown {
  let cursor: unknown = doc;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/** Does the document carry any fragment we would write? */
export function hasOurFragments(doc: unknown, contribution: ManagedContribution): boolean {
  return contribution.fragments.some(fragment => readPath(doc, fragment.path) !== undefined);
}

/**
 * A container on one of our fragment paths that exists but is NOT an object.
 *
 * `setPath` replaces such a value with `{}` on the way to writing our leaf, so
 * a user whose config held `providers: ["something"]` — legal in their schema,
 * just not ours — lost it to an apply that reported success. The classifier
 * called that document `absent` because our leaf was missing, which authorized
 * the write. Detecting it here turns a silent overwrite into a refusal the
 * user can act on; the snapshot exists, but "we backed up the thing we should
 * not have destroyed" is not the promise this feature makes.
 */
export function blockedContainerPath(
  doc: unknown,
  contribution: ManagedContribution,
): readonly string[] | null {
  for (const fragment of contribution.fragments) {
    let cursor: unknown = doc;
    for (let depth = 0; depth < fragment.path.length - 1; depth += 1) {
      const key = fragment.path[depth]!;
      /*
       * ONLY `undefined` means absent. A missing file parses as `{}`, so an
       * absent prefix reads `undefined` — but a parsed `null` is a value the
       * user's file actually contains, and treating it as absent let a
       * document that is literally `null` be replaced wholesale by a
       * "successful" apply.
       */
      if (cursor === undefined) break;
      // `typeof null === "object"`, so null has to be named explicitly or it
      // walks straight into the dereference below.
      if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
        return fragment.path.slice(0, depth);
      }
      const next = (cursor as Record<string, unknown>)[key];
      if (next === undefined) break;
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        return fragment.path.slice(0, depth + 1);
      }
      cursor = next;
    }
  }
  return null;
}

/**
 * The two-axis rule: the FILE hash proves nobody touched the file after us, and
 * the BLOCK hash proves our content is still what we would write today.
 */
export function classifyIntegration(input: {
  fileText: string | null;
  fileIsRegular: boolean;
  parsed: unknown | typeof PARSE_FAILED;
  record: OwnershipRecord | null;
  contribution: ManagedContribution;
  /**
   * The file being classified. A record only describes the file it was written
   * for, so this is compared against `record.configPath` before any
   * fingerprint is trusted.
   */
  configPath?: string;
  clientId?: IntegrationClientId;
}): { state: IntegrationState; reason?: StateReason } {
  if (input.fileText !== null && !input.fileIsRegular) {
    return { state: "unsafe", reason: "not-regular-file" };
  }
  if (input.parsed === PARSE_FAILED) return { state: "unsafe", reason: "unparseable" };
  /*
   * Checked BEFORE `absent`: our leaf is missing in exactly this case, so the
   * absent branch would authorize an apply that replaces the user's value.
   */
  if (blockedContainerPath(input.parsed, input.contribution)) {
    return { state: "unsafe", reason: "blocked-container" };
  }
  if (!hasOurFragments(input.parsed, input.contribution)) return { state: "absent" };
  if (!input.record) return { state: "conflict", reason: "unowned-key" };
  /*
   * A record proves ownership of ONE file. Change HOME, XDG_CONFIG_HOME,
   * HERMES_HOME or KIMI_CODE_HOME and the same client resolves to a different
   * path — whose contents may hash identically because we generate the same
   * bytes. Trusting the fingerprint alone would let a record for path A grant
   * `current` on path B, and the writer resolves the CURRENT path, so disable
   * would then delete fragments from a file this record never owned.
   */
  if (input.clientId !== undefined && input.record.clientId !== input.clientId) {
    return { state: "conflict", reason: "unowned-key" };
  }
  if (input.configPath !== undefined && input.record.configPath !== input.configPath) {
    return { state: "conflict", reason: "unowned-key" };
  }
  if (fingerprint(input.fileText ?? "") !== input.record.fileFingerprint) {
    return { state: "conflict", reason: "foreign-edit" };
  }
  return input.record.blockFingerprint === fingerprint(canonicalContribution(input.contribution))
    ? { state: "current" }
    : { state: "stale" };
}

export interface IntegrationStateInput {
  clientId: IntegrationClientId;
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The whole integration state store, bound to one root. */
  store?: IntegrationStateStore;
  io?: IntegrationIO;
}

export function exportContextOf(input: {
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
}): { baseUrl: string; models: readonly ExportModel[]; config: OcxConfig } {
  return {
    /*
     * Composed through the SAME helper `ocx export` uses. Interpolating the
     * hostname by hand looked equivalent and was not: `::1` produced
     * `http://::1:10100/v1` and `::` produced `http://:::10100/v1`, neither of
     * which is a URL, and a `0.0.0.0` bind wrote a wildcard address no client
     * can dial. `opencodeProxyBaseUrl` brackets IPv6 and maps wildcards to
     * loopback, and every client we write into deserves the same answer the
     * export command already gives.
     */
    baseUrl: opencodeProxyBaseUrl(input.port, input.config.hostname),
    models: input.models,
    config: input.config,
  };
}

let retriedThisProcess = false;

/**
 * Retry pending prunes once per process for the default store, and always for
 * an explicitly supplied one so tests stay order-independent. Never throws: a
 * retry failure is a logged no-op, not a failed read.
 */
export function retryPendingPrunesOnce(store: IntegrationStateStore): void {
  if (store.root === createIntegrationStateStore().root) {
    if (retriedThisProcess) return;
    retriedThisProcess = true;
  }
  try {
    store.retryPendingPrunes();
  } catch (error) {
    console.error(`[integrations] prune retry failed: ${String(error)}`);
  }
}

/**
 * Retention is derived from what is ON DISK, not from the maintenance marker.
 * The marker schedules retries and can itself fail to write; a promise about
 * the user's credential-bearing backups must not depend on that.
 */
function retentionOf(
  clientId: IntegrationClientId,
  store: IntegrationStateStore,
): { snapshotCount: number; retentionDegraded: boolean } {
  const counted = store.countSnapshots(clientId);
  if (counted === null) {
    // Cannot inspect: report degraded with -1 rather than a reassuring zero.
    return { snapshotCount: -1, retentionDegraded: true };
  }
  const marked = store.readMaintenance().pruneFailures[clientId] !== undefined;
  return { snapshotCount: counted, retentionDegraded: marked || counted > SNAPSHOT_RETENTION };
}

/** The ONE reader every surface uses. */
export function readIntegrationState(input: IntegrationStateInput): IntegrationStatus {
  const store = input.store ?? createIntegrationStateStore();
  retryPendingPrunesOnce(store);
  const io = input.io ?? store.io();
  const spec = INTEGRATION_CLIENTS[input.clientId];
  const exportSpec = EXPORT_CLIENTS[input.clientId];
  const configPath = spec.configPath(input.env, input.home);
  const installed = io.statKind(spec.detectDir(input.env, input.home)) === "dir";
  const retention = retentionOf(input.clientId, store);

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return {
      clientId: input.clientId,
      state: "unsafe",
      installed,
      configPath,
      reason: target.why === "read-failed" ? "unparseable" : "not-regular-file",
      ...retention,
    };
  }

  const parsed = parseConfig(target.before, exportSpec.format);
  const contribution = exportSpec.buildContribution(exportContextOf(input));
  const record = store.readRecords()[input.clientId] ?? null;
  const { state, reason } = classifyIntegration({
    fileText: target.before,
    fileIsRegular: true,
    parsed,
    record,
    contribution,
    configPath,
    clientId: input.clientId,
  });

  return {
    clientId: input.clientId,
    state,
    installed,
    configPath,
    ...(reason ? { reason } : {}),
    ...(record ? { appliedAt: record.appliedAt, lastOpId: record.opId } : {}),
    ...retention,
  };
}
