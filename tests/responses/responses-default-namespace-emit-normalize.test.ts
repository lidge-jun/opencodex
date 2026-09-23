/**
 * #5095: a routed Command Code Muse turn reached Codex App carrying
 * `{"type":"function_call","name":"default.view_image"}`. Codex has no handler for that name, so
 * it answered "unsupported call" and stored the item; every later request that replayed the
 * history was then refused by the upstream name pattern
 * (`Invalid 'input[877].name': string does not match pattern '^[a-zA-Z0-9_-]+$'`), which is what
 * killed a side chat opened from an 11h43m parent task. One relayed item ends the conversation.
 *
 * The cause was two resolvers disagreeing rather than a missing mechanism. The passthrough guard
 * RESOLVES an emitted name through `normalizeDeclaredToolName`, which maps a `default.`-prefixed
 * code-mode helper onto the declared `exec` (#4412) as well as a `default.`-prefixed bare tool
 * (#4176), so `default.view_image` was authorized. The emit-side rewrite
 * (`normalizeDefaultNamespaceInItem`) knew only the bare-tool case, so it forwarded the name
 * unchanged. These pin the agreement: the name the guard admits is the name the client receives.
 *
 * Kept out of `responses-undeclared-tool-guard.test.ts` because that file sits at its
 * file-size-baseline cap, and caps only move down.
 */
import { describe, expect, test } from "bun:test";
import {
  collectDeclaredBareWireToolNames,
  collectDeclaredWireToolNames,
  createUndeclaredToolCallGuardBlockRewrite,
  normalizeDefaultNamespaceInResponse,
  undeclaredToolCallNameInResponse,
  UNDECLARED_TOOL_CALL_ERROR_CODE,
} from "../../src/server/responses-undeclared-tool-guard";
import { isSchemaValidResponsesToolName } from "../../src/responses/tool-name-aliases";

/** Codex code mode: the shell is one freeform `exec`; every helper lives inside it, undeclared. */
const CODE_MODE_BODY = {
  tools: [{ type: "custom", name: "exec", description: "code mode" }],
} as const;

/** The classic Codex catalog, where `view_image` is a declared top-level function. */
const CLASSIC_BODY = {
  tools: [
    { type: "function", name: "view_image", parameters: { type: "object" } },
    { type: "custom", name: "apply_patch" },
  ],
} as const;

/** Codex App MCP tool shape from the Muse callback failure: namespace plus child function. */
const CODEX_APP_BODY = {
  tools: [{
    type: "namespace",
    name: "mcp__codex_app",
    tools: [{ type: "function", name: "send_message_to_thread", parameters: { type: "object" } }],
  }],
} as const;

function declarationsOf(body: unknown): {
  declared: ReadonlySet<string>;
  declaredBare: ReadonlySet<string>;
} {
  return {
    declared: collectDeclaredWireToolNames(body),
    declaredBare: collectDeclaredBareWireToolNames(body),
  };
}

function responseWith(...output: readonly unknown[]): Record<string, unknown> {
  return { id: "resp_1", status: "completed", output };
}

function normalizedNames(body: unknown, ...output: readonly unknown[]): unknown {
  const { declared, declaredBare } = declarationsOf(body);
  const result = normalizeDefaultNamespaceInResponse(responseWith(...output), declared, declaredBare);
  return (result.value as { output: Array<{ name?: unknown }> }).output.map(item => item.name);
}

function guardVerdict(body: unknown, item: unknown): string | undefined {
  const { declared, declaredBare } = declarationsOf(body);
  return undeclaredToolCallNameInResponse(responseWith(item), declared, undefined, undefined, declaredBare);
}

describe("schema-valid Responses tool names", () => {
  test("the pattern the upstream enforces is what the emit boundary reads", () => {
    expect(isSchemaValidResponsesToolName("view_image")).toBe(true);
    expect(isSchemaValidResponsesToolName("exec")).toBe(true);
    expect(isSchemaValidResponsesToolName("mcp__ctx7__get-docs")).toBe(true);
    expect(isSchemaValidResponsesToolName("default.view_image")).toBe(false);
    expect(isSchemaValidResponsesToolName("mcp__ctx7.get_docs")).toBe(false);
    expect(isSchemaValidResponsesToolName("view image")).toBe(false);
    expect(isSchemaValidResponsesToolName("")).toBe(false);
  });
});

describe("default-namespaced helper names under a code-mode catalog", () => {
  test("a dotted helper whose suffix resolves to the one declared tool is emitted as that tool", () => {
    // The two names from the report, verbatim.
    expect(normalizedNames(
      CODE_MODE_BODY,
      { type: "function_call", call_id: "c1", name: "default.view_image", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "default.apply_patch", arguments: "{}" },
    )).toEqual(["exec", "exec"]);
  });

  test("the guard already admitted these names, which is why they reached the client", () => {
    expect(guardVerdict(CODE_MODE_BODY, {
      type: "function_call", call_id: "c1", name: "default.view_image", arguments: "{}",
    })).toBeUndefined();
  });

  test("every emitted name is one the upstream schema accepts", () => {
    const names = normalizedNames(
      CODE_MODE_BODY,
      { type: "function_call", call_id: "c1", name: "default.view_image", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "default.exec_command", arguments: "{}" },
      { type: "function_call", call_id: "c3", name: "default.write_stdin", arguments: "{}" },
    ) as string[];
    for (const name of names) expect(isSchemaValidResponsesToolName(name)).toBe(true);
  });

  test("a dotted suffix that matches no declared tool is refused, not renamed", () => {
    const item = { type: "function_call", call_id: "c1", name: "default.lookup", arguments: "{}" };
    expect(normalizedNames(CODE_MODE_BODY, item)).toEqual(["default.lookup"]);
    expect(guardVerdict(CODE_MODE_BODY, item)).toBe("default.lookup");
  });
});

describe("default wrapper around a declared flattened namespace identity", () => {
  const canonical = "mcp__codex_app__send_message_to_thread";
  const wrapped = `default.${canonical}`;

  test("the exact Muse callback name normalizes to the declared canonical identity", () => {
    const item = { type: "function_call", call_id: "c1", name: wrapped, arguments: "{}" };
    expect(normalizedNames(CODEX_APP_BODY, item)).toEqual([canonical]);
    expect(guardVerdict(CODEX_APP_BODY, item)).toBeUndefined();
  });

  test("a namespace-dropping guess and an unknown suffix stay rejected", () => {
    for (const name of [
      "default.send_message_to_thread",
      "default.mcp__codex_app__delete_everything",
    ]) {
      const item = { type: "function_call", call_id: "c1", name, arguments: "{}" };
      expect(normalizedNames(CODEX_APP_BODY, item)).toEqual([name]);
      expect(guardVerdict(CODEX_APP_BODY, item)).toBe(name);
    }
  });
});

describe("names the emit boundary must not touch", () => {
  test("a canonical declared name passes through byte-identical", () => {
    const item = { type: "function_call", call_id: "c1", name: "view_image", arguments: "{}" };
    const { declared, declaredBare } = declarationsOf(CLASSIC_BODY);
    const response = responseWith(item);
    const result = normalizeDefaultNamespaceInResponse(response, declared, declaredBare);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(response);
  });

  test("a declared bare tool keeps the #4176 rewrite to the bare name, not to exec", () => {
    expect(normalizedNames(
      CLASSIC_BODY,
      { type: "function_call", call_id: "c1", name: "default.view_image", arguments: "{}" },
    )).toEqual(["view_image"]);
  });

  test("a dotted name the caller itself declared is a real identity and is left alone", () => {
    // `default` here is a genuine namespace the request declared, so `default.view_image` is the
    // flattened spelling of a tool the caller owns. Two declared identities claim the suffix
    // `view_image`; rewriting either onto the other would dispatch a call the caller never made.
    const ambiguous = {
      tools: [
        { type: "function", name: "view_image", parameters: { type: "object" } },
        { type: "namespace", name: "default", tools: [{ type: "function", name: "view_image", parameters: { type: "object" } }] },
      ],
    };
    const item = { type: "function_call", call_id: "c1", name: "default.view_image", arguments: "{}" };
    const { declared, declaredBare } = declarationsOf(ambiguous);
    expect(declared.has("default.view_image")).toBe(true);
    const response = responseWith(item);
    const result = normalizeDefaultNamespaceInResponse(response, declared, declaredBare);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(response);
  });

  test("a name invalid for a reason other than the namespace is refused rather than guessed at", () => {
    for (const name of ["view image", "view_image!", "exec/apply_patch"]) {
      const item = { type: "function_call", call_id: "c1", name, arguments: "{}" };
      expect(normalizedNames(CODE_MODE_BODY, item)).toEqual([name]);
      expect(guardVerdict(CODE_MODE_BODY, item)).toBe(name);
    }
  });

  test("a non-call item carrying a dotted name field is not a tool identity", () => {
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "default.view_image" }] };
    const { declared, declaredBare } = declarationsOf(CODE_MODE_BODY);
    const response = responseWith(message);
    expect(normalizeDefaultNamespaceInResponse(response, declared, declaredBare).value).toBe(response);
  });
});

describe("a replay mixing damaged and undamaged items", () => {
  test("only the damaged item changes and the rest are preserved value-identically", () => {
    const undamagedOne = { type: "function_call", call_id: "c1", name: "view_image", arguments: "{\"path\":\"a.png\"}" };
    const damaged = { type: "function_call", call_id: "c2", name: "default.apply_patch", arguments: "{}" };
    const undamagedTwo = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
    const { declared, declaredBare } = declarationsOf(CLASSIC_BODY);
    const response = responseWith(undamagedOne, damaged, undamagedTwo);
    const result = normalizeDefaultNamespaceInResponse(response, declared, declaredBare);
    expect(result.changed).toBe(true);
    const output = (result.value as { output: unknown[] }).output;
    expect(output[0]).toBe(undamagedOne);
    expect(output[1]).toEqual({ type: "function_call", call_id: "c2", name: "apply_patch", arguments: "{}" });
    expect(output[2]).toBe(undamagedTwo);
  });
});

describe("the streaming boundary the report actually crossed", () => {
  const blocks = (rewrite: (block: string) => readonly string[], items: readonly unknown[]): string[] => {
    const out: string[] = [];
    for (const item of items) {
      const payload = JSON.stringify({ type: "response.output_item.added", output_index: 0, item });
      out.push(...rewrite(`event: response.output_item.added\ndata: ${payload}`));
    }
    return out;
  };

  test("the streamed item is rewritten to the authorized name", () => {
    const { declared, declaredBare } = declarationsOf(CODE_MODE_BODY);
    const rewrite = createUndeclaredToolCallGuardBlockRewrite(declared, undefined, undefined, declaredBare);
    const emitted = blocks(rewrite, [
      { type: "function_call", id: "fc_1", call_id: "c1", name: "default.view_image", arguments: "{}" },
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('"name":"exec"');
    expect(emitted[0]).not.toContain("default.view_image");
  });

  test("the streamed Muse callback keeps its declared namespace identity", () => {
    const { declared, declaredBare } = declarationsOf(CODEX_APP_BODY);
    const rewrite = createUndeclaredToolCallGuardBlockRewrite(declared, undefined, undefined, declaredBare);
    const emitted = blocks(rewrite, [{
      type: "function_call",
      id: "fc_1",
      call_id: "c1",
      name: "default.mcp__codex_app__send_message_to_thread",
      arguments: "{}",
    }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('"name":"mcp__codex_app__send_message_to_thread"');
    expect(emitted[0]).not.toContain("default.mcp__codex_app");
  });

  test("an unresolvable dotted name ends the turn instead of reaching the client", () => {
    const { declared, declaredBare } = declarationsOf(CODE_MODE_BODY);
    const rewrite = createUndeclaredToolCallGuardBlockRewrite(declared, undefined, undefined, declaredBare);
    const emitted = blocks(rewrite, [
      { type: "function_call", id: "fc_1", call_id: "c1", name: "default.lookup", arguments: "{}" },
    ]);
    expect(emitted.join("\n")).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(emitted.join("\n")).toContain("response.failed");
  });
});
