// Core and build metadata are unambiguous and stay inline. The prerelease section does not:
// the semver.org pattern for one identifier is
//   0 | [1-9]\d* | [0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*
// whose three alternatives overlap, and wrapping that in `(?:\.…)*` gives a regex engine an
// exponential number of ways to split the same string. CodeQL flagged it (`js/redos`) and the
// cost is real, not theoretical: `0.0.0-0.` followed by repetitions of `--.` took **522ms for a
// single 125-character input** — inside the 128-char ceiling this module already enforced, and
// inside the 96-char one its only caller uses. A length cap does not fix superlinear blowup; it
// only decides where the curve is sampled.
//
// So the prerelease section is matched with one non-backtracking pass and its identifiers are
// validated individually. Each identifier is checked by an anchored regex with no repetition of
// an alternation, which is linear in the identifier's length.
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const NUMERIC_IDENTIFIER_RE = /^(?:0|[1-9]\d*)$/;
const ALPHANUMERIC_IDENTIFIER_RE = /^[0-9A-Za-z-]+$/;

/**
 * A prerelease identifier is either a numeric identifier with no leading zero, or an
 * alphanumeric one that contains at least one non-digit. Empty identifiers are invalid,
 * which is what rejects a trailing or doubled dot.
 */
function isPrereleaseIdentifier(part: string): boolean {
  if (part.length === 0) return false;
  if (NUMERIC_IDENTIFIER_RE.test(part)) return true;
  return ALPHANUMERIC_IDENTIFIER_RE.test(part) && !/^\d+$/.test(part);
}

export interface StrictSemver {
  readonly raw: string;
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly (bigint | string)[];
}

export function parseStrictSemver(value: unknown, maxLength = 128): StrictSemver | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  const match = STRICT_SEMVER_RE.exec(value);
  if (!match) return null;
  const prereleaseParts = match[4] === undefined ? [] : match[4].split(".");
  if (!prereleaseParts.every(isPrereleaseIdentifier)) return null;
  return Object.freeze({
    raw: value,
    core: Object.freeze([BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)]) as readonly [bigint, bigint, bigint],
    prerelease: Object.freeze(prereleaseParts.map(part => /^\d+$/.test(part) ? BigInt(part) : part)),
  });
}
