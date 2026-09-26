import { afterEach, describe, expect, test } from "bun:test";
import { consultAdvisor, ADVISOR_INTERNAL_HEADER, advisorDestinationOrigin } from "../../src/advisor/consult";
import type { OcxParsedRequest } from "../../src/types";
import { parseRequest } from "../../src/responses/parser";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const parsed: OcxParsedRequest = parseRequest({
  model: "deepseek/deepseek-v4",
  stream: false,
  input: [{ role: "user", content: "Fix the failing auth tests" }],
});

const baseInput = {
  parsed,
  workerIdentity: "deepseek-v4 (provider deepseek)",
  advisorModel: "gpt-6-astra",
  reason: "manual" as const,
};

describe("consultAdvisor", () => {
  test("sends the advisor chat completion through the loopback with the internal fence header", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Check the token refresh window first." } }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test");

    expect(result.ok).toBe(true);
    expect(result.advice).toContain("token refresh window");
    expect(result.usage?.inputTokens).toBe(120);
    expect(result.usage?.outputTokens).toBe(40);
    expect(seenUrl).toBe("http://advisor.test/v1/chat/completions");
    expect(seenHeaders[ADVISOR_INTERNAL_HEADER]).toBe("1");
    expect(seenBody.model).toBe("gpt-6-astra");
    expect(seenBody.stream).toBe(false);
    expect(seenBody.reasoning_effort).toBe("max");
    const messages = seenBody.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
  });

  test("resolves the loopback destination from the config port", () => {
    expect(advisorDestinationOrigin({ port: 10104 })).toBe("http://127.0.0.1:10104");
  });

  test("upstream HTTP failure fails open with a bounded, redacted error", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream exploded with secret sk-abc123456", { status: 502 })) as typeof fetch;
    const result = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test");
    expect(result.ok).toBe(false);
    expect(result.advice).toBe("");
    expect(result.error).toContain("502");
    // Secrets are redacted from the failure text before it can reach any context.
    expect(result.error).not.toContain("sk-abc123456");
  });

  test("connection refused fails open with a connect error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:10100");
    }) as typeof fetch;
    const result = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("connect_error");
  });

  test("non-JSON and empty responses fail open without throwing", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    const nonJson = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test");
    expect(nonJson.ok).toBe(false);

    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
    const empty = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test");
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("no text");
  });
});
