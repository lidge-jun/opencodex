import { describe, expect, test } from "bun:test";
import { applyOptimizations } from "../../src/optimize";
import type { OcxConfig } from "../../src/types/config";
import type { OcxParsedRequest } from "../../src/types/request";

describe("Optimization pipeline", () => {
  test("does nothing when config.optimize is unset", async () => {
    const parsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      stream: false,
      options: {},
      context: {
        systemPrompt: ["Hello"],
        messages: [{ role: "user", content: "World", timestamp: Date.now() }],
      },
    };

    const config: OcxConfig = { port: 3000 };
    await applyOptimizations(parsed, config);
    expect(parsed.context.systemPrompt?.length).toBe(1);
    expect(parsed.context.messages[0]!.content).toBe("World");
  });

  test("applies RTK and Ponytail according to config", async () => {
    const longDiff = [
      "diff --git a/test.ts b/test.ts",
      "--- a/test.ts",
      "+++ b/test.ts",
      "@@ -1,150 +1,150 @@",
      ...Array.from({ length: 150 }, (_, i) => `+line ${i} test payload exceeding minimum compress limit of 500 bytes`),
    ].join("\n");

    const parsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      stream: false,
      options: {},
      context: {
        systemPrompt: ["Base prompt"],
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "bash",
            isError: false,
            timestamp: Date.now(),
            content: longDiff,
          },
        ],
      },
    };

    const config: OcxConfig = {
      port: 3000,
      optimize: {
        rtkEnabled: true,
        ponytailEnabled: true,
        ponytailLevel: "ultra",
      },
    };

    await applyOptimizations(parsed, config);

    // Ponytail injected
    expect(parsed.context.systemPrompt?.length).toBe(2);
    expect(parsed.context.systemPrompt![1]).toContain("Ultra: YAGNI extremist");

    // RTK compressed
    expect((parsed.context.messages[0]!.content as string).length).toBeLessThan(longDiff.length);
  });

  test("applies optimizations to raw body for native lanes", async () => {
    const { applyOptimizationsToRawBody } = await import("../../src/optimize");
    const longDiff = [
      "diff --git a/test.ts b/test.ts",
      "--- a/test.ts",
      "+++ b/test.ts",
      "@@ -1,150 +1,150 @@",
      ...Array.from({ length: 150 }, (_, i) => `+line ${i} test payload exceeding minimum compress limit of 500 bytes`),
    ].join("\n");

    const rawBody = {
      messages: [
        { role: "user", content: "test" },
        { role: "tool", content: longDiff },
      ],
    };

    const config: OcxConfig = {
      port: 3000,
      optimize: {
        rtkEnabled: true,
        ponytailEnabled: true,
        ponytailLevel: "full",
      },
    };

    await applyOptimizationsToRawBody(rawBody, config, "claude-3-7-sonnet");

    // Ponytail injected into rawBody system message
    expect(rawBody.messages.some(m => m.role === "system" && m.content.includes("lazy senior developer"))).toBe(true);

    // RTK compressed tool message in rawBody
    const toolMsg = rawBody.messages.find(m => m.role === "tool");
    expect(toolMsg!.content.length).toBeLessThan(longDiff.length);
  });
});
