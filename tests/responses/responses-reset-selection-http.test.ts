import { afterEach, describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// Every leg here is real local HTTP: the client sees a head only once the proxy actually wrote one.
const realFetch = globalThis.fetch;
const encoder = new TextEncoder();
const frame = (type: string, extra: Record<string, unknown> = {}) =>
  "event: " + type + "\ndata: " + JSON.stringify({ type, ...extra }) + "\n\n";
const created = (id: string) => frame("response.created", { response: { id, status: "in_progress", output: [] } });
const delta = (text: string) => frame("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: text });
const completed = (id: string) => frame("response.completed", { response: { id, status: "completed", output: [] } });
// Far below the 15-second heartbeat the head used to wait on, and far above the inspection window.
const CLIENT_HEAD_TIMEOUT_MS = 3_000;

type Attempt = (controller: ReadableStreamDefaultController<Uint8Array>, step: number) => Promise<boolean | void> | boolean | void;

const cleanups: (() => void)[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/**
 * A local upstream whose N-th physical request streams through attempts[N]. An attempt returns
 * true to close its stream cleanly; it may await to make the source quiet.
 */
function upstream(attempts: { headers: Record<string, string>; pull: Attempt }[]) {
  const sends: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    sends.push(await req.json());
    const attempt = attempts[Math.min(sends.length - 1, attempts.length - 1)]!;
    let step = 0;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (await attempt.pull(controller, step++) === true) controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream", ...attempt.headers } });
  } });
  cleanups.push(() => server.stop(true));
  return { sends, url: "http://127.0.0.1:" + server.port + "/v1" };
}

function proxy(config: OcxConfig) {
  const release = acquireOwnedSpendHome();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    fetch: req => handleResponses(req, config, { model: "", provider: "" }) });
  cleanups.push(() => { server.stop(true); release(); });
  return (body: Record<string, unknown>, signal?: AbortSignal) => realFetch("http://127.0.0.1:" + server.port + "/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
    body: JSON.stringify({ model: "fixture/model", input: "ping", stream: true, ...body }), signal,
  });
}

const localConfig = (url: string): OcxConfig => ({ port: 0, defaultProvider: "fixture", providers: { fixture: {
  adapter: "openai-responses", baseUrl: url, apiKey: "fixture-key", authMode: "key", models: ["model"],
  allowPrivateNetwork: true, retryOnReset: { enabled: true, replacements: 1 },
} } });

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(needle)) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}
async function readAll(response: Response): Promise<{ text: string; error?: unknown }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    try {
      const next = await reader.read();
      if (next.done) return { text };
      text += decoder.decode(next.value, { stream: true });
    } catch (error) { return { text, error }; }
  }
}

describe("reset selection over real local HTTP", () => {
  for (const store of [false, true]) {
    test("a healthy slow stream gets its head before the upstream resumes (store=" + store + ")", async () => {
      const gate = Promise.withResolvers<void>();
      cleanups.push(() => gate.resolve());
      const up = upstream([{ headers: { "x-attempt": "one" }, pull: async (controller, step) => {
        if (step === 0) { controller.enqueue(encoder.encode(created("resp_slow"))); return; }
        await gate.promise;
        controller.enqueue(encoder.encode(delta("late answer") + completed("resp_slow")));
        return true;
      } }]);
      const send = proxy(localConfig(up.url));
      const response = await send({ store }, AbortSignal.timeout(CLIENT_HEAD_TIMEOUT_MS));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-attempt")).toBe("one");
      const reader = response.body!.getReader();
      let text = "";
      if (store) {
        // An ineligible request is never inspected, so its prelude is not held either.
        text = await readUntil(reader, "resp_slow");
        expect(text).toContain("resp_slow");
      } else {
        // The held prelude stays held; the comment is what carried the head onto the socket.
        text = await readUntil(reader, ": keepalive");
        expect(text).toBe(": keepalive\n\n");
      }
      gate.resolve();
      text += await readUntil(reader, "response.completed");
      expect(text).toContain("resp_slow");
      expect(text).toContain("late answer");
      expect(up.sends).toHaveLength(1);
      await reader.cancel().catch(() => {});
    }, 10_000);
  }

  test("an EOF right after the prelude publishes the replacement with its own head", async () => {
    const up = upstream([
      { headers: { "x-attempt": "one" }, pull: controller => { controller.enqueue(encoder.encode(created("resp_first"))); return true; } },
      { headers: { "x-attempt": "two" }, pull: controller => {
        controller.enqueue(encoder.encode(created("resp_second") + delta("recovered") + completed("resp_second")));
        return true;
      } },
    ]);
    const send = proxy(localConfig(up.url));
    const response = await send({ store: false }, AbortSignal.timeout(CLIENT_HEAD_TIMEOUT_MS));
    expect(response.headers.get("x-attempt")).toBe("two");
    const { text } = await readAll(response);
    expect(text).toContain("recovered");
    expect(text).not.toContain("resp_first");
    expect(up.sends).toHaveLength(2);
  }, 10_000);

  test("an EOF after a quiet prelude recovers even though the retry changes date and x-request-id", async () => {
    const headSent = Promise.withResolvers<void>();
    // Explicit, and different on purpose: `date` and `x-request-id` describe the attempt, not the
    // response identity, so a real origin varying them must not block recovery.
    const up = upstream([
      { headers: { "x-attempt": "one", "date": "Tue, 10 Nov 2026 00:00:00 GMT", "x-request-id": "req-one" }, pull: async (controller, step) => {
        if (step === 0) { controller.enqueue(encoder.encode(created("resp_first"))); return; }
        await headSent.promise;
        return true;
      } },
      { headers: { "x-attempt": "two", "date": "Tue, 10 Nov 2026 00:00:07 GMT", "x-request-id": "req-two" }, pull: controller => {
        controller.enqueue(encoder.encode(created("resp_second") + delta("replacement") + completed("resp_second")));
        return true;
      } },
    ]);
    const send = proxy(localConfig(up.url));
    const response = await send({ store: false }, AbortSignal.timeout(CLIENT_HEAD_TIMEOUT_MS));
    expect(response.headers.get("x-attempt")).toBe("one");
    // The client holds the original head before the source ends. The 200 ms window has already
    // committed it, so this is the post-head clean-EOF path, and the retry above emitted its own
    // `date` and `x-request-id`. Neither is part of the response identity, so recovery must
    // still happen; a full-header match would have refused it here.
    headSent.resolve();
    const { text } = await readAll(response);
    expect(text).toContain("replacement");
    expect(text).not.toContain("resp_first");
    expect(up.sends).toHaveLength(2);
  }, 10_000);

  test("an EOF after a quiet prelude is refused when the retry serves a different model identity", async () => {
    const headSent = Promise.withResolvers<void>();
    const up = upstream([
      { headers: { "x-attempt": "one", "openai-model": "gpt-5.6-sol" }, pull: async (controller, step) => {
        if (step === 0) { controller.enqueue(encoder.encode(created("resp_first"))); return; }
        await headSent.promise;
        return true;
      } },
      { headers: { "x-attempt": "two", "openai-model": "gpt-5.6-luna" }, pull: controller => {
        controller.enqueue(encoder.encode(created("resp_second") + delta("replacement") + completed("resp_second")));
        return true;
      } },
    ]);
    const send = proxy(localConfig(up.url));
    const response = await send({ store: false }, AbortSignal.timeout(CLIENT_HEAD_TIMEOUT_MS));
    expect(response.headers.get("x-attempt")).toBe("one");
    headSent.resolve();
    const { text } = await readAll(response);
    // The body would be labelled with a model the held head never advertised, so the original
    // stream and its clean end are preserved instead.
    expect(text).toContain("resp_first");
    expect(text).not.toContain("replacement");
    expect(up.sends).toHaveLength(2);
  }, 10_000);

  for (const store of [false, true]) {
    test("the canonical forward path returns its head while the upstream is quiet (store=" + store + ")", async () => {
      const gate = Promise.withResolvers<void>();
      const read = Promise.withResolvers<void>();
      cleanups.push(() => gate.resolve());
      let sends = 0;
      const config = { ...getDefaultConfig(), port: 0, defaultProvider: "openai", providers: {
        openai: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward",
          codexAccountMode: "direct", upstreamWebsocket: false, retryOnReset: {} },
      } } as OcxConfig;
      const send = proxy(config);
      globalThis.fetch = (async () => {
        sends++;
        let step = 0;
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (step++ === 0) { controller.enqueue(encoder.encode(created("fixture"))); return; }
            read.resolve();
            await gate.promise;
            controller.close();
          },
        }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      const pending = send({ model: "openai/gpt-5.6-sol", store }, AbortSignal.timeout(CLIENT_HEAD_TIMEOUT_MS));
      await read.promise;
      const response = await pending;
      expect(response.status).toBe(200);
      expect(sends).toBe(1);
      await response.body?.cancel();
    }, 10_000);
  }
});
