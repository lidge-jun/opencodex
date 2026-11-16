import type { OcxConfig } from "../types";

/**
 * Luna Reserve's own capability switch (#4961).
 *
 * Reserve used to ride `codexDesktopAuthless`, a flag documented as controlling whether the Codex app
 * asks for a sign-in. It is now `codexReserveEnabled`, seeded once from that flag and independent of
 * it afterwards. `codexReserveMigration` records that the seed happened.
 *
 * Until a document carries the marker, Reserve reads the legacy flag, which is exactly the value the
 * migration persists. The seed is written only when it matters: when a write changes authless (the
 * seed then comes from the persisted pre-write document, so the change cannot move Reserve), when
 * Reserve is set explicitly, or at startup for a file that already sets authless. Writes that change
 * neither leave an unmarked document byte-for-byte alone. Once the marker exists, an absent
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
  const prior = configRecord(persisted);
  if (prior && isMigratedMarker(prior.codexReserveMigration)) {
    const projected = { ...candidate };
    if (typeof projected.codexReserveEnabled !== "boolean") {
      if (typeof prior.codexReserveEnabled === "boolean") projected.codexReserveEnabled = prior.codexReserveEnabled;
      else delete projected.codexReserveEnabled;
    }
    // Same key order as the seed below, so carrying an unchanged state rewrites identical bytes.
    projected.codexReserveMigration = prior.codexReserveMigration;
    return projected;
  }
  const explicit = typeof candidate.codexReserveEnabled === "boolean";
  // With no file yet there is no earlier authless value to protect; the new document's own reading
  // stands until its seed is recorded (at startup, or by the first write that changes authless).
  const legacy = (prior ?? candidate).codexDesktopAuthless === true;
  // Nothing to record while authless keeps its persisted value: the reading is unchanged.
  if (!explicit && (candidate.codexDesktopAuthless === true) === legacy) return candidate;
  const projected = { ...candidate };
  if (!explicit) projected.codexReserveEnabled = legacy;
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
