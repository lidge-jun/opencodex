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

/**
 * SemVer precedence: -1 when left is older, 1 when newer, 0 when equal.
 *
 * Build metadata is ignored per the spec; callers that need to distinguish
 * `2.43.0+a` from `2.43.0+b` compare the raw strings separately. Shared by
 * every version comparison so two diagnostics can never disagree about which
 * install is older.
 */
export function compareStrictSemver(left: StrictSemver, right: StrictSemver): number {
  for (let i = 0; i < left.core.length; i++) {
    if (left.core[i]! !== right.core[i]!) return left.core[i]! > right.core[i]! ? 1 : -1;
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a !== typeof b) return typeof a === "bigint" ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}
