/**
 * Audit F2 (2026-09-14) — the integration boundary the helper tests do not reach.
 *
 * The original defect lived in handleChatCompletionsWithBudget, AFTER
 * chatCompletionsToResponsesBody had already produced the controls correctly. So a
 * test that calls the converter and separately calls the sanitizer proves neither:
 * the converter always preserved these fields, and the sanitizer is a pure helper.
 * Only a request that actually traverses /v1/chat/completions to a settled
 * openai-responses upstream observes what the defect broke.
 *
 * This captures the real upstream body for the same generic key Responses provider
 * reached through both ingresses and asserts they agree. The audit probe's mock is
 * reused with its expectation reversed: it asserted the Chat ingress lost the
 * controls, which is the defect.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-f2-control-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-f2-control-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) {
    try {
      removeTreeWithRetry(testDir);
    } catch {
      // Temp tree cleanup is best-effort; see isolated-codex-home for the rationale.
    }
  }
});

/** Minimal Responses upstream that records each request body and completes the turn. */
function startCapturingUpstream(captured: Array<Record<string, unknown>>) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      // Guarded: an unexpected or non-JSON request must not land in `captured` and
      // corrupt the count the assertions below depend on.
      if (!new URL(req.url).pathname.endsWith("/responses") || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      let body: Record<string, unknown>;
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        return new Response("bad request", { status: 400 });
      }
      captured.push(body);
      const response = {
        id: `resp_${captured.length}`,
        status: "completed",
        output: [{
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      const delta = JSON.stringify({
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "ok",
      });
      const done = JSON.stringify({ type: "response.completed", response });
      return new Response(
        `event: response.output_text.delta\ndata: ${delta}\n\nevent: response.completed\ndata: ${done}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
}

describe("F2 both ingresses reach a generic key Responses upstream with the same controls", () => {
  test("chat completions preserves max_output_tokens, temperature and top_p", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const upstream = startCapturingUpstream(captured);
    let server: ReturnType<typeof startServer> | undefined;

    try {
      saveConfig({
        port: 0,
        defaultProvider: "gateway",
        providers: {
          gateway: {
            adapter: "openai-responses",
            baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
            apiKey: "test-placeholder",
            // authMode "key" — a generic gateway, NOT the canonical ChatGPT backend,
            // which is exactly the population the blanket strip used to damage.
            authMode: "key",
            allowPrivateNetwork: true,
          },
        },
      } as unknown as OcxConfig);
      server = startServer(0);

      const bodies = {
        responses: { model: "gateway/model", input: "hello", stream: true, max_output_tokens: 123, temperature: 0.2, top_p: 0.8 },
        chat: { model: "gateway/model", messages: [{ role: "user", content: "hello" }], stream: true, max_tokens: 123, temperature: 0.2, top_p: 0.8 },
      };

      for (const wire of ["responses", "chat"] as const) {
        const path = wire === "responses" ? "/v1/responses" : "/v1/chat/completions";
        const res = await fetch(new URL(path, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodies[wire]),
          signal: AbortSignal.timeout(10000),
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("ok");
      }

      expect(captured.length).toBe(2);
      const [viaResponses, viaChat] = captured as [Record<string, unknown>, Record<string, unknown>];

      // The Responses ingress was never affected; it is the control.
      expect(viaResponses.max_output_tokens).toBe(123);
      expect(viaResponses.temperature).toBe(0.2);
      expect(viaResponses.top_p).toBe(0.8);

      // The defect: these three arrived undefined through the Chat ingress.
      expect(viaChat.max_output_tokens).toBe(123);
      expect(viaChat.temperature).toBe(0.2);
      expect(viaChat.top_p).toBe(0.8);
    } finally {
      await server?.stop(true);
      await upstream.stop(true);
    }
  }, 20000);
});

describe("F2 the sanitizer binds to the final provider, not to ingress order", () => {
  const canonical = {
    adapter: "openai-responses",
    authMode: "forward",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiKey: "t",
  } as unknown as OcxProviderConfig;

  const gateway = {
    adapter: "openai-responses",
    authMode: "key",
    baseUrl: "https://gateway.example/v1",
    apiKey: "k",
  } as unknown as OcxProviderConfig;

  function rawBody(): Record<string, unknown> {
    return {
      model: "some-model",
      input: "hello",
      max_output_tokens: 123,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["END"],
      user: "u-1",
    };
  }

  async function built(provider: OcxProviderConfig, parsed: ReturnType<typeof parseRequest>) {
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
    const { body } = await adapter.buildRequest(parsed);
    return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as Record<string, unknown>;
  }

  // Both orders from ONE parsed request: if the sanitizer mutated shared state, the
  // second build would disagree with the same build run first.
  const orders: Array<[string, OcxProviderConfig[]]> = [
    ["canonical first", [canonical, gateway]],
    ["gateway first", [gateway, canonical]],
  ];

  for (const [label, providers] of orders) {
    test(`${label}: canonical is stripped, generic key keeps the controls`, async () => {
      const source = rawBody();
      const before = structuredClone(source);
      const parsed = parseRequest(source);
      const results = new Map<string, Record<string, unknown>>();

      for (const provider of providers) {
        results.set(provider.authMode as string, await built(provider, parsed));
      }

      const viaCanonical = results.get("forward")!;
      expect(viaCanonical.temperature).toBeUndefined();
      expect(viaCanonical.top_p).toBeUndefined();
      expect(viaCanonical.stop).toBeUndefined();
      expect(viaCanonical.user).toBeUndefined();

      const viaGateway = results.get("key")!;
      expect(viaGateway.temperature).toBe(0.2);
      expect(viaGateway.top_p).toBe(0.8);
      expect(viaGateway.stop).toEqual(["END"]);
      expect(viaGateway.user).toBe("u-1");

      // Whole-object immutability, not a field spot-check: outBody starts as the very
      // same object as source (stripPreviousResponseId returns its input on a no-op),
      // so an in-place mutation of input/tools/metadata would slip past field asserts.
      expect(source).toEqual(before);
      expect(parsed._rawBody).toEqual(before);
    });
  }
});
