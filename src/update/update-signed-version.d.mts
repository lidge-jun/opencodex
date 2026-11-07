/** Strict full version equality, including build metadata; this grants no authority. */
export function sameSignedVersion(releaseVersion: string, signedVersion: string): boolean;

/** Caller must authenticate the trusted comment before relying on this result. */
export function trustedCommentMatchesVersion(comment: string, releaseVersion: string): boolean;
