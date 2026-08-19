import { describe, expect, test } from "bun:test";
import {
  AGR_PREAMBLE_MARKER,
  applyAgrLanguagePreamble,
  isAgentRouterBaseUrl,
} from "../src/adapters/anthropic";

describe("AgentRouter language preamble (#2074)", () => {
  test("detects AgentRouter base URLs by hostname", () => {
    expect(isAgentRouterBaseUrl("https://agentrouter.org")).toBe(true);
    expect(isAgentRouterBaseUrl("https://agentrouter.org/v1")).toBe(true);
    expect(isAgentRouterBaseUrl("https://api.anthropic.com")).toBe(false);
    expect(isAgentRouterBaseUrl("not a url")).toBe(false);
  });

  test("prepends the frame to a string first user message", () => {
    const messages = [
      { role: "user", content: "responda apenas: OK" },
      { role: "assistant", content: "OK" },
    ];
    applyAgrLanguagePreamble(messages);
    const first = messages[0] as { content: string };
    expect(first.content.startsWith(AGR_PREAMBLE_MARKER)).toBe(true);
    expect(first.content).toContain("responda apenas: OK");
  });

  test("prepends into the first text part of structured content", () => {
    const messages = [
      { role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "hola" }] },
    ];
    applyAgrLanguagePreamble(messages);
    const parts = (messages[0] as { content: Array<{ type: string; text?: string }> }).content;
    const text = parts.find(p => p.type === "text");
    expect(text?.text?.startsWith(AGR_PREAMBLE_MARKER)).toBe(true);
    expect(text?.text).toContain("hola");
  });

  test("inserts a text part when the first message has none", () => {
    const messages = [{ role: "user", content: [{ type: "image", source: {} }] }];
    applyAgrLanguagePreamble(messages);
    const parts = (messages[0] as { content: Array<{ type: string; text?: string }> }).content;
    expect(parts[0]?.type).toBe("text");
    expect(parts[0]?.text).toContain(AGR_PREAMBLE_MARKER);
  });

  test("is idempotent — replays do not stack frames", () => {
    const messages = [{ role: "user", content: "bonjour" }];
    applyAgrLanguagePreamble(messages);
    applyAgrLanguagePreamble(messages);
    const content = (messages[0] as { content: string }).content;
    expect(content.split(AGR_PREAMBLE_MARKER).length - 1).toBe(1);
  });

  test("no user message is a no-op", () => {
    const messages = [{ role: "assistant", content: "hi" }];
    applyAgrLanguagePreamble(messages);
    expect(messages).toEqual([{ role: "assistant", content: "hi" }]);
  });
});
