import type { OcxConfig } from "../types";

/**
 * Luna Reserve's own capability switch (#4961).
 *
 * Reserve used to ride `codexDesktopAuthless`, a flag documented as controlling whether the Codex app
 * asks for a sign-in. It is now `codexReserveEnabled`, seeded once from that flag and independent of
 * it afterwards. `codexReserveMigration` records that the seed happened.
 *
 * Until a document carries the marker, Reserve reads the legacy flag, which is exactly the value the
 * migration persists. The seed always comes from the persisted pre-write document, so a write that
 * also turns authless on or off cannot move Reserve. Once the marker exists, an absent
 * `codexReserveEnabled` means off, so deleting the field cannot bring the inheritance back.
 *
 * Enabling the capability never manufactures permission: every Reserve request still needs the
 * upstream, credential-bound Reserve allowance, a non-client role and a loopback admission.
 */
export const RESERVE_CAPABILITY_MIGRATION_VERSION = 1;

type ReserveCapabilityFields = Pick<OcxConfig, "codexReserveEnabled" | "codexReserveMigration" | "codexDesktopAuthless">;

function configRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isMigratedMarker(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= RESERVE_CAPABILITY_MIGRATION_VERSION;
}

export function isReserveCapabilityMigrated(config: unknown): boolean {
  return isMigratedMarker(configRecord(config)?.codexReserveMigration);
}

/** Whether the operator enabled Luna Reserve. Runtime role and listener admission are checked separately. */
export function isCodexReserveEnabled(config: Partial<ReserveCapabilityFields> | undefined): boolean {
  if (!config) return false;
  if (typeof config.codexReserveEnabled === "boolean") return config.codexReserveEnabled;
  if (isMigratedMarker(config.codexReserveMigration)) return false;
  return config.codexDesktopAuthless === true;
}

/** Seed this document from its own legacy flag, in place. Returns whether anything changed. */
export function migrateReserveCapability(config: OcxConfig): boolean {
  if (isMigratedMarker(config.codexReserveMigration)) return false;
  if (typeof config.codexReserveEnabled !== "boolean") config.codexReserveEnabled = config.codexDesktopAuthless === true;
  config.codexReserveMigration = RESERVE_CAPABILITY_MIGRATION_VERSION;
  return true;
}

/**
 * Carry the migration onto a whole-config write. `persisted` is the document on disk before the
 * write (undefined when none exists yet) and is the only authority for the legacy seed; a candidate
 * without the marker is a snapshot taken before migration and never decides the seed itself.
 */
export function projectReserveCapabilityMigration(persisted: unknown, candidate: OcxConfig): OcxConfig {
  if (isMigratedMarker(candidate.codexReserveMigration)) return candidate;
  const projected = { ...candidate };
  const prior = configRecord(persisted);
  if (prior && isMigratedMarker(prior.codexReserveMigration)) {
    projected.codexReserveMigration = prior.codexReserveMigration;
    if (typeof projected.codexReserveEnabled !== "boolean") {
      if (typeof prior.codexReserveEnabled === "boolean") projected.codexReserveEnabled = prior.codexReserveEnabled;
      else delete projected.codexReserveEnabled;
    }
    return projected;
  }
  if (typeof projected.codexReserveEnabled !== "boolean") {
    projected.codexReserveEnabled = (prior ?? candidate).codexDesktopAuthless === true;
  }
  projected.codexReserveMigration = RESERVE_CAPABILITY_MIGRATION_VERSION;
  return projected;
}

/** After the projected write succeeds, the live object holds what was written. */
export function adoptReserveCapabilityMigration(target: OcxConfig, projected: OcxConfig): void {
  if (projected.codexReserveMigration === undefined) delete target.codexReserveMigration;
  else target.codexReserveMigration = projected.codexReserveMigration;
  if (projected.codexReserveEnabled === undefined) delete target.codexReserveEnabled;
  else target.codexReserveEnabled = projected.codexReserveEnabled;
}
