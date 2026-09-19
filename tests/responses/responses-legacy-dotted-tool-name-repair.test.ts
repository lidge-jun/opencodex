/**
 * #5095, recovery half. The emit-side fix stops new `default.`-prefixed call names from being
 * created; a conversation that already contains one is still permanently unusable, because the
 * upstream refuses EVERY later request that replays the item:
 *
 *   Invalid 'input[877].name': string does not match pattern '^[a-zA-Z0-9_-]+$'.
 *
 * That is what killed a side chat opened from an 11h43m parent task, on a plain OpenAI model, from
 * history a routed provider had damaged. These pin what may and may not be rewritten on the way
 * out. The line is fail-closed in both directions: a dotted spelling the caller's own catalog
 * declares is a real tool identity and is never stripped, an ambiguous suffix is left alone, and
 * only a suffix naming exactly one declared tool or one of the bounded code-mode helper spellings
 * resolves. There is deliberately no "strip everything before the first dot" rule.
 */
import { describe, expect, test } from "bun:test";
import { repairLegacyDottedToolCallNames } from "../../src/responses/legacy-dotted-tool-name-repair";

const DAMAGED_VIEW_IMAGE = { type: "function_call", call_id: "call_a", name: "default.view_image", arguments: "{}" };
const DAMAGED_APPLY_PATCH = { type: "function_call", call_id: "call_b", name: "default.apply_patch", arguments: "{}" };

/** Codex code mode: one freeform `exec`; the helpers are nested and never declared. */
const CODE_MODE_TOOLS = [{ type: "custom", name: "exec", description: "code mode" }];

/** The classic Codex catalog, where both damaged names are declared top-level tools. */
const CLASSIC_TOOLS = [
  { type: "function", name: "view_image", parameters: { type: "object" } },
  { type: "custom", name: "apply_patch" },
];

function replay(tools: unknown[], input: unknown[]): Record<string, unknown> {
  return { model: "gpt-5.6-luna", tools, input };
}

function namesAfter(body: Record<string, unknown>): unknown[] {
  const repaired = repairLegacyDottedToolCallNames(body) as { input: Array<{ name?: unknown }> };
  return repaired.input.map(item => item.name);
}

describe("replaying a damaged history", () => {
  test("the two reported names are repaired under a code-mode catalog", () => {
    expect(namesAfter(replay(CODE_MODE_TOOLS, [DAMAGED_VIEW_IMAGE, DAMAGED_APPLY_PATCH])))
      .toEqual(["view_image", "apply_patch"]);
  });

  test("a suffix naming exactly one declared tool resolves to it", () => {
    expect(namesAfter(replay(CLASSIC_TOOLS, [DAMAGED_VIEW_IMAGE]))).toEqual(["view_image"]);
  });

  test("a declared bare tool is found through an additional_tools catalog too", () => {
    const body = replay([], [
      { type: "additional_tools", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] },
      { type: "function_call", call_id: "call_c", name: "default.lookup", arguments: "{}" },
    ]);
    expect(namesAfter(body)).toEqual([undefined, "lookup"]);
  });

  test("the whole bounded helper vocabulary resolves without being declared", () => {
    const helpers = ["exec_command", "shell_command", "write_stdin", "apply_patch", "view_image"];
    const input = helpers.map((helper, index) => ({
      type: "function_call", call_id: `call_${index}`, name: `default.${helper}`, arguments: "{}",
    }));
    expect(namesAfter(replay(CODE_MODE_TOOLS, input))).toEqual(helpers);
  });

  test("a call_id survives the rewrite, so the paired output still matches its call", () => {
    const output = { type: "function_call_output", call_id: "call_a", output: "unsupported call: default.view_image" };
    const repaired = repairLegacyDottedToolCallNames(
      replay(CODE_MODE_TOOLS, [DAMAGED_VIEW_IMAGE, output]),
    ) as { input: Array<Record<string, unknown>> };
    expect(repaired.input[0]).toEqual({ type: "function_call", call_id: "call_a", name: "view_image", arguments: "{}" });
    expect(repaired.input[1]).toBe(output);
  });
});

describe("names the repair refuses to guess at", () => {
  test("a suffix that names no declared tool and no helper is left alone", () => {
    const damaged = { type: "function_call", call_id: "call_d", name: "default.lookup", arguments: "{}" };
    expect(namesAfter(replay(CODE_MODE_TOOLS, [damaged]))).toEqual(["default.lookup"]);
  });

  test("a suffix claimed by two declared identities is ambiguous and is left alone", () => {
    const body = replay([
      { type: "namespace", name: "alpha", tools: [{ type: "function", name: "view_image", parameters: { type: "object" } }] },
      { type: "namespace", name: "beta", tools: [{ type: "function", name: "view_image", parameters: { type: "object" } }] },
    ], [DAMAGED_VIEW_IMAGE]);
    expect(namesAfter(body)).toEqual(["default.view_image"]);
  });

  test("a dotted name the caller itself declared is a real identity, not damage", () => {
    const body = replay([
      { type: "namespace", name: "default", tools: [{ type: "function", name: "view_image", parameters: { type: "object" } }] },
    ], [DAMAGED_VIEW_IMAGE]);
    expect(repairLegacyDottedToolCallNames(body)).toBe(body);
  });

  test("a suffix that is itself still invalid is not a repair", () => {
    const damaged = { type: "function_call", call_id: "call_e", name: "default.view.image", arguments: "{}" };
    expect(namesAfter(replay(CODE_MODE_TOOLS, [damaged]))).toEqual(["default.view.image"]);
  });

  test("an item carrying an explicit namespace is not the flattened shape", () => {
    const body = replay(CODE_MODE_TOOLS, [
      { type: "function_call", call_id: "call_f", name: "default.view_image", namespace: "mcp__x", arguments: "{}" },
    ]);
    expect(repairLegacyDottedToolCallNames(body)).toBe(body);
  });

  test("a name invalid for a reason other than the legacy namespace is left alone", () => {
    for (const name of ["view image", "view_image!", "other.view_image"]) {
      const damaged = { type: "function_call", call_id: "call_g", name, arguments: "{}" };
      expect(namesAfter(replay(CLASSIC_TOOLS, [damaged]))).toEqual([name]);
    }
  });
});

describe("the undamaged path", () => {
  test("a history with no legacy name is returned by reference", () => {
    const body = replay(CLASSIC_TOOLS, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "call_h", name: "view_image", arguments: "{\"path\":\"a.png\"}" },
      { type: "function_call_output", call_id: "call_h", output: "ok" },
    ]);
    expect(repairLegacyDottedToolCallNames(body)).toBe(body);
  });

  test("a body with no input array is returned by reference", () => {
    const body = { model: "gpt-5.6-luna", tools: CLASSIC_TOOLS };
    expect(repairLegacyDottedToolCallNames(body)).toBe(body);
    expect(repairLegacyDottedToolCallNames(undefined)).toBeUndefined();
  });

  test("a mixed replay repairs only the damaged item and preserves the rest by reference", () => {
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
    const healthy = { type: "function_call", call_id: "call_i", name: "view_image", arguments: "{\"path\":\"b.png\"}" };
    const body = replay(CLASSIC_TOOLS, [message, DAMAGED_APPLY_PATCH, healthy]);
    const repaired = repairLegacyDottedToolCallNames(body) as Record<string, unknown>;
    const input = repaired.input as unknown[];
    expect(repaired).not.toBe(body);
    expect(input[0]).toBe(message);
    expect(input[1]).toEqual({ type: "function_call", call_id: "call_b", name: "apply_patch", arguments: "{}" });
    expect(input[2]).toBe(healthy);
  });

  test("the caller's tool catalog is never rewritten", () => {
    const tools = [...CLASSIC_TOOLS, { type: "function", name: "default.reporting", parameters: { type: "object" } }];
    const body = replay(tools, [DAMAGED_VIEW_IMAGE]);
    const repaired = repairLegacyDottedToolCallNames(body) as Record<string, unknown>;
    expect(repaired.tools).toBe(tools);
  });

  test("a call for a dotted tool the caller declared at top level stays that call", () => {
    const tools = [{ type: "function", name: "default.reporting", parameters: { type: "object" } }];
    const body = replay(tools, [
      { type: "function_call", call_id: "call_j", name: "default.reporting", arguments: "{}" },
    ]);
    expect(repairLegacyDottedToolCallNames(body)).toBe(body);
  });
});
