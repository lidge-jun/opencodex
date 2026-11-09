const MAX_CORE = 18446744073709551615n;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function validVersion(value) {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = VERSION.exec(value);
  if (!match || match[0] !== value) return false;
  if ([match[1], match[2], match[3]].some((part) => BigInt(part) > MAX_CORE)) return false;
  if (match[4]?.split(".").some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === "0")) return false;
  return true;
}

/** Compare complete signed version identity; no update authority is implied. */
export function sameSignedVersion(releaseVersion, signedVersion) {
  if (!validVersion(releaseVersion) || typeof signedVersion !== "string") return false;
  const normalized = signedVersion.startsWith("v") ? signedVersion.slice(1) : signedVersion;
  return validVersion(normalized) && releaseVersion === normalized;
}

/** Compare a version field only after the caller authenticates the comment. */
export function trustedCommentMatchesVersion(comment, releaseVersion) {
  if (typeof comment !== "string" || Buffer.byteLength(comment, "utf8") > 4096) return false;
  const versions = comment.split("\t").filter((field) => field.startsWith("version:"));
  return versions.length === 1 && sameSignedVersion(releaseVersion, versions[0].slice("version:".length));
}
