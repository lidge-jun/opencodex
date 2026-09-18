/**
 * One-time migration off Codex-login models that upstream has retired.
 *
 * Originally this only moved the two sidecar defaults, and it was written when
 * `gpt-5.4-mini` was merely superseded rather than withdrawn. Once OpenAI retired the
 * model the same stored value stopped being a stale preference and became a guaranteed
 * 404 on every web-search, vision and pool-warmup call, so the pool warmup slug joined
 * the set.
 *
 * The match is exact equality, which means an explicitly chosen `gpt-5.4-mini` is
 * rewritten too. That is deliberate: there is no configuration in which continuing to
 * send a withdrawn model is what the operator wanted. Any other value is left alone.
 */
import type { OcxConfig } from "../types";

/** July 9 21:00 UTC = KST July 10 06:00. */
export const RETIRED_MODEL_MIGRATION_CUTOFF = Date.UTC(2026, 6, 9, 21, 0);

const RETIRED_SIDECAR_MODEL = "gpt-5.4-mini";
const REPLACEMENT_MODEL = "gpt-5.6-luna";

/**
 * @returns true when the config changed and the caller should persist it.
 */
export function runRetiredCodexModelMigration(config: OcxConfig, now = Date.now()): boolean {
  if (now < RETIRED_MODEL_MIGRATION_CUTOFF) return false;
  let migrated = false;
  if (config.webSearchSidecar?.model === RETIRED_SIDECAR_MODEL) {
    config.webSearchSidecar = { ...config.webSearchSidecar, model: REPLACEMENT_MODEL };
    migrated = true;
  }
  if (config.visionSidecar?.model === RETIRED_SIDECAR_MODEL) {
    config.visionSidecar = { ...config.visionSidecar, model: REPLACEMENT_MODEL };
    migrated = true;
  }
  if (config.tokenGuardian?.codexWarmupModel === RETIRED_SIDECAR_MODEL) {
    config.tokenGuardian = { ...config.tokenGuardian, codexWarmupModel: REPLACEMENT_MODEL };
    migrated = true;
  }
  return migrated;
}
