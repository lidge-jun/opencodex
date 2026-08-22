const COMMUNITY_ID_FRAGMENT = "[0-9a-f]{64}";
const COMMUNITY_BUNDLE_FILE_RE = new RegExp(
  `^bundle-(${COMMUNITY_ID_FRAGMENT})-(${COMMUNITY_ID_FRAGMENT})\\.json$`,
);
const COMMUNITY_REVOCATION_FILE_RE = new RegExp(
  `^revocation-(${COMMUNITY_ID_FRAGMENT})\\.json$`,
);

export interface CommunityBundleFileIdentity {
  publisherKeyId: string;
  bundleId: string;
}

export function communityBundleFileName(publisherKeyId: string, bundleId: string): string {
  return `bundle-${publisherKeyId}-${bundleId}.json`;
}

export function communityRevocationFileName(revocationId: string): string {
  return `revocation-${revocationId}.json`;
}

export function parseCommunityBundleFileName(name: string): CommunityBundleFileIdentity | null {
  const match = COMMUNITY_BUNDLE_FILE_RE.exec(name);
  return match ? { publisherKeyId: match[1]!, bundleId: match[2]! } : null;
}

export function isCommunityRevocationFileName(name: string): boolean {
  return COMMUNITY_REVOCATION_FILE_RE.test(name);
}
