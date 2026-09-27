import { existsSync, readFileSync } from "node:fs";
import { configReasoningPinsConfigError } from "./provider-validation";
import type { OcxConfig } from "../types";
import { withPreservedDiskOnlyProviders } from "../usage/user-cost-overlays";
import { refreshConfigDerivedRegistries } from "./derived-registries";
import { atomicWriteFile, isMissingPathError } from "./atomic-write";
import { getConfigPath } from "./paths";
import { configRebaseDeletionKeys, projectConfigRebaseProvenance } from "./rebase-provenance";
import { clientConnectionSchema } from "./schema/leaf-validators";

/** The requested bytes are current; callers must not roll back only live state. */
export class ConfigWritePublishedError extends Error {
  constructor(cause: unknown) {
    super("Config was published, but post-publication bookkeeping failed", { cause });
    this.name = "ConfigWritePublishedError";
  }
}

/** The literal file, with no schema merge or default injection. */
export function readRawConfigJson(): Record<string, unknown> | undefined {
  try {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    // Unreadable or corrupt: behave exactly as before. Never fail a save over protection.
    return undefined;
  }
}

function failClosedClientPersistenceError(
  raw: Record<string, unknown> | undefined,
  candidate: OcxConfig,
): string | null {
  if (!raw) return null;
  const rawHasClient = Object.hasOwn(raw, "client") && raw.client !== undefined;
  const rawRole = raw.runtimeRole;
  const rawRoleValid = rawRole === undefined
    || rawRole === "standalone"
    || rawRole === "hub"
    || rawRole === "client";
  const rawClientValid = !rawHasClient || clientConnectionSchema.safeParse(raw.client).success;
  const rawPairValid = rawRoleValid
    && ((rawRole === "client" && rawHasClient && rawClientValid)
      || (rawRole !== "client" && !rawHasClient));
  if (rawPairValid) return null;

  const candidateValid = candidate.runtimeRole === "client"
    && clientConnectionSchema.safeParse(candidate.client).success;
  const deletions = configRebaseDeletionKeys(candidate);
  const explicitClear = deletions.has("client") && deletions.has("runtimeRole");
  if (candidateValid || explicitClear) return null;
  return "config write refused: malformed or mismatched remote client state must be repaired or explicitly cleared";
}

/**
 * Atomic config.json write WITHOUT the mutation lock; callers must hold
 * `withConfigMutationLockSync`. Returns true when bytes changed. Refreshes the
 * cost-overlay registry from the persisted config so runtime estimates follow
 * every save path.
 */
export function persistConfigUnlocked(config: OcxConfig): boolean {
  const pinError = configReasoningPinsConfigError(config);
  if (pinError) throw new Error(pinError);
  const configPath = getConfigPath();
  const rawBeforeWrite = readRawConfigJson();
  const clientPersistenceError = failClosedClientPersistenceError(rawBeforeWrite, config);
  if (clientPersistenceError) throw new Error(clientPersistenceError);
  // External editors can add provider rows the live config deliberately does
  // not route with yet; merge them at the serialization boundary so an
  // unrelated in-process save cannot erase the provider or its overlay.
  // Provider preservation reads symbol-keyed live-owner state, which structuredClone
  // intentionally drops. Resolve that ownership before projecting JSON provenance.
  const provenanceProjection = projectConfigRebaseProvenance(config);
  const persisted = withPreservedDiskOnlyProviders(config);
  if (provenanceProjection.configRebaseProvenance === undefined) delete persisted.configRebaseProvenance;
  else persisted.configRebaseProvenance = provenanceProjection.configRebaseProvenance;
  const bytes = JSON.stringify(persisted, null, 2) + "\n";
  let unchanged = false;
  try {
    unchanged = readFileSync(configPath, "utf8") === bytes;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  // Keep the runtime overlay registry in sync with EVERY persist path,
  // including byte-identical saves: a cooperating CLI process may have written
  // the same bytes (e.g. before a proxy notification), and Logs/Usage must
  // adopt the overlay without waiting for a changed save or restart.
  let published = unchanged;
  try {
    if (!unchanged) {
      atomicWriteFile(configPath, bytes, undefined, { afterRename: () => { published = true; } });
      published = true;
    }
    // Publication, not successful cache refresh, is the rollback boundary. A
    // byte-identical save already has the requested state on disk as well.
    refreshConfigDerivedRegistries(persisted);
    return !unchanged;
  } catch (error) {
    if (published) throw new ConfigWritePublishedError(error);
    throw error;
  }
}
