"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  addedLines,
  assessHygiene,
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
