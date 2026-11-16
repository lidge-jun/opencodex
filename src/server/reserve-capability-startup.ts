import { mutatePersistedConfig } from "../config";
import { adoptReserveCapabilityMigration, isReserveCapabilityMigrated, migrateReserveCapability } from "../config/reserve-capability";
import type { OcxConfig } from "../types";

/**
 * Persist the one-time Reserve seed at startup for a file that sets `codexDesktopAuthless` (#4961), so
 * a later hand edit of authless cannot move Reserve. A file that never set authless reads Reserve as
 * off and is left untouched; its seed is recorded by the first write that changes authless.
 *
 * Only the two Reserve fields are adopted, in place: earlier startup migrations may hold in-memory
 * results whose persistence was unavailable, and the loaded object carries identity-keyed state
 * (file-backed provenance) that a copy would lose. On failure nothing is marked, so the legacy
 * reading continues and the next persisted write seeds from the file instead.
 */
export function migrateStartupReserveCapability(
  config: OcxConfig,
  mutate: typeof mutatePersistedConfig = mutatePersistedConfig,
): OcxConfig {
  if (isReserveCapabilityMigrated(config) || config.codexDesktopAuthless === undefined) return config;
  try {
    const outcome = mutate(fresh => ({ changed: migrateReserveCapability(fresh), value: fresh }));
    if (outcome.status === "unavailable") {
      console.warn(`[reserve-capability-migration] Persistence unavailable (${outcome.reason}); Reserve still follows codexDesktopAuthless until the next config write.`);
      return config;
    }
    adoptReserveCapabilityMigration(config, outcome.value);
    return config;
  } catch {
    // Do not log the exception: filesystem errors may contain private paths.
    console.warn("[reserve-capability-migration] Persistence failed; Reserve still follows codexDesktopAuthless until the next config write.");
    return config;
  }
}
