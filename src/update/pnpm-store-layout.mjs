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

/** Default spelling or custom layout corroborated by the pnpm store's contents. */
export function isInPnpmGlobalStoreLinks(path, exists = () => false) {
  const normalized = String(path).replaceAll("\\", "/");
  if (PNPM_GLOBAL_STORE_LINKS_PATTERN.test(normalized)) return true;
  const customStore = normalized.match(/^(.*\/v\d+)\/links\//i)?.[1];
  return !!customStore && exists(`${customStore}/files`)
    && ["index", "index.db", "index.fallback"].some(name => exists(`${customStore}/${name}`));
}
