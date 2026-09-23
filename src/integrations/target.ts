/**
 * Which file an integration operation reads, writes and records — and, when
 * that is not the file the client reads, which file is.
 *
 * A client may move its provider list between releases and keep the old file
 * reachable only through a one-shot import. Everything the integration checks
 * still passes against the old file: it is writable, the block merges, the
 * ownership record describes it correctly. The only thing that changed is
 * whether anything reads it (#5348).
 *
 * So the target is chosen before anything is classified, and it is chosen by
 * three facts in this order:
 *
 * 1. No declared store, or no store on disk — the config file, exactly as
 *    before. A client that has never run still imports what we write there.
 * 2. Our own block already sits in the config file this record names. Stay
 *    there. Disable removes what we wrote from where we wrote it, and the
 *    caller reports the write as ineffective rather than orphaning a block in
 *    one file while writing another.
 * 3. Otherwise the store, but only when its schema can be established. A store
 *    we cannot parse or whose version we have not observed is reported as the
 *    reason the write cannot reach the client, because merging an invented
 *    nesting into a file holding the user's other providers would trade a
 *    silent no-op for a silent loss.
 */
import { EXPORT_CLIENTS, ClientPathError, type BuildContribution, type ConfigFormat } from "../clients/config-export";
import { PARSE_FAILED, loadTarget, parseConfig, type IntegrationIO } from "./config-io";
import { AmbiguousSelectorError, InvalidSelectorError, readPath } from "./merge";
import type { OwnershipRecord } from "./ownership";
import { INTEGRATION_CLIENTS, type IntegrationClientId } from "./registry";

export interface IntegrationTarget {
  /** The file this operation reads, writes, journals and records ownership for. */
  readonly configPath: string;
  /** Text format of that file, which is not always the client's config format. */
  readonly format: ConfigFormat;
  /** The contribution shape that file's reader understands. */
  readonly buildContribution: BuildContribution;
  /**
   * Set when a write to the file above would not reach the client.
   *
   * `why` is carried rather than re-derived because the cases have different
   * remedies and only this function knows which one it took. Disable is not
   * gated on it: removing bytes this project wrote from the file it wrote them
   * to is as effective as it ever was.
   */
  readonly ineffective: IneffectiveWrite | null;
}

export interface IneffectiveWrite {
  /** The provider store the client reads. */
  readonly store: string;
  /**
   * `owned-config-file` — this project's block is still in the config file, so
   * the operation stays there and the remedy is to remove it first, rather than
   * leave a block in one file while writing another.
   *
   * `unestablished-schema` — the store is not a document whose shape has been
   * observed, so there is nothing safe to merge into it. This one is reachable
   * with the store itself as the target: a client that bumps its schema after
   * we wrote the store leaves our block there, removable, and the file no
   * longer one we may merge into.
   */
  readonly why: "owned-config-file" | "unestablished-schema";
}

function configFileTarget(
  clientId: IntegrationClientId,
  configPath: string,
  ineffective: IneffectiveWrite | null,
): IntegrationTarget {
  const exportSpec = EXPORT_CLIENTS[clientId];
  return {
    configPath,
    format: exportSpec.format,
    buildContribution: exportSpec.buildContribution,
    ineffective,
  };
}

function storeTarget(
  declared: NonNullable<(typeof INTEGRATION_CLIENTS)[IntegrationClientId]["currentStore"]>,
  configPath: string,
  ineffective: IneffectiveWrite | null = null,
): IntegrationTarget {
  return {
    configPath,
    format: declared.format,
    buildContribution: declared.buildContribution,
    ineffective,
  };
}

/**
 * Does the file this record names still hold any fragment it claims?
 *
 * Uncertainty answers yes. An unreadable or unparseable config file is a state
 * the classifier is about to refuse on, and it must refuse on the file our
 * record is about rather than silently move the operation to a different one.
 * An ambiguous or invalid selector is the same kind of answer.
 */
function recordedBlockStillPresent(
  io: IntegrationIO,
  format: ConfigFormat,
  configPath: string,
  record: OwnershipRecord,
): boolean {
  const loaded = loadTarget(io, configPath);
  if (!loaded.ok) return true;
  const parsed = parseConfig(loaded.before, format);
  if (parsed === PARSE_FAILED) return true;
  try {
    return record.fragmentPaths.some(path => readPath(parsed, path) !== undefined);
  } catch (error) {
    if (error instanceof AmbiguousSelectorError || error instanceof InvalidSelectorError) return true;
    throw error;
  }
}

/**
 * Resolve the target for one operation.
 *
 * `configPath` is the client's config file as the registry resolves it now, and
 * `record` is the stored ownership as read, before any path filtering — the
 * filtering depends on the answer this function returns.
 *
 * The store is observed through the caller's own `IntegrationIO`, never the
 * real filesystem directly, so status and mutation cannot disagree about
 * whether a write can land.
 */
export function resolveIntegrationTarget(args: {
  clientId: IntegrationClientId;
  configPath: string;
  io: IntegrationIO;
  record: OwnershipRecord | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): IntegrationTarget {
  const { clientId, configPath, io, record } = args;
  const declared = INTEGRATION_CLIENTS[clientId].currentStore;
  if (!declared) return configFileTarget(clientId, configPath, null);
  const storePath = declared.path(args.env, args.home);
  const kind = io.statKind(storePath);
  if (kind === "missing") return configFileTarget(clientId, configPath, null);
  // Only proven absence permits a legacy write. Unreadable or non-file stores
  // cannot establish what the client reads; preserve the recorded removal target.
  if (kind !== "file") {
    const ineffective: IneffectiveWrite = { store: storePath, why: "unestablished-schema" };
    return record?.clientId === clientId && record.configPath === storePath
      ? storeTarget(declared, storePath, ineffective)
      : configFileTarget(clientId, configPath, ineffective);
  }
  const loaded = loadTarget(io, storePath);
  const parsed = loaded.ok ? parseConfig(loaded.before, declared.format) : PARSE_FAILED;
  const established = parsed !== PARSE_FAILED && declared.establishes(parsed);
  const unestablished: IneffectiveWrite = { store: storePath, why: "unestablished-schema" };
  /*
   * Our own block decides the target before the store's schema does, whichever
   * file holds it. Disable has to remove what we wrote from where we wrote it,
   * and an apply must never leave a block in one file while writing another.
   */
  const owned = record !== null && record.clientId === clientId ? record : null;
  if (owned?.configPath === storePath && recordedBlockStillPresent(io, declared.format, storePath, owned)) {
    return storeTarget(declared, storePath, established ? null : unestablished);
  }
  if (
    owned?.configPath === configPath
    && recordedBlockStillPresent(io, EXPORT_CLIENTS[clientId].format, configPath, owned)
  ) {
    return configFileTarget(clientId, configPath, { store: storePath, why: "owned-config-file" });
  }
  if (!established) {
    return configFileTarget(clientId, configPath, unestablished);
  }
  return storeTarget(declared, storePath);
}

/**
 * The target a path NAMES, or null when this client may not write there.
 *
 * Undo acts on the file its journal row recorded, so it needs the meaning of a
 * historical path rather than the choice above: which contribution shape
 * describes those bytes, and whether this client still resolves that location
 * at all. Resolving a path the client no longer names is what would let a row
 * recorded for one home delete a file in another, so an unrecognised path is
 * null and the caller refuses.
 */
export function declaredIntegrationTarget(args: {
  clientId: IntegrationClientId;
  configPath: string;
  resolvedConfigPath: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): IntegrationTarget | null {
  const { clientId, configPath, resolvedConfigPath } = args;
  if (configPath === resolvedConfigPath) return configFileTarget(clientId, configPath, null);
  const declared = INTEGRATION_CLIENTS[clientId].currentStore;
  if (!declared) return null;
  try {
    if (declared.path(args.env, args.home) !== configPath) return null;
  } catch (error) {
    // A store the operator relocated with a path we cannot resolve proves
    // nothing about the row, so the row is not a legal target.
    if (error instanceof ClientPathError) return null;
    throw error;
  }
  return storeTarget(declared, configPath);
}
