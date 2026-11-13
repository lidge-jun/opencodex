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
  // Global link slots repeat package identity on both sides of node_modules.
  // This identifies an unmarked custom store without treating a generic vN/links
  // ancestor as pnpm evidence.
  const instance = normalized.match(/(?:^|\/)v\d+\/links\/(@[^/]+)\/([^/]+)\/[^/]+\/(?:[^/]+\/)?node_modules\/(?:(@[^/]+)\/)?([^/]+)(?:\/|$)/i);
  if (instance && instance[2].toLowerCase() === instance[4].toLowerCase()
    && (instance[1] === "@" ? !instance[3] : instance[1].toLowerCase() === instance[3]?.toLowerCase())) return true;
  const customStore = normalized.match(/^(.*\/v\d+)\/links\//i)?.[1];
  return !!customStore && exists(`${customStore}/files`)
    && ["index", "index.db", "index.fallback"].some(name => exists(`${customStore}/${name}`));
}

/**
 * A configured alternate directory is evidence only when an enclosing store has pnpm markers. Every
 * versioned ancestor above the package's node_modules is checked, so a nested v<N> directory inside a
 * marked store cannot hide the markers of the store that encloses it.
 */
export function isInMarkedPnpmCustomStore(path, exists = () => false) {
  const normalized = String(path).replaceAll("\\", "/");
  const lastModules = normalized.toLowerCase().lastIndexOf("/node_modules/");
  if (lastModules < 0) return false;
  const parts = normalized.slice(0, lastModules).split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!/^v\d+$/i.test(parts[index])) continue;
    const store = parts.slice(0, index + 1).join("/");
    if (exists(`${store}/files`) && ["index", "index.db", "index.fallback"].some(name => exists(`${store}/${name}`))) return true;
  }
  return false;
}
