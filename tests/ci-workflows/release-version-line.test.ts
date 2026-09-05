import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compareReleaseTags } from "../../scripts/release-notes";
import { repoPath, repoRoot as resolveRepoRoot } from "../helpers/repo-root";

const repoRoot = resolveRepoRoot();

/**
 * The in-tree version must never sit BEHIND a version this repository has already
 * released.
 *
 * This is not hypothetical. dev accumulated 254 commits without ever touching
 * package.json, so its version string (2.32.1-preview.20260825) fell behind the
 * published latest dist-tag (2.33.0) once v2.33.0 was cut from main. One stale line,
 * two distinct failure modes:
 *
 *  - assertChannelVersionMovesForward in scripts/release.ts refuses the string as a
 *    channel regression, so a release cut from that tree cannot publish at all.
 *  - merging dev into main resolves package.json to main's side, producing a tree that
 *    claims to be the ALREADY-PUBLISHED 2.33.0 - a silent duplicate instead of a loud
 *    failure.
 *
 * Commit 32529c2b2 repaired precisely this by hand once, and nothing has enforced it
 * since. The assertion reads the local tag set rather than the npm registry, so it needs
 * no network and no edit at each release.
 * The durable repair now moves `dev` forward before the release instead of catching it
 * up afterward.
 *
 * compareReleaseTags comes from scripts/release-notes and not from scripts/release: the
 * latter parses process.argv and calls process.exit at module scope, so importing it from
 * a test kills the runner. release-notes guards its CLI behind import.meta.main.
 */

/** Release tags shaped vX.Y.Z[-pre]. Non-release tags are ignored, not an error. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function git(args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot });
  return {
    ok: result.exitCode === 0,
    out: new TextDecoder().decode(result.stdout).trim(),
  };
}

function localReleaseTags(): string[] {
  const result = git(["tag", "--list", "v*"]);
  // A tarball install or a missing git binary lands here. Absent tags cannot prove a
  // regression, so the check reports nothing rather than inventing a failure.
  if (!result.ok) return [];
  return result.out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => RELEASE_TAG.test(line));
}

function inTreeVersion(): string {
  const raw = readFileSync(repoPath("package.json"), "utf8");
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error("package.json has no string version");
  return version;
}

/** Newest tag by SemVer precedence, or null when the set is empty. */
function highestReleaseTag(tags: string[]): string | null {
  if (tags.length === 0) return null;
  const sorted = [...tags].sort(compareReleaseTags);
  return sorted[sorted.length - 1] ?? null;
}

/**
 * True when the given tag names the commit under test.
 *
 * This is the difference between "equal is legal" and "equal is a duplicate". On a
 * release commit — main at v2.33.0, preview at v2.33.0-preview.20260825 — package.json
 * SHOULD equal the highest tag, and a test that demanded strictly-ahead everywhere would
 * turn every released commit red. On any other commit, equal means the tree claims a
 * version that is already published.
 */
function tagPointsAtHead(tag: string): boolean {
  const head = git(["rev-parse", "HEAD^{commit}"]);
  const tagged = git([`rev-parse`, `${tag}^{commit}`]);
  return head.ok && tagged.ok && head.out.length > 0 && head.out === tagged.out;
}

describe("release version line", () => {
  test("package.json carries a parseable SemVer version", () => {
    expect(inTreeVersion()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  test("the in-tree version is never behind a released one", () => {
    const tags = localReleaseTags();
    // A checkout with no tags cannot answer the question. CI fetches tags explicitly for
     // the jobs that run this suite (see .github/workflows/ci.yml), so an empty set here
    // means a tarball or a hand-made shallow clone, not a silently unprotected pipeline.
    if (tags.length === 0) return;

    const version = inTreeVersion();
    const highest = highestReleaseTag(tags);
    expect(highest).not.toBeNull();

    const ordering = compareReleaseTags("v" + version, highest!);
    if (ordering === 0) {
      // Legal only on the release commit that tag names.
      expect(
        tagPointsAtHead(highest!),
        "package.json version " + version + " equals release tag " + highest +
          ", but this commit is not the one that tag names. The tree claims an " +
          "already-published version: publishing is refused as a duplicate. Bump " +
          "package.json.",
      ).toBe(true);
      return;
    }

    expect(
      ordering,
      "package.json version " + version + " is BEHIND the highest release tag " +
        highest +
        ". A release cut from this tree is rejected as a channel regression, and " +
        "merging into main resolves package.json to main's side and silently " +
        "republishes. Bump package.json.",
    ).toBeGreaterThan(0);
  });

  test("a version behind the tag set is detected rather than tolerated", () => {
    // Proves the comparison above is not vacuous: the same helper, given the exact string
    // dev actually carried, must order it BEHIND the release that stranded it.
    expect(compareReleaseTags("v2.32.1-preview.20260825", "v2.33.0")).toBeLessThan(0);
    expect(compareReleaseTags("v2.33.0", "v2.33.0")).toBe(0);
    expect(compareReleaseTags("v2.34.0", "v2.33.0")).toBeGreaterThan(0);
    // A prerelease of a FUTURE version is ahead, not behind: dev may legitimately carry
    // 2.35.0-preview.1 while v2.34.0 is the newest tag.
    expect(compareReleaseTags("v2.35.0-preview.1", "v2.34.0")).toBeGreaterThan(0);
    // ...but a prerelease of the SAME core is behind its own stable release.
    expect(compareReleaseTags("v2.34.0-preview.1", "v2.34.0")).toBeLessThan(0);
  });
});
