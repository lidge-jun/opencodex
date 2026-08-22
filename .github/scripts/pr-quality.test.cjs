"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ANCESTRY_BEHIND_THRESHOLD,
  REVIEW_READINESS_ITEMS,
  isWrongAncestry,
  authorHasPushPermission,
  assessPrDescription,
  hasGuiCue,
  guiPathsChanged,
  isChangedFileListTruncated,
  hasGuiOverride,
  hasScreenshotEvidence,
  buildReviewReadinessSection,
  extractReviewReadiness,
  appendReviewReadinessSection,
  stripReviewReadinessSection,
  uncheckReviewReadinessBoxes,
  REVIEW_READINESS_CLAIM_INDEX,
  resetReviewReadinessSection,
  collectPrQualityFailures,
} = require("./pr-quality.cjs");

describe("isWrongAncestry", () => {
  it("flags #644-shaped compares (0 behind main, far behind base, few ahead of main)", () => {
    assert.equal(
      isWrongAncestry({ behindMain: 0, behindBase: 44, aheadMain: 1 }),
      true,
    );
  });

  it("uses threshold 20 by default", () => {
    assert.equal(ANCESTRY_BEHIND_THRESHOLD, 20);
    assert.equal(isWrongAncestry({ behindMain: 0, behindBase: 20, aheadMain: 1 }), true);
    assert.equal(isWrongAncestry({ behindMain: 0, behindBase: 19, aheadMain: 1 }), false);
  });

  it("passes when head is behind main (not sitting on main tip)", () => {
    assert.equal(isWrongAncestry({ behindMain: 1, behindBase: 44, aheadMain: 1 }), false);
  });

  it("passes stale dev-based branches that are many commits ahead of main", () => {
    assert.equal(
      isWrongAncestry({ behindMain: 0, behindBase: 44, aheadMain: 50 }),
      false,
    );
  });
});

describe("authorHasPushPermission", () => {
  it("accepts write/maintain/admin only", () => {
    assert.equal(authorHasPushPermission("admin"), true);
    assert.equal(authorHasPushPermission("maintain"), true);
    assert.equal(authorHasPushPermission("write"), true);
    assert.equal(authorHasPushPermission("triage"), false);
    assert.equal(authorHasPushPermission("read"), false);
    assert.equal(authorHasPushPermission(null), false);
  });
});

describe("assessPrDescription", () => {
  it("rejects empty and comment-only bodies", () => {
    assert.equal(assessPrDescription("").ok, false);
    assert.equal(assessPrDescription("   ").ok, false);
    assert.equal(
      assessPrDescription("<!-- release notes by coderabbit.ai -->\n\n<!-- end -->").reason,
      "empty",
    );
    assert.equal(
      assessPrDescription("<!--\n![proof](https://example.invalid/screenshot.png)").reason,
      "empty",
    );
  });

  it("rejects placeholder-only bodies", () => {
    assert.equal(assessPrDescription("N/A").reason, "placeholder");
    assert.equal(assessPrDescription("TODO").reason, "placeholder");
  });

  it("rejects literal escaped newlines like #644", () => {
    const body =
      "## What changed\\n- make the Windows tray launcher resolve Codex home\\n\\n## Validation\\n- git diff --check";
    assert.equal(assessPrDescription(body).reason, "escaped_newlines");
  });

  it("rejects thin real-newline bodies", () => {
    assert.equal(assessPrDescription("fix stuff").reason, "thin");
  });

  it("rejects an untouched GitHub PR template as empty/thin", () => {
    const body = [
      "## Summary",
      "",
      "- Explain the user-visible or maintainer-facing change.",
      "",
      "## Verification",
      "",
      "- List the commands or checks you ran.",
      "- If this PR changes the GUI, include a screenshot of the UI change in the description.",
      "",
      "## Checklist",
      "",
      "- [ ] Scope stays focused and avoids unrelated cleanup.",
      "- [ ] Docs or release notes were updated when needed.",
      "- [ ] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.",
    ].join("\n");
    const result = assessPrDescription(body);
    assert.equal(result.ok, false);
    assert.ok(result.reason === "empty" || result.reason === "thin");
  });

  it("accepts two rich markdown sections", () => {
    const body = [
      "## Summary",
      "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
      "",
      "## Test plan",
      "- Launch the tray app after setting CODEX_HOME",
      "- Confirm the listener and launcher use the same workspace root",
    ].join("\n");
    assert.equal(assessPrDescription(body).ok, true);
  });

  it("accepts unstructured bodies that are long enough with multiple blocks", () => {
    const p1 =
      "Updates the Windows tray launcher to resolve the active Codex home through the shared helper so listener and launcher stay aligned.";
    const p2 =
      "Validated with git diff --check on the changed tray module; typecheck was not available in that session so CI must cover it.";
    assert.equal(assessPrDescription(`${p1}\n\n${p2}`).ok, true);
  });
});

describe("hasGuiCue", () => {
  it("matches gui as a whole word, case-insensitively, in title or body", () => {
    assert.equal(hasGuiCue("Fix GUI spacing", ""), true);
    assert.equal(hasGuiCue("fix gui spacing", ""), true);
    assert.equal(hasGuiCue("", "This changes gui/src/App.tsx"), true);
    assert.equal(
      hasGuiCue("", "## Summary\nGUI button is misaligned in the dashboard"),
      true,
    );
  });

  it("does not match negated gui phrases", () => {
    assert.equal(hasGuiCue("", "no gui changes in this PR"), false);
    assert.equal(hasGuiCue("", "Without gui changes"), false);
    assert.equal(hasGuiCue("No GUI changes", ""), false);
    assert.equal(
      hasGuiCue("", "This does not change the API. Please add a gui screenshot."),
      true,
    );
  });

  it("does not match gui inside other words", () => {
    assert.equal(hasGuiCue("Add contributor guidance", ""), false);
    assert.equal(hasGuiCue("", "Fix the guild invitation bug"), false);
    assert.equal(hasGuiCue("", "Remove guillotine dead code"), false);
  });

  it("does not match missing or non-string inputs", () => {
    assert.equal(hasGuiCue(undefined, undefined), false);
    assert.equal(hasGuiCue(null, null), false);
  });
});

describe("guiPathsChanged", () => {
  it("matches gui/ paths with a slash guard", () => {
    assert.equal(guiPathsChanged(["gui/src/App.tsx"]), true);
    assert.equal(guiPathsChanged(["gui"]), true);
    assert.equal(guiPathsChanged(["scripts/foo.ts", "gui/package.json"]), true);
    assert.equal(guiPathsChanged(["scripts/foo.ts"]), false);
    assert.equal(guiPathsChanged(["guitools/x.ts"]), false);
    assert.equal(guiPathsChanged([]), false);
  });
});

describe("isChangedFileListTruncated", () => {
  it("treats head drift, invalid counts, and oversized lists as truncated", () => {
    assert.equal(isChangedFileListTruncated(10, 10, false), true);
    assert.equal(isChangedFileListTruncated(undefined, 10, true), true);
    assert.equal(isChangedFileListTruncated(10.5, 10, true), true);
    assert.equal(isChangedFileListTruncated(11, 10, true), true);
    assert.equal(isChangedFileListTruncated(10, 10, true), false);
    assert.equal(isChangedFileListTruncated(5, 10, true), false);
  });
});

describe("hasGuiOverride", () => {
  const owner = { author_association: "OWNER", body: "Not touching gui here." };
  const collaborator = { author_association: "COLLABORATOR", body: "no gui changes needed" };
  const member = { author_association: "MEMBER", body: "doesn't change the gui" };
  const author = { author_association: "CONTRIBUTOR", body: "Not touching gui here." };
  const outsider = { author_association: "NONE", body: "Not touching gui here." };

  it("matches a maintainer comment with a negation phrase", () => {
    assert.equal(hasGuiOverride({ comments: [owner] }), true);
    assert.equal(hasGuiOverride({ comments: [collaborator] }), true);
    assert.equal(hasGuiOverride({ comments: [member] }), true);
    assert.equal(
      hasGuiOverride({ comments: [{ author_association: "OWNER", body: "I did not change gui" }] }),
      true,
    );
    assert.equal(
      hasGuiOverride({ comments: [{ author_association: "OWNER", body: "Without gui changes" }] }),
      true,
    );
  });

  it("does not let the PR author or a non-collaborator waive the gate", () => {
    assert.equal(hasGuiOverride({ comments: [author] }), false);
    assert.equal(hasGuiOverride({ comments: [outsider] }), false);
  });

  it("does not match a comment that names gui without negating it", () => {
    assert.equal(
      hasGuiOverride({ comments: [{ author_association: "OWNER", body: "This touches gui but only config" }] }),
      false,
    );
    assert.equal(
      hasGuiOverride({ comments: [{ author_association: "OWNER", body: "gui is involved here" }] }),
      false,
    );
  });

  it("does not match a negation that belongs to another sentence or line", () => {
    assert.equal(
      hasGuiOverride({ comments: [{ author_association: "OWNER", body: "This does not change the API. Please add a gui screenshot." }] }),
      false,
    );
    assert.equal(
      hasGuiOverride({ comments: [{ author_association: "OWNER", body: "- no rebase needed\n- gui tweak included" }] }),
      false,
    );
  });

  it("is clean for no comments or a comment without a body", () => {
    assert.equal(hasGuiOverride({ comments: [] }), false);
    assert.equal(hasGuiOverride({ comments: [{ author_association: "OWNER" }] }), false);
    assert.equal(hasGuiOverride({}), false);
  });
});

describe("hasScreenshotEvidence", () => {
  it("accepts embedded markdown images", () => {
    assert.equal(
      hasScreenshotEvidence("![after](https://example.com/after.png)"),
      true,
    );
    assert.equal(
      hasScreenshotEvidence(
        "Before:\n\n![Screenshot 2026-08-03 at 14.22](https://user-images.githubusercontent.com/1/2.png)",
      ),
      true,
    );
  });

  it("accepts HTML img tags", () => {
    assert.equal(
      hasScreenshotEvidence('<img src="https://example.com/ui.png" width="600">'),
      true,
    );
  });

  it("accepts reference-style images with a matching definition", () => {
    assert.equal(
      hasScreenshotEvidence(
        "After:\n\n![after][shot]\n\n[shot]: https://example.com/after.png",
      ),
      true,
    );
    assert.equal(
      hasScreenshotEvidence(
        "![after][]\n\n[after]: https://example.com/after.png",
      ),
      true,
    );
  });

  it("rejects image syntax inside fenced code and HTML comments", () => {
    assert.equal(
      hasScreenshotEvidence('```\n![after](https://example.com/after.png)\n```'),
      false,
    );
    assert.equal(
      hasScreenshotEvidence('```\n<img src="https://example.com/ui.png">\n```'),
      false,
    );
    assert.equal(
      hasScreenshotEvidence("<!-- ![after](https://example.com/after.png) -->"),
      false,
    );
    assert.equal(
      hasScreenshotEvidence('<!-- <img src="https://example.com/ui.png"> -->'),
      false,
    );
    assert.equal(
      hasScreenshotEvidence("<!--\n![after](https://example.com/after.png)"),
      false,
    );
  });

  it("rejects img tags without a renderable src and references without a definition", () => {
    assert.equal(hasScreenshotEvidence("<img>"), false);
    assert.equal(hasScreenshotEvidence('<img src="">'), false);
    assert.equal(
      hasScreenshotEvidence("![after][shot]"),
      false,
    );
  });

  it("rejects plain links, bare image URLs, and text-only bodies", () => {
    assert.equal(
      hasScreenshotEvidence("[Screenshot](https://example.com/ui.png)"),
      false,
    );
    assert.equal(hasScreenshotEvidence("https://example.com/ui.png"), false);
    assert.equal(hasScreenshotEvidence("No screenshot here."), false);
    assert.equal(hasScreenshotEvidence(undefined), false);
  });
});

describe("review readiness checklist", () => {
  const SECTION = buildReviewReadinessSection();

  it("builds exactly the four required boxes inside the markers", () => {
    assert.ok(SECTION.includes("<!-- pr-quality-readiness-checklist:start -->"));
    assert.ok(SECTION.includes("<!-- pr-quality-readiness-checklist:end -->"));
    assert.equal((SECTION.match(/\[ \]/g) || []).length, 4);
    assert.equal((SECTION.match(/\[x\]/g) || []).length, 0);
    assert.equal(REVIEW_READINESS_ITEMS.length, 4);
  });

  it("keeps the closing 'ready for review' box separated by a blank line", () => {
    const lines = SECTION.split("\n");
    const readyIndex = lines.findIndex((line) =>
      line.includes("My PR is ready for review."),
    );
    assert.ok(readyIndex > 0);
    assert.equal(lines[readyIndex - 1], "");
  });

  it("reports absent when the body has no markers", () => {
    assert.deepEqual(extractReviewReadiness("## Summary\n\nplain body"), {
      present: false,
      complete: false,
      checked: 0,
      total: 0,
      items: [],
    });
    assert.deepEqual(extractReviewReadiness(null), {
      present: false,
      complete: false,
      checked: 0,
      total: 0,
      items: [],
    });
  });

  it("counts checked boxes and requires all four for completion", () => {
    const body = [
      "## Summary",
      "Change.",
      SECTION.replaceAll("- [ ] ", "- [x] "),
    ].join("\n\n");
    assert.deepEqual(extractReviewReadiness(body), {
      present: true,
      complete: true,
      checked: 4,
      total: 4,
      items: [
        { checked: true },
        { checked: true },
        { checked: true },
        { checked: true },
      ],
    });

    const partial = body.replace("- [x] My PR is ready for review.", "- [ ] My PR is ready for review.");
    assert.deepEqual(extractReviewReadiness(partial), {
      present: true,
      complete: false,
      checked: 3,
      total: 4,
      items: [
        { checked: true },
        { checked: true },
        { checked: true },
        { checked: false },
      ],
    });
  });

  it("reports per-item state so the mirror marks the right boxes", () => {
    const body = SECTION.replace(
      "- [ ] My PR is ready for review.",
      "- [x] My PR is ready for review.",
    );
    const result = extractReviewReadiness(body);
    assert.equal(result.checked, 1);
    assert.deepEqual(result.items, [
      { checked: false },
      { checked: false },
      { checked: false },
      { checked: true },
    ]);
  });

  it("treats a reworded but complete section as complete", () => {
    const reworded = SECTION
      .replace("All CI tests are green on my local testing.", "Local suite green.")
      .replaceAll("- [ ] ", "- [x] ");
    const result = extractReviewReadiness(reworded);
    assert.equal(result.present, true);
    assert.equal(result.complete, true);
    assert.equal(result.checked, 4);
  });

  it("stays incomplete for fewer or extra boxes inside the markers", () => {
    const fewer = SECTION.replace("- [ ] My PR is ready for review.", "");
    assert.equal(extractReviewReadiness(fewer).complete, false);
    assert.equal(extractReviewReadiness(fewer).total, 3);
    assert.equal(extractReviewReadiness(fewer).items.length, 3);

    const extra = SECTION.replace(
      "<!-- pr-quality-readiness-checklist:end -->",
      "- [x] An extra box.\n<!-- pr-quality-readiness-checklist:end -->",
    );
    const result = extractReviewReadiness(extra);
    assert.equal(result.complete, false);
    assert.equal(result.total, 5);
    assert.equal(result.items.length, 5);
  });

  it("treats inverted or partial markers as present-but-incomplete, never appends again", () => {
    const inverted = [
      "## Summary",
      "Body.",
      "<!-- pr-quality-readiness-checklist:end -->",
      "residue",
      "<!-- pr-quality-readiness-checklist:start -->",
      "- [x] orphan box",
    ].join("\n");
    const extracted = extractReviewReadiness(inverted);
    assert.equal(extracted.present, true);
    assert.equal(extracted.complete, false);
    assert.equal(appendReviewReadinessSection(inverted), inverted);

    const orphanEnd = "body\n<!-- pr-quality-readiness-checklist:end -->";
    assert.equal(extractReviewReadiness(orphanEnd).present, true);
    assert.equal(extractReviewReadiness(orphanEnd).complete, false);
    assert.equal(appendReviewReadinessSection(orphanEnd), orphanEnd);

    const duplicate = SECTION + SECTION;
    const duplicated = extractReviewReadiness(duplicate);
    assert.equal(duplicated.present, true);
    // A second marker pair is malformed, never complete — even when the first
    // section's boxes would parse as checked (CodeRabbit round 3).
    assert.equal(duplicated.complete, false);
    assert.equal(duplicated.total, 0);
    assert.equal(appendReviewReadinessSection(duplicate), duplicate);
    assert.equal(stripReviewReadinessSection(duplicate), duplicate);
  });

  it("appends once and is idempotent", () => {
    const first = appendReviewReadinessSection("## Summary\n\nBody.");
    assert.equal(extractReviewReadiness(first).present, true);
    assert.equal(extractReviewReadiness(first).total, 4);
    const second = appendReviewReadinessSection(first);
    assert.equal(second, first);
    assert.equal((second.match(/pr-quality-readiness-checklist:start/g) || []).length, 1);
  });

  it("appends cleanly to an empty body", () => {
    const body = appendReviewReadinessSection("");
    assert.equal(extractReviewReadiness(body).present, true);
    assert.ok(body.startsWith("<!-- pr-quality-readiness-checklist:start -->"));
  });

  it("strips the marker-bounded section and leaves the rest intact", () => {
    const body = [
      "## Summary",
      "Author content.",
      "",
      SECTION,
      "",
      "## Test plan",
      "- Ran the suite.",
    ].join("\n");
    const stripped = stripReviewReadinessSection(body);
    assert.equal(extractReviewReadiness(stripped).present, false);
    assert.ok(stripped.includes("Author content."));
    assert.ok(stripped.includes("## Test plan"));
    assert.ok(!stripped.includes("Review readiness checklist"));
  });

  it("strips a section-only body to empty and leaves markerless bodies alone", () => {
    assert.equal(stripReviewReadinessSection(SECTION), "");
    assert.equal(stripReviewReadinessSection("plain body"), "plain body");
    assert.equal(stripReviewReadinessSection(null), null);
  });

  it("resets every checked box to unticked and keeps the surrounding body", () => {
    const body = [
      "## Summary",
      "Author content.",
      "",
      SECTION.replaceAll("- [ ] ", "- [x] "),
      "",
      "## Test plan",
      "- Ran the suite.",
    ].join("\n");
    const reset = resetReviewReadinessSection(body);
    const extracted = extractReviewReadiness(reset);
    assert.equal(extracted.present, true);
    assert.equal(extracted.complete, false);
    assert.equal(extracted.checked, 0);
    assert.equal(extracted.total, 4);
    assert.equal((reset.match(/\[x\]/g) || []).length, 0);
    assert.ok(reset.includes("Author content."));
    assert.ok(reset.includes("## Test plan"));
  });

  it("resets a partially ticked section as well", () => {
    const partial = SECTION.replace(
      "- [ ] My PR is ready for review.",
      "- [x] My PR is ready for review.",
    );
    const reset = resetReviewReadinessSection(partial);
    const extracted = extractReviewReadiness(reset);
    assert.equal(extracted.checked, 0);
    assert.equal(extracted.complete, false);
  });

  it("preserves the surrounding author formatting exactly", () => {
    const body = [
      "## Summary",
      "Author content.",
      "",
      "",
      SECTION.replaceAll("- [ ] ", "- [x] "),
      "",
      "",
      "Trailing note with blank lines above.",
      "",
    ].join("\n");
    const reset = resetReviewReadinessSection(body);
    // Only the bounded section changed; deliberate blank lines and trailing
    // markdown survive byte for byte (no `\n{3,}` collapse, no trimEnd).
    assert.equal(reset, body.replaceAll("- [x] ", "- [ ] "));
  });

  it("is idempotent on an already-unticked section", () => {
    const once = resetReviewReadinessSection(
      SECTION.replaceAll("- [ ] ", "- [x] "),
    );
    assert.equal(resetReviewReadinessSection(once), once);
    assert.equal(extractReviewReadiness(once).checked, 0);
  });

  it("leaves markerless and malformed bodies alone", () => {
    assert.equal(resetReviewReadinessSection("plain body"), "plain body");
    assert.equal(resetReviewReadinessSection(null), null);
    const duplicate = SECTION + SECTION;
    assert.equal(resetReviewReadinessSection(duplicate), duplicate);
    const inverted =
      "<!-- pr-quality-readiness-checklist:end -->\n" +
      "<!-- pr-quality-readiness-checklist:start -->\n" +
      "- [x] orphan box";
    assert.equal(resetReviewReadinessSection(inverted), inverted);
  });
});

describe("uncheckReviewReadinessBoxes", () => {
  const checkedBody = [
    "## Summary",
    "",
    "Substantive summary text for the author's own description.",
    "",
    "## Test plan",
    "",
    "- [x] Run the suite",
    "",
    "<!-- pr-quality-readiness-checklist:start -->",
    "## Review readiness checklist",
    "",
    "- [x] All CI tests are green on my local testing.",
    "- [x] I pushed my PR to the latest dev commit.",
    "- [x] I resolved all correct Codex and CodeRabbit findings.",
    "- [x] My PR is ready for review.",
    "<!-- pr-quality-readiness-checklist:end -->",
  ].join("\n");

  it("unchecks only the requested boxes", () => {
    const body = uncheckReviewReadinessBoxes(checkedBody, [
      REVIEW_READINESS_CLAIM_INDEX.latest_dev,
    ]);
    assert.ok(body.includes("- [x] All CI tests are green on my local testing."));
    assert.ok(body.includes("- [ ] I pushed my PR to the latest dev commit."));
    assert.ok(body.includes("- [x] My PR is ready for review."));
  });

  it("can uncheck several boxes at once", () => {
    const body = uncheckReviewReadinessBoxes(checkedBody, [
      0,
      REVIEW_READINESS_CLAIM_INDEX.latest_dev,
    ]);
    assert.ok(body.includes("- [ ] All CI tests are green on my local testing."));
    assert.ok(body.includes("- [ ] I pushed my PR to the latest dev commit."));
    assert.ok(body.includes("- [x] I resolved all correct Codex and CodeRabbit findings."));
    assert.ok(body.includes("- [x] My PR is ready for review."));
  });

  it("preserves the surrounding author content exactly", () => {
    const body = uncheckReviewReadinessBoxes(checkedBody, [0]);
    assert.ok(body.startsWith("## Summary\n"));
    assert.ok(body.includes("- [x] Run the suite\n"));
    assert.ok(body.endsWith("<!-- pr-quality-readiness-checklist:end -->"));
    // The three untouched checklist boxes keep their ticks; only the CI box
    // flipped. The author's own box in the Test plan is untouched too.
    const checklist = body.split("<!-- pr-quality-readiness-checklist:start -->")[1];
    assert.equal((checklist.match(/- \[x\]/g) || []).length, 3);
  });

  it("is idempotent on an already-unchecked box", () => {
    const once = uncheckReviewReadinessBoxes(checkedBody, [0]);
    const twice = uncheckReviewReadinessBoxes(once, [0]);
    assert.equal(twice, once);
  });

  it("leaves markerless and malformed bodies alone", () => {
    assert.equal(uncheckReviewReadinessBoxes("plain body", [0]), "plain body");
    const malformed = checkedBody + "<!-- pr-quality-readiness-checklist:start -->\n<!-- pr-quality-readiness-checklist:end -->";
    assert.equal(uncheckReviewReadinessBoxes(malformed, [0]), malformed);
  });
});

describe("assessPrDescription with the readiness section", () => {
  const SUBSTANTIAL = [
    "## Summary",
    "",
    "This change adds enough substantive detail for reviewers to understand the motivation and approach taken.",
    "",
    "## Test plan",
    "",
    "- Ran bun test tests/ci-workflows.test.ts",
  ].join("\n");

  it("never counts the injected checklist as description substance", () => {
    // The bot's own injected section must not clear the description gate for
    // an author who wrote nothing (Codex review round 2).
    assert.equal(assessPrDescription(buildReviewReadinessSection()).ok, false);
    assert.equal(
      assessPrDescription("fix stuff\n\n" + buildReviewReadinessSection()).reason,
      "thin",
    );
    assert.equal(
      assessPrDescription(SUBSTANTIAL + "\n\n" + buildReviewReadinessSection()).ok,
      true,
    );
  });
});

describe("collectPrQualityFailures", () => {
  const allowed = ["dev"];

  const richBody = [
    "## Summary",
    "This change fixes the provider list spacing in the dashboard.",
    "",
    "## Test plan",
    "- Ran bun test tests/ci-workflows.test.ts",
  ].join("\n");

  it("reports wrong_base without requiring ancestry inputs", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: "## Summary\n" + "x".repeat(50) + "\n\n## Test plan\n" + "y".repeat(50),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
    });
    assert.ok(failures.some((f) => f.code === "wrong_base"));
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("reports wrong_base and bad_description together for main + empty body", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: "",
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
    });
    assert.ok(failures.some((f) => f.code === "wrong_base"));
    assert.ok(failures.some((f) => f.code === "bad_description"));
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("reports wrong_ancestry for contributor on #644-shaped compare", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 0,
      behindBase: 44,
      aheadMain: 1,
      authorPermission: "read",
    });
    assert.deepEqual(
      failures.map((f) => f.code),
      ["wrong_ancestry"],
    );
  });

  it("skips ancestry for push permission but still flags bad description", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: "",
      behindMain: 0,
      behindBase: 44,
      aheadMain: 1,
      authorPermission: "write",
    });
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
    assert.ok(failures.some((f) => f.code === "bad_description"));
  });

  it("applies ancestry when permission lookup failed (fail closed)", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 0,
      behindBase: 44,
      aheadMain: 1,
      authorPermission: null,
      permissionLookupFailed: true,
    });
    assert.ok(failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("does not flag stale dev-based branches that are far ahead of main", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 0,
      behindBase: 44,
      aheadMain: 50,
      authorPermission: "read",
    });
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("skips ancestry when compare lookup failed (cannot evaluate)", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      aheadMain: 0,
      authorPermission: "read",
      ancestryLookupFailed: true,
    });
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("skips wrong_base when stackedBase is set", () => {
    const failures = collectPrQualityFailures({
      baseRef: "feature/parent",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 0,
      behindBase: 44,
      aheadMain: 1,
      authorPermission: "read",
      stackedBase: true,
    });
    assert.ok(!failures.some((f) => f.code === "wrong_base"));
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("still flags wrong_base for non-allow-list bases without stackedBase", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: "fix stuff",
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      stackedBase: false,
    });
    assert.ok(failures.some((f) => f.code === "wrong_base"));
  });

  it("flags gui/ file changes without a screenshot", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "Fix dashboard spacing",
      body: richBody,
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: ["gui/src/App.tsx"],
    });
    assert.ok(failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("does not flag a gui title when no gui/ files changed", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "GUI: fix provider list spacing",
      body: richBody,
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: ["scripts/foo.ts"],
    });
    assert.ok(!failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("flags truncated file lists even when gui/ is not in the partial list", () => {
    const truncatedPaths = Array.from({ length: 3000 }, (_, index) => `scripts/file-${index}.ts`);
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "Large refactor",
      body: richBody,
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: truncatedPaths,
      filesTruncated: true,
    });
    assert.ok(failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("flags truncated file lists when gui/ appears in the partial list", () => {
    const truncatedPaths = Array.from({ length: 2999 }, (_, index) => `scripts/file-${index}.ts`);
    truncatedPaths.push("gui/src/App.tsx");
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "Large refactor with gui tweak",
      body: richBody,
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: truncatedPaths,
      filesTruncated: true,
    });
    assert.ok(failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("does not flag no gui changes text without gui/ file changes", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "Fix proxy routing",
      body: [
        "## Summary",
        "No gui changes in this PR; proxy routing only.",
        "",
        "## Test plan",
        "- Ran bun test tests/ci-workflows.test.ts",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: ["scripts/foo.ts"],
    });
    assert.ok(!failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("flags a gui mention in the body without a screenshot when gui/ changed", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "Fix dashboard spacing",
      body: [
        "## Summary",
        "This change adjusts gui/ spacing tokens used by the dashboard.",
        "",
        "## Test plan",
        "- Ran bun test tests/ci-workflows.test.ts",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: ["gui/src/styles.css"],
    });
    assert.ok(failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("waives the screenshot gate for a maintainer override comment", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "GUI: fix provider list spacing",
      body: [
        "## Summary",
        "This change adjusts gui/ spacing tokens used by the dashboard.",
        "",
        "## Test plan",
        "- Ran bun test tests/ci-workflows.test.ts",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: ["gui/src/App.tsx"],
      guiOverrideComments: [
        { author_association: "OWNER", body: "no gui changes here" },
      ],
    });
    assert.ok(!failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("keeps the screenshot gate when only the PR author claims no gui change", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "GUI: fix provider list spacing",
      body: [
        "## Summary",
        "This change adjusts gui/ spacing tokens used by the dashboard.",
        "",
        "## Test plan",
        "- Ran bun test tests/ci-workflows.test.ts",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: ["gui/src/App.tsx"],
      guiOverrideComments: [
        { author_association: "CONTRIBUTOR", body: "no gui changes here" },
      ],
    });
    assert.ok(failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("accepts a gui title when a screenshot image is embedded", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "GUI: fix provider list spacing",
      body: [
        "## Summary",
        "This change fixes the provider list spacing in the dashboard.",
        "",
        "![after](https://example.com/after.png)",
        "",
        "## Test plan",
        "- Ran bun test tests/ci-workflows.test.ts",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: ["gui/src/App.tsx"],
    });
    assert.ok(!failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("accepts a gui title when the screenshot uses reference-style markdown", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "GUI: fix provider list spacing",
      body: [
        "## Summary",
        "This change fixes the provider list spacing in the dashboard.",
        "",
        "![after][shot]",
        "",
        "[shot]: https://example.com/after.png",
        "",
        "## Test plan",
        "- Ran bun test tests/ci-workflows.test.ts",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: ["gui/src/App.tsx"],
    });
    assert.ok(!failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("still flags gui/ changes when image syntax is only inside a code fence", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "GUI: fix provider list spacing",
      body: [
        "## Summary",
        "This change fixes the provider list spacing in the dashboard.",
        "",
        "```",
        "![after](https://example.com/after.png)",
        "```",
        "",
        "## Test plan",
        "- Ran bun test tests/ci-workflows.test.ts",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      changedFilePaths: ["gui/src/App.tsx"],
    });
    assert.ok(failures.some((f) => f.code === "missing_ui_screenshot"));
  });

  it("ignores the template's own gui/screenshot instruction", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      title: "Add a thing",
      body: [
        "## Summary",
        "This change touches the proxy only; no UI surface changed.",
        "",
        "## Verification",
        "- List the commands or checks you ran.",
        "- If this PR changes the GUI, include a screenshot of the UI change in the description.",
        "",
        "## Checklist",
        "- [ ] Scope stays focused and avoids unrelated cleanup.",
        "- [ ] Docs or release notes were updated when needed.",
        "- [ ] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
    });
    assert.ok(!failures.some((f) => f.code === "missing_ui_screenshot"));
  });
});

describe("comment stripping respects fenced code (regression)", () => {
  it("keeps a screenshot that follows a comment-like literal in a fence", () => {
    // GFM treats fence contents as literal text, so `<!--` inside a code sample
    // never opens an HTML comment. Stripping comments before fences let the
    // unclosed literal run to EOF and swallow the real screenshot below it,
    // rejecting a valid GUI PR.
    const body = [
      "Example of a raw HTML comment:",
      "",
      "```html",
      "<!-- literal unclosed-comment example",
      "```",
      "",
      "![after](https://example.invalid/after.png)",
    ].join("\n");

    assert.equal(hasScreenshotEvidence(body), true);
  });

  it("still ignores a screenshot inside a real HTML comment", () => {
    const body = ["<!--", "![hidden](https://example.invalid/hidden.png)", "-->"].join("\n");
    assert.equal(hasScreenshotEvidence(body), false);
  });
});
