import { describe, expect, test } from "bun:test";
import { compileCodeModeHelperInput, resolveCodeModeHelperName } from "../../src/responses/code-mode-helper-compat";
import { restoreRoutedCustomCallsInJson } from "../../src/responses/custom-tool-compat";

/**
 * Recognition and compilation must read ONE canonical body (#5046).
 *
 * #4983 widened what counts as an apply-patch call under a code-mode `exec` catalog: an
 * outer Markdown fence, and any single fallback field of that tool name. Recognition used
 * the widened unwrap; compilation kept a narrower one that saw only `input` and `patch`. So
 * a body accepted through a fence or through `content` reached `tools.apply_patch` still
 * wrapped, and the host rejected the JSON text or the fence instead of applying the patch.
 *
 * These cases are written against the pair, not against either half, because the defect was
 * that the two halves disagreed while each looked correct alone.
 */
const PATCH = "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch";
const EXPECTED = `const result = await tools.apply_patch(${JSON.stringify(PATCH)});\ntext(result);`;
const CODE_MODE = new Set(["exec"]);

/** Exactly what every bridge call site does: recognize, then compile under the wire name. */
function compileAsBridge(body: string, wireName = "exec", declared = CODE_MODE): string | undefined {
  const helper = resolveCodeModeHelperName(undefined, wireName, body, undefined, declared);
  return helper ? compileCodeModeHelperInput(body, helper, wireName) : undefined;
}

describe("code-mode apply_patch compiles the body recognition accepted", () => {
  test("every accepted exec fallback field compiles to the same raw patch", () => {
    // The list is `FREEFORM_FALLBACK_KEYS.exec` plus the `input` wrapper. If a key is added
    // there and not here, the two lists have drifted and the next reader should be told.
    for (const key of ["input", "code", "script", "js", "javascript", "command", "cmd", "content"]) {
      const body = JSON.stringify({ [key]: PATCH });
      expect({ key, source: compileAsBridge(body) }).toEqual({ key, source: EXPECTED });
    }
  });

  test("fenced and unfenced forms compile identically", () => {
    const fenced = "```\n" + PATCH + "\n```";
    expect(compileAsBridge(PATCH)).toBe(EXPECTED);
    expect(compileAsBridge(fenced)).toBe(EXPECTED);
    expect(compileAsBridge(JSON.stringify({ input: fenced }))).toBe(EXPECTED);
    expect(compileAsBridge("```diff\n" + PATCH + "\n```")).toBe(EXPECTED);
  });

  test("a native apply_patch call keeps its own vocabulary", () => {
    // The name-based path arrives under `apply_patch`, whose fallback keys are `patch` and
    // `content`. `{"patch": ...}` is meaningful there and is NOT an exec fallback field, so
    // the two names deliberately answer differently — which is why the wire name, not the
    // helper name, decides.
    expect(compileCodeModeHelperInput(JSON.stringify({ patch: PATCH }), "apply_patch")).toBe(EXPECTED);
    expect(compileCodeModeHelperInput(PATCH, "apply_patch")).toBe(EXPECTED);
    expect(compileAsBridge(JSON.stringify({ patch: PATCH }))).toBeUndefined();
  });

  test("a normal code-mode JavaScript body is left alone", () => {
    for (const body of [
      'const result = await tools.exec_command({ cmd: "ls" });\ntext(result);',
      'await tools.apply_patch("*** Begin Patch\\n*** Add File: a.txt\\n+hi\\n*** End Patch");',
      JSON.stringify({ input: 'const a = 1;\ntext(a);' }),
    ]) {
      expect(resolveCodeModeHelperName(undefined, "exec", body, undefined, CODE_MODE)).toBeUndefined();
    }
  });

  test("a caller-defined exec outside a code-mode catalog is never reinterpreted", () => {
    // Without a genuine code-mode catalog an `exec` that takes patch text is a legitimate
    // caller tool, and handing it generated JavaScript would be the mis-route this repair
    // exists to avoid. The widened unwrap must not change that.
    for (const body of [PATCH, JSON.stringify({ content: PATCH }), "```\n" + PATCH + "\n```"]) {
      expect(compileAsBridge(body, "exec", new Set(["shell"]))).toBeUndefined();
      // A catalog that also declares a legacy shell bridge is not code mode either, and no
      // declared set at all is the plainest case of the same rule.
      expect(compileAsBridge(body, "exec", new Set(["exec", "shell_command"]))).toBeUndefined();
      expect(resolveCodeModeHelperName(undefined, "exec", body, undefined, undefined)).toBeUndefined();
    }
  });

  test("the compiled helper survives the bridge, not only the recognizer", () => {
    // The unit above proves the pair agrees. This proves the agreement reaches the item a
    // client actually receives: before the fix this restored
    // `tools.apply_patch("{\"content\":\"*** Begin Patch...\"}")`.
    for (const key of ["content", "code", "input"]) {
      const upstream = JSON.stringify({
        id: "resp_patch",
        output: [{
          type: "function_call",
          id: "fc_patch",
          call_id: "call_patch",
          name: "exec",
          arguments: JSON.stringify({ [key]: PATCH }),
          status: "completed",
        }],
      });
      const restored = JSON.parse(restoreRoutedCustomCallsInJson(
        upstream,
        new Set(["exec"]),
        new Set(),
        CODE_MODE,
      )) as { output: Array<Record<string, unknown>> };
      expect({ key, item: restored.output[0] }).toMatchObject({
        key,
        item: { type: "custom_tool_call", name: "exec", input: EXPECTED },
      });
    }
  });
});
