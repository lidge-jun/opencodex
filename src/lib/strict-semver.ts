const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface StrictSemver {
  readonly raw: string;
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly (bigint | string)[];
}

export function parseStrictSemver(value: unknown, maxLength = 128): StrictSemver | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  const match = STRICT_SEMVER_RE.exec(value);
  if (!match) return null;
  return Object.freeze({
    raw: value,
    core: Object.freeze([BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)]) as readonly [bigint, bigint, bigint],
    prerelease: Object.freeze(match[4]
      ? match[4].split(".").map(part => /^\d+$/.test(part) ? BigInt(part) : part)
      : []),
  });
}
