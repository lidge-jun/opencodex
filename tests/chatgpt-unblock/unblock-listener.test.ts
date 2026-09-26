import { describe, expect, test } from "bun:test";
import {
  CHATGPT_UNBLOCK_IDENTITY_PATH,
  CHATGPT_UNBLOCK_SERVICE_ID,
  ChatgptUnblockDiagnostics,
  relayWithSendUnblock,
  sseRewriteStream,
} from "../../src/chatgpt/desktop-unblock/listener";

const UPSTREAM = "https://chatgpt.example";

/** A fetch stand-in that records the target and answers with `response`. */
function upstreamReturning(response: () => Response): { fetchImpl: typeof fetch; targets: string[] } {
  const targets: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    targets.push(String(input));
    return response();
  }) as typeof fetch;
  return { fetchImpl, targets };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("chatgpt unblock relay scope", () => {
  test("an unrelated endpoint carrying a closed rate_limit passes through byte-identical", async () => {
    // Reproduction from review: the whole hostname is mapped, so unrelated JSON must not change.
    const body = '{"result":{"rate_limit":{"allowed":false,"limit_reached":true}}}';
    const { fetchImpl } = upstreamReturning(() => new Response(body, { headers: { "content-type": "application/json" } }));
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/review-fixture/not-a-composer-endpoint"), UPSTREAM, fetchImpl);
    expect(await res.text()).toBe(body);
  });

  test("the usage endpoint's closed gate is opened", async () => {
    const { fetchImpl, targets } = upstreamReturning(() => json({ rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } } }));
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage?x=1"), UPSTREAM, fetchImpl);
    expect(targets).toEqual([`${UPSTREAM}/backend-api/wham/usage?x=1`]);
    expect(await res.json()).toEqual({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100 } } });
  });

  test("conversation init loses quota send blocks and reports preserved eligibility blocks", async () => {
    const diagnostics = new ChatgptUnblockDiagnostics();
    const { fetchImpl } = upstreamReturning(() => json({
      blocked_features: [
        { name: "send", block_reason: "usage_limit" },
        { name: "tpp_send", block_reason: "work_subscription_required" },
      ],
    }));
    const res = await relayWithSendUnblock(
      new Request("https://chatgpt.com/backend-api/conversation/init", { method: "POST", body: "{}" }),
      UPSTREAM, fetchImpl, diagnostics,
    );
    expect(await res.json()).toEqual({ blocked_features: [{ name: "tpp_send", block_reason: "work_subscription_required" }] });
    const identity = await relayWithSendUnblock(new Request(`https://chatgpt.com${CHATGPT_UNBLOCK_IDENTITY_PATH}`), UPSTREAM, fetchImpl, diagnostics);
    const snapshot = await identity.json() as { service: string; preservedSendBlocks: { name: string; reason: string }[] };
    expect(snapshot.service).toBe(CHATGPT_UNBLOCK_SERVICE_ID);
    expect(snapshot.preservedSendBlocks.map(({ name, reason }) => ({ name, reason }))).toEqual([
      { name: "tpp_send", reason: "work_subscription_required" },
    ]);
  });

  test("the identity path is answered locally and never relayed", async () => {
    const { fetchImpl, targets } = upstreamReturning(() => json({}));
    const res = await relayWithSendUnblock(new Request(`https://chatgpt.com${CHATGPT_UNBLOCK_IDENTITY_PATH}`), UPSTREAM, fetchImpl);
    expect(targets).toEqual([]);
    expect(((await res.json()) as { service: string }).service).toBe(CHATGPT_UNBLOCK_SERVICE_ID);
  });
});

describe("chatgpt unblock relay responses", () => {
  for (const status of [204, 205, 304]) {
    test(`a ${status} with a JSON content type is relayed without a body`, async () => {
      const { fetchImpl } = upstreamReturning(() => new Response(null, { status, headers: { "content-type": "application/json", etag: "\"v1\"" } }));
      const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage"), UPSTREAM, fetchImpl);
      expect(res.status).toBe(status);
      expect(res.body).toBeNull();
      expect(res.headers.get("etag")).toBe("\"v1\"");
    });
  }

  test("a HEAD request is answered without a body", async () => {
    const { fetchImpl } = upstreamReturning(() => json({ rate_limit: { allowed: false } }));
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage", { method: "HEAD" }), UPSTREAM, fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("an upstream failure becomes a 502 error envelope", async () => {
    const fetchImpl = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage"), UPSTREAM, fetchImpl);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { message: "chatgpt unblock relay failed: connect ECONNREFUSED" } });
  });

  test("response headers keep cookies and drop encoding, length and HTTP/3 advertisements", async () => {
    const { fetchImpl } = upstreamReturning(() => {
      const headers = new Headers({
        "content-type": "text/plain",
        "content-encoding": "br",
        "content-length": "999",
        "alt-svc": "h3=\":443\"; ma=86400",
      });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("ok", { headers });
    });
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/"), UPSTREAM, fetchImpl);
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).not.toBe("999");
    expect(res.headers.get("alt-svc")).toBeNull();
  });
});

describe("chatgpt unblock SSE rewriting", () => {
  const locked = JSON.stringify({ usage: { rate_limit: { allowed: false, limit_reached: true } } });
  const opened = JSON.stringify({ usage: { rate_limit: { allowed: true, limit_reached: false } } });

  test("a data line split across chunks is rewritten once and every other byte survives", async () => {
    const frame = `event: snapshot\ndata: ${locked}\n\n: keep-alive\n\n`;
    const cut = frame.indexOf("limit_reached");
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame.slice(0, cut)));
        controller.enqueue(encoder.encode(frame.slice(cut)));
        controller.close();
      },
    });
    const text = await collect(source.pipeThrough(sseRewriteStream({ surface: "usage" })));
    expect(text.split("\n\n")).toEqual(["event: snapshot\ndata: " + opened, ": keep-alive", ""]);
  });

  test("CRLF-framed events are rewritten and keep their line endings", async () => {
    const frame = `event: snapshot\r\ndata: ${locked}\r\n\r\n`;
    const source = new Response(frame).body!;
    const text = await collect(source.pipeThrough(sseRewriteStream({ surface: "usage" })));
    expect(text).toBe(`event: snapshot\r\ndata: ${opened}\r\n\r\n`);
  });

  test("a stream on the conversation surface leaves usage gates alone", async () => {
    const source = new Response(`data: ${locked}\n\n`).body!;
    const text = await collect(source.pipeThrough(sseRewriteStream({ surface: "conversation" })));
    expect(text).toBe(`data: ${locked}\n\n`);
  });
});
