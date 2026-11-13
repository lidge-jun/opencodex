import { describe, expect, test } from "bun:test";
import { groupByModelFamily, MODEL_FAMILIES, MODEL_FAMILY_IDS, modelFamily } from "../../src/lib/model-families";
import * as cli from "../../src/cli/model-picker-ordering";
import * as gui from "../../gui/src/model-picker-order";

const id = (slug: string) => modelFamily(slug).id;

describe("model family registry", () => {
  test("table order is the declared id order and ends with the catch-all", () => {
    expect(MODEL_FAMILIES.map(family => family.id)).toEqual([...MODEL_FAMILY_IDS]);
    expect(MODEL_FAMILIES.slice(0, 5).map(family => family.id)).toEqual(["gpt", "gemini", "claude", "grok", "deepseek"]);
    expect(MODEL_FAMILIES.at(-1)?.id).toBe("other");
  });

  test.each([
    ["gpt-6.1-sol", "gpt"],
    ["openai/gpt-5.5", "gpt"],
    ["openai/o3-mini", "gpt"],
    ["jd-chat/o4", "gpt"],
    ["chatgpt-4o-latest", "gpt"],
    ["google-antigravity/gemini-3.8-flash", "gemini"],
    ["agy/gemini-3.8-flash", "gemini"],
    ["agy/claude-opus-5-5-thinking", "claude"],
    ["jd-claude/sonnet-5", "claude"],
    ["anthropic/haiku-5.5", "claude"],
    ["openrouter/anthropic/claude-sonnet-4", "claude"],
    ["xai/grok-4.7", "grok"],
    ["tyler/deepseek-v4-pro", "deepseek"],
    ["openrouter/deepseek/deepseek-r1-distill-qwen-32b", "deepseek"],
    ["opencode-go/qwen3-coder", "qwen"],
    ["moonshot/kimi-k3", "kimi"],
    ["jd-chat/glm-5.2", "glm"],
    ["openrouter/z-ai/glm-4.6", "glm"],
    ["minimax/MiniMax-M2", "minimax"],
    ["openrouter/meta-llama/llama-3.3-70b", "llama"],
    ["mistral/codestral-latest", "mistral"],
    ["combo/mixed", "other"],
    ["ollama/phi-4", "other"],
    ["native-only", "other"],
  ])("%s is %s", (slug, family) => {
    expect(id(slug)).toBe(family as never);
  });

  test("the model part decides before the provider prefix, which is only a fallback", () => {
    expect(id("claude-sub/gpt-6")).toBe("gpt");
    expect(id("gemini-relay/anthropic-opus")).toBe("claude");
    expect(id("kimi-coding/turbo")).toBe("kimi");
    expect(id("combo/gemini-or-claude")).toBe("gemini");
  });

  test("grouping keeps registry order and each family's incoming order", () => {
    const rows = ["x/grok-4", "x/gpt-b", "x/zzz", "x/claude-a", "x/gpt-a", "x/gemini-1"];
    const groups = groupByModelFamily(rows, row => row);
    expect(groups.map(group => group.family.id)).toEqual(["gpt", "gemini", "claude", "grok", "other"]);
    expect(groups[0]!.items).toEqual(["x/gpt-b", "x/gpt-a"]);
  });

  test("family mode makes each family one run, and the CLI and GUI ports agree", () => {
    const slugs = ["a/grok-4", "b/gpt-5", "a/claude-opus", "a/deepseek-v4", "c/gemini-3", "a/gpt-6", "b/zzz", "b/claude-sonnet"];
    const expected = ["a/gpt-6", "b/gpt-5", "c/gemini-3", "a/claude-opus", "b/claude-sonnet", "a/grok-4", "a/deepseek-v4", "b/zzz"];
    expect(cli.modelPickerOrder("family", slugs)).toEqual(expected);
    expect(gui.modelPickerOrder("family", slugs)).toEqual(expected);
    expect(gui.isPickerOrderSaved({ pickerOrder: expected, pickerOrderMode: "family" })).toBe(true);
    expect(cli.isPickerOrderSaved({ pickerOrder: expected, pickerOrderMode: "family" })).toBe(true);
  });
});
