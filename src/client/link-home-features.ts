import { LINK_REQUEST_ZSTD_FEATURE, parseLinkHomeFeatures } from "../link/request-compression";

/**
 * What each Home said it serves on its last verified relay-auth answer, per link, in this process.
 * It decides only whether a Child prepares a compressed body; the connection that carries the body
 * confirms the feature again before it is used. Bounded to 256 links.
 */
const MAX_LINKS = 256;
const homes = new Map<string, readonly string[]>();

export function recordLinkHomeFeatures(linkId: string, header: string | null): readonly string[] | null {
  const features = parseLinkHomeFeatures(header);
  homes.delete(linkId);
  if (features) {
    homes.set(linkId, features);
    if (homes.size > MAX_LINKS) homes.delete(homes.keys().next().value!);
  }
  return features;
}

export function linkHomeAcceptsRequestZstd(linkId: string): boolean {
  return homes.get(linkId)?.includes(LINK_REQUEST_ZSTD_FEATURE) === true;
}

export function forgetLinkHomeFeaturesForTests(): void {
  homes.clear();
}
