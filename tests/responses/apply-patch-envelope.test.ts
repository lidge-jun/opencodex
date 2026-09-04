import { describe, expect, test } from "bun:test";
import {
  isCompletePatchEnvelope,
  mayBecomePatchEnvelope,
  normalizeApplyPatchDelimiters,
  repairFreeformToolInput,
} from "../../src/responses/apply-patch-envelope";
import { compileCodeModeHelperInput, resolveCodeModeHelperName } from "../../src/responses/code-mode-helper-compat";

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

  // `repairFreeformToolInput` itself never compiles: exec bodies come back byte-identical.
  // Recognizing a raw envelope as an implicit apply_patch call is a separate decision made
  // one level up, by `resolveCodeModeHelperName` at the bridge and native-restore
  // boundaries. See devlog/_plan/260905_apply_patch_envelope_gap.
  test("repairFreeformToolInput never compiles a raw exec body into a helper call", () => {
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

// A complete envelope submitted as the `exec` body is never valid JavaScript, so the
// callers retarget it to the apply_patch helper. See
// devlog/_plan/260905_apply_patch_envelope_gap.
describe("raw exec patch envelope recognition", () => {
  // Recognition requires a genuine code-mode catalog, not merely a tool named `exec`.
  const CODE_MODE = new Set(["exec"]);
  const ADD = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
  const DELETE = "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch";

  test("accepts a complete envelope for every file operation, canonical or decorated", () => {
    for (const body of [CANONICAL_PATCH, DECORATED_PATCH, ADD, DELETE]) {
      expect(isCompletePatchEnvelope(body)).toBe(true);
      expect(resolveCodeModeHelperName(undefined, "exec", body, undefined, CODE_MODE)).toBe("apply_patch");
    }
  });

  test("compiles a recognized envelope into an apply_patch helper call", () => {
    const helper = resolveCodeModeHelperName(undefined, "exec", DECORATED_PATCH, undefined, CODE_MODE);
    const source = compileCodeModeHelperInput(DECORATED_PATCH, helper!);
    expect(source).toContain("await tools.apply_patch(");
    // The patch travels as a JSON string argument, never as interpolated source, and the
    // decorated delimiters are normalized on the way through.
    expect(source).toContain(JSON.stringify(CANONICAL_PATCH));
    expect(source).not.toContain("*** Begin Patch ***");
  });

  test("refuses JavaScript that merely mentions an envelope", () => {
    const cases = [
      "const sample = \"tools.apply_patch({ input: patchText })\";",
      "// tools.apply_patch({ input: patchText })\nconst ok = true;",
      "const marker = /\\*\\*\\* Begin Patch \\*\\*\\*/;",
      "const a = 1;\n/*** Begin Patch ***/\nawait tools.exec_command({ cmd: \"id\" });",
      "await tools.apply_patch(`" + DECORATED_PATCH + "`);",
    ];
    for (const source of cases) {
      expect(isCompletePatchEnvelope(source)).toBe(false);
      expect(resolveCodeModeHelperName(undefined, "exec", source, undefined, CODE_MODE)).toBeUndefined();
      expect(repairFreeformToolInput(source, "exec")).toBe(source);
    }
  });

  test("refuses incomplete, prefixed, suffixed, and operation-free envelopes", () => {
    const cases = [
      "*** Begin Patch ***",
      `prefix\n${DECORATED_PATCH}`,
      `${DECORATED_PATCH}\nsuffix`,
      "*** Begin Patch ***\nplain text\n*** End Patch ***",
      "",
    ];
    for (const source of cases) {
      expect(isCompletePatchEnvelope(source)).toBe(false);
      expect(resolveCodeModeHelperName(undefined, "exec", source, undefined, CODE_MODE)).toBeUndefined();
    }
  });

  test("stays scoped to a bare exec call and never double-wraps a named helper", () => {
    expect(resolveCodeModeHelperName(undefined, "exec", CANONICAL_PATCH, "mcp", CODE_MODE)).toBeUndefined();
    expect(resolveCodeModeHelperName(undefined, "apply_patch", CANONICAL_PATCH, undefined, CODE_MODE)).toBeUndefined();
    expect(resolveCodeModeHelperName(undefined, "render_diagram", CANONICAL_PATCH, undefined, CODE_MODE)).toBeUndefined();
    // An already-resolved name-based helper wins and is returned unchanged.
    expect(resolveCodeModeHelperName("write_stdin", "exec", CANONICAL_PATCH, undefined, CODE_MODE)).toBe("write_stdin");
  });

  // `exec` beside a bare shell bridge is the flat-catalog shape, not code mode: there a
  // caller-defined `exec` may legitimately take patch text.
  test("refuses a catalog that is not genuine code mode", () => {
    for (const declared of [undefined, new Set<string>(), new Set(["exec", "exec_command"]), new Set(["exec", "shell_command"]), new Set(["apply_patch"])]) {
      expect(resolveCodeModeHelperName(undefined, "exec", CANONICAL_PATCH, undefined, declared)).toBeUndefined();
    }
  });

  test("unwraps the {input} function wrapper before recognizing the envelope", () => {
    expect(resolveCodeModeHelperName(undefined, "exec", JSON.stringify({ input: DECORATED_PATCH }), undefined, CODE_MODE)).toBe("apply_patch");
  });

  test("holds a streaming buffer that could still become an envelope", () => {
    for (const partial of ["*** Be", "*** Begin Patch", "*** Begin Patch\n*** Add File: a.txt"]) {
      expect(mayBecomePatchEnvelope(partial)).toBe(true);
    }
    for (const partial of ["", "const x = 1;", "await tools.exec_command({"]) {
      expect(mayBecomePatchEnvelope(partial)).toBe(false);
    }
  });
});
