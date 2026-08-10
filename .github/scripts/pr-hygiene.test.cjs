"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  addedLines,
  assessHygiene,
  collectDeterministicHygieneFailures,
  HYGIENE_FAILURE_HINTS,
  HYGIENE_GATE_LABELS,
  hasEmptyCatch,
  resultLines,
  resultLinesByHunk,
} = require("./pr-hygiene.cjs");

describe("patch parsing", () => {
  it("returns added content without diff headers", () => {
    assert.deepEqual(addedLines("+++ b/a.ts\n+const x = 1;\n-old"), ["const x = 1;"]);
  });

  it("detects empty catch blocks across added lines", () => {
    assert.equal(hasEmptyCatch(["try { work(); } catch (error) {", "}"]), true);
    assert.equal(hasEmptyCatch(["catch (error) {", "report(error);", "}"]), false);
  });

  it("keeps hunk context and added lines for result scanning", () => {
    assert.deepEqual(
      resultLines(" catch (e) {\n-  report(e);\n }"),
      ["catch (e) {", "}"],
    );
  });
});

describe("assessHygiene", () => {
  it("requires regression coverage for behavior changes", () => {
    const failures = assessHygiene({ files: [{ filename: "src/router.ts", patch: "+change" }] });
    assert.equal(failures[0].code, "missing_regression_test");
  });

  it("accepts behavior changes with tests or approved exception", () => {
    assert.deepEqual(assessHygiene({ files: [
      { filename: "src/router.ts", patch: "+change" },
      { filename: "tests/router.test.ts", patch: "+test" },
    ] }), []);
    assert.deepEqual(assessHygiene({
      files: [{ filename: "src/router.ts", patch: "+change" }],
      labels: ["test-exception-approved"],
    }), []);
  });

  it("does not read an empty catch across a hunk boundary", () => {
    // Hunks are disjoint windows onto the file. Concatenating them puts unrelated
    // lines next to each other: a hunk ending at `} catch (e) {` followed by one
    // starting at `}` reads as an empty catch that exists nowhere in the file.
    const crossHunk = [
      "@@ -10,2 +10,3 @@",
      "+  const a = 1;",
      "   } catch (e) {",
      "@@ -90,2 +90,3 @@",
      "   }",
      "+  const b = 2;",
    ].join("\n");
    assert.equal(resultLinesByHunk(crossHunk).some((w) => hasEmptyCatch(w)), false);

    // A catch emptied within one window is still caught.
    const realEmpty = ["@@ -10,3 +10,3 @@", "-  report(e);", "   } catch (e) {", "   }"].join("\n");
    assert.equal(resultLinesByHunk(realEmpty).some((w) => hasEmptyCatch(w)), true);
  });

  it("treats a deleted lockfile as no dependency change", () => {
    // Removing bun.lock adds no dependency. The generated-output and
    // regression-test checks already exclude removals; this one did not.
    assert.deepEqual(
      assessHygiene({ files: [{ filename: "bun.lock", status: "removed", patch: "@@\n-x" }] }),
      [],
    );
    // A modified or MOVED lockfile with no manifest beside it is still orphaned.
    assert.equal(
      assessHygiene({ files: [{ filename: "bun.lock", status: "modified", patch: "@@\n+x" }] })[0].code,
      "orphan_lockfile",
    );
    assert.equal(
      assessHygiene({ files: [
        { filename: "lock/bun.lock", previous_filename: "bun.lock", status: "renamed", patch: "@@\n+x" },
      ] })[0].code,
      "orphan_lockfile",
    );
  });

  it("does not demand a test for a comment-only source change", () => {
    // This repository asks for dense explanatory comments in source. A PR that
    // only sharpens one changed no behavior, and forcing it through the label
    // escape would teach contributors to request the label instead of writing
    // tests — weakening the gate exactly where it matters.
    assert.deepEqual(assessHygiene({ files: [
      { filename: "src/router.ts", patch: "@@\n+// clarify why this fails closed\n-// old wording" },
    ] }), []);
    assert.deepEqual(assessHygiene({ files: [
      { filename: "src/router.ts", patch: "@@\n+/**\n+ * why this is bounded\n+ */" },
    ] }), []);
  });

  it("still demands a test when a comment change carries any code", () => {
    for (const patch of [
      "@@\n+// note\n+const y = 2;",
      "@@\n+// looks harmless\n+runUntrusted(payload);",
      "@@\n-const y = 2;\n+// removed the line",
    ]) {
      const failures = assessHygiene({ files: [{ filename: "src/router.ts", patch }] });
      assert.equal(failures[0].code, "missing_regression_test", patch);
    }
  });

  it("classifies renamed behavior files on both sides", () => {
    const failures = assessHygiene({ files: [
      { filename: "docs/moved.md", previous_filename: "src/router.ts", patch: "" },
    ] });
    assert.equal(failures[0].code, "missing_regression_test");
  });

  it("accepts a renamed behavior file when tests are included", () => {
    assert.deepEqual(assessHygiene({ files: [
      { filename: "docs/moved.md", previous_filename: "src/router.ts", patch: "" },
      { filename: "tests/moved.test.ts", patch: "+test" },
    ] }), []);
  });

  it("classifies renamed generated files on both sides", () => {
    const failures = assessHygiene({ files: [
      { filename: "docs/notes.md", previous_filename: "gui/dist/index.js", patch: "" },
    ] });
    assert.equal(failures[0].code, "generated_output");
  });

  it("blocks added suppressions", () => {
    const failures = assessHygiene({ files: [
      { filename: "tests/a.test.ts", patch: "+// @ts-ignore\n+value();" },
    ] });
    assert.equal(failures[0].code, "new_suppression");
  });

  it("blocks focused or skipped tests", () => {
    const failures = assessHygiene({ files: [
      { filename: "tests/a.test.ts", patch: "+test.only(\"x\", () => {});" },
    ] });
    assert.equal(failures[0].code, "focused_or_skipped_test");
  });

  it("blocks empty catches", () => {
    const failures = assessHygiene({ files: [
      { filename: "tests/a.test.ts", patch: "+try {} catch (error) {}" },
    ] });
    assert.equal(failures[0].code, "empty_catch");
  });

  it("detects a catch emptied by deletion", () => {
    const failures = assessHygiene({ files: [
      { filename: "docs/example.ts", patch: " catch (e) {\n-  report(e);\n }" },
    ] });
    assert.equal(failures[0].code, "empty_catch");
  });

  it("does not flag a nonempty catch in a hunk with unrelated deletions", () => {
    const failures = assessHygiene({ files: [
      { filename: "docs/example.ts", patch: " catch (e) {\n   report(e);\n-  old();\n }" },
    ] });
    assert.deepEqual(failures, []);
  });

  it("blocks generated output and orphan lockfile churn", () => {
    const failures = assessHygiene({ files: [
      { filename: "gui/dist/index.js", patch: "+built" },
      { filename: "bun.lock", patch: "+package" },
    ] });
    assert.deepEqual(failures.map((failure) => failure.code), ["generated_output", "orphan_lockfile"]);
  });

  it("allows removal of generated output", () => {
    assert.deepEqual(assessHygiene({ files: [
      { filename: "gui/dist/index.js", status: "removed", patch: "-built" },
    ] }), []);
  });

  it("does not count deleted tests as regression coverage", () => {
    const failures = assessHygiene({ files: [
      { filename: "src/router.ts", patch: "+change" },
      { filename: "tests/old.test.ts", status: "removed", patch: "-test" },
    ] });
    assert.equal(failures[0].code, "missing_regression_test");
  });

  it("allows maintainer-approved narrow exceptions", () => {
    const failures = assessHygiene({
      files: [
        { filename: "src/router.ts", patch: "+// eslint-disable-next-line\n+run();" },
        { filename: "gui/dist/index.js", patch: "+built" },
        { filename: "bun.lock", patch: "+package" },
      ],
      labels: [
        "test-exception-approved",
        "suppression-approved",
        "generated-change-approved",
        "dependency-change-approved",
      ],
    });
    assert.deepEqual(failures, []);
  });
});

describe("collectDeterministicHygieneFailures", () => {
  it("combines patch hygiene and sponsored-surface failures", () => {
    const failures = collectDeterministicHygieneFailures({
      files: [
        { filename: "src/codex/auth-api.ts", patch: "+change" },
      ],
      authorHasPushPermission: false,
    });
    assert.deepEqual(
      failures.map((failure) => failure.code).sort(),
      ["missing_regression_test", "unsponsored_surface"],
    );
  });

  it("skips sponsorship for maintainers with push permission", () => {
    const failures = collectDeterministicHygieneFailures({
      files: [
        { filename: "src/codex/auth-api.ts", patch: "+change" },
        { filename: "tests/codex-auth-api.test.ts", patch: "+test" },
      ],
      authorHasPushPermission: true,
    });
    assert.deepEqual(failures, []);
  });

  it("requires sponsorship when renaming away from a restricted path", () => {
    const failures = collectDeterministicHygieneFailures({
      files: [
        {
          filename: "docs/moved-release.yml",
          previous_filename: ".github/workflows/release.yml",
          status: "renamed",
          patch: "+moved",
        },
      ],
      authorHasPushPermission: false,
    });
    const unsponsored = failures.find((failure) => failure.code === "unsponsored_surface");
    assert.ok(unsponsored, "expected unsponsored_surface for a restricted rename source");
    assert.deepEqual(unsponsored.paths, [".github/workflows/release.yml"]);
  });

  it("exposes hints and gate labels for the Ready coupling", () => {
    assert.equal(typeof HYGIENE_FAILURE_HINTS.unsponsored_surface, "string");
    assert.ok(HYGIENE_GATE_LABELS.includes("maintainer-sponsored"));
    assert.ok(HYGIENE_GATE_LABELS.includes("intake: hygiene-blocked"));
  });
});

describe("pr-hygiene workflow trust boundary", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const workflow = fs.readFileSync(
    path.join(__dirname, "../workflows/pr-hygiene.yml"),
    "utf8",
  );

  it("checks out trusted scripts from an integration branch, never a PR-controlled ref", () => {
    // Scope to the checkout step so a stray `ref:` elsewhere cannot satisfy
    // this, and compare the whole expression rather than matching fragments:
    // independent substring checks would pass even with the operator grouping
    // wrong or a `base.sha` fallback still present.
    const checkoutStep = workflow
      .split("- name: Checkout trusted hygiene script")[1]
      .split(/\n {6}- name:/)[0];
    const ref = checkoutStep.match(/^\s*ref:\s*(.+)$/m)?.[1];
    assert.ok(ref, "trusted checkout must declare ref");
    assert.equal(
      ref.replace(/\s+/g, " ").trim(),
      "${{ github.event.pull_request.base.ref == 'main' && 'main' || 'dev' }}",
    );
    // A stacked child PR's base is another open PR's head; neither a base nor
    // a head ref may select the code that runs with the write-capable token.
    assert.doesNotMatch(ref, /base\.sha|head\.(?:sha|ref)/);
    assert.match(checkoutStep, /persist-credentials:\s*false/);
  });

  it("never lets a PR-controlled ref reach an executable step", () => {
    // Pinning the checkout ref is not enough on its own: a later `run:` or
    // `github-script` step could fetch and execute PR head content and a
    // checkout-scoped assertion would still pass. This gates the whole file.
    //
    // `pull_request_target` grants a write-capable token, so no executable
    // surface here may interpolate a head ref, and nothing may reference the
    // head repository at all.
    assert.doesNotMatch(
      workflow,
      /pull_request\.head\.(?:sha|ref|repo)/,
      "no step in a pull_request_target workflow may consume a PR head ref",
    );
    // `refs/pull/<n>/head` reaches the same PR-controlled tree without ever
    // naming `head`, so ban the merge-ref form too.
    assert.doesNotMatch(
      workflow,
      /refs\/pull\//,
      "no step may check out a refs/pull/* ref",
    );
    // Banning literal text is not enough: `format('refs/{0}/{1}/{2}', ...)`
    // builds the same PR-controlled ref without ever spelling it. Every
    // checkout in a pull_request_target workflow must therefore declare a ref
    // drawn from the trusted allowlist, and no other step may name the PR
    // number in a ref-shaped expression.
    // An ALLOWLIST, not a denylist: every checkout in this workflow must use
    // exactly the trusted expression. Banning known-bad shapes lost twice —
    // first to `refs/pull/<n>/head`, then to `format('refs/{0}/...')` — and a
    // `repository:` override pointing at the fork head is a third shape no
    // denylist would have caught.
    const checkouts = workflow.match(/uses:\s*actions\/checkout@[\s\S]*?(?=\n {6}- name:|$)/g) ?? [];
    for (const step of checkouts) {
      const stepRef = (step.match(/^\s*ref:\s*(.+)$/m)?.[1] ?? "").replace(/\s+/g, " ").trim();
      assert.equal(stepRef, "${{ github.event.pull_request.base.ref == 'main' && 'main' || 'dev' }}", "every checkout must use the trusted ref");
      assert.doesNotMatch(step, /repository:/, "a checkout must not retarget its repository");
    }
    // Checkout is not the only way to obtain PR-controlled code. A `run:` step
    // can fetch it directly, and that is a realistic future edit rather than a
    // synthetic one, so executable steps are gated on the acquisition verbs
    // themselves.
    // Stop enumerating command shapes. A denylist lost four times here
    // (`refs/pull`, `format()`, `repository:`, `gh pr checkout`), and
    // `git clone https://github.com/<fork>` would have been the fifth. The
    // invariant is simpler than the attack surface: under
    // `pull_request_target`, nothing executable may name the PR head or the
    // fork repository at all.
    // Comments may discuss the head ref; only executable content may not use
    // it, so YAML comment lines are stripped before this check.
    const executable = workflow
      .split("\n")
      .filter(line => !/^\s*#/.test(line) && !/^\s*\/\//.test(line.replace(/^\s*/, "")))
      .join("\n");
    assert.doesNotMatch(
      executable.replace(/^\s*\/\/.*$/gm, ""),
      /github\.head_ref|pull_request(?:\[['"]head['"]\]|\.head)\s*(?:\[|\.)?\s*['"]?repo/,
      "no executable step may reference the PR head repository",
    );
    // Belt and braces for the acquisition verbs, which have no legitimate use
    // in either gate: both only read PR metadata through the API.
    assert.doesNotMatch(
      workflow,
      /gh\s+pr\s+checkout|git\s+(?:fetch|checkout|clone|switch)|refs\/pull/,
      "no step may acquire pull-request code",
    );
  });

  it("uses repository permission level for the sponsorship exemption", () => {
    assert.match(workflow, /getCollaboratorPermissionLevel/);
    assert.match(workflow, /authorHasPushPermission\(authorPermission\)/);
    assert.doesNotMatch(
      workflow,
      /authorHasPushPermission:\s*\["OWNER",\s*"MEMBER",\s*"COLLABORATOR"\]\.includes\(\s*pr\.author_association/,
    );
  });
});
