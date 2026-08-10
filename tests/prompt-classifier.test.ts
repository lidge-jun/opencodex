import { describe, expect, test } from "bun:test";
import { classifyPromptComplexity } from "../src/routing/prompt-classifier";

describe("prompt complexity classifier", () => {
  test("classifies short conversational prompts as fast in English and Chinese", () => {
    expect(classifyPromptComplexity("Hello!").tier).toBe("fast");
    expect(classifyPromptComplexity("你好").tier).toBe("fast");
    expect(classifyPromptComplexity("请把这句话翻译成英文").tier).toBe("fast");
  });

  test("keeps ordinary explanatory work in the balanced tier", () => {
    const result = classifyPromptComplexity(
      "Explain how an HTTP request moves through a web application, using a small example that a new developer can follow.",
    );
    expect(result.tier).toBe("balanced");
  });

  test("routes repository-scale and multi-step coding work to powerful", () => {
    const result = classifyPromptComplexity(`
Investigate the root cause in this repository and implement a safe architecture-level fix.

1. Trace the request flow.
2. Add regression tests.
3. Verify the complete test suite.

\`\`\`ts
export function route(input: unknown) {}
\`\`\`
`);
    expect(result.tier).toBe("powerful");
    expect(result.signals).toContain("complex-intent");
    expect(result.signals).toContain("multi-step");
    expect(result.signals).toContain("code-block");
  });

  test("uses an explicit reasoning effort as an additional signal", () => {
    const prompt = "Compare these two implementation approaches and recommend one.";
    expect(classifyPromptComplexity(prompt, "low").tier).toBe("fast");
    expect(classifyPromptComplexity(prompt, "xhigh").tier).toBe("powerful");
  });
});
