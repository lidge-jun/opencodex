export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[] | null;
}

export type ReleaseBumpKind = "patch" | "minor" | "major";

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Optional leading v, optional prerelease, optional (ignored) build metadata. */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

function compareParsedVersions(
  left: ParsedVersion,
  right: ParsedVersion,
  compareText: (a: string, b: string) => number,
): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aIsNumeric = /^\d+$/.test(a);
    const bIsNumeric = /^\d+$/.test(b);
    if (aIsNumeric && bIsNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference;
      continue;
    }
    if (aIsNumeric !== bIsNumeric) return aIsNumeric ? -1 : 1;
    const difference = compareText(a, b);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Strict ordering for release decisions. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  if (!a) throw new Error(`unparseable release version: ${JSON.stringify(left)}`);
  const b = parseVersion(right);
  if (!b) throw new Error(`unparseable release version: ${JSON.stringify(right)}`);
  return compareParsedVersions(a, b, (x, y) => x < y ? -1 : x > y ? 1 : 0);
}

/** Lenient ordering for historical tag sets. */
export function compareTagsLenient(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  }
  return compareParsedVersions(a, b, (x, y) => x.localeCompare(y));
}

/**
 * The version a development line carries once `released` exists.
 *
 *   X.Y.Z-preview.*  ->  X.Y.Z
 *   X.Y.Z (stable)   ->  X.(Y+1).0
 */
export function nextDevelopmentVersion(released: string): string {
  const parsed = parseVersion(released);
  if (!parsed) throw new Error(`released version is not parseable: ${JSON.stringify(released)}`);
  return parsed.prerelease === null
    ? `${parsed.major}.${parsed.minor + 1}.0`
    : `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function newestVersion(versions: readonly string[]): string | null {
  return versions.reduce<string | null>((newest, version) => {
    if (!parseVersion(version)) {
      throw new Error(`unparseable release version: ${JSON.stringify(version)}`);
    }
    return newest === null || compareVersions(version, newest) > 0 ? version : newest;
  }, null);
}

function stableBase(stableTip: string | null, stableTags: readonly string[]): string {
  const candidates = stableTip === null ? stableTags : [stableTip, ...stableTags];
  for (const candidate of candidates) {
    const parsed = parseVersion(candidate);
    if (!parsed || parsed.prerelease !== null) {
      throw new Error(`stable release version is not parseable as stable SemVer: ${JSON.stringify(candidate)}`);
    }
  }
  const base = newestVersion(candidates);
  if (base === null) throw new Error("cannot resolve a release bump without a stable channel tip or stable tag");
  return base;
}

function versionCore(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`unparseable release version: ${JSON.stringify(version)}`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function bumpCore(base: string, kind: ReleaseBumpKind): string {
  const parsed = parseVersion(base);
  if (!parsed || parsed.prerelease !== null) {
    throw new Error(`release bump base is not a stable version: ${JSON.stringify(base)}`);
  }
  if (kind === "major") return `${parsed.major + 1}.0.0`;
  if (kind === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function higherCorePreview(base: string, previews: readonly string[]): string | null {
  const blockers = previews.filter(preview => {
    const parsed = parseVersion(preview);
    if (!parsed || parsed.prerelease === null) {
      throw new Error(`preview release version is not parseable as prerelease SemVer: ${JSON.stringify(preview)}`);
    }
    return compareVersions(versionCore(preview), versionCore(base)) > 0;
  });
  return newestVersion(blockers);
}

function assertAboveGlobalFloor(candidate: string, published: readonly (string | null)[]): void {
  const floor = newestVersion(published.filter((version): version is string => version !== null));
  if (floor !== null && compareVersions(candidate, floor) <= 0) {
    throw new Error(`resolved release ${candidate} does not outrank the global published floor ${floor}`);
  }
}

/**
 * Resolve the next stable release from the stable channel only. Preview tags are
 * consulted only for the higher-core patch refusal and the final global assertion.
 */
export function nextStableRelease(input: {
  kind: ReleaseBumpKind;
  stableTip: string | null;
  stableTags: string[];
  previewTags: string[];
}): string {
  const base = stableBase(input.stableTip, input.stableTags);
  if (input.kind === "patch") {
    const blocker = higherCorePreview(base, input.previewTags);
    if (blocker !== null) {
      throw new Error(
        `cannot bump stable patch from ${versionCore(base)} while higher-core preview ${blocker} is open; ship the fix in ${versionCore(blocker)}`,
      );
    }
  }

  const candidate = bumpCore(base, input.kind);
  assertAboveGlobalFloor(candidate, [input.stableTip, ...input.stableTags, ...input.previewTags]);
  return candidate;
}

interface PreviewIdentity {
  ordinal: number;
  stamp: string;
}

function previewIdentity(version: string): PreviewIdentity {
  const parsed = parseVersion(version);
  const prerelease = parsed?.prerelease;
  if (
    !prerelease
    || prerelease[0] !== "preview"
    || !/^\d{8}$/.test(prerelease[1] ?? "")
    || prerelease.length > 3
    || (prerelease[2] !== undefined && !/^\d+$/.test(prerelease[2]))
  ) {
    throw new Error(`preview incumbent has an unsupported prerelease shape: ${JSON.stringify(version)}`);
  }
  return {
    stamp: prerelease[1]!,
    ordinal: prerelease[2] === undefined ? 1 : Number(prerelease[2]),
  };
}

/** Resolve a preview core from the stable line, then succeed its same-core incumbent. */
export function nextPreviewRelease(input: {
  kind: ReleaseBumpKind;
  stableTip: string | null;
  stableTags: string[];
  previewTip: string | null;
  previewTags: string[];
  stamp: string;
}): string {
  if (!/^\d{8}$/.test(input.stamp)) {
    throw new Error(`preview stamp must be YYYYMMDD: ${JSON.stringify(input.stamp)}`);
  }

  const base = stableBase(input.stableTip, input.stableTags);
  const allPreviews = input.previewTip === null
    ? input.previewTags
    : [input.previewTip, ...input.previewTags];
  if (input.kind === "patch") {
    const blocker = higherCorePreview(base, allPreviews);
    if (blocker !== null) {
      throw new Error(
        `cannot bump preview patch from ${versionCore(base)} while higher-core preview ${blocker} is open`,
      );
    }
  }

  const core = bumpCore(base, input.kind);
  const sameCorePreviews = allPreviews.filter(preview => {
    const parsed = parseVersion(preview);
    if (!parsed || parsed.prerelease === null) {
      throw new Error(`preview release version is not parseable as prerelease SemVer: ${JSON.stringify(preview)}`);
    }
    return versionCore(preview) === core;
  });
  const incumbent = newestVersion(sameCorePreviews);
  let candidate = `${core}-preview.${input.stamp}`;

  if (incumbent !== null) {
    const identity = previewIdentity(incumbent);
    if (input.stamp < identity.stamp) {
      throw new Error(
        `preview clock regression: supplied stamp ${input.stamp} is older than incumbent stamp ${identity.stamp}`,
      );
    }
    if (input.stamp === identity.stamp) {
      candidate = `${candidate}.${identity.ordinal + 1}`;
    }
    if (compareVersions(candidate, incumbent) <= 0) {
      throw new Error(`resolved preview ${candidate} does not succeed incumbent ${incumbent}`);
    }
  }

  assertAboveGlobalFloor(candidate, [
    input.stableTip,
    ...input.stableTags,
    input.previewTip,
    ...input.previewTags,
  ]);
  return candidate;
}

/**
 * The publication-boundary ordering policy: a candidate must strictly outrank
 * every release tag. The equality exception is granted only by release.yml for
 * a dry run whose existing tag already names the commit under test.
 */
export function assertReleasable(input: {
  candidate: string;
  tags: readonly string[];
  allowExistingTagAtHead?: boolean;
}): { ok: true } | { ok: false; blockedBy: string } {
  for (const tag of input.tags) {
    const order = compareVersions(input.candidate, tag);
    if (order < 0 || (order === 0 && !input.allowExistingTagAtHead)) {
      return { ok: false, blockedBy: tag };
    }
  }
  return { ok: true };
}

const VERSION_LINE_USAGE = "usage: bun scripts/version-line.ts assert-ahead <a> <b> | assert-releasable <version> [--allow-existing-tag-at-head]";

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "assert-ahead") {
    const [left, right] = rest;
    if (!left || !right) {
      console.error(VERSION_LINE_USAGE);
      process.exit(1);
    }
    if (compareVersions(left, right) <= 0) {
      console.error(
        `::error::origin/dev carries ${left}, which does not outrank ${right}. Run the dev pre-move before releasing.`,
      );
      process.exit(1);
    }
    process.exit(0);
  }

  if (command === "assert-releasable") {
    const [candidate, ...flags] = rest;
    if (!candidate) {
      console.error(VERSION_LINE_USAGE);
      process.exit(1);
    }
    const tags = (await Bun.stdin.text())
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
    const verdict = assertReleasable({
      candidate,
      tags,
      allowExistingTagAtHead: flags.includes("--allow-existing-tag-at-head"),
    });
    if (!verdict.ok) {
      console.error(
        `::error::${candidate} does not outrank the current tag set (blocked by ${verdict.blockedBy}). Opening a preview for a higher core closes older stable patch lines — see devlog/_plan/260904_release_version_line/020 §4.0.`,
      );
      process.exit(1);
    }
    process.exit(0);
  }

  console.error(VERSION_LINE_USAGE);
  process.exit(1);
}
