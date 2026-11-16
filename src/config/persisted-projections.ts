import type { OcxConfig } from "../types";
import { adoptCustomModelCatalogMigration, projectCustomModelCatalogMigration } from "../codex/custom-model-catalog-migration";
import { adoptReserveCapabilityMigration, projectReserveCapabilityMigration } from "./reserve-capability";

/**
 * Every one-time migration a whole-config write must carry, projected against the same pre-write
 * document. Writers call this once instead of each migration separately, so a new migration cannot
 * be wired into some write paths and silently missed by others.
 */
export function projectPersistedConfigMigrations(persisted: unknown, candidate: OcxConfig): OcxConfig {
  return projectReserveCapabilityMigration(persisted, projectCustomModelCatalogMigration(persisted, candidate));
}

/** Copy the migration state a successful projected write established onto the live object. */
export function adoptPersistedConfigMigrations(target: OcxConfig, projected: OcxConfig): void {
  adoptCustomModelCatalogMigration(target, projected);
  adoptReserveCapabilityMigration(target, projected);
}
