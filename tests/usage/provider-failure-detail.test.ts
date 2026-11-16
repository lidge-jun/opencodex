import { afterAll, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import { addFinalRequestLog, type RequestLogContext, type RequestLogEntry } from "../../src/server/request-log";
import { recordUpstreamProviderErrorDetail } from "../../src/server/request-log-failure-detail";
import { boundedFailureDetail, providerFailureDetailOf } from "../../src/lib/failure-detail";
import { createGoogleAdapter } from "../../src/adapters/google";
import { failureDetailLabel } from "../../gui/src/pages/logs-failure-summary";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";

const releaseSpendHome = acquireOwnedSpendHome();
afterAll(() => releaseSpendHome());

// Upstream-authored text that must never reach a row: a credential-shaped token and prompt words.
const SECRET = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const MESSAGE = `Invalid value at contents[3] near "private prompt" for key ${SECRET}`;
const googleError = (status: string, code = 400) => ({ error: { code, status, message: MESSAGE } });

describe("closed provider failure detail contract (#8446)", () => {
  test("keeps a Google RPC status class and a closed finishReason on provider_error", () => {
    expect(boundedFailureDetail({ code: "provider_error", type: "INVALID_ARGUMENT" })).toEqual({ code: "provider_error", type: "INVALID_ARGUMENT" });
    expect(boundedFailureDetail({ code: "provider_error", type: "FAILED_PRECONDITION", finishReason: "MALFORMED_FUNCTION_CALL" }))
      .toEqual({ code: "provider_error", type: "FAILED_PRECONDITION", finishReason: "MALFORMED_FUNCTION_CALL" });
  });

  test("drops unknown statuses and reasons, free text, and a finishReason on another code", () => {
    expect(boundedFailureDetail({ code: "provider_error", type: SECRET, finishReason: MESSAGE })).toEqual({ code: "provider_error" });
    expect(boundedFailureDetail({ code: "provider_error", type: "invalid_argument" })).toEqual({ code: "provider_error" });
    expect(boundedFailureDetail({ code: "stream_failed", finishReason: "SAFETY" })).toEqual({ code: "stream_failed" });
  });

  test("the dashboard renders the status and the finish reason as machine tokens", () => {
    const t = (key: string, vars?: Record<string, unknown>) => `${key}${vars ? JSON.stringify(vars) : ""}`;
    const label = failureDetailLabel({ code: "provider_error", type: "INVALID_ARGUMENT", finishReason: "MALFORMED_FUNCTION_CALL" }, t as never);
    expect(label).toContain("INVALID_ARGUMENT");
    expect(label).toContain("MALFORMED_FUNCTION_CALL");
  });
});

describe("raw upstream error capture", () => {
  test("records the Google status class from an object or a streamed array body, never the message", () => {
    for (const body of [googleError("INVALID_ARGUMENT"), [googleError("INVALID_ARGUMENT")]]) {
      const ctx: RequestLogContext = {};
      recordUpstreamProviderErrorDetail(ctx, 400, JSON.stringify(body));
      expect(ctx.failureDetail).toEqual({ code: "provider_error", type: "INVALID_ARGUMENT" });
      expect(JSON.stringify(ctx.failureDetail)).not.toContain(SECRET);
    }
  });

  test("keeps existing closed envelope types and validation pairs, and ignores success or unknown classes", () => {
    const typed: RequestLogContext = {};
    recordUpstreamProviderErrorDetail(typed, 400, { error: { type: "invalid_request_error", message: MESSAGE } });
    expect(typed.failureDetail).toEqual({ code: "provider_error", type: "invalid_request_error" });
    const validation: RequestLogContext = {};
    recordUpstreamProviderErrorDetail(validation, 422, { detail: [{ loc: ["body", "store"], type: "extra_forbidden", input: SECRET }] });
    expect(validation.failureDetail).toEqual({ code: "provider_error", validation: [{ field: "store", type: "extra_forbidden" }] });
    for (const [status, body] of [[200, googleError("INVALID_ARGUMENT")], [400, { error: { type: SECRET, message: MESSAGE } }], [400, MESSAGE]] as const) {
      const ctx: RequestLogContext = {};
      recordUpstreamProviderErrorDetail(ctx, status, typeof body === "string" ? body : JSON.stringify(body));
      expect(ctx.failureDetail).toBeUndefined();
    }
    const server: RequestLogContext = {};
    recordUpstreamProviderErrorDetail(server, 503, JSON.stringify(googleError("UNAVAILABLE", 503)));
    expect(server.failureDetail).toEqual({ code: "provider_error", type: "UNAVAILABLE" });
  });
});

describe("Google adapter failure events", () => {
  const vertex = { adapter: "google", baseUrl: "https://x", googleMode: "vertex" } as OcxProviderConfig;
  const collect = async (chunks: unknown[]): Promise<AdapterEvent[]> => {
    const adapter = withTestTranslatorBudget(createGoogleAdapter(vertex));
    const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(body, { headers: { "content-type": "text/event-stream" } }))) events.push(event);
    return events;
  };

  test("a mid-stream error frame carries its closed status class off the wire", async () => {
    const events = await collect([googleError("FAILED_PRECONDITION")]);
    const error = events.at(-1)!;
    expect(error.type).toBe("error");
    expect(providerFailureDetailOf(error)).toEqual({ type: "FAILED_PRECONDITION" });
    expect(JSON.stringify(error)).not.toContain("FAILED_PRECONDITION\"}");
  });

  test("a truncated turn carries the finishReason that ended it", async () => {
    const events = await collect([{ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } }]);
    expect(providerFailureDetailOf(events.at(-1)!)).toEqual({ finishReason: "MALFORMED_FUNCTION_CALL" });
  });
});

describe("Responses rows through the Vertex route", () => {
  // The Vertex transport builds its own googleapis.com URL, so the fixture answers at fetch itself:
  // nothing in these cases may leave the process.
  async function run(answer: () => Response, options: { config?: Partial<OcxConfig>; model?: string } = {}) {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return answer(); }) as unknown as typeof fetch;
    try {
      const config = { port: 0, defaultProvider: "fixture", ...options.config, providers: { fixture: {
        adapter: "google", googleMode: "vertex", project: "fixture-project", location: "us-central1",
        baseUrl: "https://aiplatform.googleapis.com", authMode: "key", apiKey: SECRET,
      } } } as OcxConfig;
      const log: RequestLogContext = { model: "gemini-3-pro", provider: "fixture" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: options.model ?? "fixture/gemini-3-pro", input: "private prompt", stream: true }) }), config, log);
      await response.text().catch(() => "");
      let row: RequestLogEntry | undefined;
      addFinalRequestLog("fixture", Date.now(), log, response.status === 200 ? 502 : response.status, undefined, entry => { row = entry; });
      return { log, row, calls };
    } finally { globalThis.fetch = realFetch; }
  }
  const sse = (...frames: unknown[]) => () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
  const malformed = sse({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } });

  test("an HTTP 400 keeps INVALID_ARGUMENT in the row without the provider message", async () => {
    const { row } = await run(() => Response.json(googleError("INVALID_ARGUMENT"), { status: 400 }));
    expect(row?.failureDetail).toEqual({ code: "provider_error", type: "INVALID_ARGUMENT" });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain("private prompt");
  });

  test("a combo child keeps the class of the provider refusal", async () => {
    const { log } = await run(() => Response.json(googleError("FAILED_PRECONDITION"), { status: 400 }), {
      model: "pair", config: { combos: { pair: { strategy: "fallback", targets: [{ provider: "fixture", model: "gemini-3-pro" }] } } } as Partial<OcxConfig>,
    });
    expect(log.failureDetail).toEqual({ code: "provider_error", type: "FAILED_PRECONDITION" });
  });

  test("a mid-stream error frame keeps its status class in the row", async () => {
    const { row } = await run(sse(googleError("FAILED_PRECONDITION")));
    expect(row?.failureDetail).toEqual({ code: "provider_error", type: "FAILED_PRECONDITION" });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  test("a turn the provider truncated keeps its finishReason in the row", async () => {
    const { row } = await run(malformed);
    expect(row?.failureDetail).toEqual({ code: "provider_error", finishReason: "MALFORMED_FUNCTION_CALL" });
  });

  test("a replay that then succeeds leaves no provider failure detail behind", async () => {
    let served = 0;
    const ok = sse({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } });
    const { log, calls } = await run(() => (++served === 1 ? malformed() : ok()), { config: { emptyCompletionRetry: true } });
    expect(calls).toBe(2);
    expect(log.failureDetail).toBeUndefined();
  });
});
