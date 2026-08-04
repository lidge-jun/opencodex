import { describe, expect, test } from "bun:test";
import {
  assembleReleaseNotes,
  hasMeaningfulCarriedNotes,
  hasNonWhitespace,
  joinCarriedPreviewNotes,
  matchingPreviewTag,
  matchingPreviewTags,
  parseTakeoverSourcePr,
  previousReleaseNotesTag,
  rewriteTakeoverCredits,
  selectNewestCarriedPreviewTag,
  stripCarriedReleaseNotes,
  stripGenerateNotesCompareLink,
} from "../scripts/release-notes";

describe("matchingPreviewTag", () => {
  test("picks the newest matching preview tag for a stable version", () => {
    expect(matchingPreviewTag("2.7.39", [
      "v2.7.38-preview.20260724",
      "v2.7.39-preview.20260724",
      "v2.7.39-preview.20260725",
      "v2.7.40-preview.20260725",
      "v2.7.39",
    ])).toBe("v2.7.39-preview.20260725");
  });

  test("returns null for preview versions and when no match exists", () => {
    expect(matchingPreviewTag("2.7.39-preview.1", ["v2.7.39-preview.1"])).toBeNull();
    expect(matchingPreviewTag("2.7.41", ["v2.7.40-preview.20260725"])).toBeNull();
  });
});

describe("matchingPreviewTags", () => {
  test("returns all matching preview tags oldest to newest", () => {
    expect(matchingPreviewTags("2.7.39", [
      "v2.7.39-preview.20260725",
      "v2.7.38-preview.20260724",
      "v2.7.39-preview.20260724",
      "v2.7.39",
    ])).toEqual([
      "v2.7.39-preview.20260724",
      "v2.7.39-preview.20260725",
    ]);
  });

  test("orders same-day previews numerically, not lexicographically", () => {
    expect(matchingPreviewTags("2.7.39", [
      "v2.7.39-preview.20260725.10",
      "v2.7.39-preview.20260725.2",
    ])).toEqual([
      "v2.7.39-preview.20260725.2",
      "v2.7.39-preview.20260725.10",
    ]);
  });
});

describe("previousReleaseNotesTag", () => {
  test("preview baselines the newest prior release of either channel", () => {
    expect(previousReleaseNotesTag("2.7.43-preview.20260728", [
      "v2.7.41-preview.20260726",
      "v2.7.41",
      "v2.7.42",
      "v2.7.43-preview.20260728",
    ])).toBe("v2.7.42");
  });

  test("preview after preview (no stable in between) keeps the previous preview", () => {
    expect(previousReleaseNotesTag("2.7.43-preview.20260729", [
      "v2.7.42",
      "v2.7.43-preview.20260728",
      "v2.7.43-preview.20260729",
    ])).toBe("v2.7.43-preview.20260728");
  });

  test("stable baselines the newest prior stable only", () => {
    expect(previousReleaseNotesTag("2.7.43", [
      "v2.7.42",
      "v2.7.43-preview.20260728",
      "v2.7.43",
    ])).toBe("v2.7.42");
  });

  test("returns null when no eligible prior tag exists", () => {
    expect(previousReleaseNotesTag("2.7.43-preview.1", ["v2.7.43-preview.1"])).toBeNull();
    expect(previousReleaseNotesTag("2.7.43", ["v2.7.43-preview.1"])).toBeNull();
  });

  test("ignores candidate tags newer than the target release", () => {
    expect(previousReleaseNotesTag("2.7.43-preview.20260728", [
      "v2.7.42",
      "v2.8.0-preview.1",
    ])).toBe("v2.7.42");
  });

  test("ranks a stable tag after its matching preview when both are prior", () => {
    expect(previousReleaseNotesTag("2.7.43-preview.20260728", [
      "v2.7.42-preview.20260727",
      "v2.7.42",
    ])).toBe("v2.7.42");
  });
});

describe("stripCarriedReleaseNotes", () => {
  test("keeps PR categories and drops npm blurb, commits, and compare link", () => {
    const body = [
      "Published to npm as `@bitkyc08/opencodex@2.7.39-preview.20260724` with dist-tag `preview`.",
      "",
      "<!-- Release notes generated using configuration in .github/release.yml at abc -->",
      "",
      "## What's Changed",
      "### Bug Fixes",
      "* fix(release): full channel changelog by @Wibias in https://example.test/pull/364",
      "",
      "## New Contributors",
      "* @someone made their first contribution",
      "",
      "## Commits",
      "",
      "- release: v2.7.39-preview.20260724 (8894e40e)",
      "- Merge branch 'dev' into preview (9077f7c1)",
      "",
      "**Full Changelog**: https://github.com/lidge-jun/opencodex/compare/v2.7.38-preview.20260724...v2.7.39-preview.20260724",
      "",
    ].join("\n");

    expect(stripCarriedReleaseNotes(body)).toBe([
      "<!-- Release notes generated using configuration in .github/release.yml at abc -->",
      "",
      "## What's Changed",
      "### Bug Fixes",
      "* fix(release): full channel changelog by @Wibias in https://example.test/pull/364",
      "",
      "## New Contributors",
      "* @someone made their first contribution",
    ].join("\n"));
  });

  test("commits-only preview bodies strip to non-meaningful notes", () => {
    const body = [
      "Published to npm as `@bitkyc08/opencodex@2.7.39-preview.20260724` with dist-tag `preview`.",
      "",
      "<!-- Release notes generated using configuration in .github/release.yml at abc -->",
      "",
      "## Commits",
      "",
      "- release: v2.7.39-preview.20260724 (8894e40e)",
      "",
      "**Full Changelog**: https://example/compare/a...b",
    ].join("\n");
    const stripped = stripCarriedReleaseNotes(body);
    expect(hasMeaningfulCarriedNotes(stripped)).toBe(false);
  });
});

describe("joinCarriedPreviewNotes", () => {
  test("aggregates multiple incremental preview bodies in order", () => {
    const joined = joinCarriedPreviewNotes([
      "## What's Changed\n* fix A",
      "<!-- only comment -->",
      "## What's Changed\n* fix B",
    ]);
    expect(joined).toBe("## What's Changed\n* fix A\n\n## What's Changed\n* fix B");
  });
});

describe("selectNewestCarriedPreviewTag", () => {
  const meaningfulBody = [
    "Published to npm as `@pkg@1.0.0-preview.1` with dist-tag `preview`.",
    "",
    "## What's Changed",
    "* fix from preview.1",
    "",
    "## Commits",
    "- release preview.1",
  ].join("\n");

  const emptyBody = [
    "Published to npm as `@pkg@1.0.0-preview.2` with dist-tag `preview`.",
    "",
    "<!-- Release notes generated using configuration in .github/release.yml at abc -->",
    "",
    "## Commits",
    "- release preview.2",
    "",
    "**Full Changelog**: https://example/compare/a...b",
  ].join("\n");

  test("keeps preview.1 as baseline when preview.2 is missing or empty", () => {
    expect(selectNewestCarriedPreviewTag([
      { tag: "v1.0.0-preview.1", releaseBody: meaningfulBody },
      { tag: "v1.0.0-preview.2", releaseBody: null },
    ])).toBe("v1.0.0-preview.1");

    expect(selectNewestCarriedPreviewTag([
      { tag: "v1.0.0-preview.1", releaseBody: meaningfulBody },
      { tag: "v1.0.0-preview.2", releaseBody: emptyBody },
    ])).toBe("v1.0.0-preview.1");
  });

  test("advances to preview.2 only when its body is meaningful", () => {
    expect(selectNewestCarriedPreviewTag([
      { tag: "v1.0.0-preview.1", releaseBody: meaningfulBody },
      { tag: "v1.0.0-preview.2", releaseBody: "## What's Changed\n* fix from preview.2" },
    ])).toBe("v1.0.0-preview.2");
  });
});

describe("assembleReleaseNotes", () => {
  test("copies preview notes and appends only the since-preview delta", () => {
    const notes = assembleReleaseNotes({
      npmMetadata: "Published to npm as `@bitkyc08/opencodex@2.7.39` with dist-tag `latest`.",
      carriedPreviewNotes: "## What's Changed\n### Bug Fixes\n* fix A",
      deltaPrNotes: "## What's Changed\n### Bug Fixes\n* fix B",
      commits: "- release: v2.7.39 (357acee6)",
      compareFrom: "v2.7.37",
      compareTo: "v2.7.39",
      repository: "lidge-jun/opencodex",
    });

    expect(notes).toContain("dist-tag `latest`");
    expect(notes).toContain("## What's Changed\n### Bug Fixes\n* fix A");
    expect(notes).toContain("## Since preview\n\n## What's Changed\n### Bug Fixes\n* fix B");
    expect(notes).toContain("## Commits\n\n- release: v2.7.39 (357acee6)");
    expect(notes).toContain("**Full Changelog**: https://github.com/lidge-jun/opencodex/compare/v2.7.37...v2.7.39");
  });

  test("omits empty generate-notes delta that is only the config comment", () => {
    const notes = assembleReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      carriedPreviewNotes: "## What's Changed\n* fix A",
      deltaPrNotes: "<!-- Release notes generated using configuration in .github/release.yml at abc -->\n\n\n**Full Changelog**: https://example/compare/a...b\n",
      commits: "- release: v1.0.0 (abc)",
      compareFrom: "v0.9.0",
      compareTo: "v1.0.0",
      repository: "acme/pkg",
    });

    expect(notes).toContain("* fix A");
    expect(notes).not.toContain("## Since preview");
    expect(notes).not.toContain("Full Changelog**: https://example/compare/a...b");
  });

  test("falls back to channel notes when no preview body is carried", () => {
    const notes = assembleReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      deltaPrNotes: "## What's Changed\n* feat X\n\n**Full Changelog**: https://example/compare/a...b",
      commits: "- feat X (abc1234)",
      compareFrom: "v0.9.0",
      compareTo: "v1.0.0",
      repository: "acme/pkg",
    });

    expect(notes).not.toContain("## Since preview");
    expect(notes).toContain("## What's Changed\n* feat X");
    expect(notes).not.toContain("https://example/compare/a...b");
    expect(hasNonWhitespace("")).toBe(false);
    expect(stripGenerateNotesCompareLink("x\n**Full Changelog**: y")).toBe("x");
  });
});

describe("parseTakeoverSourcePr", () => {
  test("matches common maintainer-takeover title forms", () => {
    expect(parseTakeoverSourcePr("feat(images): Grok image bridge (maintainer takeover of #424)")).toBe(424);
    expect(parseTakeoverSourcePr("feat(codex): account pause (takeover #565)")).toBe(565);
    expect(parseTakeoverSourcePr("feat x", "Maintainer takeover of #424.")).toBe(424);
    expect(parseTakeoverSourcePr("feat x", "no mention")).toBeNull();
  });
});

describe("rewriteTakeoverCredits", () => {
  test("credits original author and keeps landing PR link", async () => {
    const body = [
      "## What's Changed",
      "### New Features",
      "* feat(images): Grok image bridge (maintainer takeover of #424) by @Wibias in https://github.com/lidge-jun/opencodex/pull/577",
      "* feat(other): normal change by @Alice in https://github.com/lidge-jun/opencodex/pull/100",
    ].join("\n");

    const landingCalls: number[] = [];
    const rewritten = await rewriteTakeoverCredits(
      body,
      async (pr) => {
        landingCalls.push(pr);
        return null;
      },
      async (source) => (source === 424 ? "tizerluo" : null),
    );

    expect(landingCalls).toEqual([]);
    expect(rewritten).toContain(
      "* feat(images): Grok image bridge (maintainer takeover of #424) by @tizerluo (takeover by @Wibias) in https://github.com/lidge-jun/opencodex/pull/577",
    );
    expect(rewritten).toContain(
      "* feat(other): normal change by @Alice in https://github.com/lidge-jun/opencodex/pull/100",
    );
  });

  test("falls back to landing lookup when title says takeover without #N", async () => {
    const line =
      "* feat x (takeover) by @Wibias in https://github.com/lidge-jun/opencodex/pull/577";
    const rewritten = await rewriteTakeoverCredits(
      line,
      async (pr) => {
        if (pr !== 577) return null;
        return {
          title: "feat x (takeover)",
          body: "Maintainer takeover of #424.",
          authorLogin: "Wibias",
        };
      },
      async (source) => (source === 424 ? "tizerluo" : null),
    );
    expect(rewritten).toContain(
      "* feat x (takeover) by @tizerluo (takeover by @Wibias) in https://github.com/lidge-jun/opencodex/pull/577",
    );
  });

  test("leaves line unchanged when landing lookup returns null", async () => {
    const line =
      "* feat x (takeover) by @Wibias in https://github.com/lidge-jun/opencodex/pull/577";
    const rewritten = await rewriteTakeoverCredits(
      line,
      async () => null,
      async () => "tizerluo",
    );
    expect(rewritten).toBe(line);
  });

  test("leaves line unchanged when original author matches landing author", async () => {
    const line =
      "* feat x (takeover #9) by @Wibias in https://github.com/lidge-jun/opencodex/pull/10";
    const rewritten = await rewriteTakeoverCredits(
      line,
      async () => ({
        title: "feat x (takeover #9)",
        body: "",
        authorLogin: "Wibias",
      }),
      async () => "Wibias",
    );
    expect(rewritten).toBe(line);
  });
});
