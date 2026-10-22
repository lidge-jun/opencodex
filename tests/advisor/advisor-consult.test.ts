import { afterEach, describe, expect, test } from "bun:test";
import { consultAdvisor, ADVISOR_INTERNAL_HEADER, advisorDestinationOrigin } from "../../src/advisor/consult";
import { internalCallCapability } from "../../src/lib/local-internal-call-capability";
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
  test("question-only sends only the question over real loopback independently of history size", async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      bodies.push(await req.json());
      return Response.json({ choices: [{ message: { content: "Check the refresh boundary." } }] });
    } });
    try {
      for (const size of [1, 100_000]) {
        const input = { ...baseInput, contextMode: "question-only" as const, question: "How should I test token expiry?",
          parsed: parseRequest({ model: "worker", input: [{ role: "user", content: "HISTORY_SENTINEL".repeat(size) }],
            tools: [{ type: "function", name: "private_tool", description: "CATALOG_SENTINEL", parameters: {} }] }) };
        expect((await consultAdvisor(input, {}, "medium", 5_000, undefined, `http://127.0.0.1:${server.port}`)).ok).toBe(true);
      }
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0]!.messages).toHaveLength(2);
      expect(bodies[0]!.messages[1]).toEqual({ role: "user", content: "How should I test token expiry?" });
      const wire = JSON.stringify(bodies[0]);
      for (const omitted of ["HISTORY_SENTINEL", "CATALOG_SENTINEL", "private_tool", baseInput.workerIdentity]) expect(wire).not.toContain(omitted);
    } finally { server.stop(true); }
  });

  test("question-only rejects empty questions without sending a request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    for (const question of [undefined, "", "   "]) {
      const result = await consultAdvisor({ ...baseInput, contextMode: "question-only", question }, {}, "max", 5000);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("question");
    }
    expect(calls).toBe(0);
  });

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
    // The fence header carries this process's server-owned capability, never a literal.
    expect(seenHeaders[ADVISOR_INTERNAL_HEADER]).toBe(internalCallCapability());
    expect(seenHeaders[ADVISOR_INTERNAL_HEADER]).not.toBe("1");
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
