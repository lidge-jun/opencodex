/**
 * Value-free planning for integration mutations.
 *
 * An operator confirming "apply", "overwrite", "disable" or "undo" is agreeing to consequences
 * nobody has shown them. This module computes those consequences as bounded managed schema paths
 * and closed change kinds, and binds them to a fingerprint over every input the decision rested
 * on, so a confirmation can be refused when the state it described has moved.
 *
 * Two rules give the output its safety. Nothing here is a value: paths are structural, and a
 * segment that is not representable in the managed grammar is dropped rather than echoed, because
 * an ownership record on disk accepts arbitrary strings and is not a validation authority. And
 * nothing here writes: this module owns no IO, takes no lock, and must never import the writer.
 * The dependency direction is state/ownership/merge into here, and here into the writer and the
 * preview route.
 */
import { createHash } from "node:crypto";
import { canonicalContribution, fingerprint, type OwnershipRecord } from "./ownership";
import { ClientPathError, EXPORT_CLIENTS, type ExportModel, type ManagedContribution } from "../clients/config-export";
import { OPENCODE_PROVIDER_ID } from "../clients/config-export/constants";
import { createClineIO, ClineTransactionError } from "./cline-io";
import { parseClineDocument } from "./cline-document";
import { PARSE_FAILED, defaultIntegrationIO, loadTarget, parseConfig, type IntegrationIO } from "./config-io";
import { INTEGRATION_CLIENTS, isLoopbackOnly, resolveIntegrationPaths, type IntegrationClientId } from "./registry";
import { shouldInjectApiAuthHeader } from "../codex/inject";
import { classifyIntegration, exportContextOf, readPath, type IntegrationState, type StateReason } from "./state";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";
import type { OcxConfig } from "../types";
import { matchesOperationResult, type JournalEntry } from "./journal";

/**
 * Why a mutation refused. Declared here rather than in the writer so the planner can report a
 * refusal without depending on the module that performs writes; the writer re-exports it, so this
 * is a move rather than a second vocabulary.
 */
export type RefusalReason =
  | "not_installed"
  | "conflict"
  | "unsafe"
  | "non_loopback"
  | "drift_requires_confirm"
  | "snapshot_expired"
  | "write_failed";

export type IntegrationPlanOperation = "apply" | "overwrite" | "disable" | "restore";
export type IntegrationPlanChangeKind = "add" | "replace" | "remove" | "snapshot" | "ownership" | "journal";
export type IntegrationPlanForeignEdit = "none" | "unowned" | "foreign-edit" | "drift";

/**
 * Effects that are not places in the client's document. They carry no disk location and no value,
 * so an operator learns that history will be written without learning where it lives.
 */
export const PLAN_SNAPSHOT_PATH = "$snapshot";
export const PLAN_OWNERSHIP_PATH = "$ownership";
export const PLAN_JOURNAL_PATH = "$journal";

/**
 * Upper bound on reported changes. Above the largest contribution any registered client builds and
 * well below a response worth truncating, so the cap is a guard rather than a routine limit.
 */
export const PLAN_CHANGE_LIMIT = 256;

export interface IntegrationPlanChange {
  readonly kind: IntegrationPlanChangeKind;
  readonly path: string;
}

export interface IntegrationMutationPlan {
  readonly version: 1;
  readonly clientId: IntegrationClientId;
  readonly operation: IntegrationPlanOperation;
  readonly state: IntegrationState;
  readonly foreignEdit: IntegrationPlanForeignEdit;
  readonly changes: readonly IntegrationPlanChange[];
  readonly fingerprint: string;
  readonly canApply: boolean;
  /**
   * Whether confirming would write at all.
   *
   * An apply against an already-current file and a disable against an absent one both succeed
   * while writing nothing, so reporting a snapshot and a journal row for them would describe
   * consequences that never happen.
   */
  readonly willChange: boolean;
  readonly refusalReason?: RefusalReason;
  readonly profileId?: number;
}

/** A position whose observed value is never published, only its presence. */
export const DYNAMIC_SEGMENT = "*";

/**
 * Where each client's managed fragments live, declared rather than inferred.
 *
 * A general "looks like a plain key" rule is not good enough, and Kimi is the proof: it writes one
 * fragment per model at `models.<alias>`, so an alphanumeric allowlist would publish a user's
 * model identifier verbatim. The same rule would accept any plain path sitting in an ownership
 * record, and a record on disk is not a validation authority.
 *
 * So a path is published only when it matches one of these templates exactly. Static segments must
 * match literally, a DYNAMIC_SEGMENT position accepts any observed segment, and the string that
 * leaves this module is the TEMPLATE rather than the observed path. That is what makes publishing
 * a value structurally impossible instead of merely unlikely.
 *
 * The satisfies clause makes a new client a type error here, so nobody can add one whose managed
 * paths silently have no declaration.
 */
const CLIENT_MANAGED_PATHS = {
  opencode: [["provider", OPENCODE_PROVIDER_ID], ["providers", OPENCODE_PROVIDER_ID]],
  pi: [["providers", OPENCODE_PROVIDER_ID]],
  omp: [["providers", OPENCODE_PROVIDER_ID]],
  hermes: [["providers", OPENCODE_PROVIDER_ID]],
  openclaw: [["models", "providers", OPENCODE_PROVIDER_ID]],
  kimi: [["providers", OPENCODE_PROVIDER_ID], ["models", DYNAMIC_SEGMENT]],
  gajae: [["providers", OPENCODE_PROVIDER_ID]],
  dsh: [["llm-pi-ai", "providers", OPENCODE_PROVIDER_ID]],
  mcode: [["custom_provider", OPENCODE_PROVIDER_ID]],
  zcode: [["provider", OPENCODE_PROVIDER_ID]],
  prime: [["providers", OPENCODE_PROVIDER_ID]],
  aside: [["providers", OPENCODE_PROVIDER_ID]],
  raycast: [["providers", `[id=${OPENCODE_PROVIDER_ID}]`]],
  omo: [["providers", OPENCODE_PROVIDER_ID]],
  cline: [
    ["settings", "providers", OPENCODE_PROVIDER_ID],
    ["catalog", "providers", OPENCODE_PROVIDER_ID],
  ],
} satisfies Record<IntegrationClientId, readonly (readonly string[])[]>;

/** Not a configuration surface. Exported so a parity case can compare it against the shipped clients. */
export const MANAGED_PATH_TEMPLATES: Readonly<Record<IntegrationClientId, readonly (readonly string[])[]>> = CLIENT_MANAGED_PATHS;

function matchesTemplate(template: readonly string[], path: readonly string[]): boolean {
  if (template.length !== path.length) return false;
  return template.every((segment, index) => {
    const observed = path[index];
    if (observed === undefined || observed.length === 0) return false;
    return segment === DYNAMIC_SEGMENT || segment === observed;
  });
}

/**
 * The managed schema path this change touches, or null when the path is outside the client's
 * declared grammar.
 *
 * Null is not an error to work around. A path nobody declared is either a record written by a
 * different version or something arbitrary, and neither is safe to name, so the caller reports the
 * fixed ownership pseudo-path or a refusal instead of inventing a description.
 */
export function canonicalSchemaPath(clientId: IntegrationClientId, path: readonly string[]): string | null {
  if (path.length === 0) return null;
  for (const template of CLIENT_MANAGED_PATHS[clientId]) {
    if (matchesTemplate(template, path)) return template.join(".");
  }
  return null;
}

const KIND_ORDER: readonly IntegrationPlanChangeKind[] = ["add", "replace", "remove", "snapshot", "ownership", "journal"];

/**
 * Deterministic, deduplicated and capped. Deterministic because the fingerprint is taken over this
 * projection, so an unstable order would stale a plan that did not change.
 */
export function orderPlanChanges(changes: readonly IntegrationPlanChange[]): readonly IntegrationPlanChange[] {
  const seen = new Set<string>();
  const unique: IntegrationPlanChange[] = [];
  for (const change of changes) {
    const key = `${change.kind}\u0000${change.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(change);
  }
  unique.sort((left, right) => {
    const byKind = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
    if (byKind !== 0) return byKind;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  return Object.freeze(unique.slice(0, PLAN_CHANGE_LIMIT));
}

/**
 * Every input the plan's authority rests on.
 *
 * `models` is here because the desired contribution is derived from it, so a model roster that
 * changed between preview and commit changes what would be written. `snapshot` carries a digest of
 * the bytes a restore would actually publish rather than only the operation id, because the id
 * names the row and the bytes are what lands in the user's file.
 */
export interface PlanFingerprintInput {
  readonly operation: IntegrationPlanOperation;
  readonly clientId: IntegrationClientId;
  readonly profileId?: number;
  readonly configPath: string;
  readonly detectDir: string;
  /**
   * What the detect directory actually was when observed, not merely where it is.
   *
   * Binding only the path leaves a confirmation valid across an uninstall: the contribution is
   * unchanged, so every other component matches, while the answer to "is this client installed"
   * has flipped. The observed kind is the input the not_installed refusal is derived from.
   */
  readonly installKind: string;
  /**
   * Whether admission policy blocks this integration, which is the non_loopback refusal's input.
   *
   * Config eligibility can change without touching the file, the record or the contribution, so a
   * plan that did not bind it could be confirmed after the proxy stopped being a legal target.
   */
  readonly admissionBlocked: boolean;
  /** Exact current bytes, or null when the target is missing. Missing and empty are not equal. */
  readonly before: string | null;
  readonly contribution: ManagedContribution | null;
  readonly record: OwnershipRecord | null;
  readonly models: readonly ExportModel[];
  readonly restore?: {
    readonly opId: string;
    readonly entry: JournalEntry;
    readonly snapshotKind: string;
    /** Digest of the snapshot's exact text, or null when it holds none. */
    readonly snapshotText: string | null;
    readonly confirmDrift: boolean;
    /**
     * Whether the target has changed since the operation being undone, which is the
     * drift_requires_confirm predicate. Passed in rather than recomputed so the plan and the
     * mutation read drift from the same comparison.
     */
    readonly driftsFromResult: boolean;
  };
}

const PLAN_FINGERPRINT_VERSION = "p1";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * An opaque optimistic-concurrency token, not authorization.
 *
 * Longer than the 16-hex ownership fingerprint because this one is supplied by a caller and
 * compared for equality, so accidental collision matters more than it does for a stored digest.
 * The version prefix means a future input set invalidates old tokens instead of silently
 * comparing two different meanings.
 */
export function planFingerprint(input: PlanFingerprintInput): string {
  const restore = input.restore;
  const components = [
    PLAN_FINGERPRINT_VERSION,
    input.operation,
    input.clientId,
    input.profileId === undefined ? null : input.profileId,
    input.configPath,
    input.detectDir,
    input.installKind,
    input.admissionBlocked,
    input.before === null ? "\u0000absent" : fingerprint(input.before),
    input.contribution === null ? null : fingerprint(canonicalContribution(input.contribution)),
    input.record === null ? null : fingerprint(JSON.stringify(input.record)),
    fingerprint(JSON.stringify(input.models)),
    restore === undefined ? null : [
      restore.opId,
      fingerprint(JSON.stringify(restore.entry)),
      restore.snapshotKind,
      restore.snapshotText === null ? "\u0000none" : fingerprint(restore.snapshotText),
      restore.confirmDrift,
      restore.driftsFromResult,
    ],
  ];
  return `${PLAN_FINGERPRINT_VERSION}:${digest(JSON.stringify(components))}`;
}

/** The observation facts a plan is derived from, beside the fingerprint inputs. */
export interface PlanInput extends PlanFingerprintInput {
  readonly classified: { readonly state: IntegrationState; readonly reason?: StateReason };
  /**
   * The parsed target document. Whether a managed place is occupied is a fact about the file, not
   * about our record: an overwrite of a key somebody else wrote replaces a value even though no
   * record of ours mentions it.
   */
  readonly parsed: unknown;
}

type PlanOutcome =
  | { readonly kind: "refuse"; readonly reason: RefusalReason }
  | { readonly kind: "noop" }
  | { readonly kind: "change" };

const CHANGE: PlanOutcome = { kind: "change" };
const NOOP: PlanOutcome = { kind: "noop" };
const deny = (reason: RefusalReason): PlanOutcome => ({ kind: "refuse", reason });

function foreignEditOf(input: PlanInput): IntegrationPlanForeignEdit {
  if (input.restore?.driftsFromResult) return "drift";
  if (input.classified.reason === "unowned-key") return "unowned";
  if (input.classified.reason === "foreign-edit") return "foreign-edit";
  return "none";
}

/**
 * Why this operation would refuse, in the writer's own order.
 *
 * The order is not cosmetic. An uninstalled client is reported as not installed rather than as
 * whatever its leftover file happens to classify as, and an unreadable or unparseable file is
 * reported before either, because that is the sequence the writer itself refuses in. A plan that
 * named a different reason than the mutation would name is worse than no plan.
 */
function applyOutcome(input: PlanInput): PlanOutcome {
  if (input.installKind !== "dir") return deny("not_installed");
  if (input.admissionBlocked) return deny("non_loopback");
  // Overwrite exists precisely to proceed through a conflict the operator has been shown.
  if (input.classified.state === "conflict" && input.operation !== "overwrite") return deny("conflict");
  if (input.classified.state === "unsafe") return deny("unsafe");
  if (input.classified.state === "current") return NOOP;
  return CHANGE;
}

/**
 * Disable answers a different question, so it asks different ones.
 *
 * It never checks installation or admission: removing what we wrote from a file that still exists
 * is meaningful whether or not the client is installed now, and it emits nothing that admission
 * policy could object to. An absent block is a success that writes nothing rather than a refusal.
 */
function disableOutcome(input: PlanInput): PlanOutcome {
  if (input.classified.state === "absent") return NOOP;
  if (input.classified.state === "conflict") return deny("conflict");
  if (input.classified.state === "unsafe") return deny("unsafe");
  return CHANGE;
}

function restoreOutcome(input: PlanInput): PlanOutcome {
  if (input.restore === undefined) return deny("unsafe");
  if (input.restore.snapshotKind === "expired") return deny("snapshot_expired");
  if (input.restore.driftsFromResult && !input.restore.confirmDrift) return deny("drift_requires_confirm");
  return CHANGE;
}

/**
 * What this operation would do, decided the way the operation itself decides it.
 *
 * Applying one global sequence to all four was wrong: it reported disable as refused on an
 * uninstalled client the writer would have accepted, and it ranked the classifier's unsafe ahead
 * of a conflict that apply reports first. A plan is only useful if it reaches the same verdict,
 * for the same reason, as the mutation it describes.
 */
function outcomeOf(input: PlanInput): PlanOutcome {
  if (input.operation === "restore") return restoreOutcome(input);
  if (input.operation === "disable") return disableOutcome(input);
  return applyOutcome(input);
}


/**
 * The managed places this operation would touch, plus the history it would write.
 *
 * A path that does not canonicalize is omitted rather than guessed at. For a shipped client that
 * cannot happen, and the parity case proves it; what it does cover is a record written by another
 * version, where declining to describe a path is the honest answer and the fixed ownership entry
 * still tells the operator that ownership changes.
 */
function changesOf(input: PlanInput): readonly IntegrationPlanChange[] {
  const changes: IntegrationPlanChange[] = [];
  if (input.operation === "apply" || input.operation === "overwrite") {
    for (const fragment of input.contribution?.fragments ?? []) {
      const path = canonicalSchemaPath(input.clientId, fragment.path);
      if (path === null) continue;
      // Occupied is a fact about the document. Deciding from our own record instead would call an
      // overwrite of somebody else's key an addition, which is the one case overwrite exists for.
      const occupied = readPath(input.parsed, fragment.path) !== undefined;
      changes.push({ kind: occupied ? "replace" : "add", path });
    }
  }
  if (input.operation === "disable") {
    for (const owned of input.record?.fragmentPaths ?? []) {
      const path = canonicalSchemaPath(input.clientId, owned);
      if (path === null) continue;
      changes.push({ kind: "remove", path });
    }
  }
  if (input.operation === "restore") {
    /*
     * An undo replaces the whole document, so what it changes is the difference between the
     * places that are ours now and the places the row recorded as ours before that operation ran.
     *
     * Reading only the prior record got both common undos wrong. Undoing an initial apply has no
     * prior record, so the plan described a change to nothing at all while the undo removed the
     * managed block. Undoing a disable has a prior record and an empty document, so the plan said
     * it would replace paths the file does not currently have.
     *
     * Provenance is still restored rather than re-derived: the prior record is what says which
     * places are ours afterwards. The document only answers whether each of them is there now.
     */
    const prior = new Map<string, readonly string[]>();
    for (const fragment of input.restore?.entry.priorRecord?.fragmentPaths ?? []) {
      const path = canonicalSchemaPath(input.clientId, fragment);
      if (path !== null) prior.set(path, fragment);
    }
    /*
     * A document we could not read says nothing about whether a place is there, and restore does
     * not need it read: eligibility is a question about bytes. Where it cannot be read, each place
     * is reported as a replacement, which is what this list said before any of it was derived.
     */
    const documentKnown = input.parsed !== PARSE_FAILED;
    for (const [path, fragment] of prior) {
      const absent = documentKnown && readPath(input.parsed, fragment) === undefined;
      changes.push({ kind: absent ? "add" : "replace", path });
    }
    for (const fragment of input.record?.fragmentPaths ?? []) {
      const path = canonicalSchemaPath(input.clientId, fragment);
      if (path === null || prior.has(path)) continue;
      changes.push({ kind: "remove", path });
    }
  }
  changes.push({ kind: "snapshot", path: PLAN_SNAPSHOT_PATH });
  changes.push({ kind: "ownership", path: PLAN_OWNERSHIP_PATH });
  changes.push({ kind: "journal", path: PLAN_JOURNAL_PATH });
  return orderPlanChanges(changes);
}

/**
 * The whole plan, value-free.
 *
 * A refused plan is still worth returning: knowing that undo is blocked because the backup expired
 * is the answer an operator needs, and it carries no more detail than an allowed one.
 */
export function buildMutationPlan(input: PlanInput): IntegrationMutationPlan {
  const outcome = outcomeOf(input);
  return Object.freeze({
    version: 1 as const,
    clientId: input.clientId,
    operation: input.operation,
    state: input.classified.state,
    foreignEdit: foreignEditOf(input),
    // Only a plan that would actually write describes places to write.
    changes: outcome.kind === "change" ? changesOf(input) : Object.freeze([]),
    fingerprint: planFingerprint(input),
    canApply: outcome.kind !== "refuse",
    willChange: outcome.kind === "change",
    ...(outcome.kind === "refuse" ? { refusalReason: outcome.reason } : {}),
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  });
}

/**
 * The token a plan carries when observation itself refused.
 *
 * Such a plan never read the state it would have bound, so there is nothing to bind. It is safe
 * for every one of them to share this value because `canApply` is false, and a mutation may only
 * be bound to a plan that could apply.
 */
export const PLAN_UNBOUND_FINGERPRINT = `${PLAN_FINGERPRINT_VERSION}:unbound`;

function unboundPlan(
  clientId: IntegrationClientId,
  operation: IntegrationPlanOperation,
  failure: IntegrationObservationFailure,
  profileId?: number,
): IntegrationMutationPlan {
  return Object.freeze({
    version: 1 as const,
    clientId,
    operation,
    state: failure.state,
    foreignEdit: "none" as const,
    changes: Object.freeze([]),
    fingerprint: PLAN_UNBOUND_FINGERPRINT,
    canApply: false,
    willChange: false,
    refusalReason: failure.reason,
    ...(profileId === undefined ? {} : { profileId }),
  });
}

/**
 * Restore reads a different specification, so it gets its own observation.
 *
 * The writer's undo path never parses and never classifies: it compares the resolved config path
 * against the one the journal row was recorded for, reads the snapshot, and reads the target's
 * BYTES. Routing a preview through the general observation therefore refused an undo of a file
 * that was readable but unparseable, which is the state that most needs restoring, and accepted a
 * row recorded against a previous home, which is the single case path equality exists to refuse.
 */
export function observeRestore(
  input: IntegrationWriteInput,
  opId: string,
  effects: ObservationEffects,
  /**
   * The row a caller already selected, with the store it came from.
   *
   * Aside can hold more than one valid copy of the same operation, so re-resolving here could
   * legitimately pick a different row than the mutation will. The plan would then describe an
   * operation the confirmation was never about. A caller that has resolved one passes it in, and
   * neither side resolves again.
   */
  selectedOperation?: { entry: JournalEntry; store: IntegrationStateStore },
) {
  const store = selectedOperation?.store ?? input.store ?? createIntegrationStateStore();
  let io = input.io ?? defaultIntegrationIO(store);
  const clientId = input.clientId;
  let resolved: { configPath: string; detectDir: string };
  try {
    resolved = input.resolvedPaths ?? resolveIntegrationPaths(clientId, input.env, input.home);
  } catch (error) {
    if (!(error instanceof ClientPathError)) throw error;
    return { failed: observationFailure("unsafe", "unsafe", error.message) } as const;
  }
  // Coordinated restore refuses this before it looks at the row at all: an undo will not create
  // the client's home, so a writer-lock client without one has nothing to restore into.
  if (INTEGRATION_CLIENTS[clientId].writerLock && io.statKind(resolved.detectDir) !== "dir") {
    return {
      failed: observationFailure("unsafe", "unsafe", "the client home is missing; restore will not create it"),
    } as const;
  }
  const entry = selectedOperation?.entry ?? store.findOperation(opId);
  if (!entry || entry.clientId !== clientId) {
    return { failed: observationFailure("unsafe", "unsafe", "that operation cannot be undone") } as const;
  }
  const configPath = entry.configPath;
  // An undo acts on the path the operation was journaled against. A row recorded for one home must
  // never be allowed to rewrite a file in another.
  if (resolved.configPath !== configPath) {
    return {
      failed: observationFailure("conflict", "conflict", "that operation was recorded for a different location"),
    } as const;
  }
  if (clientId === "cline") {
    try { io = createClineIO(io, configPath, store, effects.recover); }
    catch (error) {
      if (!(error instanceof ClineTransactionError)) throw error;
      return { failed: { ...observationFailure("unsafe", "unsafe", error.message, error.snapshotPath), residual: true } } as const;
    }
  }
  const snapshot = store.readSnapshot(entry);
  /*
   * Expiry is decided before the target is read, exactly as the writer decides it. Reading first
   * let an expired backup over an unreadable file report the file as the problem, when the answer
   * the operator needs is that the backup is gone.
   */
  if (snapshot.kind === "expired") {
    return { failed: observationFailure("snapshot_expired", "absent", "that backup has expired") } as const;
  }
  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return { failed: observationFailure("unsafe", "unsafe", "the target cannot be read safely") } as const;
  }
  const before = target.before;
  return {
    failed: undefined,
    clientId,
    configPath,
    detectDir: resolved.detectDir,
    installKind: io.statKind(resolved.detectDir),
    entry,
    snapshotKind: snapshot.kind,
    snapshotText: snapshot.kind === "stored" ? snapshot.text : null,
    before,
    // Bytes only. Parsing here is exactly what must not happen.
    driftsFromResult: !matchesOperationResult(entry, before),
  } as const;
}

export interface PreviewRequest {
  readonly operation: IntegrationPlanOperation;
  /** Required for restore; names the journalled operation being undone. */
  readonly opId?: string;
  readonly confirmDrift?: boolean;
  readonly profileId?: number;
  /** A row and store the caller already selected, so neither side resolves it twice. */
  readonly resolved?: { entry: JournalEntry; store: IntegrationStateStore };
}

/**
 * Plan an operation without performing it.
 *
 * Observation runs with both write-capable effects off, so this path prunes nothing, recovers
 * nothing, takes no lock and enters no mutation flight. Everything it reads is a read: the target
 * file, the ownership records, and for restore the journal row and its snapshot.
 */
export function previewIntegration(input: IntegrationWriteInput, request: PreviewRequest): IntegrationMutationPlan {
  // Restore never reaches the general observation, because the writer's undo path never parses
  // or classifies and a preview that did would answer a different question.
  if (request.operation === "restore") return previewRestore(input, request);
  const observed = observeIntegration(input, { maintenance: false, recover: false });
  if (observed.failed) return unboundPlan(input.clientId, request.operation, observed.failed, request.profileId);

  const shared = {
    operation: request.operation,
    clientId: observed.clientId,
    configPath: observed.configPath,
    detectDir: observed.detectDir,
    installKind: observed.io.statKind(observed.detectDir),
    // Loopback-only clients cannot carry the admission header a non-loopback bind requires.
    admissionBlocked: isLoopbackOnly(observed.clientId) && shouldInjectApiAuthHeader(input.config),
    before: observed.before,
    contribution: observed.contribution,
    record: observed.record,
    models: input.models,
    classified: observed.classified,
    parsed: observed.parsed,
    ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
  };

  return buildMutationPlan(shared);
}

/**
 * Which places are ours in the file this undo would rewrite, read the same way the general
 * observation reads them.
 *
 * Read from the store bound to the target being rewritten, never from the store a historical row
 * was selected out of. Aside keeps a copy of an operation in the root store while the profile's
 * own store holds the ownership for its file, so asking the selected row's store would have
 * described the wrong file's ownership. The selected store stays what it is for: the row and its
 * snapshot. A record written for another location grants nothing here either, which is the same
 * rule the writer applies.
 */
function currentRecordFor(
  input: IntegrationWriteInput,
  clientId: IntegrationClientId,
  configPath: string,
): OwnershipRecord | null {
  const store = input.store ?? createIntegrationStateStore();
  const stored = store.readRecords()[clientId] ?? null;
  return stored && stored.clientId === clientId && stored.configPath === configPath ? stored : null;
}

/**
 * Plan an undo the way the writer performs one.
 *
 * State is derived from bytes alone: a missing target is absent, a target that no longer matches
 * the row's recorded result is a conflict, and anything else is current. Admission is not asked
 * about, because restore emits nothing an admission policy could object to and the writer does not
 * ask either.
 */
function previewRestore(input: IntegrationWriteInput, request: PreviewRequest): IntegrationMutationPlan {
  const refusal = (message: string): IntegrationMutationPlan =>
    unboundPlan(input.clientId, "restore", { reason: "unsafe", state: "unsafe", message }, request.profileId);
  if (request.opId === undefined) return refusal("that operation cannot be undone");

  const observed = observeRestore(
    input,
    request.opId,
    { maintenance: false, recover: false },
    request.resolved,
  );
  if (observed.failed) return unboundPlan(input.clientId, "restore", observed.failed, request.profileId);

  /*
   * Drift decides first. A row that recorded a file and now finds none has drifted, and calling
   * that absent would report a missing file as an ordinary undo while the writer refuses it
   * pending confirmation. Absent is only honest when the recorded result was absence too.
   */
  const state: IntegrationState = observed.driftsFromResult
    ? "conflict"
    : observed.before === null ? "absent" : "current";

  return buildMutationPlan({
    operation: "restore",
    clientId: observed.clientId,
    configPath: observed.configPath,
    detectDir: observed.detectDir,
    installKind: observed.installKind,
    admissionBlocked: false,
    before: observed.before,
    contribution: null,
    // Descriptive, never decisive. The record says which places are ours now and the document
    // says which of them the file holds, so the change list can distinguish a place this undo
    // adds back from one it replaces and one it takes away. Neither is allowed to refuse: an
    // unreadable document is reported as PARSE_FAILED and leaves every place a replacement, and
    // restore eligibility stays the byte comparison it was.
    record: currentRecordFor(input, observed.clientId, observed.configPath),
    models: input.models,
    classified: { state },
    parsed: observed.before === null
      ? {}
      : observed.clientId === "cline"
        ? parseClineDocument(observed.before)
        : parseConfig(observed.before, EXPORT_CLIENTS[observed.clientId].format),
    restore: {
      opId: observed.entry.opId,
      entry: observed.entry,
      snapshotKind: observed.snapshotKind,
      snapshotText: observed.snapshotText,
      confirmDrift: request.confirmDrift === true,
      driftsFromResult: observed.driftsFromResult,
    },
    ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
  });
}

/**
 * What a mutation is asked to do. Declared here because the observation below consumes it and the
 * planner must not depend on the writer; the writer re-exports it, so callers are unaffected.
 */
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

/** A refusal in the planner's own vocabulary, so observation does not depend on the writer's result type. */
export interface IntegrationObservationFailure {
  readonly reason: RefusalReason;
  readonly state: IntegrationState;
  readonly message: string;
  readonly snapshotPath?: string;
  /** A Cline transaction left residue that only a mutation may clear. */
  readonly residual?: boolean;
}

function observationFailure(
  reason: RefusalReason,
  state: IntegrationState,
  message: string,
  snapshotPath?: string,
): IntegrationObservationFailure {
  return { reason, state, message, ...(snapshotPath ? { snapshotPath } : {}) };
}

/**
 * What preview and mutation are allowed to touch while looking.
 *
 * Both are false for a preview and both are true for a mutation, and neither defaults, because the
 * difference is the whole safety argument. `maintenance` runs pending snapshot pruning, which
 * writes; `recover` lets the Cline adapter repair a pending transaction, which also writes. A
 * preview that quietly inherited either would be a mutation wearing a read's name.
 */
export interface ObservationEffects {
  readonly maintenance: boolean;
  readonly recover: boolean;
}

/**
 * Detect, gate, read, parse and classify, once, for both preview and mutation.
 *
 * Extracted from the writer so a plan and the mutation it authorizes rest on the same
 * classification rather than two independent reads that can disagree. The ordering of refusals is
 * load-bearing and is preserved exactly as the writer had it.
 */
export function observeIntegration(input: IntegrationWriteInput, effects: ObservationEffects) {
  const store = input.store ?? createIntegrationStateStore();
  let io = input.io ?? defaultIntegrationIO(store);
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
    if (clientId === "cline") io = createClineIO(io, configPath, store, effects.recover);
  } catch (error) {
    if (error instanceof ClineTransactionError) {
      return { failed: { ...observationFailure("unsafe", "unsafe", error.message, error.snapshotPath), residual: true } } as const;
    }
    if (!(error instanceof ClientPathError)) throw error;
    return { failed: observationFailure("unsafe", "unsafe", error.message) } as const;
  }
  // Pruning writes, so only a mutation may perform it. Preview reports the state it finds.
  if (effects.maintenance) store.retryPendingPrunes();

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return {
      failed: observationFailure("unsafe", "unsafe",
        target.why === "read-failed"
          ? `${configPath} exists but could not be read`
          : `${configPath} is not a regular file`),
    } as const;
  }
  const before = target.before;
  const parsed = clientId === "cline" ? parseClineDocument(before) : parseConfig(before, exportSpec.format);
  if (parsed === PARSE_FAILED) {
    return { failed: observationFailure("unsafe", "unsafe",
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
