import { describe, expect, test } from "bun:test";
import { hasFirstOutput, resolveFirstOutputFailover, withFirstOutputFailover } from "../../src/server/first-output-failover";

const enc = new TextEncoder();
const frame = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

function sse(parts: Array<{ afterMs: number; text: string }>, onCancel?: () => void): Response {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const p of parts) {
        await Bun.sleep(p.afterMs);
        if (cancelled) return;
        controller.enqueue(enc.encode(p.text));
      }
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; onCancel?.(); },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatRequest(model: string, stream = true): Request {
  return new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("hasFirstOutput", () => {
  test("role preamble is not output", () => {
    expect(hasFirstOutput(frame({ role: "assistant", content: "" }))).toBe(false);
  });
  test("content, reasoning and tool calls are output", () => {
    expect(hasFirstOutput(frame({ content: "x" }))).toBe(true);
    expect(hasFirstOutput(frame({ reasoning_content: "t" }))).toBe(true);
    expect(hasFirstOutput(frame({ tool_calls: [{ index: 0 }] }))).toBe(true);
  });
});

const rules = (afterMs: number) => ({ "xai/grok-composer-2.5-fast": { to: "cursor/composer-2.5-fast", afterMs } });

describe("resolveFirstOutputFailover", () => {
  test("ignores unset, zero, self-targeting and empty rules", () => {
    expect(resolveFirstOutputFailover(undefined, "m")).toBeUndefined();
    expect(resolveFirstOutputFailover({ m: { to: "n", afterMs: 0 } }, "m")).toBeUndefined();
    expect(resolveFirstOutputFailover({ m: { to: "m", afterMs: 100 } }, "m")).toBeUndefined();
    expect(resolveFirstOutputFailover({ m: { to: " ", afterMs: 100 } }, "m")).toBeUndefined();
    expect(resolveFirstOutputFailover({ m: { to: "n", afterMs: 100 } }, "m")).toEqual({ to: "n", afterMs: 100 });
  });
});

describe("withFirstOutputFailover", () => {
  test("no rules calls the handler once with the original request", async () => {
    let calls = 0;
    const res = await withFirstOutputFailover(chatRequest("xai/grok-composer-2.5-fast"), undefined, async () => { calls++; return new Response("ok"); });
    expect(await res.text()).toBe("ok");
    expect(calls).toBe(1);
  });

  test("silent xAI stream fails over to cursor with the same body", async () => {
    const seen: string[] = [];
    let xaiCancelled = false;
    const handle = async (req: Request) => {
      const body = await req.json() as { model: string; messages: unknown[] };
      seen.push(body.model);
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      if (body.model === "xai/grok-composer-2.5-fast") {
        return sse([{ afterMs: 5, text: frame({ role: "assistant", content: "" }) }, { afterMs: 2000, text: frame({ content: "late" }) }], () => { xaiCancelled = true; });
      }
      return sse([{ afterMs: 5, text: frame({ content: "cursor" }) }, { afterMs: 1, text: "data: [DONE]\n\n" }]);
    };
    const events: string[] = [];
    const t0 = Date.now();
    const res = await withFirstOutputFailover(chatRequest("xai/grok-composer-2.5-fast"), rules(200), handle, (f, t) => events.push(`${f}->${t}`));
    const text = await res.text();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(seen).toEqual(["xai/grok-composer-2.5-fast", "cursor/composer-2.5-fast"]);
    expect(text).toContain("cursor");
    expect(text).not.toContain("late");
    expect(xaiCancelled).toBe(true);
    expect(events).toEqual(["xai/grok-composer-2.5-fast->cursor/composer-2.5-fast"]);
  });

  test("prompt xAI output streams through without calling cursor", async () => {
    const seen: string[] = [];
    const handle = async (req: Request) => {
      const body = await req.json() as { model: string };
      seen.push(body.model);
      return sse([
        { afterMs: 5, text: frame({ role: "assistant", content: "" }) },
        { afterMs: 5, text: frame({ content: "A" }) },
        { afterMs: 300, text: frame({ content: "B" }) },
        { afterMs: 1, text: "data: [DONE]\n\n" },
      ]);
    };
    const res = await withFirstOutputFailover(chatRequest("xai/grok-composer-2.5-fast"), rules(100), handle);
    const text = await res.text();
    expect(seen).toEqual(["xai/grok-composer-2.5-fast"]);
    expect(text.indexOf("\"A\"")).toBeLessThan(text.indexOf("\"B\""));
    expect(text).toContain("[DONE]");
  });

  test("other models and non-streaming requests are passed through once", async () => {
    const seen: string[] = [];
    const handle = async (req: Request) => {
      seen.push((await req.json() as { model: string }).model);
      return sse([{ afterMs: 500, text: frame({ content: "slow" }) }]);
    };
    await (await withFirstOutputFailover(chatRequest("gpt-6-sol--fast"), rules(50), handle)).text();
    await (await withFirstOutputFailover(chatRequest("xai/grok-composer-2.5-fast", false), rules(50), handle)).text();
    expect(seen).toEqual(["gpt-6-sol--fast", "xai/grok-composer-2.5-fast"]);
  });

  test("upstream error is returned without failover", async () => {
    const seen: string[] = [];
    const handle = async (req: Request) => {
      seen.push((await req.json() as { model: string }).model);
      return new Response("{\"error\":{}}", { status: 403 });
    };
    const res = await withFirstOutputFailover(chatRequest("xai/grok-composer-2.5-fast"), rules(50), handle);
    expect(res.status).toBe(403);
    expect(seen).toEqual(["xai/grok-composer-2.5-fast"]);
  });
});
