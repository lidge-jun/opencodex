import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { parseRequest } from "../../src/responses/parser";
import {
  CODE_MODE_HOST_CONTRACT_SENTENCE,
  CODE_MODE_HOST_FAILURE_GUIDANCE,
  EMPTY_EXEC_OUTPUT_MESSAGE,
  EMPTY_EXEC_OUTPUT_REGEX,
  annotateCodeModeHostFailure,
  isEmptyExecToolResult,
  normalizeEmptyExecToolResultText,
} from "../../src/adapters/exec-tool-result-normalize";

// Live host strings (Codex 0.153.2, probed 2026-09-07) and the rule each one names. The pre-call
// sentence and these rows are one contract in one module; a model must never be told one thing
// before the call and another after.
describe("code-mode host failure annotation", () => {
  test.each(CODE_MODE_HOST_FAILURE_GUIDANCE.map(row => [row.marker, row.guidance] as const))(
    "annotates an exec result carrying %p regardless of case",
    (marker, guidance) => {
      const text = `Script failed\nWall time 0.1 seconds\nOutput:\nError: ${marker.toUpperCase()}`;
      expect(annotateCodeModeHostFailure(text, { toolName: "exec" })).toBe(`${text}\n[recovery: ${guidance}]`);
    },
  );

  test("matches the host's real capitalisation and argument text", () => {
    expect(annotateCodeModeHostFailure("Unsupported import in exec: node:fs", { toolName: "exec" })).toContain("injected globals");
    expect(annotateCodeModeHostFailure("Script error:\ntool `apply_patch` expects a string input", { toolName: "exec" })).toContain("exactly one string");
    expect(annotateCodeModeHostFailure(
      "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'",
      { toolName: "exec" },
    )).toContain("bare marker line `*** Begin Patch`");
  });

  const successfulSearch = "Script completed\nWall time 0.1 seconds\nOutput:\nREADME.md:8: expects a string input\nexit_code: 0";

  test("preserves the audit's successful rg output byte-for-byte on the Responses wire", () => {
    const body = {
      model: "grok-4.6",
      tools: [{ type: "namespace", name: "functions", tools: [{
        type: "custom", name: "exec", description: "Run JavaScript in a V8 isolate.",
      }] }],
      input: [
        { type: "custom_tool_call", name: "exec", call_id: "call_probe", input: 'text(await tools.exec_command({cmd:"rg phrase README.md"}))' },
        { type: "custom_tool_call_output", call_id: "call_probe", output: successfulSearch },
      ],
    };
    const budget = createTranslatorBudget();
    try {
      const request = createResponsesPassthroughAdapter({
        adapter: "openai-responses", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "test-key",
      }).buildRequest(parseRequest(body), { headers: new Headers(), translatorBudget: budget });
      expect(JSON.parse(request.body).input[1].output).toBe(successfulSearch);
    } finally {
      budget.dispose();
    }
  });

  test.each([
    successfulSearch,
    "README.md:8: expects a string input",
    "expects a string input",
    "the first line of the patch must be '*** Begin Patch'",
    "the last line of the patch must be '*** End Patch'",
    "The docs say Unsupported import in exec: node:fs",
    "README.md:8: Script error: tool `apply_patch` expects a string input",
    "Script completed\nWall time 0.1 seconds\nOutput:\nScript error:\ntool `apply_patch` expects a string input\nexit_code: 0",
    "Script completed\nWall time 0.1 seconds\nOutput:\nError: Unsupported import in exec: node:fs\nexit_code: 0",
    "Script completed\r\nWall time 0.1 seconds\r\nOutput:\napply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'\nexit_code: 0",
    "Script completed\nWall time 0.1 seconds\nOutput:\napply_patch verification failed: invalid patch: The last line of the patch must be '*** End Patch'\nexit_code: 0",
  ])("does not annotate a phrase without a host error context: %p", text => {
    expect(annotateCodeModeHostFailure(text, { toolName: "exec" })).toBeUndefined();
  });

  test.each([
    "tool `apply_patch` expects a string input",
    "Error: tool `apply_patch` expects a string input",
    "Script error:\ntool `apply_patch` expects a string input",
    "Script failed\r\nWall time 0.1 seconds\r\nOutput:\r\nError: tool `apply_patch` expects a string input",
  ])("recognizes direct and wrapped host diagnostics: %p", text => {
    expect(annotateCodeModeHostFailure(text, { toolName: "exec" })).toContain("exactly one string");
  });

  test("leaves non-exec tools, shell bridges, foreign namespaces, non-matching text and already-annotated text alone", () => {
    expect(annotateCodeModeHostFailure("Script error:\ntool `apply_patch` expects a string input", { toolName: "read_file" })).toBeUndefined();
    // Flat shell bridges never run the isolate, so the four strings cannot be theirs.
    expect(annotateCodeModeHostFailure("Script error:\ntool `apply_patch` expects a string input", { toolName: "exec_command" })).toBeUndefined();
    // A foreign MCP server's own exec is not Codex's, even when its output quotes the phrase, and a
    // namespace that merely CONTAINS the provider name is still foreign.
    expect(annotateCodeModeHostFailure("Script error:\ntool `apply_patch` expects a string input", { toolName: "exec", toolNamespace: "mcp__docker" })).toBeUndefined();
    expect(annotateCodeModeHostFailure("Script error:\ntool `apply_patch` expects a string input", { toolName: "exec", toolNamespace: "mcp__foreign-opencodex-responses" })).toBeUndefined();
    // Codex's own display namespaces and flattened aliases for the same code-mode tool still count.
    for (const options of [
      { toolName: "exec", toolNamespace: "opencodex-responses" },
      { toolName: "exec", toolNamespace: "mcp__opencodex-responses" },
      { toolName: "mcp__opencodex-responses__exec" },
      { toolName: "mcp_opencodex-responses_exec" },
    ]) {
      expect(annotateCodeModeHostFailure("Script error:\ntool `apply_patch` expects a string input", options)).toContain("[recovery:");
    }
    expect(annotateCodeModeHostFailure("all good", { toolName: "exec" })).toBeUndefined();
    const once = annotateCodeModeHostFailure("Script error:\ntool `apply_patch` expects a string input", { toolName: "exec" });
    if (!once) throw new Error("expected one annotation");
    expect(annotateCodeModeHostFailure(once, { toolName: "exec" })).toBeUndefined();
  });

  test("every failure row is a rule the pre-call sentence already states", () => {
    expect(CODE_MODE_HOST_CONTRACT_SENTENCE).toContain("takes exactly one string");
    expect(CODE_MODE_HOST_CONTRACT_SENTENCE).toContain("`*** Begin Patch`");
    expect(CODE_MODE_HOST_CONTRACT_SENTENCE).toContain("`*** End Patch`");
    expect(CODE_MODE_HOST_CONTRACT_SENTENCE).toContain("no `import`");
    expect(CODE_MODE_HOST_CONTRACT_SENTENCE).toContain("write_stdin");
    // Never shows the decorated marker as a copyable literal (same rule as the nudge tests).
    expect(CODE_MODE_HOST_CONTRACT_SENTENCE).not.toContain("*** Begin Patch ***");
  });
});

describe("empty exec output wrapper detection", () => {
  test("recognizes each optional section and their combinations", () => {
    for (const text of [
      "Script completed\nWall time 0.1 seconds\nOutput:\n",
      "Script completed\nWall time 0.1 seconds\nOutput:\n<empty>\n",
      "Command finished\nOutput:\n",
      "Execution finished\n\n\nWall time 1s\n\nOutput:\n\n<empty>\n\n",
      "Wall time 5s\n",
      "Wall time 5s\nOutput:\n<empty>",
      "Output:<empty>",
      "Output:\n\n\n",
      "<empty>",
      "\n\n\n",
    ]) {
      expect(EMPTY_EXEC_OUTPUT_REGEX.test(text)).toBe(true);
    }
    for (const text of [
      "Script completed",
      "Script completed\nreal output\n",
      "Script failed\nOutput:\n",
      "Output: hi\n",
      "text\n<empty>",
      "x<empty>",
      "Script completed\nWall time\nOutput:\n<empty>x",
      "Wall time\n<empty> trailing",
    ]) {
      expect(EMPTY_EXEC_OUTPUT_REGEX.test(text)).toBe(false);
    }
  });

  // The previous pattern let adjacent `\n+`/`\s*` quantifiers repartition a newline block
  // combinatorially; these inputs keep that a timeout-scale regression rather than a silent one.
  test("stays linear on pathological whitespace runs", () => {
    const newlines = "\n".repeat(200_000);
    const start = performance.now();
    expect(EMPTY_EXEC_OUTPUT_REGEX.test(`Script completed\n${newlines}!`)).toBe(false);
    expect(EMPTY_EXEC_OUTPUT_REGEX.test(`Output:${newlines}`)).toBe(true);
    expect(EMPTY_EXEC_OUTPUT_REGEX.test(`Script completed\nWall time x\n${newlines}trailing`)).toBe(false);
    // Generous bound: the previous pattern hung on this shape; a second is far above linear cost.
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  // The bare regex tolerates one trailing newline, but the real path trims first — "Wall time 5s"
  // then lacks the newline its section requires and "Script completed" alone is not a wrapper.
  // Pinning the divergence keeps the example rows above from being read as callable behaviour.
  test("real path trims before matching, so a lone trailing newline is not empty", () => {
    for (const text of ["Wall time 5s\n", "Script completed\n"]) {
      expect(EMPTY_EXEC_OUTPUT_REGEX.test(text)).toBe(true);
      expect(normalizeEmptyExecToolResultText(text, { toolName: "exec" })).toBeUndefined();
      expect(isEmptyExecToolResult(text, { toolName: "exec" })).toBe(false);
    }
    // A wrapper whose structure survives the trim still normalizes through the same path.
    expect(normalizeEmptyExecToolResultText(
      "Script completed\nWall time 0.1 seconds\nOutput:\n",
      { toolName: "exec" },
    )).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
  });
});
