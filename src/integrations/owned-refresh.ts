/**
 * Refresh a file integration only when OpenCodex already owns its block.
 *
 * This is the safe bridge between an implicit operation such as `ocx sync`
 * and the explicit integration writer. An implicit sync may update a block
 * the user previously enabled, but it must never claim an unowned block,
 * recreate one the user removed, or overwrite edits made after our write.
 */
import type { ExportModel } from "../clients/config-export";
import type { OcxConfig } from "../types";
import type { IntegrationIO } from "./config-io";
import type { IntegrationClientId } from "./registry";
import { runIntegrationMutationFlight } from "./mutation-flight";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";
import {
  refreshIntegrationCoordinated,
  type CoordinatedIntegrationOptions,
} from "./writer";

export interface OwnedIntegrationRefreshInput {
  clientId: IntegrationClientId;
  /** Lazy in `ocx sync`, so an unowned client does not even load the catalog. */
  models: readonly ExportModel[] | (() => Promise<readonly ExportModel[]>);
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  store?: IntegrationStateStore;
  io?: IntegrationIO;
  /** Internal profile target selected before entering the coordinated writer. */
  resolvedPaths?: { configPath: string; detectDir: string };
}

export interface OwnedIntegrationRefreshOutcome {
  readonly client: IntegrationClientId;
  readonly ok: boolean;
  readonly changed?: boolean;
  readonly reason?: string;
  readonly profileId?: number;
  readonly refusalReason?: string;
  readonly state?: string;
  readonly snapshotPath?: string;
  readonly residual?: boolean;
}

/**
 * Returns `null` when the client has never been connected by OpenCodex.
 * Callers use that distinction to report "left alone" rather than "skipped".
 */
export async function refreshOwnedIntegration(
  input: OwnedIntegrationRefreshInput,
  options?: CoordinatedIntegrationOptions,
): Promise<OwnedIntegrationRefreshOutcome | null> {
  const store = input.store ?? createIntegrationStateStore();

  // The ownership record is the user's durable opt-in. Do this check before
  // reading or classifying the target so an implicit sync can never turn an
  // unowned provider block into one of ours.
  const record = store.readRecords()[input.clientId];
  if (!record || record.clientId !== input.clientId) return null;

  const { models: suppliedModels, ...rest } = input;
  const models = typeof suppliedModels === "function"
    ? await suppliedModels()
    : suppliedModels;
  const bound = { ...rest, models, store };
  const result = await runIntegrationMutationFlight(
    input.clientId,
    // Separate catalog snapshots must not inherit another refresh's success.
    // The shared flight owner returns busy for overlapping operations instead.
    `refresh:${crypto.randomUUID()}`,
    input.io?.now ?? Date.now,
    () => refreshIntegrationCoordinated(bound, options),
  );
  return result.ok
    ? {
        client: input.clientId,
        ok: true,
        changed: result.changed,
        ...(result.state === "absent" ? { reason: result.message } : {}),
      }
    : { client: input.clientId, ok: false, reason: result.message, refusalReason: result.reason, state: result.state,
        ...(result.snapshotPath ? { snapshotPath: result.snapshotPath } : {}),
        ...(result.residual ? { residual: true } : {}),
      };
}
