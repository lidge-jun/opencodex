/**
 * pnpm's global virtual store keeps every package instance under
 * `<store>/v<N>/links/...` (pnpm 11 `enableGlobalVirtualStore`). The spelling has one owner so
 * install detection (`install-detection.mjs`) and the pnpm tree verifier
 * (`transactional-install.mjs`) cannot drift apart: detection routed such installs to the pnpm
 * updater while the verifier still rejected their dependency group (#8183).
 *
 * This module is a dependency-free leaf on purpose. `install-detection.mjs` is replaced by
 * `mock.module` in update subprocess tests, so the verifier must not import its spelling from there.
 */

/** Default store layout is sufficient for the legacy install-detection signature. */
export const PNPM_GLOBAL_STORE_LINKS_PATTERN = /(?:^|\/)store\/v\d+\/links(?:\/|$)/i;

/** True when a native path (either separator) has the versioned links layout. */
export function isInPnpmGlobalStoreLinks(path) {
  return /(?:^|\/)v\d+\/links(?:\/|$)/i.test(String(path).replaceAll("\\", "/"));
}
