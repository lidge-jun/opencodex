import { describe, expect, test } from "bun:test";
import { baseProviderLabel } from "../../src/providers/label";

describe("baseProviderLabel", () => {
  test("returns the input when there is no pool suffix", () => {
    expect(baseProviderLabel("openai")).toBe("openai");
    expect(baseProviderLabel("anthropic")).toBe("anthropic");
  });

  test("normalizes ChatGPT auth usage into the OpenAI display provider", () => {
    expect(baseProviderLabel("chatgpt")).toBe("openai");
    expect(baseProviderLabel("chatgpt-main")).toBe("openai");
    expect(baseProviderLabel("chatgpt-p104398")).toBe("openai");
  });

  test("normalizes historical Multi rows while keeping API-key usage distinct", () => {
    expect(baseProviderLabel("openai-multi")).toBe("openai");
    expect(baseProviderLabel("openai-multi-p104398")).toBe("openai");
    expect(baseProviderLabel("openai-multi-main")).toBe("openai");
    expect(baseProviderLabel("openai-apikey")).toBe("openai-apikey");
  });

  test("strips a lowercase-hex pool suffix matching CODEX_ACCOUNT_LOG_LABEL_RE", () => {
    expect(baseProviderLabel("openai-p104398")).toBe("openai");
    expect(baseProviderLabel("anthropic-pabc123")).toBe("anthropic");
  });

  test("keeps configured provider names ending in -main distinct", () => {
    expect(baseProviderLabel("openrouter-main")).toBe("openrouter-main");
    expect(baseProviderLabel("azure-main")).toBe("azure-main");
  });

  test("strips the legacy -main suffix from the known Codex provider labels", () => {
    expect(baseProviderLabel("openai-main")).toBe("openai");
    expect(baseProviderLabel("chatgpt-main")).toBe("openai");
    expect(baseProviderLabel("openai-multi-main")).toBe("openai");
  });

  test("keeps suffixes that do not match the pool log-label shape", () => {
    expect(baseProviderLabel("chatgpt-pABC123")).toBe("chatgpt-pABC123"); // uppercase not allowed
    expect(baseProviderLabel("chatgpt-p12345")).toBe("chatgpt-p12345");   // 5 hex, not 6
    expect(baseProviderLabel("chatgpt-p1234567")).toBe("chatgpt-p1234567"); // 7 hex, not 6
    expect(baseProviderLabel("anthropic-claude")).toBe("anthropic-claude");
  });

  test("leaves bare provider names with leading or trailing dashes alone", () => {
    expect(baseProviderLabel("-pabc123")).toBe("-pabc123"); // empty head
    expect(baseProviderLabel("chatgpt-")).toBe("chatgpt-");  // empty tail
  });
});
