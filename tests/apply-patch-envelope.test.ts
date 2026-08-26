import { describe, expect, test } from "bun:test";
import {
  normalizeApplyPatchDelimiters,
  repairFreeformToolInput,
} from "../src/responses/apply-patch-envelope";

const DECORATED_PATCH = `*** Begin Patch ***
*** Update File: README.md
@@
-old
+new
*** End Patch ***`;

const CANONICAL_PATCH = `*** Begin Patch
*** Update File: README.md
@@
-old
+new
*** End Patch`;

describe("apply_patch envelope repair", () => {
  test("repairs only the outer lines of a complete top-level apply_patch payload", () => {
    expect(repairFreeformToolInput(DECORATED_PATCH, "apply_patch")).toBe(CANONICAL_PATCH);
    expect(normalizeApplyPatchDelimiters(DECORATED_PATCH)).toBe(CANONICAL_PATCH);
  });

  test("preserves CRLF and an existing trailing newline", () => {
    const decorated = DECORATED_PATCH.replaceAll("\n", "\r\n") + "\r\n";
    const canonical = CANONICAL_PATCH.replaceAll("\n", "\r\n") + "\r\n";
    expect(repairFreeformToolInput(decorated, "apply_patch")).toBe(canonical);
  });

  test("unwraps the function-call {input} wrapper before top-level repair", () => {
    expect(repairFreeformToolInput(JSON.stringify({ input: DECORATED_PATCH }), "apply_patch")).toBe(CANONICAL_PATCH);
  });

  test("repairs only bare and reserved-functions apply_patch grammars", () => {
    const wrapped = JSON.stringify({ input: DECORATED_PATCH });
    expect(repairFreeformToolInput(wrapped, "apply_patch", "functions")).toBe(CANONICAL_PATCH);
    expect(repairFreeformToolInput(wrapped, "apply_patch", "mcp")).toBe(DECORATED_PATCH);
  });

  test("keeps exec JavaScript strings, comments, templates, and regexes byte-identical", () => {
    const cases = [
      'const sample = "tools.apply_patch({ input: patchText })";',
      "// tools.apply_patch({ input: patchText })\nconst ok = true;",
      "const source = `await tools.apply_patch(\\`*** Begin Patch ***\\`)`;",
      "const marker = /\\*\\*\\* Begin Patch \\*\\*\\*/;",
      `await tools.apply_patch(\`*** Begin Patch ***
*** Update File: README.md
@@
-old
+new
*** End Patch ***\`)`,
    ];
    for (const source of cases) {
      expect(repairFreeformToolInput(source, "exec")).toBe(source);
    }
  });

  test("does not turn a raw exec body into an executable helper call", () => {
    expect(repairFreeformToolInput(DECORATED_PATCH, "exec")).toBe(DECORATED_PATCH);
    expect(repairFreeformToolInput(JSON.stringify({ input: DECORATED_PATCH }), "exec")).toBe(DECORATED_PATCH);
  });

  test("does not rewrite decorated delimiter text inside patch-file content", () => {
    const body = `*** Begin Patch
*** Update File: docs.md
@@
-old
+A patch starts with *** Begin Patch *** if you add extra stars.
+Do not rewrite *** End Patch *** in file content.
*** End Patch`;
    expect(repairFreeformToolInput(body, "apply_patch")).toBe(body);
    expect(normalizeApplyPatchDelimiters(body)).toBe(body);
  });

  test("leaves incomplete, prefixed, suffixed, and non-operation envelopes alone", () => {
    const cases = [
      "*** Begin Patch ***",
      `prefix\n${DECORATED_PATCH}`,
      `${DECORATED_PATCH}\nsuffix`,
      "*** Begin Patch ***\nplain text\n*** End Patch ***",
    ];
    for (const source of cases) {
      expect(repairFreeformToolInput(source, "apply_patch")).toBe(source);
    }
  });

  test("repairs one decorated outer line without touching an already canonical peer", () => {
    const decoratedBegin = CANONICAL_PATCH.replace("*** Begin Patch", "*** Begin Patch ***");
    const decoratedEnd = CANONICAL_PATCH.replace("*** End Patch", "*** End Patch ***");
    expect(repairFreeformToolInput(decoratedBegin, "apply_patch")).toBe(CANONICAL_PATCH);
    expect(repairFreeformToolInput(decoratedEnd, "apply_patch")).toBe(CANONICAL_PATCH);
  });

  test("unwraps other freeform tools without changing their body", () => {
    const body = "*** Begin Patch ***";
    expect(repairFreeformToolInput(JSON.stringify({ input: body }), "render_diagram")).toBe(body);
    expect(repairFreeformToolInput(body, "")).toBe(body);
  });
});
