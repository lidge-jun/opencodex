/**
 * Inclusive integer bounds for `visionSidecar.timeoutMs`.
 * The ceiling is the 32-bit timer delay used by `signalWithTimeout` / `setTimeout`.
 * This module is the single authority: the runtime, management API, and Dashboard
 * import these numbers rather than restating them.
 */
export const DEFAULT_VISION_TIMEOUT_MS = 45_000;
export const MIN_VISION_TIMEOUT_MS = 1;
export const MAX_VISION_TIMEOUT_MS = 2_147_483_647;
