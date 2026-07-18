import { describe, expect, test } from "bun:test";
import { codexAccountModeState } from "../gui/src/codex-multi-state";

describe("OpenAI provider account-mode presentation state", () => {
  test("distinguishes absent, disabled, pool, and direct configurations", () => {
    expect(codexAccountModeState({ providers: {} })).toBe("absent");
    expect(codexAccountModeState({ providers: { openai: { disabled: true } } })).toBe("disabled");
    expect(codexAccountModeState({ providers: { openai: { codexAccountMode: "pool" } } })).toBe("pool");
    expect(codexAccountModeState({ providers: { openai: { codexAccountMode: "direct" } } })).toBe("direct");
    expect(codexAccountModeState({ providers: { openai: {} } })).toBe("pool");
  });

  test("fails malformed and inherited provider values conservatively", () => {
    expect(codexAccountModeState({ providers: { openai: "invalid" } })).toBe("absent");
    expect(codexAccountModeState({ providers: { openai: { codexAccountMode: "invalid" } } })).toBe("absent");
    const providers = Object.create({ openai: { codexAccountMode: "pool" } }) as Record<string, unknown>;
    expect(codexAccountModeState({ providers })).toBe("absent");
  });

  test("does not revive a legacy Multi-only configuration", () => {
    expect(codexAccountModeState({ providers: { "openai-multi": { disabled: false } } })).toBe("absent");
  });
});
