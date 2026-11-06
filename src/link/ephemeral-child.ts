/**
 * Contract predicates for the lightweight `ocx-child` ephemeral Remote Link Child runtime.
 *
 * Pure and free of import-time side effects inside `src/link/` so Home enrollment and
 * diagnostics can distinguish a clean detached `ocx-child` host from a full standalone
 * `ocx` daemon without changing persisted `LinkStore` records on disk.
 */

export interface EphemeralChildConfigProjection {
  readonly port: number;
  readonly runtimeRole?: "standalone" | null | undefined;
  readonly ephemeralChild: true;
}

function isValidChildPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/**
 * True when `config show --json` came from a clean, detached `ocx-child` binary ready for
 * Home-initiated enrollment (`runtimeRole: "standalone"`, `ephemeralChild: true`, valid port).
 * An already-attached `ocx-child` reports `runtimeRole: "client"` and returns `false`.
 */
export function isDetachedEphemeralChildConfig(value: unknown): value is EphemeralChildConfigProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.ephemeralChild === true
    && (record.runtimeRole ?? "standalone") === "standalone"
    && isValidChildPort(record.port);
}

/** True when a `/healthz` payload identifies a live `ocx-child` client relay on `expectedPort`. */
export function isEphemeralChildHealth(value: unknown, expectedPort: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.service === "opencodex"
    && record.role === "client"
    && record.ephemeralChild === true
    && record.port === expectedPort
    && typeof record.pid === "number"
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.startedAt === "string"
    && Number.isFinite(Date.parse(record.startedAt));
}
