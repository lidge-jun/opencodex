import { afterEach, describe, expect, test } from "bun:test";
import { consultAdvisor, ADVISOR_INTERNAL_HEADER, advisorDestinationOrigin } from "../../src/advisor/consult";
import { internalCallCapability } from "../../src/lib/local-internal-call-capability";
import type { OcxParsedRequest } from "../../src/types";
import { parseRequest } from "../../src/responses/parser";
import { ADVISOR_ADMISSION_SCOPE_HEADER, decodeAdvisorAdmissionScope } from "../../src/server/advisor-admission-scope";

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
  test("parses multiline SSE events and headerless event fields split across chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of ['eve', 'nt: message\ndata: {"choices":\n', 'data: [{"delta":{"content":"Advice"}}]}\n\ndata: [DONE]\n\n']) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    globalThis.fetch = (async () => new Response(stream)) as typeof fetch;
    const result = await consultAdvisor(baseInput, {}, "max", 500, undefined, "http://advisor.test");
    expect(result.ok).toBe(true);
    expect(result.advice).toBe("Advice");
  });

  test("stops reading at DONE even when the upstream leaves the body open", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Advice"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
      },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = (async () => new Response(stream, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const result = await consultAdvisor(baseInput, {}, "max", 80, undefined, "http://advisor.test");
    expect(result.ok).toBe(true);
    expect(result.advice).toBe("Advice");
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    expect(cancelled).toBe(true);
  });
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

    const scope = { providers: ["deepseek"], models: ["deepseek/deepseek-v4"] };
    const result = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test", scope);

    expect(result.ok).toBe(true);
    expect(result.advice).toContain("token refresh window");
    expect(result.usage?.inputTokens).toBe(120);
    expect(result.usage?.outputTokens).toBe(40);
    expect(seenUrl).toBe("http://advisor.test/v1/chat/completions");
    // The fence header carries this process's server-owned capability, never a literal.
    expect(seenHeaders[ADVISOR_INTERNAL_HEADER]).toBe(internalCallCapability());
    expect(seenHeaders[ADVISOR_INTERNAL_HEADER]).not.toBe("1");
    expect(decodeAdvisorAdmissionScope(seenHeaders[ADVISOR_ADMISSION_SCOPE_HEADER] ?? null)).toEqual(scope);
    expect(seenBody.model).toBe("gpt-6-astra");
    expect(seenBody.stream).toBe(true);
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

  test("timeout and caller cancellation retain distinct safe outcomes", async () => {
    globalThis.fetch = (async () => { throw new DOMException("private timeout text", "TimeoutError"); }) as typeof fetch;
    const timeout = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test");
    expect(timeout.ok).toBe(false);
    expect(timeout.error).toBe("advisor timeout");
    const controller = new AbortController();
    globalThis.fetch = (async () => { controller.abort(); throw new Error("private cancellation text"); }) as typeof fetch;
    const cancelled = await consultAdvisor(baseInput, {}, "max", 5_000, controller.signal, "http://advisor.test");
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.error).toBe("advisor cancelled by the caller");
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

  test("an over-bound admission scope fails before any fetch, with nothing sent", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const oversized = { providers: ["deepseek"], models: ["deepseek/" + "m".repeat(20_000)] };
    const result = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test", oversized);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exceeds encoded bound");
    // The undeliverable header was caught before dispatch: no consult was ever sent.
    expect(fetchCount).toBe(0);
  });

  test("parses text/event-stream deltas, usage, and ignores heartbeat comments", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(": opencodex heartbeat\n\n"));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"First "}}]}\n\n'));
        await Bun.sleep(10);
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"second"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    globalThis.fetch = (async () => new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    })) as typeof fetch;

    const result = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test");
    expect(result.ok).toBe(true);
    expect(result.advice).toBe("First second");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  test("inactivity timeout resets on streaming data chunks but ignores heartbeat comments", async () => {
    const encoder = new TextEncoder();
    const activeStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Total duration ~75ms > 45ms timeoutMs, but each data chunk arrives within 20ms.
        for (const token of ["Step 1 ", "Step 2 ", "Step 3"]) {
          await Bun.sleep(20);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    globalThis.fetch = (async () => new Response(activeStream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })) as typeof fetch;

    const okResult = await consultAdvisor(baseInput, {}, "max", 45, undefined, "http://advisor.test");
    expect(okResult.ok).toBe(true);
    expect(okResult.advice).toBe("Step 1 Step 2 Step 3");

    // Heartbeat comments alone do NOT reset the inactivity timeout.
    let iv: ReturnType<typeof setInterval> | undefined;
    const heartbeatOnlyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        iv = setInterval(() => {
          try { controller.enqueue(encoder.encode(": opencodex heartbeat\n\n")); } catch { if (iv !== undefined) clearInterval(iv); }
        }, 12);
      },
      cancel() {
        if (iv !== undefined) clearInterval(iv);
      },
    });
    globalThis.fetch = (async (_url, init) => {
      init?.signal?.addEventListener("abort", () => {}, { once: true });
      return new Response(heartbeatOnlyStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const timedOut = await consultAdvisor(baseInput, {}, "max", 40, undefined, "http://advisor.test");
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toBe("advisor timeout");
  });

  test("in-stream SSE error returns bounded advisor HTTP 502", async () => {
    const body = 'data: {"error":{"message":"sensitive prompt echo"}}\n\n';
    globalThis.fetch = (async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })) as typeof fetch;

    const result = await consultAdvisor(baseInput, {}, "max", 5_000, undefined, "http://advisor.test");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("advisor HTTP 502");
  });

  test("headerless SSE stream resets inactivity timeout incrementally before EOF", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of ["Frame 1 ", "Frame 2 ", "Frame 3"]) {
          await Bun.sleep(25);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`));
        }
        await Bun.sleep(20);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    // No Content-Type header at all (headerless SSE). Total ~95ms > 50ms timeout.
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;

    const result = await consultAdvisor(baseInput, {}, "max", 50, undefined, "http://advisor.test");
    expect(result.ok).toBe(true);
    expect(result.advice).toBe("Frame 1 Frame 2 Frame 3");
  });
});
