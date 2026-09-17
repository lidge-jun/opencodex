import { afterEach, describe, expect, test } from "bun:test";
import { applyManualCompactionOverride } from "../../src/server/responses/manual-compaction";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { clearCompactHandoffRoutesForTests } from "../../src/server/responses/compact";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "../../src/responses/compaction";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { warnDegradedManualCompaction } from "../../src/config/load-degrade";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests, recallComboForLane, rememberComboForLane } from "../../src/server/responses/combo-session-recall";
import { sessionLaneIdFromRequest } from "../../src/server/request-log-conversation";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const metadata = (trigger = "manual", request_kind = "compaction") =>
  JSON.stringify({ request_kind, compaction: { trigger } });

function config(): OcxConfig {
  return {
    ...getDefaultConfig(),
    defaultProvider: "gateway",
    providers: {
      gateway: {
        adapter: "openai-responses", authMode: "key",
        baseUrl: "https://gateway.example/v1", apiKey: "fixture-key",
      },
    },
    manualCompaction: { model: "gateway/cheap", reasoningEffort: "low" },
  };
}

function body(compact = true): Record<string, any> {
  return {
    model: "gateway/normal", stream: false,
    reasoning: { effort: "high", summary: "auto" },
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Keep the task state." }] },
      ...(compact ? [{ type: "compaction_trigger" }] : []),
    ],
  };
}

function request(value: unknown, trigger?: string, path = "responses"): Request {
  return new Request(`http://localhost/v1/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", session_id: "manual-compaction-fixture",
      ...(trigger ? { "x-codex-turn-metadata": metadata(trigger) } : {}),
    },
    body: JSON.stringify(value),
  });
}

function completion(summary = "Retain progress and resume the task."): Record<string, unknown> {
  return {
    id: "resp_manual_fixture", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

function upstreamCompletion(input: Record<string, unknown>): Response {
  const response = { ...completion(), model: input.model };
  return input.stream
    ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
    : Response.json(response);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearComboRecallForTests();
  clearCompactHandoffRoutesForTests();
});

describe("manual compaction request selection", () => {
  test.each(["header", "body", "both"])("uses explicit manual metadata from %s", location => {
    const input = body();
    const history = structuredClone(input.input);
    const headers = new Headers();
    if (location !== "body") headers.set("x-codex-turn-metadata", metadata());
    if (location !== "header") input.client_metadata = { "x-codex-turn-metadata": metadata() };
    expect(applyManualCompactionOverride(input, headers, config())).toEqual({ sourceModel: "gateway/normal" });
    expect(input.model).toBe("gateway/cheap");
    expect(input.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(input.input).toEqual(history);
  });

  test.each([
    undefined, "{", "null", "[]", metadata("auto"), metadata("manual", "turn"),
    JSON.stringify({ compaction: { trigger: "manual" } }),
    JSON.stringify({ request_kind: "compaction" }),
  ])("does not override absent, malformed, automatic or ordinary metadata: %s", value => {
    const input = body();
    const before = structuredClone(input);
    const headers = new Headers(value === undefined ? {} : { "x-codex-turn-metadata": value });
    expect(applyManualCompactionOverride(input, headers, config())).toBeNull();
    expect(input).toEqual(before);
  });

  test("conflicting metadata cannot override automatic compaction", () => {
    for (const [header, embedded] of [[metadata(), metadata("auto")], [metadata("auto"), metadata()], [metadata(), "{"], ["{", metadata()]]) {
      const input = { ...body(), client_metadata: { "x-codex-turn-metadata": embedded } };
      expect(applyManualCompactionOverride(input, new Headers({ "x-codex-turn-metadata": header! }), config())).toBeNull();
      expect(input.model).toBe("gateway/normal");
    }
  });

  test("WebSocket frames use their own trigger and never reuse handshake metadata", () => {
    for (const [handshake, frame, expected] of [
      ["auto", "manual", true], ["manual", "auto", false], ["manual", undefined, false],
    ] as const) {
      const input = body();
      if (frame) input.client_metadata = { "x-codex-turn-metadata": metadata(frame) };
      const headers = new Headers({ "x-codex-turn-metadata": metadata(handshake) });
      expect(applyManualCompactionOverride(input, headers, config(), { transport: "websocket" })).toEqual(expected ? { sourceModel: "gateway/normal" } : null);
      expect(input.model).toBe(expected ? "gateway/cheap" : "gateway/normal");
    }
  });

  test("model-only configuration preserves the caller's reasoning", () => {
    const input = body();
    const settings = config();
    settings.manualCompaction = { model: "gateway/cheap" };
    expect(applyManualCompactionOverride(input, new Headers({ "x-codex-turn-metadata": metadata() }), settings)).toEqual({ sourceModel: "gateway/normal" });
    expect(input.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(settings.manualCompaction).toEqual({ model: "gateway/cheap" });
  });

  test("unset configuration preserves manual compaction", () => {
    const input = body();
    const before = structuredClone(input);
    const settings = config();
    delete settings.manualCompaction;
    expect(applyManualCompactionOverride(input, new Headers({ "x-codex-turn-metadata": metadata() }), settings)).toBeNull();
    expect(input).toEqual(before);
  });

  test("manual metadata on an ordinary turn never rewrites the request", () => {
    const input = body(false);
    const before = structuredClone(input);
    const headers = new Headers({ "x-codex-turn-metadata": metadata() });
    expect(applyManualCompactionOverride(input, headers, config())).toBeNull();
    expect(applyManualCompactionOverride(input, headers, config(), { endpoint: "responses" })).toBeNull();
    expect(input).toEqual(before);
    expect(applyManualCompactionOverride(input, headers, config(), { endpoint: "compact" })).toEqual({ sourceModel: "gateway/normal" });
    expect(input.model).toBe("gateway/cheap");
  });
});


describe("manual compaction config", () => {
  test("validates optional settings without resetting providers on malformed hand edits", () => {
    expect(validateConfigCandidate(config()).ok).toBe(true);
    for (const value of [null, {}, [], "cheap", { model: " " }, { model: 42 },
      { model: "gateway/cheap", reasoningEffort: "invalid" }, { model: "gateway/cheap", typo: true }]) {
      const raw = { ...config(), manualCompaction: value };
      expect(validateConfigCandidate(raw).ok).toBe(false);
      const loaded = configSchema.parse(raw);
      expect(loaded.manualCompaction).toBeUndefined();
      expect(loaded.providers).toEqual(config().providers);
    }
  });

  test("a dropped hand-edited block warns at load; valid or absent blocks stay silent", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => { warnings.push(String(message)); };
    try {
      const invalid = { ...config(), manualCompaction: { model: "gateway/cheap", reasoningEffort: "Low" } };
      warnDegradedManualCompaction(invalid, configSchema.parse(invalid) as OcxConfig);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("manualCompaction is invalid");
      warnDegradedManualCompaction(config(), configSchema.parse(config()) as OcxConfig);
      const absent = config();
      delete absent.manualCompaction;
      warnDegradedManualCompaction(absent, configSchema.parse(absent) as OcxConfig);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = original;
    }
  });
});

describe("manual compaction reuses existing handlers", () => {
  test("an ordinary turn carrying manual metadata stays on the conversation model", async () => {
    const settings = config();
    const calls: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      calls.push(input.model);
      return upstreamCompletion(input);
    }) as typeof fetch;
    const response = await handleResponses(request(body(false), "manual"), settings, { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();
    expect(calls).toEqual(["normal"]);
  });

  test.each(["v1", "v2", "v2-body", "v2-websocket"])("%s changes only the manual request and returns the existing summary format", async version => {
    const settings = config();
    const saved = structuredClone(settings);
    const calls: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(completion());
    }) as typeof fetch;
    const handler = version === "v1" ? handleResponsesCompact : handleResponses;
    const input = body(version !== "v1");
    if (version === "v2-body" || version === "v2-websocket") input.client_metadata = { "x-codex-turn-metadata": metadata() };
    const manualRequest = request(input, version === "v2-body" ? undefined : version === "v2-websocket" ? "auto" : "manual");
    const logCtx = { model: "", provider: "" } as { model: string; provider: string; requestedModel?: string };
    const response = version === "v2-websocket"
      ? await handleResponses(manualRequest, settings, logCtx, { inboundTransport: "websocket" })
      : await handler(manualRequest, settings, logCtx);
    const result = await response.json() as { output: Array<Record<string, any>> };
    expect(response.status).toBe(200);
    expect(logCtx.requestedModel).toBe("gateway/normal");
    expect(logCtx.model).toBe("cheap");
    expect(calls[0]!.model).toBe("cheap");
    expect(calls[0]!.reasoning.effort).toBe("low");
    if (version === "v1") expect(JSON.stringify(result.output)).toContain(SUMMARY_PREFIX);
    else expect(decodeCompactionSummary(result.output.find(item => item.type === "compaction")!.encrypted_content)).toContain("Retain progress");

    const automatic = await handler(request(body(version !== "v1"), "auto"), settings, { model: "", provider: "" });
    expect(automatic.status).toBe(200);
    await automatic.text();
    const resumedBody = body(false);
    resumedBody.input = [...result.output, ...resumedBody.input];
    const resumed = await handleResponses(request(resumedBody), settings, { model: "", provider: "" });
    expect(resumed.status).toBe(200);
    await resumed.text();
    expect(calls.map(call => [call.model, call.reasoning.effort])).toEqual([
      ["cheap", "low"], ["normal", "high"], ["normal", "high"],
    ]);
    expect(JSON.stringify(calls[2]!.input)).toContain("Retain progress");
    expect(JSON.stringify(calls[2]!.input)).not.toContain("ocx1:");
    expect(settings).toEqual(saved);
    expect(input.model).toBe("gateway/normal");
  });

  test("native v2 keeps caller authentication and forwards the existing compaction request", async () => {
    const settings = config();
    settings.providers.openai = {
      adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    settings.manualCompaction = { model: "gpt-5.6-luna", reasoningEffort: "low" };
    const input = body();
    input.model = "gpt-6-astra";
    input.stream = true;
    const req = request(input, "manual");
    const authorization = `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "fixture-account" })}`;
    req.headers.set("authorization", authorization);
    req.headers.set("chatgpt-account-id", "fixture-account");
    const calls: Array<{ body: Record<string, any>; authorization: string | null }> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
      const response = { ...completion(), model: "gpt-5.6-luna", output: [{ type: "compaction", encrypted_content: "native-summary" }] };
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const response = await handleResponses(req, settings, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("native-summary");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe(authorization);
    expect(calls[0]!.body.model).toBe("gpt-5.6-luna");
    expect(calls[0]!.body.reasoning.effort).toBe("low");
    expect(calls[0]!.body.input).toContainEqual({ type: "compaction_trigger" });
  });

  test("same-provider native compact retains its existing endpoint and reasoning behavior", async () => {
    const settings = config();
    settings.providers["openai-apikey"] = {
      adapter: "openai-responses", authMode: "key", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key",
    };
    settings.manualCompaction = { model: "openai-apikey/gpt-5.6-luna", reasoningEffort: "low" };
    const calls: Array<{ url: string; body: Record<string, any> }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ output: [{ type: "compaction", encrypted_content: "native-summary" }] });
    }) as typeof fetch;
    const input = { ...body(false), model: "openai-apikey/gpt-6-astra" };
    const response = await handleResponsesCompact(request(input, "manual", "responses/compact"), settings, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ output: [{ type: "compaction", encrypted_content: "native-summary" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses/compact");
    expect(calls[0]!.body.model).toBe("gpt-5.6-luna");
    expect(calls[0]!.body.reasoning).toBeUndefined();
  });

  test.each(["v1", "v2"])("%s cross-provider override produces a summary the conversation model can replay", async version => {
    const settings = config();
    settings.providers["openai-apikey"] = {
      adapter: "openai-responses", authMode: "key", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key",
    };
    settings.manualCompaction = { model: "openai-apikey/gpt-5.6-luna", reasoningEffort: "low" };
    const calls: Array<{ url: string; body: Record<string, any> }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body: input });
      if (String(url).endsWith("/compact")) return Response.json({ output: [{ type: "compaction", encrypted_content: "native-ciphertext" }] });
      return upstreamCompletion(input);
    }) as typeof fetch;
    const handler = version === "v1" ? handleResponsesCompact : handleResponses;
    const response = await handler(request(body(version !== "v1"), "manual"), settings, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const result = await response.json() as { output: Array<Record<string, any>> };
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]!.body.model).toBe("gpt-5.6-luna");
    expect(calls[0]!.body.reasoning.effort).toBe("low");
    expect(JSON.stringify(result.output)).not.toContain("native-ciphertext");
    if (version === "v1") expect(JSON.stringify(result.output)).toContain(SUMMARY_PREFIX);
    else expect(decodeCompactionSummary(result.output.find(item => item.type === "compaction")!.encrypted_content)).toContain("Retain progress");

    const resumedBody = body(false);
    resumedBody.input = [...result.output, ...resumedBody.input];
    const resumed = await handleResponses(request(resumedBody), settings, { model: "", provider: "" });
    expect(resumed.status).toBe(200);
    await resumed.text();
    expect(calls[1]!.url).toBe("https://gateway.example/v1/responses");
    expect(calls[1]!.body.model).toBe("normal");
    expect(JSON.stringify(calls[1]!.body.input)).toContain("Retain progress");
    expect(JSON.stringify(calls[1]!.body.input)).not.toContain("cannot read");
  });

  test("same-provider override keeps a caller-supplied bearer; a cross-provider override drops it", async () => {
    const settings = config();
    settings.providers.openai = {
      adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    settings.manualCompaction = { model: "gpt-5.6-luna", reasoningEffort: "low" };
    const seen: Array<string | null> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return upstreamCompletion(JSON.parse(String(init?.body)));
    }) as typeof fetch;
    for (const [sourceModel, expectedStatus] of [["gpt-6-astra", 200], ["gateway/normal", 401]] as const) {
      const input = { ...body(), model: sourceModel, stream: true };
      const req = request(input, "manual");
      req.headers.set("authorization", "Bearer opaque-caller-token");
      const response = await handleResponses(req, settings, { model: "", provider: "" });
      expect(response.status).toBe(expectedStatus);
      await response.text();
    }
    expect(seen).toEqual(["Bearer opaque-caller-token"]);
  });

  test("a ChatGPT target for a routed conversation runs the portable summarizer instead of native compaction", async () => {
    const settings = config();
    settings.providers.openai = {
      adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    settings.manualCompaction = { model: "gpt-5.6-luna", reasoningEffort: "low" };
    const calls: Array<{ url: string; body: Record<string, any> }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body: input });
      if (String(url).endsWith("/compact") || JSON.stringify(input.input).includes("compaction_trigger")) {
        const response = { ...completion(), model: input.model, output: [{ type: "compaction", encrypted_content: "native-ciphertext" }] };
        return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return upstreamCompletion(input);
    }) as typeof fetch;
    const jwt = `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "fixture-account" })}`;
    for (const version of ["v1", "v2"] as const) {
      calls.length = 0;
      const req = request(body(version === "v2"), "manual", version === "v1" ? "responses/compact" : "responses");
      req.headers.set("authorization", jwt);
      req.headers.set("chatgpt-account-id", "fixture-account");
      const handler = version === "v1" ? handleResponsesCompact : handleResponses;
      const response = await handler(req, settings, { model: "", provider: "" });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("native-ciphertext");
      const output = (JSON.parse(text) as { output: Array<Record<string, any>> }).output;
      if (version === "v1") expect(JSON.stringify(output)).toContain(SUMMARY_PREFIX);
      else expect(decodeCompactionSummary(output.find(item => item.type === "compaction")!.encrypted_content)).toContain("Retain progress");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(calls[0]!.body.model).toBe("gpt-5.6-luna");
      expect(JSON.stringify(calls[0]!.body.input)).not.toContain("compaction_trigger");

      const resumedBody = body(false);
      resumedBody.input = [...output, ...resumedBody.input];
      const resumed = await handleResponses(request(resumedBody), settings, { model: "", provider: "" });
      expect(resumed.status).toBe(200);
      await resumed.text();
      expect(calls[1]!.url).toBe("https://gateway.example/v1/responses");
      expect(JSON.stringify(calls[1]!.body.input)).toContain("Retain progress");
    }
  });

  test("manual quota failure cannot borrow the conversation's automatic handoff target", async () => {
    const settings = config();
    settings.providers["openai-apikey"] = {
      adapter: "openai-responses", authMode: "key", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key",
    };
    settings.manualCompaction = { model: "openai-apikey/gpt-5.6-luna" };
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      calls.push(input.model);
      return String(url).endsWith("/compact")
        ? Response.json({ error: { message: "quota exceeded", code: "insufficient_quota" } }, { status: 429 })
        : upstreamCompletion(input);
    }) as typeof fetch;
    const seed = await handleResponsesCompact(request(body(false), "auto"), settings, { model: "", provider: "" });
    expect(seed.status).toBe(200);
    await seed.text();
    const manual = await handleResponsesCompact(request({ ...body(false), model: "openai-apikey/gpt-6-astra" }, "manual"), settings, { model: "", provider: "" });
    expect(manual.status).toBe(429);
    await manual.text();
    expect(calls).toEqual(["normal", "gpt-5.6-luna"]);

    const automatic = await handleResponsesCompact(request({ ...body(false), model: "openai-apikey/gpt-6-astra" }, "auto"), settings, { model: "", provider: "" });
    expect(automatic.status).toBe(200);
    await automatic.text();
    expect(calls).toEqual(["normal", "gpt-5.6-luna", "gpt-6-astra", "normal"]);
  });

  test.each(["v1", "v2"])("%s combo override preserves failover and the conversation's remembered combo", async version => {
    const settings = config();
    settings.combos = {
      normal: { targets: [{ provider: "gateway", model: "normal" }] },
      compact: { strategy: "failover", targets: [{ provider: "gateway", model: "unavailable" }, { provider: "gateway", model: "cheap" }] },
    };
    settings.manualCompaction = { model: "combo/compact", reasoningEffort: "low" };
    const req = request(body(version !== "v1"), "manual");
    const lane = sessionLaneIdFromRequest(req.headers);
    rememberComboForLane(lane, "normal", { provider: "gateway", model: "normal" }, "normal", captureConfigGeneration());
    const calls: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model;
      calls.push(model);
      if (model === "unavailable") return Response.json({ error: {
        type: "invalid_request_error", code: "unsupported_value", param: "reasoning.effort",
        message: "Unsupported value: 'low' is not supported with this model. Supported values are: 'medium', 'high'.",
      } }, { status: 400 });
      return upstreamCompletion(JSON.parse(String(init?.body)));
    }) as typeof fetch;
    const handler = version === "v1" ? handleResponsesCompact : handleResponses;
    const response = await handler(req, settings, { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();
    expect(calls).toEqual(["unavailable", "cheap"]);
    expect(recallComboForLane(settings, lane, "normal")).toBe("normal");
  });
});
