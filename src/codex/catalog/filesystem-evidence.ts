import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { expandUserPath } from "../../config";
import type {
  CatalogConditionalSourceObservations,
  CatalogConditionalSourceRole,
  CatalogFilesystemIdentity,
  CatalogHomeSelectionObservation,
  CatalogRequiredSourceObservations,
  CatalogRequiredSourceRole,
  CatalogSourceEvidence,
  CatalogSourceObservation,
  CatalogSourceRole,
} from "../convergence-types";
import { defaultCodexHome } from "../home";

export type CatalogGatherReadableSourceRole =
  | "active-catalog-merge"
  | "hashed-backup-fallback"
  | "legacy-backup-fallback"
  | "models-cache-fallback"
  | "runtime-selection";

/** The minimal observe-only source interface consumed by bundled catalog selection. */
export interface CatalogGatherEvidenceSession {
  readSource(role: CatalogGatherReadableSourceRole): Uint8Array | null;
}

/** The exact observe-only auth input consumed by provider discovery. */
export interface CatalogGatherProviderAuthEvidence {
  readonly authStoreBuffer: Uint8Array | null;
}

export type CatalogFilesystemEvidenceSession = CatalogGatherEvidenceSession
  & CatalogGatherProviderAuthEvidence;

const CONDITIONAL_SOURCE_ROLES = [
  "bundled-catalog-template",
  "active-catalog-merge",
  "hashed-backup-fallback",
  "legacy-backup-fallback",
  "models-cache-fallback",
  "native-catalog-selection",
  "runtime-selection",
  "provider-auth-selection",
] as const satisfies readonly CatalogConditionalSourceRole[];

interface MutableSessionState {
  homeSelection: CatalogHomeSelectionObservation | null;
  readonly sourcePaths: Map<CatalogSourceRole, string>;
  requiredTargetSelection: CatalogSourceObservation<CatalogRequiredSourceRole> | null;
  readonly conditional: Record<CatalogConditionalSourceRole, CatalogSourceObservation[]>;
  sealed: boolean;
}

const sessionStates = new WeakMap<object, MutableSessionState>();

function filesystemIdentity(
  entry: Readonly<{ dev: bigint; ino: bigint }>,
): CatalogFilesystemIdentity {
  return Object.freeze({ volume: String(entry.dev), fileId: String(entry.ino) });
}

function sessionState(session: CatalogFilesystemEvidenceSession): MutableSessionState {
  const state = sessionStates.get(session);
  if (!state) {
    throw new TypeError("Catalog filesystem evidence session was not created by its owner.");
  }
  return state;
}

function assertOpen(state: MutableSessionState): void {
  if (state.sealed) throw new Error("Catalog filesystem evidence session is already sealed.");
}

function observedHomeSelection(): CatalogHomeSelectionObservation {
  const environmentSelector = process.env.CODEX_HOME?.trim();
  const selector = environmentSelector
    ? { kind: "environment" as const, raw: environmentSelector }
    : { kind: "default" as const, raw: defaultCodexHome() };
  const selectedPath = selector.kind === "environment"
    ? resolve(expandUserPath(selector.raw))
    : resolve(selector.raw);
  const canonicalCodexHome = realpathSync.native(selectedPath);
  const root = statSync(canonicalCodexHome, { bigint: true });
  if (!root.isDirectory()) {
    throw new Error(`Codex home is not a directory: ${selectedPath}`);
  }
  return Object.freeze({
    selector: Object.freeze(selector),
    canonicalCodexHome,
    rootIdentity: filesystemIdentity(root),
  });
}

/** Capture and freeze the selector/root authority before any derived path is admitted. */
export function captureAndSealCatalogHomeSelection(
  session: CatalogFilesystemEvidenceSession,
): CatalogHomeSelectionObservation {
  const state = sessionState(session);
  assertOpen(state);
  if (state.homeSelection) return state.homeSelection;
  state.homeSelection = observedHomeSelection();
  return state.homeSelection;
}

/** Bind the next consultation for a closed role without exposing the evidence arrays. */
export function acceptCatalogGatherSourcePath(
  session: CatalogFilesystemEvidenceSession,
  role: CatalogSourceRole,
  logicalPath: string,
): void {
  const state = sessionState(session);
  assertOpen(state);
  if (!state.homeSelection) {
    throw new Error("Catalog home selection must be sealed before accepting a derived path.");
  }
  state.sourcePaths.set(role, resolve(logicalPath));
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function observeSource<R extends CatalogSourceRole>(
  role: R,
  logicalPath: string,
): Readonly<{ bytes: Uint8Array | null; observation: CatalogSourceObservation<R> }> {
  const canonicalParent = realpathSync.native(dirname(logicalPath));
  const parent = statSync(canonicalParent, { bigint: true });
  if (!parent.isDirectory()) {
    throw new Error(`Catalog source parent is not a directory: ${dirname(logicalPath)}`);
  }
  const parentIdentity = Object.freeze({
    canonicalPath: canonicalParent,
    ...filesystemIdentity(parent),
  });

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(readFileSync(logicalPath));
  } catch (error) {
    if (!isMissing(error)) throw error;
    return Object.freeze({
      bytes: null,
      observation: Object.freeze({
        state: "absent" as const,
        role,
        logicalPath,
        canonicalPath: resolve(canonicalParent, basename(logicalPath)),
        parentIdentity,
        fileIdentity: null,
      }),
    });
  }

  const canonicalPath = realpathSync.native(logicalPath);
  const file = statSync(canonicalPath, { bigint: true });
  if (!file.isFile()) throw new Error(`Catalog source is not a regular file: ${logicalPath}`);
  return Object.freeze({
    bytes,
    observation: Object.freeze({
      state: "present" as const,
      role,
      logicalPath,
      canonicalPath,
      parentIdentity,
      fileIdentity: filesystemIdentity(file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  });
}

/** Read once, record PRESENT/ABSENT first, then return the exact hashed buffer. */
export function readCatalogGatherSource<R extends CatalogSourceRole>(
  session: CatalogFilesystemEvidenceSession,
  role: R,
): Uint8Array | null {
  const state = sessionState(session);
  assertOpen(state);
  const logicalPath = state.sourcePaths.get(role);
  if (!logicalPath) throw new Error(`No catalog source path was accepted for role ${role}.`);
  if (role === "catalog-target-selection" && state.requiredTargetSelection) {
    throw new Error(`Required catalog source role ${role} was already observed.`);
  }

  const observed = observeSource(role, logicalPath);
  if (role === "catalog-target-selection") {
    state.requiredTargetSelection = observed.observation as CatalogSourceObservation<"catalog-target-selection">;
  } else {
    state.conditional[role as CatalogConditionalSourceRole].push(observed.observation);
  }
  return observed.bytes;
}

function optionalFileIdentity(path: string): Readonly<{ device: string; inode: string }> | null {
  try {
    const entry = statSync(path, { bigint: true });
    return { device: String(entry.dev), inode: String(entry.ino) };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Probe a candidate write target without allowing filesystem mutation. */
export function captureCatalogGatherTargetIdentity(
  session: CatalogFilesystemEvidenceSession,
  path: string,
): string {
  const state = sessionState(session);
  assertOpen(state);
  if (!state.homeSelection) {
    throw new Error("Catalog home selection must be sealed before accepting a derived path.");
  }
  const textualPath = resolve(path);
  const canonicalParent = realpathSync.native(dirname(textualPath));
  const parent = statSync(canonicalParent, { bigint: true });
  return JSON.stringify({
    path: textualPath,
    canonicalParent,
    parentIdentity: { device: String(parent.dev), inode: String(parent.ino) },
    fileIdentity: optionalFileIdentity(textualPath),
  });
}

function cloneObservation<R extends CatalogSourceRole>(
  observation: CatalogSourceObservation<R>,
): CatalogSourceObservation<R> {
  if (observation.state === "absent") {
    return Object.freeze({
      ...observation,
      parentIdentity: Object.freeze({ ...observation.parentIdentity }),
      fileIdentity: null,
    });
  }
  return Object.freeze({
    ...observation,
    parentIdentity: Object.freeze({ ...observation.parentIdentity }),
    fileIdentity: Object.freeze({ ...observation.fileIdentity }),
  });
}

/** Seal one complete owner-created session into detached, recursively frozen evidence. */
export function sealCatalogGatherEvidenceSession(
  session: CatalogFilesystemEvidenceSession,
): CatalogSourceEvidence {
  const state = sessionState(session);
  assertOpen(state);
  if (!state.homeSelection) throw new Error("Catalog home selection is required before sealing.");
  const targetSelection = state.requiredTargetSelection;
  if (!targetSelection) {
    throw new Error("Required catalog source role catalog-target-selection was not observed.");
  }
  for (const role of CONDITIONAL_SOURCE_ROLES) {
    if (!Object.hasOwn(state.conditional, role)) {
      throw new Error(`Conditional catalog source role ${role} is missing.`);
    }
  }

  const conditional = Object.fromEntries(CONDITIONAL_SOURCE_ROLES.map(role => [
    role,
    Object.freeze(state.conditional[role].map(observation => cloneObservation(observation))),
  ])) as unknown as CatalogConditionalSourceObservations;
  const required = Object.freeze({
    "catalog-target-selection": cloneObservation(targetSelection),
  }) as CatalogRequiredSourceObservations;
  const evidence = Object.freeze({
    homeSelection: Object.freeze({
      ...state.homeSelection,
      selector: Object.freeze({ ...state.homeSelection.selector }),
      rootIdentity: Object.freeze({ ...state.homeSelection.rootIdentity }),
    }),
    required,
    conditional: Object.freeze(conditional),
  });
  state.sealed = true;
  return evidence;
}

/** Create an opaque session; all mutable evidence state remains module-private. */
export function createCatalogGatherEvidenceSession(): CatalogFilesystemEvidenceSession {
  let session: CatalogFilesystemEvidenceSession;
  session = Object.freeze({
    readSource: (role: CatalogGatherReadableSourceRole) => readCatalogGatherSource(session, role),
    get authStoreBuffer(): Uint8Array | null {
      return readCatalogGatherSource(session, "provider-auth-selection");
    },
  });
  sessionStates.set(session, {
    homeSelection: null,
    sourcePaths: new Map(),
    requiredTargetSelection: null,
    conditional: Object.fromEntries(
      CONDITIONAL_SOURCE_ROLES.map(role => [role, [] as CatalogSourceObservation[]]),
    ) as unknown as MutableSessionState["conditional"],
    sealed: false,
  });
  return session;
}
