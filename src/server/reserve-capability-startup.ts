import { mutatePersistedConfig } from "../config";
import { adoptReserveCapabilityMigration, isReserveCapabilityMigrated, migrateReserveCapability } from "../config/reserve-capability";
import type { OcxConfig } from "../types";

/**
 * Persist the one-time Reserve seed at startup so the file states the capability explicitly (#4961).
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
  if (isReserveCapabilityMigrated(config)) return config;
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
