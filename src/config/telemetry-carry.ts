import type { OcxConfig } from "../types";
import { telemetryConfigSchema } from "./schema/leaf-validators";

/**
 * Telemetry consent is owned by `config.json` on disk: `ocx telemetry`, the start prompt and the
 * consent route write it there, often while another process holds an older snapshot. A whole-config
 * save therefore writes the on-disk block (validated; a malformed hand edit is dropped, as a load
 * would drop it) instead of the snapshot's, so a decision is never dropped or rolled back. Without a
 * file on disk the snapshot's block is kept.
 *
 * Returns whether the block was taken from disk and the value now in `target`.
 */
export function carryPersistedTelemetry(
  target: OcxConfig,
  onDisk: Record<string, unknown> | undefined,
): { carried: boolean; value: OcxConfig["telemetry"] } {
  if (onDisk === undefined) return { carried: false, value: target.telemetry };
  const parsed = onDisk.telemetry === undefined ? undefined : telemetryConfigSchema.safeParse(onDisk.telemetry);
  const value = parsed?.success ? (structuredClone(parsed.data) as OcxConfig["telemetry"]) : undefined;
  if (value === undefined) delete target.telemetry;
  else target.telemetry = value;
  return { carried: true, value };
}
