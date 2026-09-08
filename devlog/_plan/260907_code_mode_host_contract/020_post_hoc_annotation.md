# 020 — wp2: post-hoc annotation of host failures on exec results

Depends on 010 (same module, same wording). Class C2. Anchors verified against ec799db26 plus
the wp1 delta. Ends with an authorized push; the draft PR from wp1 picks up the new head.

## MODIFY `src/adapters/exec-tool-result-normalize.ts`

Insert after `CODE_MODE_HOST_CONTRACT_SENTENCE` (added in wp1):

```ts

/**
 * Post-hoc half of the host contract: the four host strings a routed model reads inside a
 * non-error exec result, each paired with the rule it broke. Matched case-insensitively because
 * the host writes "Unsupported import in exec: <spec>" while Cursor's earlier marker was
 * lowercase; one table, one owner, so this text and the pre-call sentence cannot drift.
 */
export const CODE_MODE_HOST_FAILURE_GUIDANCE: ReadonlyArray<{ marker: string; guidance: string }> = [
  {
    marker: "expects a string input",
    guidance: "tools.apply_patch takes exactly one string argument; pass the patch text itself, not an object such as {input: ...}.",
  },
  {
    marker: "the first line of the patch must be",
    guidance: "The patch text must open with the bare marker line `*** Begin Patch`: no code fence, prose, or extra asterisks on that line (blank lines or indentation before it are tolerated).",
  },
  {
    marker: "the last line of the patch must be",
    guidance: "The patch text must close with the bare marker line `*** End Patch`: no trailing text or extra asterisks on that line (blank lines after it are tolerated).",
  },
  {
    marker: "unsupported import in exec",
    guidance: "Imports are not available in this exec context; use the injected globals (tools, text, notify, store, load, ALL_TOOLS) instead.",
  },
];

/** Prefix of every recovery line this module appends; callers use it to recognise replayed annotations. */
export const CODE_MODE_HOST_RECOVERY_PREFIX = "[recovery: ";

/** Namespaces under which Cursor displays Codex's own Responses tools (see cursor/tool-naming.ts). */
const CODEX_RESPONSES_DISPLAY_NAMESPACES: ReadonlySet<string> = new Set(["opencodex-responses", "mcp__opencodex-responses"]);
/** Flattened spellings of the same code-mode exec when a client folds the namespace into the name. */
const CODEX_CODE_MODE_EXEC_ALIASES: ReadonlySet<string> = new Set(["exec", "mcp__opencodex-responses__exec", "mcp_opencodex-responses_exec"]);

/**
 * The code-mode `exec` tool by NAME — bare, or under Codex's own `opencodex-responses` display
 * namespace, matched exactly. The four host strings above originate only in that isolate, so flat
 * shell bridges (`exec_command`, `shell`, …) and every other namespace (`mcp__docker`,
 * `mcp__foreign-opencodex-responses`) are excluded: an unrelated server's output that quotes the
 * phrase must not receive Codex guidance. Narrower than `isCodexExecBridgeTool` on purpose; the
 * empty-output repair keeps the wider gate. Callers that KNOW the catalog shape (Kiro's
 * `codeModeExecName`, the Responses body gate) add that check on top; this predicate alone cannot
 * tell a structured tool named `exec` from the freeform one.
 */
export function isCodexCodeModeExecResult(toolName?: string, toolNamespace?: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  if (toolNamespace !== undefined) return CODEX_RESPONSES_DISPLAY_NAMESPACES.has(toolNamespace) && lower === "exec";
  return CODEX_CODE_MODE_EXEC_ALIASES.has(lower);
}

/**
 * Append a one-line recovery hint when a code-mode exec result carries a known host failure string.
 * Returns undefined when the tool is not the code-mode exec, no marker matches, or a recovery line is
 * already present (a replayed annotated result must not grow a second one). Never touches error
 * status: the host already decided whether the call failed.
 */
export function annotateCodeModeHostFailure(
  text: string,
  options: { toolName?: string; toolNamespace?: string } = {},
): string | undefined {
  if (!isCodexCodeModeExecResult(options.toolName, options.toolNamespace)) return undefined;
  if (text.includes(CODE_MODE_HOST_RECOVERY_PREFIX)) return undefined;
  const lower = text.toLowerCase();
  const hit = CODE_MODE_HOST_FAILURE_GUIDANCE.find(({ marker }) => lower.includes(marker));
  return hit ? `${text}\n${CODE_MODE_HOST_RECOVERY_PREFIX}${hit.guidance}]` : undefined;
}
```

Flat shell tools are deliberately not annotated: the strings come from the code-mode host, and the
"flat catalogs untouched" statement in the docs is therefore literally true.

## MODIFY `src/adapters/responses-code-mode.ts`

Line 3 import gains `annotateCodeModeHostFailure`.

Line 55 BEFORE (6-space indent):
```ts
      const normalized = text === undefined ? undefined : normalizeEmptyExecToolResultText(text, { toolName: "exec" });
```
AFTER:
```ts
      const normalized = text === undefined
        ? undefined
        : normalizeEmptyExecToolResultText(text, { toolName: "exec" })
          ?? annotateCodeModeHostFailure(text, { toolName: "exec" });
```
Activation: paired `custom_tool_call_output` whose text contains `\`apply_patch\` expects a string input`;
observable: output ends with the recovery line, `input[0]` is the same object reference.

## MODIFY `src/adapters/kiro.ts`

Line 47 BEFORE:
```ts
import { EMPTY_EXEC_OUTPUT_MESSAGE, normalizeEmptyExecToolResultText } from "./exec-tool-result-normalize";
```
AFTER:
```ts
import { EMPTY_EXEC_OUTPUT_MESSAGE, annotateCodeModeHostFailure, normalizeEmptyExecToolResultText } from "./exec-tool-result-normalize";
```

Lines 758-771 BEFORE (6-space indent):
```ts
      const normalizedExecText = normalizeEmptyExecToolResultText(text, {
        toolName: tr.toolName,
        toolNamespace: tr.toolNamespace,
      });
      const resultText = normalizedExecText ?? (text.trim() ? text : KIRO_EMPTY_TOOL_RESULT_MESSAGE);
      const images = extractKiroImages(tr.content);
      const toolUseId = normalizeToolId(tr.toolCallId);
      const call = priorCalls.get(toolUseId);
      if (!call || call.rawId !== tr.toolCallId) {
        throw new Error(`Kiro history contains an orphaned tool result for call ${JSON.stringify(tr.toolCallId)}`);
      }
      // Keep real whitespace and failed wrappers, but no empty-success wrapper boilerplate.
      const rawGroupText = text.length > 0 && (!text.trim() || normalizedExecText !== EMPTY_EXEC_OUTPUT_MESSAGE)
        ? text : undefined;
```
AFTER:
```ts
      const execOptions = { toolName: tr.toolName, toolNamespace: tr.toolNamespace };
      const normalizedExecText = normalizeEmptyExecToolResultText(text, execOptions);
      // A host failure string inside a non-empty exec result gets the rule it broke appended, but
      // only when this request's emitted catalog is genuinely code mode (`codeModeExecName` above):
      // a structured tool named exec, or exec beside a shell bridge, never ran the isolate. This is
      // the only substitution the grouping path below also carries: whitespace and empty/failed
      // wrappers keep their existing raw policy.
      const annotatedExecText = normalizedExecText === undefined && codeModeExecName !== undefined
        ? annotateCodeModeHostFailure(text, execOptions)
        : undefined;
      const resultText = normalizedExecText ?? annotatedExecText ?? (text.trim() ? text : KIRO_EMPTY_TOOL_RESULT_MESSAGE);
      const images = extractKiroImages(tr.content);
      const toolUseId = normalizeToolId(tr.toolCallId);
      const call = priorCalls.get(toolUseId);
      if (!call || call.rawId !== tr.toolCallId) {
        throw new Error(`Kiro history contains an orphaned tool result for call ${JSON.stringify(tr.toolCallId)}`);
      }
      // Keep real whitespace and failed wrappers, but no empty-success wrapper boilerplate.
      const rawGroupText = text.length > 0 && (!text.trim() || normalizedExecText !== EMPTY_EXEC_OUTPUT_MESSAGE)
        ? (annotatedExecText ?? text) : undefined;
```
`annotatedExecText` is defined only when `normalizedExecText` is undefined, i.e. the text is neither an
empty-success nor a failed-empty wrapper, so every existing grouping expectation
(`kiro-adapter.test.ts:1209` whitespace, `1252` raw failed wrapper) is unchanged by construction.

## MODIFY `src/adapters/cursor/tool-result-normalize.ts`

Imports (lines 12-18) gain `CODE_MODE_HOST_RECOVERY_PREFIX`, `annotateCodeModeHostFailure` and
`isCodexCodeModeExecResult`. `RUNTIME_FAILURE_GUIDANCE` (lines 50-67) and its
loop (lines 107-113) stay byte-identical: Cursor's marker semantics, case sensitivity and
`isError:true` policy are its own.

Lines 97-106 BEFORE (2-space indent):
```ts
  if (isCodexExecBridgeTool(options.toolName, options.toolNamespace) && isEmptyOrFailedExecWrapper(text.trim())) {
    return {
      // A `Script failed` wrapper is empty but NOT a success: reporting it as an empty success
      // would erase the only failure signal. Text classification stays separate from Cursor's
      // isError policy, which the Computer Use branch above owns.
      text: isFailedEmptyExecWrapper(text.trim()) ? FAILED_EXEC_OUTPUT_MESSAGE : EMPTY_EXEC_OUTPUT_MESSAGE,
      isError: false,
      changed: true,
    };
  }
```
AFTER (append one branch directly after that block):
```ts
  if (isCodexExecBridgeTool(options.toolName, options.toolNamespace) && isEmptyOrFailedExecWrapper(text.trim())) {
    return {
      // A `Script failed` wrapper is empty but NOT a success: reporting it as an empty success
      // would erase the only failure signal. Text classification stays separate from Cursor's
      // isError policy, which the Computer Use branch above owns.
      text: isFailedEmptyExecWrapper(text.trim()) ? FAILED_EXEC_OUTPUT_MESSAGE : EMPTY_EXEC_OUTPUT_MESSAGE,
      isError: false,
      changed: true,
    };
  }
  // A host failure string inside a code-mode exec result gets the rule it broke appended, with
  // Cursor's isError decision left exactly as the caller passed it. A replayed result that already
  // carries a recovery line returns here unchanged: falling through would let the legacy loop
  // below match the lowercase import marker a second time and flip isError.
  if (isCodexCodeModeExecResult(options.toolName, options.toolNamespace)) {
    if (text.includes(CODE_MODE_HOST_RECOVERY_PREFIX)) return { text, isError, changed: false };
    const hostFailure = annotateCodeModeHostFailure(text, options);
    if (hostFailure !== undefined) return { text: hostFailure, isError, changed: true };
  }
```
The existing `unsupported import in exec` row in `RUNTIME_FAILURE_GUIDANCE` still serves node_repl /
Computer Use tools; for the code-mode exec the new branch runs first, carries the shared hint, and
terminates replay before the legacy loop can see it.

## NEW `tests/adapters/exec-tool-result-normalize.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import {
  CODE_MODE_HOST_CONTRACT_SENTENCE,
  CODE_MODE_HOST_FAILURE_GUIDANCE,
  annotateCodeModeHostFailure,
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

  test("leaves non-exec tools, shell bridges, foreign namespaces, non-matching text and already-annotated text alone", () => {
    expect(annotateCodeModeHostFailure("expects a string input", { toolName: "read_file" })).toBeUndefined();
    // Flat shell bridges never run the isolate, so the four strings cannot be theirs.
    expect(annotateCodeModeHostFailure("expects a string input", { toolName: "exec_command" })).toBeUndefined();
    // A foreign MCP server's own exec is not Codex's, even when its output quotes the phrase, and a
    // namespace that merely CONTAINS the provider name is still foreign.
    expect(annotateCodeModeHostFailure("expects a string input", { toolName: "exec", toolNamespace: "mcp__docker" })).toBeUndefined();
    expect(annotateCodeModeHostFailure("expects a string input", { toolName: "exec", toolNamespace: "mcp__foreign-opencodex-responses" })).toBeUndefined();
    // Codex's own display namespaces and flattened aliases for the same code-mode tool still count.
    for (const options of [
      { toolName: "exec", toolNamespace: "opencodex-responses" },
      { toolName: "exec", toolNamespace: "mcp__opencodex-responses" },
      { toolName: "mcp__opencodex-responses__exec" },
      { toolName: "mcp_opencodex-responses_exec" },
    ]) {
      expect(annotateCodeModeHostFailure("expects a string input", options)).toContain("[recovery:");
    }
    expect(annotateCodeModeHostFailure("all good", { toolName: "exec" })).toBeUndefined();
    const once = annotateCodeModeHostFailure("expects a string input", { toolName: "exec" });
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
```

Register in `scripts/test-layout/layout.json` `explicit` between
`"empty-tool-output-annotation.test.ts": "adapters",` (line 620) and its successor:
`"exec-tool-result-normalize.test.ts": "adapters",`; same key/value in
`tests/fixtures/test-layout-expected.json` in alphabetical position. The name matches no regex seed
(`"adapters"` seed is `^(?:bridge\.test\.ts|buffered|identity|run|tool|translator)-`), so the explicit
entry is required and `tests/test-layout-tooling.test.ts` names it if missing.

## Updated tests

`tests/responses/openai-responses-passthrough.test.ts` — add inside the code-mode describe:
```ts
  test("annotates a paired exec result that carries a host failure string without touching the program", () => {
    const failure = "Script failed\nWall time 0.1 seconds\nOutput:\nScript error:\ntool `apply_patch` expects a string input";
    const body = raw(failure);
    const wire = JSON.parse(createResponsesPassthroughAdapter(routed).buildRequest(parseRequest(body)).body);
    expect(wire.input[1].output).toBe(`${failure}\n[recovery: tools.apply_patch takes exactly one string argument; pass the patch text itself, not an object such as {input: ...}.]`);
    expect(JSON.parse(wire.input[0].arguments).input).toBe(body.input[0].input);
    // Replayed history already carrying the hint is not annotated twice: the output item and the
    // program keep their identity, and a second pass over the normalized body is a deep no-op.
    const replayed = raw(wire.input[1].output);
    const once = normalizeResponsesCodeMode(replayed, parseRequest(replayed), routed) as typeof replayed;
    expect(once.input[1]).toBe(replayed.input[1]);
    expect(once.input[0]).toBe(replayed.input[0]);
    expect(normalizeResponsesCodeMode(once, parseRequest(once), routed)).toEqual(once);
  });
```

`tests/providers/kiro/kiro-adapter.test.ts`
- After `"an empty code-mode exec result carries the actionable reason…"` (line 323) add:
```ts
  test("a code-mode exec result carrying a host failure string names the broken rule", async () => {
    // freeform: the Kiro seam annotates only when the emitted catalog is genuinely code mode.
    const execTool = { name: "exec", description: "Run JavaScript", freeform: true, parameters: { type: "object" } };
    const failure = "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'";
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-x", name: "exec", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-x", toolName: "exec", content: failure, isError: false },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages, [execTool]));
    const resultText = JSON.parse(body).conversationState.currentMessage.userInputMessage
      .userInputMessageContext.toolResults[0].content[0].text;
    expect(resultText).toBe(`${failure}\n[recovery: The patch text must open with the bare marker line \`*** Begin Patch\`: no code fence, prose, or extra asterisks on that line (blank lines or indentation before it are tolerated).]`);
  });

  test("a host failure string on a non-code-mode catalog stays raw", async () => {
    const failure = "tool `apply_patch` expects a string input";
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-x", name: "exec", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-x", toolName: "exec", content: failure, isError: false },
    ];
    for (const tools of [
      // A structured tool that merely shares the name exec.
      [{ name: "exec", description: "Run a shell string", parameters: { type: "object" } }],
      // Freeform exec beside a bare shell bridge is the flat-catalog shape, not code mode.
      [
        { name: "exec", description: "Run JavaScript", freeform: true, parameters: { type: "object" } },
        { name: "exec_command", description: "Run", parameters: { type: "object" } },
      ],
    ]) {
      const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages, tools));
      const resultText = JSON.parse(body).conversationState.currentMessage.userInputMessage
        .userInputMessageContext.toolResults[0].content[0].text;
      expect(resultText).toBe(failure);
    }
  });
```
- In the grouped-result table (the `execResult` cases around lines 1195-1262) add one case:
```ts
      {
        name: "host failure chunk in a multi group carries its recovery line beside raw siblings",
        id: "call-host-failure-multi",
        results: [execResult("call-host-failure-multi", "  "), execResult("call-host-failure-multi", "tool `apply_patch` expects a string input"), execResult("call-host-failure-multi", failedExecWrapper)],
        content: [{ text: "  " }, { text: "tool `apply_patch` expects a string input\n[recovery: tools.apply_patch takes exactly one string argument; pass the patch text itself, not an object such as {input: ...}.]" }, { text: failedExecWrapper }],
        status: "success",
        forbidden: [EMPTY_EXEC_OUTPUT_MESSAGE, FAILED_EXEC_OUTPUT_MESSAGE, KIRO_EMPTY_TOOL_RESULT_MESSAGE],
      },
```
  This drives the grouping path with whitespace, an annotated chunk and a raw failed wrapper in one
  group — the exact combination blocker 1 said the single-result test could not exercise.

`tests/providers/cursor/cursor-toolresult-normalize.test.ts` — add after the `test.each` runtime-failure table:
```ts
  test.each(["Unsupported import in exec: node:fs", "unsupported import in exec: node:fs"])(
    "a code-mode exec result carrying %p gains the shared hint, keeps its isError, and is not re-annotated on replay",
    (payload) => {
      const out = normalizeCursorToolResultText(payload, { toolName: "exec" });
      expect(out.changed).toBe(true);
      expect(out.isError).toBe(false);
      expect(out.text).toBe(`${payload}\n[recovery: Imports are not available in this exec context; use the injected globals (tools, text, notify, store, load, ALL_TOOLS) instead.]`);
      // Replay through Responses history arrives with isError=false; the legacy lowercase marker
      // row must not get a second look at it.
      const replay = normalizeCursorToolResultText(out.text, { toolName: "exec", isError: false });
      expect(replay).toEqual({ text: out.text, isError: false, changed: false });
    },
  );

  test("the legacy node_repl import row keeps its own isError policy", () => {
    const out = normalizeCursorToolResultText("unsupported import in exec", { toolName: "js", toolNamespace: "mcp__node_repl" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("injected globals");
  });

  test("a non-exec tool whose successful output merely mentions a host phrase stays byte-identical", () => {
    const doc = "The docs say apply_patch expects a string input.";
    const out = normalizeCursorToolResultText(doc, { toolName: "read_file" });
    expect(out.changed).toBe(false);
    expect(out.isError).toBe(false);
    expect(out.text).toBe(doc);
  });
```

## Delivery for this phase

Stage only the files above (`git diff --cached --stat` first); commit `--no-verify`; push `--no-verify`.

## Verification (C, hosted only)

NOT RUN locally. Exact-head Cross-platform CI on the wp2 head; receipt via
`cxc receipt test --session <id> --cwd <worktree> -- gh run view <id> --exit-status`.
