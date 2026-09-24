import { describe, expect, test } from "bun:test";
import {
  ADMISSION_TOLERANCE,
  checkComboTargetInputAdmission,
  checkInputAdmission,
  estimateInputTokens,
  resolveInputCeiling,
  resolveOutputCeiling,
} from "../../src/server/responses/input-admission";
import { modelRecordValue } from "../../src/reasoning-effort";
import { messagesToChatFormat } from "../../src/adapters/openai-chat/messages";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../src/types";

const CANONICAL_NATIVE: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};

function request(messages: OcxMessage[], tools?: OcxTool[]): OcxParsedRequest {
  return {
    modelId: "test-model",
    context: { messages, ...(tools ? { tools } : {}) },
    stream: false,
    options: {},
  } as OcxParsedRequest;
}

function userText(text: string): OcxMessage {
  return { role: "user", content: text, timestamp: 0 };
}

/** Create a replay whose thinking alone exceeds the test model's context window. */
function replayedThinking(): OcxParsedRequest {
  return {
    ...request([
      userText("Continue."),
      { role: "assistant", timestamp: 0, content: [
        { type: "thinking", thinking: asciiTokens(30_000) },
        { type: "text", text: "Done." },
      ] },
    ]),
    modelId: "m",
  };
}

/** Roughly `tokens` worth of plain ASCII at the default 4 chars/token ratio. */
function asciiTokens(tokens: number): string {
  return "a".repeat(tokens * 4);
}

describe("resolveInputCeiling", () => {
  test("prefers the per-model window over the provider-wide one", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      contextWindow: 8_000,
      modelContextWindows: { "m": 32_000 },
    };
    expect(resolveInputCeiling(provider, "custom", "m")).toBe(32_000);
    expect(resolveInputCeiling(provider, "custom", "other")).toBe(8_000);
  });

  test("modelMaxInputTokens can only tighten the window", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      modelContextWindows: { "m": 32_000 },
      modelMaxInputTokens: { "m": 20_000 },
    };
    expect(resolveInputCeiling(provider, "custom", "m")).toBe(20_000);
  });

  test("a looser modelMaxInputTokens never widens the window", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      modelContextWindows: { "m": 32_000 },
      modelMaxInputTokens: { "m": 90_000 },
    };
    expect(resolveInputCeiling(provider, "custom", "m")).toBe(32_000);
  });

  test("returns null when nothing is configured", () => {
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.test/v1" };
    expect(resolveInputCeiling(provider, "custom", "m")).toBeNull();
  });

  test("resolves the native window from static metadata for a canonical route", () => {
    // The `openai` registry entry carries no context fields, so without the native
    // fallback the gate would be inert on the default Codex route.
    expect(resolveInputCeiling(CANONICAL_NATIVE, "openai", "gpt-5.6-sol")).toBe(272_000);
  });

  test("a custom provider merely NAMED openai does not inherit native limits", () => {
    const impostor: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://impostor.test/v1",
      authMode: "key",
    };
    expect(resolveInputCeiling(impostor, "openai", "gpt-5.6-sol")).toBeNull();
  });

  test("a routed provider/model id does not take the native fallback", () => {
    expect(resolveInputCeiling(CANONICAL_NATIVE, "openai", "vendor/gpt-5.6-sol")).toBeNull();
  });

  test("an explicit user window still wins over native metadata", () => {
    const pinned: OcxProviderConfig = { ...CANONICAL_NATIVE, modelContextWindows: { "gpt-5.6-sol": 50_000 } };
    expect(resolveInputCeiling(pinned, "openai", "gpt-5.6-sol")).toBe(50_000);
  });

  test("a family entry covers its tagged siblings, like the catalog", () => {
    // The catalog resolves modelContextWindows through modelRecordValue, so it advertises
    // 131_072 for gpt-oss:120b off this config. A bare lookup here resolved nothing and
    // fell back to contextWindow, leaving the gate refusing turns the model can hold.
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      contextWindow: 8_000,
      modelContextWindows: { "gpt-oss": 131_072 },
    };
    expect(modelRecordValue(provider.modelContextWindows, "gpt-oss:120b")).toBe(131_072);
    expect(resolveInputCeiling(provider, "custom", "gpt-oss:120b")).toBe(131_072);
    // An id with no tag and no entry still falls back to the provider-wide window.
    expect(resolveInputCeiling(provider, "custom", "other")).toBe(8_000);
  });

  test("an exact entry still beats the family entry", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      modelContextWindows: { "gpt-oss": 131_072, "gpt-oss:20b": 32_000 },
    };
    expect(resolveInputCeiling(provider, "custom", "gpt-oss:20b")).toBe(32_000);
    expect(resolveInputCeiling(provider, "custom", "gpt-oss:120b")).toBe(131_072);
  });

  test("a family modelMaxInputTokens tightens its tagged siblings", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      modelContextWindows: { "gpt-oss": 131_072 },
      modelMaxInputTokens: { "gpt-oss": 40_000 },
    };
    expect(resolveInputCeiling(provider, "custom", "gpt-oss:120b")).toBe(40_000);
  });
});

describe("estimateInputTokens", () => {
  test("counts assistant thinking blocks and tool-call arguments", () => {
    // A walk that only counted {type:"text"} would report ~0 here, which is exactly the
    // shape of an agent conversation that triggers this gate.
    const parsed = request([{
      role: "assistant",
      timestamp: 0,
      content: [
        { type: "thinking", thinking: asciiTokens(500) },
        { type: "toolCall", id: "c1", name: "apply_patch", arguments: { patch: asciiTokens(500) } },
      ],
    }]);
    expect(estimateInputTokens(parsed, "test-model")).toBeGreaterThan(900);
  });

  test("counts tool name, description, and parameter schema", () => {
    const bare = estimateInputTokens(request([userText("hi")]), "test-model");
    const withTools = estimateInputTokens(request([userText("hi")], [{
      name: "search",
      description: asciiTokens(300),
      parameters: { type: "object", properties: { q: { type: "string", description: asciiTokens(300) } } },
    }]), "test-model");
    expect(withTools - bare).toBeGreaterThan(500);
  });

  test("charges a data: image by decoded size, not URL length", () => {
    // base64 inflates by 4/3, so charging the string would overcount by a third.
    const base64 = "A".repeat(75_000);
    const parsed = request([{
      role: "user",
      timestamp: 0,
      content: [{ type: "image", imageUrl: `data:image/png;base64,${base64}` }],
    }]);
    const decoded = Math.floor((75_000 * 3) / 4);
    expect(estimateInputTokens(parsed, "test-model")).toBe(Math.ceil(decoded / 750));
  });

  test("charges a remote image a flat cost, not its URL length", () => {
    const short = request([{
      role: "user",
      timestamp: 0,
      content: [{ type: "image", imageUrl: "https://example.test/a.png" }],
    }]);
    const long = request([{
      role: "user",
      timestamp: 0,
      content: [{ type: "image", imageUrl: `https://example.test/${"b".repeat(4_000)}.png` }],
    }]);
    expect(estimateInputTokens(short, "test-model")).toBe(estimateInputTokens(long, "test-model"));
  });

  test("Korean text costs more than the same number of ASCII characters", () => {
    const korean = estimateInputTokens(request([userText("한".repeat(4_000))]), "test-model");
    const ascii = estimateInputTokens(request([userText("a".repeat(4_000))]), "test-model");
    expect(korean).toBeGreaterThan(ascii);
  });
});

describe("checkInputAdmission", () => {
  const provider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    modelContextWindows: { "m": 10_000 },
  };

  /** Compare direct admission with the actual serialized reasoning payload. */
  test("ignores reasoning that openai-chat drops but counts preserved and native reasoning", () => {
    const parsed = replayedThinking();
    const dropped = checkInputAdmission(parsed, provider, "custom", "m");
    expect(dropped.admitted).toBe(true);
    expect(dropped.estimatedTokens).toBeLessThan(100);
    expect(JSON.stringify(messagesToChatFormat(parsed, provider))).not.toContain("reasoning_content");
    expect(JSON.stringify(messagesToChatFormat(parsed, provider))).not.toContain(asciiTokens(30_000));

    const preserved = { ...provider, preserveReasoningContentModels: ["m"] };
    expect(JSON.stringify(messagesToChatFormat(parsed, preserved))).toContain("reasoning_content");
    expect(JSON.stringify(messagesToChatFormat(parsed, preserved))).toContain(asciiTokens(30_000));
    expect(checkInputAdmission(parsed, preserved, "custom", "m").admitted).toBe(false);
    expect(checkInputAdmission(parsed, { ...provider, adapter: "openai-responses" }, "custom", "m").admitted).toBe(false);
  });

  test("admits input under the ceiling", () => {
    const result = checkInputAdmission(request([userText(asciiTokens(5_000))]), provider, "custom", "m");
    expect(result.admitted).toBe(true);
    expect(result.ceiling).toBe(10_000);
  });

  test("admits input over the ceiling but inside the tolerance", () => {
    // The estimator has a real error bar, so 1.0x-2.5x is deliberately not refused.
    const result = checkInputAdmission(request([userText(asciiTokens(15_000))]), provider, "custom", "m");
    expect(result.admitted).toBe(true);
  });

  test("refuses input past the tolerance", () => {
    const result = checkInputAdmission(request([userText(asciiTokens(40_000))]), provider, "custom", "m");
    expect(result.admitted).toBe(false);
    expect(result.ceiling).toBe(10_000);
    expect(result.estimatedTokens).toBeGreaterThan(10_000 * ADMISSION_TOLERANCE);
  });

  test("admits everything when no ceiling resolves", () => {
    const unknown: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.test/v1" };
    const result = checkInputAdmission(request([userText(asciiTokens(5_000_000))]), unknown, "custom", "m");
    expect(result.admitted).toBe(true);
    expect(result.ceiling).toBeNull();
  });

  test("the estimator CJK sampling alias does not trip the gate", () => {
    // cjkRatio samples every stride-th character. A payload of fixed-width records whose
    // length aligns with the stride samples as 100% CJK while being ~1.6% CJK, inflating
    // the estimate by 1.6x. ADMISSION_TOLERANCE exists to absorb exactly this; a payload
    // whose HONEST size fits must still be admitted.
    const record = "\uAC00" + "x".repeat(61);
    const text = record.repeat(2_033);
    const honestTokens = Math.ceil(text.length / 4);
    const aliased: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      modelContextWindows: { "m": honestTokens },
    };
    const result = checkInputAdmission(request([userText(text)]), aliased, "custom", "m");
    expect(result.estimatedTokens).toBeGreaterThan(honestTokens); // the overshoot is real
    expect(result.admitted).toBe(true);                            // and absorbed
  });

  test("resolving a ceiling touches no filesystem", () => {
    // The native fallback must read static maps only; a catalog read here would put
    // synchronous file I/O on every request.
    const fs = require("node:fs");
    const watched = ["readFileSync", "existsSync", "statSync"] as const;
    const originals = watched.map(name => [name, fs[name]] as const);
    let calls = 0;
    for (const [name, fn] of originals) {
      fs[name] = (...args: unknown[]) => { calls += 1; return (fn as (...a: unknown[]) => unknown)(...args); };
    }
    try {
      resolveInputCeiling(CANONICAL_NATIVE, "openai", "gpt-5.6-sol");
    } finally {
      for (const [name, fn] of originals) fs[name] = fn;
    }
    expect(calls).toBe(0);
  });
});

describe("combo target input admission", () => {
  const capped: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    modelContextWindows: { m: 128_000 },
    modelMaxOutputTokens: { m: 32_000 },
  };

  /** Verify each combo target counts only reasoning retained by its wire compiler. */
  test("uses the target's reasoning replay policy before reserving output space", () => {
    const parsed = { ...replayedThinking(), options: { maxOutputTokens: 1_000 } };
    const target = { ...capped, modelContextWindows: { m: 10_000 }, modelMaxOutputTokens: { m: 1_000 } };
    expect(checkComboTargetInputAdmission(parsed, target, "custom", "m").admitted).toBe(true);
    expect(JSON.stringify(messagesToChatFormat(parsed, target))).not.toContain(asciiTokens(30_000));
    const preserved = { ...target, preserveReasoningContentModels: ["m"] };
    expect(checkComboTargetInputAdmission(parsed, preserved, "custom", "m").admitted).toBe(false);
    expect(JSON.stringify(messagesToChatFormat(parsed, preserved))).toContain(asciiTokens(30_000));
  });

  const withMaxOutput = (inputTokens: number, maxOutputTokens = 64_000): OcxParsedRequest => ({
    ...request([userText(asciiTokens(inputTokens))]),
    modelId: "m",
    options: { maxOutputTokens },
  });
  // A separate builder, because passing `undefined` to the one above would silently take its
  // default and the row below would assert the opposite of what it claims to cover.
  const withoutMaxOutput = (inputTokens: number): OcxParsedRequest => ({
    ...request([userText(asciiTokens(inputTokens))]),
    modelId: "m",
    options: {},
  });

  test("skips a target that cannot hold the turn plus its own output ceiling", () => {
    // 100k input + 32k of reachable output does not fit 128k, so this target would have
    // answered 200, emitted a few hundred tokens and stopped on finish_reason: length.
    const result = checkComboTargetInputAdmission(withMaxOutput(100_000), capped, "custom", "m");
    expect(result.admitted).toBe(false);
    expect(result.ceiling).toBe(128_000);
    expect(result.requiredOutputHeadroom).toBe(32_000);
  });

  test("reserves no more than the target can actually emit", () => {
    // The caller asked for 64k, but this model tops out at 32k, so reserving the caller's
    // number would skip a target that fits.
    const result = checkComboTargetInputAdmission(withMaxOutput(90_000), capped, "custom", "m");
    expect(result.admitted).toBe(true);
    expect(result.requiredOutputHeadroom).toBe(32_000);
  });

  test("an input-only cap is not charged the output reserve twice", () => {
    // modelMaxInputTokens tightens the admissible INPUT; the output reserve belongs against
    // the window. Charging both against the tightened number would refuse a turn that fits.
    const inputCapped: OcxProviderConfig = { ...capped, modelMaxInputTokens: { m: 90_000 } };
    const fits = checkComboTargetInputAdmission(withMaxOutput(85_000), inputCapped, "custom", "m");
    expect(fits.admitted).toBe(true);
    expect(fits.ceiling).toBe(90_000);
    // The input cap itself still refuses on its own terms.
    expect(checkComboTargetInputAdmission(withMaxOutput(95_000), inputCapped, "custom", "m").admitted).toBe(false);
  });

  test("unknown context stays fail-open", () => {
    const unknown: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.test/v1" };
    const result = checkComboTargetInputAdmission(withMaxOutput(2_000_000), unknown, "custom", "m");
    expect(result.admitted).toBe(true);
    expect(result.ceiling).toBeNull();
  });

  test("no declared output allowance keeps the loose direct contract", () => {
    const result = checkComboTargetInputAdmission(withoutMaxOutput(150_000), capped, "custom", "m");
    expect(result.admitted).toBe(true); // still inside the existing 2.5x pathological gate
    expect(result.requiredOutputHeadroom).toBeUndefined();
  });

  test("a canonical native slug missing from the override table resolves from generated metadata", () => {
    // Spark carries 128k/32k in the generated bundle but is absent from the narrower pinned
    // native table, which left the gate completely blind on exactly this route. It is retired
    // from the picker and still dispatchable when an operator names it in a combo target.
    expect(resolveInputCeiling(CANONICAL_NATIVE, "openai", "gpt-5.3-codex-spark")).toBe(128_000);
    expect(resolveOutputCeiling(CANONICAL_NATIVE, "openai", "gpt-5.3-codex-spark")).toBe(32_000);
    // The native Codex catalog is consulted first, and it is keyed "openai-codex" — which is NOT
    // the routing provider id, because that one is the string "openai". `gpt-5-codex-mini` exists
    // only in the native catalog, so resolving it proves the right key is being read.
    expect(resolveInputCeiling(CANONICAL_NATIVE, "openai", "gpt-5-codex-mini")).toBe(272_000);
    // A slug the override table does know keeps its own pinned window.
    expect(resolveInputCeiling(CANONICAL_NATIVE, "openai", "gpt-5.6-sol")).toBe(272_000);
    // An operator cap may only narrow the generated value, never widen it.
    expect(resolveInputCeiling(CANONICAL_NATIVE, "openai", "gpt-5.3-codex-spark", 64_000)).toBe(64_000);
    // A provider merely named openai still inherits nothing.
    const impostor: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://impostor.test/v1", authMode: "key" };
    expect(resolveInputCeiling(impostor, "openai", "gpt-5.3-codex-spark")).toBeNull();
    expect(resolveOutputCeiling(impostor, "openai", "gpt-5.3-codex-spark")).toBeNull();
  });
});
