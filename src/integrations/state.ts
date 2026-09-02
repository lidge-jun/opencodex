/**
 * "What is on disk, and did we put it there?"
 *
 * The classifier is deliberately ordered, and the order is load-bearing: an
 * unreadable file can never be reported as absent, and an edit to a fragment
 * we own can never be reported as ordinary drift. Getting that wrong would let
 * `disable` delete a user's own edits.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/021 §3.
 */
import { ClientPathError, EXPORT_CLIENTS, opencodeProxyBaseUrl, type ExportModel, type ManagedContribution } from "../clients/config-export";
import type { OcxConfig } from "../types";
import { PARSE_FAILED, loadTarget, parseConfig, type IntegrationIO } from "./config-io";
import { SNAPSHOT_RETENTION } from "./journal";
import { canonicalContribution, fingerprint, semanticContribution, type OwnershipRecord } from "./ownership";
import {
  protectedContributionFingerprint,
  refreshablePathsOf,
  semanticProtectedContributionFingerprint,
  validRefreshablePaths,
} from "./ownership-policy";
import {
  INTEGRATION_CLIENTS,
  resolveIntegrationPaths,
  unresolvedPathHintFor,
  type IntegrationClientId,
} from "./registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";

export type IntegrationState = "absent" | "current" | "stale" | "conflict" | "unsafe";
export type StateReason =
  | "unparseable"
  | "not-regular-file"
  | "foreign-edit"
  | "unowned-key"
  /** A container we would have to write through holds a non-object value. */
  | "blocked-container"
  /** A path selector we cannot resolve, e.g. a relative OPENCLAW_CONFIG_PATH. */
  | "unresolvable-path";

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
 * Fingerprint the recorded fragments as they appear in the document now.
 *
 * The record intentionally names every path we own. Comparing just those
 * values lets another integration or a user add a sibling without blocking a
 * later refresh, while a change inside our block still fails closed.
 */
function recordedContribution(
  doc: unknown,
  record: OwnershipRecord,
): ManagedContribution | null {
  if (
    !Array.isArray(record.fragmentPaths)
    || record.fragmentPaths.length === 0
    || !record.fragmentPaths.every(path => (
      Array.isArray(path)
      && path.length > 0
      && path.every(key => typeof key === "string")
    ))
  ) return null;
  const fragments = [];
  for (const path of record.fragmentPaths) {
    const value = readPath(doc, path);
    if (value === undefined) return null;
    fragments.push({ path, value });
  }
  return {
    clientId: record.clientId,
    fragments,
  };
}

/**
 * Prove that every protected field still matches what OpenCodex wrote.
 *
 * New records carry an operation-scoped protected fingerprint and the exact
 * paths excluded from it. Legacy records can recover only when the desired
 * contribution has not moved since apply; otherwise catalog drift and a
 * foreign edit are indistinguishable, so the classifier keeps failing closed.
 */
function recordedBlockIsOwned(
  doc: unknown,
  record: OwnershipRecord,
  desired: ManagedContribution,
): boolean {
  const observed = recordedContribution(doc, record);
  if (!observed) return false;
  if (fingerprint(canonicalContribution(observed)) === record.blockFingerprint) return true;

  const observedSemanticFingerprint = fingerprint(semanticContribution(observed));
  if (
    typeof record.semanticBlockFingerprint === "string"
    && observedSemanticFingerprint === record.semanticBlockFingerprint
  ) return true;

  const desiredFingerprint = fingerprint(canonicalContribution(desired));
  if (
    desiredFingerprint === record.blockFingerprint
    && observedSemanticFingerprint === fingerprint(semanticContribution(desired))
  ) return true;

  if (
    typeof record.protectedBlockFingerprint === "string"
    && validRefreshablePaths(observed, record.refreshablePaths)
    && record.refreshablePaths.length > 0
  ) {
    const observedProtectedFingerprint = protectedContributionFingerprint(
      observed,
      record.refreshablePaths,
    );
    if (observedProtectedFingerprint === record.protectedBlockFingerprint) return true;

    const observedSemanticProtectedFingerprint = semanticProtectedContributionFingerprint(
      observed,
      record.refreshablePaths,
    );
    if (
      typeof record.semanticProtectedBlockFingerprint === "string"
      && observedSemanticProtectedFingerprint === record.semanticProtectedBlockFingerprint
    ) return true;

    return protectedContributionFingerprint(desired, record.refreshablePaths)
        === record.protectedBlockFingerprint
      && observedSemanticProtectedFingerprint
        === semanticProtectedContributionFingerprint(desired, record.refreshablePaths);
  }

  if (desiredFingerprint !== record.blockFingerprint) return false;
  const legacyPaths = refreshablePathsOf(desired);
  return legacyPaths.length > 0
    && semanticProtectedContributionFingerprint(observed, legacyPaths)
      === semanticProtectedContributionFingerprint(desired, legacyPaths);
}

/**
 * The two-axis rule: the recorded bytes or fragments prove nobody changed
 * what we may rewrite, and the contribution hash proves our catalog has not
 * moved on. Three classes of client (revising the unconditional whole-file
 * rule of devlog 260802_client_toggle_api/021 §3 for json — #1631):
 * registry-declared source-preserving YAML clients are fragment-scoped because
 * their writers patch only the owned leaf, so the whole-file check is skipped;
 * strict-json clients keep the whole-file check but downgrade a drift with
 * intact owned fragments to `stale`, because a rewrite there can lose only
 * formatting (comments cannot parse, non-round-tripping numbers are refused
 * by the serializer); every comment-capable whole-document serializer (yaml,
 * json5, toml) retains the whole-file fingerprint guard as a hard conflict.
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

  /*
   * Fragments the desired contribution carries beyond the paths this record names. Both
   * states appear whenever a client gains a second owned block:
   *
   *   - occupied by a value we did not write -> refuse. A refresh merges the WHOLE
   *     contribution, so without this check applying would replace a block the user wrote
   *     themselves and report success.
   *   - empty -> our own block is missing, because the record predates it. Report drift so
   *     a refresh adds it. Without this the file reads `current` forever and the second
   *     block never arrives, which is exactly what an older installation hits on upgrade.
   *
   * A byte-identical value is ours in substance: adopt it instead of dead-ending a
   * hand-merged config on a conflict the user can only resolve by deleting our own block.
   */
  const recordedPaths = new Set((input.record?.fragmentPaths ?? []).map(path => path.join("\u0000")));
  let addedPathMissing = false;
  for (const fragment of input.contribution.fragments) {
    if (recordedPaths.has(fragment.path.join("\u0000"))) continue;
    const observed = readPath(input.parsed, fragment.path);
    if (observed === undefined) {
      addedPathMissing = true;
      continue;
    }
    const one = (value: unknown): string => fingerprint(canonicalContribution({
      clientId: (input.clientId ?? input.record?.clientId) as IntegrationClientId,
      fragments: [{ path: fragment.path, value }],
    }));
    if (one(observed) !== one(fragment.value)) return { state: "conflict", reason: "unowned-key" };
  }
  /*
   * No record: whatever occupies our paths is not ours to touch. A byte-identical value
   * would be ours in substance, but `stale` without a record is not actionable — the writer
   * reads `createdContainers` off the record to decide what it may prune, so adopting a
   * hand-merged block needs an apply path that creates one first. Refuse, exactly as before.
   */
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
  const clientId = input.clientId ?? input.record.clientId;
  /*
   * Checked BEFORE file-level drift: an edit INSIDE an owned fragment is a
   * conflict no matter what the rest of the file looks like, so the sibling-
   * edit exemption below can never mask it.
   */
  if (!recordedBlockIsOwned(input.parsed, input.record, input.contribution)) {
    return { state: "conflict", reason: "foreign-edit" };
  }
  if (!INTEGRATION_CLIENTS[clientId].sourcePreservingYaml
    && fingerprint(input.fileText ?? "") !== input.record.fileFingerprint) {
    /*
     * The file changed since we wrote it, but every fragment we own is still
     * byte-for-byte what we put there — a sibling edit, not tampering. Apply
     * rewrites the WHOLE document, so for comment-capable formats (yaml,
     * json5, toml) it would drop comments the user wrote next to us: fail
     * closed there. Strict JSON cannot carry comments — a commented file
     * never reaches this branch because parsing already failed — so the only
     * possible loss is formatting normalization: everything a rewrite would
     * actually change (numbers that would not round-trip, duplicate members
     * a rewrite would delete) is PARSE_FAILED in parseConfig and classifies
     * as unsafe long before this branch, exactly like comments. Refusing
     * forever over formatting
     * dead-ends the integration on the user's first own config edit (#1631).
     * Report drift instead; a re-apply merges into the parsed document as it
     * stands and re-owns the file. This also lets disable proceed on a
     * drifted file — removal still touches only the recorded fragment paths.
     */
    if (EXPORT_CLIENTS[clientId].format !== "json") {
      return { state: "conflict", reason: "foreign-edit" };
    }
    return { state: "stale" };
  }
  /*
   * Checked after everything else that could refuse: an owned fragment that no longer
   * matches, or a sibling edit in a format that cannot be rewritten safely, still wins.
   * What is left is a block we own on paper and are merely missing on disk.
   */
  if (addedPathMissing) return { state: "stale" };
  const desiredFingerprint = typeof input.record.semanticBlockFingerprint === "string"
    ? fingerprint(semanticContribution(input.contribution))
    : fingerprint(canonicalContribution(input.contribution));
  const recordedFingerprint = input.record.semanticBlockFingerprint ?? input.record.blockFingerprint;
  return recordedFingerprint === desiredFingerprint
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
    baseUrl: opencodeProxyBaseUrl(input.port, input.config.hostname, input.config),
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
  const retention = retentionOf(input.clientId, store);
  /*
   * Resolution can refuse — a relative OPENCLAW_* selector names a file whose
   * meaning depends on a working directory we cannot know. The LIST route asks
   * every client for its state, so letting that escape would answer 500 for
   * the whole Integrations page because one client is misconfigured.
   */
  let configPath: string;
  let installed: boolean;
  try {
    // One resolution for both, so a client whose paths come from mutable state
    // cannot report one account's install beside another account's config path.
    const paths = resolveIntegrationPaths(input.clientId, input.env, input.home);
    configPath = paths.configPath;
    installed = io.statKind(paths.detectDir) === "dir";
  } catch (error) {
    if (!(error instanceof ClientPathError)) throw error;
    /*
     * Two different situations reach here and they are not the same answer.
     *
     * A relative `OPENCLAW_CONFIG_PATH` is a misconfiguration: there is nothing
     * to name, and "cannot verify" is correct. Aside's absent account manifest
     * is the ORDINARY state of an Aside that has been installed and never
     * signed into, and answering that with a red danger badge and an empty path
     * told the user their config was suspect when in fact there is no account
     * yet. A client that can name where its config would go gets `installed:
     * false` and that location, which reads as "not installed" in the UI.
     */
    const hint = unresolvedPathHintFor(input.clientId, input.env, input.home);
    return {
      clientId: input.clientId,
      state: hint ? "absent" : "unsafe",
      installed: false,
      configPath: hint,
      reason: "unresolvable-path",
      ...retention,
    };
  }

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
