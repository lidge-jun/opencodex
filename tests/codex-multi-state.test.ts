import { describe, expect, test } from "bun:test";
import { codexMultiProviderState } from "../gui/src/codex-multi-state";

describe("Codex Multi provider presentation state", () => {
  test("distinguishes absent, enabled, and disabled configurations", () => {
    expect(codexMultiProviderState({ providers: {} })).toBe("absent");
    expect(codexMultiProviderState({
      providers: { "openai-multi": { disabled: false } },
    })).toBe("enabled");
    expect(codexMultiProviderState({
      providers: { "openai-multi": { disabled: true } },
    })).toBe("disabled");
  });

  test("uses own-property presence instead of inherited provider names", () => {
    const providers = Object.create({ "openai-multi": { disabled: false } }) as Record<string, unknown>;
    expect(codexMultiProviderState({ providers })).toBe("absent");
  });
});
