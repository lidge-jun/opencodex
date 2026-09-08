# Phase release_notes: exact leading enforcement marker normalization

Source PR #3899, source SHA 4d6896cd0bd62434b4703a1956fe57a99cd4959a. MODIFY the three files below. Preserve/reuse the source PR's related numbered implementation record if carrying its whole commit; it is documentation for this same bug, not another feature. Security review covers title text handling only: no workflow, command dispatch, credentials, publishing or release execution change. SoT: structure/06_docs-and-release.md.

Activation/acceptance: prefixed generated and carried notes lose only the exact leading marker in summaries and full changelog; conventional scope grouping and attribution remain; unrelated bracketed/nonleading/near-match markers remain. Hosted CI must execute tests/ci-workflows/release-notes.test.ts (via the existing shard manifest) plus required gates. Explicit security review is recorded before maintainer sponsorship/integration. No local tests or typecheck are run. Rebase/carry applies only to our branch, uses original author and -x/Co-authored-by, and exact current-head checks. Issue #3895 closes only after verified dev landing. One independent revert restores only this bug's diff.

Exact source patch follows; refresh against latest dev at its P phase:

```diff
diff --git a/scripts/release-notes.ts b/scripts/release-notes.ts
index 16627f5f9..d0a58a043 100644
--- a/scripts/release-notes.ts
+++ b/scripts/release-notes.ts
@@ -546,8 +546,14 @@ export function parseGeneratedNotes(body: string): ReleaseNoteCategory[] {
 const CONVENTIONAL_COMMIT_PREFIX =
   /^(?:feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert|merge|release)(?:\(([^)]+)\))?:\s*(.+)$/i;

+function stripPrEnforcementPrefix(title: string): string {
+  const text = title.trim();
+  const prefix = "[WRONG BRANCH] ";
+  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : text;
+}
+
 export function cleanPrTitle(title: string, prNumber: number | null = null): { scope: string | null; text: string } {
-  let text = title.trim();
+  let text = stripPrEnforcementPrefix(title);
   let scope: string | null = null;
   const prefix = CONVENTIONAL_COMMIT_PREFIX.exec(text);
   if (prefix) {
@@ -689,7 +695,7 @@ export function renderReleaseNotes(input: {
       changelog.push(`Full Changelog: https://github.com/${repo}/compare/${from}...${to}`, "");
     }
     for (const pr of allPrs) {
-      changelog.push(`- #${pr.number} ${pr.title.trim()} @${pr.author}`);
+      changelog.push(`- #${pr.number} ${stripPrEnforcementPrefix(pr.title)} @${pr.author}`);
     }
     parts.push(changelog.join("\n"));
   }
diff --git a/structure/06_docs-and-release.md b/structure/06_docs-and-release.md
index 8c6149802..886c8fc04 100644
--- a/structure/06_docs-and-release.md
+++ b/structure/06_docs-and-release.md
@@ -227,6 +227,11 @@ so stable notes are the aggregate of their preview train. The raw commit dump is
 intentionally gone — non-PR commits stay reachable via the Full Changelog compare link when
 that link is available.

+Both summary bullets and full-changelog titles strip the exact leading `[WRONG BRANCH] `
+enforcement marker. Other bracketed text is preserved. Summary bullets still remove conventional
+commit prefixes and group by scope; full-changelog entries keep those conventional prefixes,
+PR numbers, and author attribution. This normalization does not change PR-target enforcement.
+
 The deterministic renderer produces the structure but not curated prose. Maintainers who want
 the OpenAI-style grouped summaries can run the optional local polish step against the rendered
 body (needs an OpenAI-compatible API key):
diff --git a/tests/ci-workflows/release-notes.test.ts b/tests/ci-workflows/release-notes.test.ts
index 11196108d..d27036008 100644
--- a/tests/ci-workflows/release-notes.test.ts
+++ b/tests/ci-workflows/release-notes.test.ts
@@ -455,6 +455,20 @@ describe("rewriteTakeoverCredits", () => {
 });

 describe("cleanPrTitle", () => {
+  test("removes the enforcement marker before extracting scope and sentence casing", () => {
+    expect(cleanPrTitle("  [WRONG BRANCH] chore(release): promote validated 2.45.0 to main (#3813)  ", 3813)).toEqual({
+      scope: "release",
+      text: "Promote validated 2.45.0 to main",
+    });
+  });
+
+  test.each([
+    ["[Preview] chore(release): keep this marker", "[Preview] chore(release): keep this marker"],
+    ["fix: document [WRONG BRANCH] markers", "Document [WRONG BRANCH] markers"],
+    ["[WRONG BRANCH]ish: keep this title", "[WRONG BRANCH]ish: keep this title"],
+  ])("preserves meaningful title text: %s", (title, text) => {
+    expect(cleanPrTitle(title).text).toBe(text);
+  });
   test("strips conventional prefix, keeps scope, and sentence-cases the title", () => {
     expect(cleanPrTitle("feat(providers): add Baseten Model APIs preset", 653)).toEqual({
       scope: "providers",
@@ -488,6 +502,55 @@ describe("cleanPrTitle", () => {
 });

 describe("renderReleaseNotes", () => {
+  test.each(["delta", "carried"])("removes the bot marker from summaries and full changelogs (%s)", source => {
+    const body = [
+      "## What's Changed",
+      "### Chores",
+      "* [WRONG BRANCH] chore(release): promote validated 2.45.0 to main by @lidge-jun in https://github.com/lidge-jun/opencodex/pull/3813",
+    ].join("\n");
+    const notes = renderReleaseNotes({
+      npmMetadata: "",
+      ...(source === "delta" ? { deltaPrNotes: body } : { carriedPreviewNotes: [
+        "## Chores", "",
+        "- [WRONG BRANCH] chore(release): promote validated 2.45.0 to main (#3813)", "",
+        "## Changelog", "",
+        "- #3813 [WRONG BRANCH] chore(release): promote validated 2.45.0 to main @lidge-jun",
+      ].join("\n") }),
+    });
+    expect(notes).toBe([
+      "## Chores", "",
+      "- Promote validated 2.45.0 to main (#3813)", "",
+      "## Changelog", "",
+      "- #3813 chore(release): promote validated 2.45.0 to main @lidge-jun", "",
+    ].join("\n"));
+  });
+
+  test("groups a bot-prefixed title with ordinary titles of the same scope", () => {
+    const notes = renderReleaseNotes({
+      npmMetadata: "",
+      deltaPrNotes: [
+        "## What's Changed", "### Chores",
+        "* [WRONG BRANCH] chore(release): promote verified version by @maintainer in https://github.com/lidge-jun/opencodex/pull/10",
+        "* chore(release): update notes by @contributor in https://github.com/lidge-jun/opencodex/pull/11",
+      ].join("\n"),
+    });
+    expect(notes).toContain("- Release: Promote verified version; Update notes (#10, #11)");
+    expect(notes).toContain("- #10 chore(release): promote verified version @maintainer");
+    expect(notes).toContain("- #11 chore(release): update notes @contributor");
+    expect(notes).not.toContain("[WRONG BRANCH]");
+  });
+
+  test.each([
+    "[Preview] chore(release): retain the preview marker",
+    "fix: document [WRONG BRANCH] markers (#99)",
+    "[WRONG BRANCH]ish: retain this title",
+  ])("preserves meaningful full-changelog title text: %s", title => {
+    const notes = renderReleaseNotes({
+      npmMetadata: "",
+      deltaPrNotes: `## What's Changed\n### Chores\n* ${title} by @contributor in https://github.com/lidge-jun/opencodex/pull/12`,
+    });
+    expect(notes).toContain(`- #12 ${title} @contributor`);
+  });
   const carried = [
     "<!-- Release notes generated using configuration in .github/release.yml at abc -->",
     "",
```

## C-stage correction: active release builder

Accepted Codex review: actual release.yml invokes scripts/build-release-changelog.ts, whose changelog still used pr.title.trim(). The original tests certified a renderer but not this active entry. Extend the same bug fix: export stripPrEnforcementPrefix from scripts/release-notes.ts, import/use it for PR changelog titles in scripts/build-release-changelog.ts; add public buildReleaseNotes regressions in existing tests/ci-workflows/build-release-changelog.test.ts for generated-note enrichment and associated-PR fallback, asserting cleaned summary, preserved conventional changelog title/author/ID, and unrelated/embedded/near-match preservation. Keep category policy, direct-commit policy, network/dispatch and release coverage rules unchanged. The two new paths are part of this one bug, not a new delivery. Hosted current-head CI must execute both renderer test files. No local product test. Re-audit active caller and pure-string security boundary before accepting the repair.

Repair source audit PASS at ef15842fc: actual builder emission and generated/associated regression paths verified. Source-of-truth paragraph corrected in be1f60f28 to distinguish active builder from standalone renderer; category selection/direct-commit policy unchanged. Final proof compares landed blobs to final reviewed candidate, not the original incomplete source. Prior run34167832861 passed16/skipped3 and showed original renderer cases onLinux/macOS; final newhead must be certified separately.

DONE: PR3960 landed9c8f66b9d, finalheadbe1f60f28; CI34168481093 success16/skipped3. Both renderer files and new5 active-builder cases were observed in Linux logs; macOS lanespassed. Independent final source/security auditPASS. Exact destination60bcb9050 plus reviewed patch tree verified; coauthor present; source3899 and issue3895 closed. The combined destination tree was verified structurally, not claimed executed as the PR test tree. Local productcommandsNOTRUN.
