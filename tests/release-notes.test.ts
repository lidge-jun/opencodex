import { describe, expect, test } from "bun:test";
import {
  cleanPrTitle,
  extractChangelogPrNumbers,
  extractCommitBulletSections,
  mergeCommitBulletSections,
  extractPrNumbers,
  hasMeaningfulCarriedNotes,
  isReleasePlumbingCommit,
  isPolishBaseUrlAllowed,
  joinCarriedPreviewNotes,
  matchingPreviewTag,
  matchingPreviewTags,
  parseCommitLog,
  parseGeneratedNotes,
  parseSectionHeadings,
  parseTakeoverSourcePr,
  previousReleaseNotesTag,
  renderCommitFallbackNotes,
  sanitizeCommitText,
  renderReleaseNotes,
  rewriteTakeoverCredits,
  selectNewestCarriedPreviewTag,
  splitPolishInput,
  stripCarriedReleaseNotes,
  validatePolishedSections,
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

describe("commit fallback: untrusted-input and carry hardening", () => {
  const log = (s: string) => parseCommitLog(s);

  test("git author display names never render as GitHub mentions", () => {
    // %an is a free-form display name; "@Abhishek" would notify an unrelated account.
    const out = renderCommitFallbackNotes(log("aaaaaaaaaaaa1\u0000fix(x): a fix\u0000Abhishek Sharma"));
    expect(out).toContain("Abhishek Sharma");
    expect(out).not.toMatch(/@Abhishek/);
  });

  test("mentions inside commit subjects are neutralized but stay readable", () => {
    const out = renderCommitFallbackNotes(log("aaaaaaaaaaaa1\u0000fix(x): thanks @octocat\u0000dev"));
    expect(out).not.toMatch(/@octocat/);
    expect(out).toContain("octocat");
  });

  test("markdown metacharacters cannot restructure the release body", () => {
    const subject = "fix(x): drop " + String.fromCharCode(96) + "code" + String.fromCharCode(96) + " and <b>tags</b>";
    const NUL = String.fromCharCode(0);
    const out = renderCommitFallbackNotes(log("aaaaaaaaaaaa1" + NUL + subject + NUL + "dev"));
    // Non-vacuous: the entry must actually render.
    expect(out).toContain("drop");
    // Escaped, not deleted: technical text survives but cannot restructure the body.
    expect(out).toContain("\\" + String.fromCharCode(96) + "code");
    expect(out).toContain("\\<b\\>");
    expect(out).not.toMatch(/(^|[^\\])<b>/);
  });

  test("sanitizeCommitText collapses newlines and strips the separator byte", () => {
    expect(sanitizeCommitText("a\nb")).toBe("a b");
    expect(sanitizeCommitText("a" + String.fromCharCode(31) + "b")).toBe("a b");
  });

  test("a unit separator in subject OR author cannot forge a field boundary", () => {
    // Git accepts U+001F in both subjects and author names, so the old framing
    // was ambiguous in both directions; NUL cannot appear in commit content.
    const commits = log("aaaaaaaaaaaa1\u0000subject\u001fwith sep\u0000Mallory\u001fInjected");
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe("subject\u001fwith sep");
    expect(commits[0]!.author).toBe("Mallory\u001fInjected");
    expect(renderCommitFallbackNotes(commits)).not.toContain("\u001f");
  });

  test("a non-hex sha is dropped rather than rendered", () => {
    const out = renderCommitFallbackNotes([{ sha: "not-a-sha](evil)", subject: "fix(x): y", author: "dev" }]);
    expect(out).not.toContain("evil");
    expect(out).toContain("- x: y");
  });

  test("conventional merge: commits are plumbing too", () => {
    expect(isReleasePlumbingCommit("merge: bring dev into main")).toBe(true);
    expect(isReleasePlumbingCommit("merge(dev): sync")).toBe(true);
    const NUL = String.fromCharCode(0);
    // Non-vacuous: an ordinary commit in the same shape does render.
    expect(renderCommitFallbackNotes(log("aaaaaaaaaaaa1" + NUL + "fix(x): real" + NUL + "dev"))).toContain("real");
    expect(renderCommitFallbackNotes(log("aaaaaaaaaaaa1" + NUL + "merge: bring dev into main" + NUL + "dev"))).toBe("");
  });

  test("preview fallback notes survive the carry into a stable release", () => {
    // Guards the blocker: a preview body built by the fallback is "meaningful",
    // so the workflow carries it and skips regenerating — and the PR renderer
    // would otherwise discard every non-PR bullet, collapsing back to the stub.
    const previewBody = "## Bug Fixes\n\n- gui: fix a thing (abc1234, Some Name)\n";
    const rendered = renderReleaseNotes({
      npmMetadata: "npm line.",
      carriedPreviewNotes: previewBody,
      deltaPrNotes: "",
      compareFrom: "v1.0.0",
      compareTo: "v1.1.0",
      repository: "o/n",
    });
    expect(rendered).toContain("## Bug Fixes");
    expect(rendered).toContain("gui: fix a thing (abc1234, Some Name)");
  });

  test("extractCommitBulletSections keeps only PR-free bullets", () => {
    const body = [
      "## Bug Fixes",
      "",
      "- gui: commit style (abc1234, Name)",
      "- pr style (#42)",
      "",
      "## Changelog",
      "",
      "- #42 pr style @dev",
    ].join("\n");
    const out = extractCommitBulletSections(body);
    expect(out).toContain("gui: commit style");
    expect(out).not.toContain("#42");
    expect(out).not.toContain("Changelog");
  });

  test("carried and current fallback bullets merge under one heading per category", () => {
    const rendered = renderReleaseNotes({
      npmMetadata: "npm line.",
      carriedPreviewNotes: "## Bug Fixes\n\n- carried one (aaa1234, N)\n",
      commitFallbackNotes: "## Bug Fixes\n\n- current one (bbb1234, M)\n\n## Chores\n\n- chore one (ccc1234, O)\n",
      compareFrom: "v1.0.0",
      compareTo: "v1.1.0",
      repository: "o/n",
    });
    expect(rendered).toContain("carried one");
    expect(rendered).toContain("current one");
    expect(rendered).toContain("chore one");
    expect((rendered.match(/## Bug Fixes/g) ?? [])).toHaveLength(1);
  });

  test("mergeCommitBulletSections drops duplicate bullets", () => {
    const merged = mergeCommitBulletSections([
      "## Bug Fixes\n\n- same (aaa1234, N)\n",
      "## Bug Fixes\n\n- same (aaa1234, N)\n- other (bbb1234, M)\n",
    ]);
    expect((merged.match(/- same/g) ?? [])).toHaveLength(1);
    expect(merged).toContain("- other");
  });

  test("carried PR sections still win over carried commit bullets", () => {
    const previewBody = "## Bug Fixes\n\n- real pr work (#7)\n\n## Changelog\n\n- #7 real pr work @dev\n";
    const rendered = renderReleaseNotes({
      npmMetadata: "npm line.",
      carriedPreviewNotes: previewBody,
      commitFallbackNotes: "## Chores\n\n- noise: should not appear (abc1234, Name)\n",
      compareFrom: "v1.0.0",
      compareTo: "v1.1.0",
      repository: "o/n",
    });
    expect(rendered).toContain("#7");
    expect(rendered).not.toContain("should not appear");
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

  test("a trailing same-core preview does not hide the stable (2.9.1 → 2.10.0-preview)", () => {
    // v2.9.1-preview.20260802 shipped after the v2.9.1 stable on another lineage;
    // the next preview train must still baseline the stable, not the trailing
    // preview. This is the workflow's `git tag --list` (full set) contract: the
    // same input restricted to `--merged HEAD` would drop v2.9.1 and wrongly
    // return v2.9.1-preview.20260802.
    expect(previousReleaseNotesTag("2.10.0-preview.20260802", [
      "v2.9.1-preview.20260802",
      "v2.9.1",
      "v2.10.0-preview.20260802",
    ])).toBe("v2.9.1");
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

describe("hasMeaningfulCarriedNotes", () => {
    test("HTML comments stay non-meaningful through a closing marker or EOF", () => {
      expect(hasMeaningfulCarriedNotes("<!-- generated\nmetadata -->")).toBe(false);
      expect(hasMeaningfulCarriedNotes("<!-- generated\nmetadata")).toBe(false);
      expect(hasMeaningfulCarriedNotes("<!-- hidden -->\n## What's Changed\n* visible fix")).toBe(true);
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

describe("cleanPrTitle", () => {
  test("strips conventional prefix, keeps scope, and sentence-cases the title", () => {
    expect(cleanPrTitle("feat(providers): add Baseten Model APIs preset", 653)).toEqual({
      scope: "providers",
      text: "Add Baseten Model APIs preset",
    });
  });

  test("keeps non-conventional titles", () => {
    expect(cleanPrTitle("clarify Codex pool routing semantics", 5)).toEqual({
      scope: null,
      text: "Clarify Codex pool routing semantics",
    });
  });

  test("strips a conventional prefix that has no scope", () => {
    expect(cleanPrTitle("fix: drop the stale retry timer", 11)).toEqual({
      scope: null,
      text: "Drop the stale retry timer",
    });
  });

  test("strips a trailing reference to the PR's own number", () => {
    expect(cleanPrTitle("fix(codex): sentinel on all owner-verification failures (#857)", 857).text).toBe(
      "Sentinel on all owner-verification failures",
    );
  });

  test("keeps a trailing reference to another PR", () => {
    expect(cleanPrTitle("feat(images): Grok image bridge (#424)", 577).text).toBe("Grok image bridge (#424)");
  });
});

describe("renderReleaseNotes", () => {
  const carried = [
    "<!-- Release notes generated using configuration in .github/release.yml at abc -->",
    "",
    "## What's Changed",
    "### New Features",
    "* feat(providers): add Baseten Model APIs preset by @olddonkey in https://github.com/lidge-jun/opencodex/pull/653",
    "### Bug Fixes",
    "* fix(providers): keep Antigravity catalog static by @luvs01 in https://github.com/lidge-jun/opencodex/pull/744",
    "",
    "## New Contributors",
    "* @n3wr1ch made their first contribution",
  ].join("\n");

  const delta = [
    "## What's Changed",
    "### New Features",
    "* feat(server): advertise reasoning-effort ladders on the raw /v1/models list by @n3wr1ch in https://github.com/lidge-jun/opencodex/pull/853",
    "### Documentation",
    "* docs(codex): clarify pool routing and account continuity by @luvs01 in https://github.com/lidge-jun/opencodex/pull/862",
  ].join("\n");

  test("renders OpenAI-style sections, scope bullets, and a full PR changelog", () => {
    const notes = renderReleaseNotes({
      npmMetadata: "Published to npm as `@bitkyc08/opencodex@2.10.0` with dist-tag `latest`.",
      carriedPreviewNotes: carried,
      deltaPrNotes: delta,
      compareFrom: "v2.9.1",
      compareTo: "v2.10.0",
      repository: "lidge-jun/opencodex",
    });

    expect(notes).toBe([
      "Published to npm as `@bitkyc08/opencodex@2.10.0` with dist-tag `latest`.",
      "",
      "## New Features",
      "",
      "- Add Baseten Model APIs preset (#653)",
      "- Advertise reasoning-effort ladders on the raw /v1/models list (#853)",
      "",
      "## Bug Fixes",
      "",
      "- Keep Antigravity catalog static (#744)",
      "",
      "## Documentation",
      "",
      "- Clarify pool routing and account continuity (#862)",
      "",
      "## Changelog",
      "",
      "Full Changelog: https://github.com/lidge-jun/opencodex/compare/v2.9.1...v2.10.0",
      "",
      "- #653 feat(providers): add Baseten Model APIs preset @olddonkey",
      "- #744 fix(providers): keep Antigravity catalog static @luvs01",
      "- #853 feat(server): advertise reasoning-effort ladders on the raw /v1/models list @n3wr1ch",
      "- #862 docs(codex): clarify pool routing and account continuity @luvs01",
      "",
    ].join("\n"));
  });

  test("groups same-scope PRs into one bullet with all references", () => {
    const notes = renderReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      carriedPreviewNotes: [
        "## What's Changed",
        "### New Features",
        "* feat(providers): add A by @a in https://github.com/o/r/pull/1",
        "* feat(providers): add B by @b in https://github.com/o/r/pull/2",
        "* feat(gui): dark mode by @c in https://github.com/o/r/pull/3",
      ].join("\n"),
    });

    expect(notes).toContain("- Providers: Add A; Add B (#1, #2)");
    expect(notes).toContain("- Dark mode (#3)");
    expect(notes).toContain("- #1 feat(providers): add A @a");
    expect(notes).toContain("- #2 feat(providers): add B @b");
    expect(notes).toContain("- #3 feat(gui): dark mode @c");
  });

  test("merges scope-less PRs into one bullet without a label prefix", () => {
    const notes = renderReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      carriedPreviewNotes: [
        "## What's Changed",
        "### Bug Fixes",
        "* fix: drop the stale retry timer by @a in https://github.com/o/r/pull/11",
        "* fix: close the idle socket by @b in https://github.com/o/r/pull/12",
      ].join("\n"),
    });

    expect(notes).toContain("- Drop the stale retry timer; Close the idle socket (#11, #12)");
  });

  test("parses bot-authored PRs in generated and rendered notes", () => {
    const notes = renderReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      carriedPreviewNotes: [
        "## What's Changed",
        "### Chores",
        "* chore(deps): bump bun by @dependabot[bot] in https://github.com/o/r/pull/20",
      ].join("\n"),
    });

    expect(notes).toContain("- Bump bun (#20)");
    expect(notes).toContain("- #20 chore(deps): bump bun @dependabot[bot]");
  });

  test("deduplicates a PR whose category changed between preview and delta", () => {
    const notes = renderReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      carriedPreviewNotes: [
        "## What's Changed",
        "### Bug Fixes",
        "* fix(x): y by @a in https://github.com/o/r/pull/9",
      ].join("\n"),
      deltaPrNotes: [
        "## What's Changed",
        "### New Features",
        "* feat(x): y by @a in https://github.com/o/r/pull/9",
      ].join("\n"),
    });

    expect(notes.match(/- #9 /g)).toHaveLength(1);
    expect(notes).toContain("## Bug Fixes");
    expect(notes).not.toContain("## New Features");
  });

  test("emits the compare link even when no PRs were parsed", () => {
    const notes = renderReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      deltaPrNotes:
        "<!-- Release notes generated using configuration in .github/release.yml at abc -->\n\n\n**Full Changelog**: https://example/compare/a...b\n",
      compareFrom: "v1.0.0",
      compareTo: "v1.0.1",
      repository: "o/r",
    });

    expect(notes).toContain("## Changelog");
    expect(notes).toContain("Full Changelog: https://github.com/o/r/compare/v1.0.0...v1.0.1");
  });

  test("omits empty categories and the compare link when no range is available", () => {
    const notes = renderReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      carriedPreviewNotes: [
        "## What's Changed",
        "### Bug Fixes",
        "* fix(x): y by @a in https://github.com/o/r/pull/9",
      ].join("\n"),
    });

    expect(notes).not.toContain("## New Features");
    expect(notes).not.toContain("Full Changelog");
    expect(notes).toContain("- Y (#9)");
    expect(notes).toContain("## Changelog");
  });

  test("handles maintainer-takeover credited lines", () => {
    const notes = renderReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      carriedPreviewNotes: [
        "## What's Changed",
        "### New Features",
        "* feat(images): Grok image bridge (maintainer takeover of #424) by @tizerluo (takeover by @Wibias) in https://github.com/lidge-jun/opencodex/pull/577",
      ].join("\n"),
    });

    expect(notes).toContain("- Grok image bridge (maintainer takeover of #424) (#577)");
    expect(notes).toContain("- #577 feat(images): Grok image bridge (maintainer takeover of #424) @tizerluo");
  });

  test("deduplicates PRs appearing in both carried and delta", () => {
    const duplicate = [
      "## What's Changed",
      "### Bug Fixes",
      "* fix(x): y by @a in https://github.com/o/r/pull/9",
    ].join("\n");
    const notes = renderReleaseNotes({
      npmMetadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      carriedPreviewNotes: duplicate,
      deltaPrNotes: duplicate,
    });

    expect(notes.match(/- #9 /g)).toHaveLength(1);
  });

  test("parses rendered bodies: bullets assign categories, changelog lines supply title/author", () => {
    const sections = parseGeneratedNotes([
      "## New Features",
      "",
      "- Providers: Add A; Add B (#1, #2)",
      "",
      "## Changelog",
      "",
      "- #1 feat(providers): add A @a",
      "- #2 feat(providers): add B @b",
    ].join("\n"));

    expect(sections).toEqual([
      {
        title: "New Features",
        prs: [
          { number: 1, title: "feat(providers): add A", author: "a" },
          { number: 2, title: "feat(providers): add B", author: "b" },
        ],
      },
    ]);
  });

  test("carries already-rendered preview bodies losslessly into stable notes", () => {
    const preview = renderReleaseNotes({
      npmMetadata: "Published to npm as `@bitkyc08/opencodex@2.10.0-preview.1` with dist-tag `preview`.",
      carriedPreviewNotes: carried,
      deltaPrNotes: delta,
      compareFrom: "v2.9.1",
      compareTo: "v2.10.0-preview.1",
      repository: "lidge-jun/opencodex",
    });
    const stable = renderReleaseNotes({
      npmMetadata: "Published to npm as `@bitkyc08/opencodex@2.10.0` with dist-tag `latest`.",
      carriedPreviewNotes: preview,
      compareFrom: "v2.9.1",
      compareTo: "v2.10.0",
      repository: "lidge-jun/opencodex",
    });

    expect(stable).toContain("- Add Baseten Model APIs preset (#653)");
    expect(stable).toContain("- #653 feat(providers): add Baseten Model APIs preset @olddonkey");
    expect(stable).toContain("- #744 fix(providers): keep Antigravity catalog static @luvs01");
    expect(stable).toContain("- #853 feat(server): advertise reasoning-effort ladders on the raw /v1/models list @n3wr1ch");
    expect(stable).toContain("- #862 docs(codex): clarify pool routing and account continuity @luvs01");
    expect(stable).toContain("Full Changelog: https://github.com/lidge-jun/opencodex/compare/v2.9.1...v2.10.0");

    // The preview's own metadata and compare link must not survive the carry.
    expect(stable).not.toContain("2.10.0-preview.1");
    expect(stable).not.toContain("dist-tag `preview`");
    expect(stable.match(/Full Changelog:/g)).toHaveLength(1);

    // Every PR appears exactly once in the changelog.
    for (const pr of [653, 744, 853, 862]) {
      expect(stable.match(new RegExp(`^- #${pr} `, "gm"))).toHaveLength(1);
    }
  });
});

describe("polish validation", () => {
  const head = [
    "Published to npm as `@bitkyc08/opencodex@2.10.0` with dist-tag `latest`.",
    "",
    "## New Features",
    "",
    "- Add Baseten Model APIs preset (#653)",
    "- Advertise reasoning-effort ladders on the raw /v1/models list (#853)",
    "",
    "## Bug Fixes",
    "",
    "- Keep Antigravity catalog static (#744)",
  ].join("\n");

  test("extractPrNumbers deduplicates and sorts", () => {
    expect(extractPrNumbers("(#853, #744, #653, #653)")).toEqual([653, 744, 853]);
  });

  test("extractChangelogPrNumbers reads only leading entry identifiers", () => {
    const changelog = [
      "## Changelog",
      "",
      "- #577 feat(images): Grok image bridge (maintainer takeover of #424) @tizerluo",
      "- #653 feat(providers): add Baseten Model APIs preset @olddonkey",
    ].join("\n");
    expect(extractChangelogPrNumbers(changelog)).toEqual([577, 653]);
  });

  test("splitPolishInput peels metadata, splits at the first Changelog heading, and normalizes CRLF", () => {
    const body = [
      "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      "",
      "## Bug Fixes",
      "",
      "- Keep Antigravity catalog static (#744)",
      "",
      "## Changelog",
      "",
      "- #744 fix(providers): keep Antigravity catalog static @luvs01",
      "",
    ].join("\r\n");

    expect(splitPolishInput(body)).toEqual({
      metadata: "Published to npm as `@pkg@1.0.0` with dist-tag `latest`.",
      head: ["## Bug Fixes", "", "- Keep Antigravity catalog static (#744)"].join("\n"),
      changelog: ["## Changelog", "", "- #744 fix(providers): keep Antigravity catalog static @luvs01"].join("\n"),
    });
  });

  test("isPolishBaseUrlAllowed accepts https and loopback http, rejects plaintext remote hosts", () => {
    expect(isPolishBaseUrlAllowed("https://api.openai.com/v1")).toBe(true);
    expect(isPolishBaseUrlAllowed("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isPolishBaseUrlAllowed("http://localhost:8080/v1")).toBe(true);
    expect(isPolishBaseUrlAllowed("http://[::1]:8080/v1")).toBe(true);
    expect(isPolishBaseUrlAllowed("http://my.localhost:8080/v1")).toBe(true);
    expect(isPolishBaseUrlAllowed("http://example.com/v1")).toBe(false);
    expect(isPolishBaseUrlAllowed("not a url")).toBe(false);
  });

  test("parseSectionHeadings excludes the machine-rendered Changelog", () => {
    expect(parseSectionHeadings("## Changelog\n\n## New Features\n\n## Bug Fixes")).toEqual([
      "New Features",
      "Bug Fixes",
    ]);
  });

  test("accepts rewritten sections with the same PR set and headings", () => {
    expect(validatePolishedSections(head, [653, 744, 853], ["New Features", "Bug Fixes"])).toEqual([]);
  });

  test("rejects missing PR references", () => {
    const out = head.replace("(#653)", "(#999)");
    expect(validatePolishedSections(out, [653, 744, 853], ["New Features", "Bug Fixes"])).toContain(
      "missing PR references: #653",
    );
  });

  test("rejects invented PR references", () => {
    const out = head.replace("(#653)", "(#653, #424242)");
    expect(validatePolishedSections(out, [653, 744, 853], ["New Features", "Bug Fixes"])).toContain(
      "unexpected PR references: #424242",
    );
  });

  test("accepts a rewrite that drops a foreign PR reference carried inside a title", () => {
    const sections = [
      "## New Features",
      "",
      "- Grok image bridge (maintainer takeover of #424) (#577)",
    ].join("\n");
    const rewritten = sections.replace("(maintainer takeover of #424) ", "");

    expect(validatePolishedSections(rewritten, [577], ["New Features"], [424])).toEqual([]);
  });

  test("rejects repeated PR references", () => {
    const out = head.replace("(#653)", "(#653, #653)");
    expect(validatePolishedSections(out, [653, 744, 853], ["New Features", "Bug Fixes"])).toContain(
      "repeated PR references: #653",
    );
  });

  test("rejects removed or invented headings", () => {
    const out = head.replace("## Bug Fixes", "## Internal");
    const errors = validatePolishedSections(out, [653, 744, 853], ["New Features", "Bug Fixes"]);
    expect(errors).toContain("missing headings: Bug Fixes");
    expect(errors).toContain("unexpected headings: Internal");
  });
});

describe("commit-based changelog fallback", () => {
  const log = [
    "aaaaaaaaaaaa1\u0000feat(gui): add a quota badge\u0000alice",
    "bbbbbbbbbbbb2\u0000fix(codex): stop a launcher crash (#1625)\u0000bob",
    "cccccccccccc3\u0000docs(devlog): record the release train\u0000carol",
    "dddddddddddd4\u0000chore(ci): prune stale workflows\u0000dave",
    "eeeeeeeeeeee5\u0000just a bare subject\u0000eve",
    "ffffffffffff6\u0000Merge dev into main: v9.9.9 release\u0000mallory",
    "gggggggggggg7\u0000release: v9.9.9\u0000trent",
  ].join("\u0000");

  test("parseCommitLog reads the NUL-separated git log format", () => {
    const commits = parseCommitLog(log);
    expect(commits).toHaveLength(7);
    expect(commits[0]).toEqual({ sha: "aaaaaaaaaaaa1", subject: "feat(gui): add a quota badge", author: "alice" });
  });

  test("parseCommitLog ignores blank and malformed lines", () => {
    expect(parseCommitLog("")).toEqual([]);
    expect(parseCommitLog("\n\n")).toEqual([]);
    // A hash with no subject carries no changelog value.
    expect(parseCommitLog("abc123")).toEqual([]);
  });

  test("conventional prefixes map onto the release.yml categories", () => {
    const out = renderCommitFallbackNotes(parseCommitLog(log));
    expect(out).toContain("## New Features");
    expect(out).toContain("- gui: add a quota badge (aaaaaaaaa, alice)");
    expect(out).toContain("## Bug Fixes");
    expect(out).toContain("- codex: stop a launcher crash (#1625) (bbbbbbbbb, bob)");
    expect(out).toContain("## Documentation");
    expect(out).toContain("## Chores");
    expect(out).toContain("## Other Changes");
    expect(out).toContain("- just a bare subject (eeeeeeeee, eve)");
  });

  test("categories render in the canonical order", () => {
    const out = renderCommitFallbackNotes(parseCommitLog(log));
    const order = ["## New Features", "## Bug Fixes", "## Documentation", "## Chores", "## Other Changes"]
      .map(heading => out.indexOf(heading));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every(index => index >= 0)).toBe(true);
  });

  test("merge commits and release bumps are excluded", () => {
    const out = renderCommitFallbackNotes(parseCommitLog(log));
    expect(out).not.toContain("Merge dev into main");
    expect(out).not.toContain("release: v9.9.9");
    expect(isReleasePlumbingCommit("Merge pull request #1 from x/y")).toBe(true);
    expect(isReleasePlumbingCommit("release: v2.20.0")).toBe(true);
    expect(isReleasePlumbingCommit("fix(codex): a real fix")).toBe(false);
  });

  test("a range with only plumbing commits renders nothing, so the caller keeps minimal notes", () => {
    const plumbingOnly = [
      "ffffffffffff6\u0000Merge dev into main: v9.9.9 release\u0000mallory",
      "gggggggggggg7\u0000release: v9.9.9\u0000trent",
    ].join("\u0000");
    const out = renderCommitFallbackNotes(parseCommitLog(plumbingOnly));
    expect(out).toBe("");
    expect(hasMeaningfulCarriedNotes(out)).toBe(false);
  });

  test("no commits at all renders nothing", () => {
    expect(renderCommitFallbackNotes([])).toBe("");
  });

  test("real PR sections win; the commit fallback is not appended alongside them", () => {
    const rendered = renderReleaseNotes({
      npmMetadata: "npm line.",
      deltaPrNotes: "## Bug Fixes\n\n* fix a thing by @dev in https://github.com/o/n/pull/42\n",
      commitFallbackNotes: renderCommitFallbackNotes(parseCommitLog(log)),
      compareFrom: "v9.9.8",
      compareTo: "v9.9.9",
      repository: "owner/name",
    });
    expect(rendered).toContain("#42");
    expect(rendered).not.toContain("@alice");
    expect(rendered).not.toContain("aaaaaaaaa");
  });

  test("the fallback output is meaningful, which is the workflow's switch condition", () => {
    // The workflow calls has-meaningful on the generate-notes body; when that is
    // empty it renders the commit fallback and checks the same predicate again.
    const emptyGenerateNotes = "<!-- Release notes generated using configuration in .github/release.yml at v9.9.9 -->\n\n\n";
    expect(hasMeaningfulCarriedNotes(emptyGenerateNotes)).toBe(false);
    expect(hasMeaningfulCarriedNotes(renderCommitFallbackNotes(parseCommitLog(log)))).toBe(true);
  });

  test("fallback sections flow through the real renderer into a non-empty body", () => {
    // The whole point: an empty generate-notes delta must still produce a body
    // with categorized content rather than the npm line plus a compare link.
    const rendered = renderReleaseNotes({
      npmMetadata: "Published to npm as \`pkg@9.9.9\` with dist-tag \`latest\`.",
      commitFallbackNotes: renderCommitFallbackNotes(parseCommitLog(log)),
      compareFrom: "v9.9.8",
      compareTo: "v9.9.9",
      repository: "owner/name",
    });
    expect(rendered).toContain("## New Features");
    expect(rendered).toContain("## Bug Fixes");
    expect(rendered.length).toBeGreaterThan(400);
  });
});
