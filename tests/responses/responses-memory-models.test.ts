import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MEMORY_MODEL_TARGET_UNAVAILABLE_CODE,
  applyMemoryModelEffort,
  configuredMemoryModel,
  detectMemoryModelPhase,
} from "../../src/server/responses/memory-models";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import { MODEL_NOT_ALLOWED_FOR_KEY } from "../../src/server/admission-model-scope";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { warnDegradedMemoryModels } from "../../src/config/load-degrade";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig, OcxParsedRequest } from "../../src/types";
import type { ServerWebSocket } from "bun";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import type { WsData } from "../../src/server/ws-bridge";

const originalFetch = globalThis.fetch;
/** The spend-journal writer lease is taken by startServer, so a bare handler call needs one. */
let releaseSpendHome: (() => void) | undefined;

/** Phase 1's shape: codex-rs marks the kind AND the thread source. */
const extractMetadata = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ request_kind: "memory", thread_source: "memory_consolidation", ...extra });
/** Phase 2's shape: an ordinary turn inside the consolidation thread. */
const consolidationMetadata = () =>
  JSON.stringify({ request_kind: "turn", thread_source: "memory_consolidation" });

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
    memoryModels: {
      extract: { model: "gateway/cheap", reasoningEffort: "high" },
      consolidation: { model: "gateway/strong", reasoningEffort: "xhigh" },
    },
  };
}

function body(model = "gpt-5.6-luna"): Record<string, unknown> {
  return {
    model, stream: false,
    reasoning: { effort: "low", summary: "auto" },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Summarize this rollout." }] }],
  };
}

function request(value: unknown, metadata?: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json", session_id: "memory-models-fixture",
      ...(metadata ? { "x-codex-turn-metadata": metadata } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(value),
  });
}

function completion(): Record<string, unknown> {
  return {
    id: "resp_memory_fixture", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

beforeEach(() => {
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearComboSelectionState();
  clearComboTargetCooldowns();
});

describe("memory phase detection", () => {
  test("recognizes each phase from Codex's own turn metadata", () => {
    expect(detectMemoryModelPhase(body(), new Headers({ "x-codex-turn-metadata": extractMetadata() }))).toBe("extract");
    expect(detectMemoryModelPhase(body("gpt-5.6-terra"), new Headers({ "x-codex-turn-metadata": consolidationMetadata() }))).toBe("consolidation");
  });

  test("explicit non-memory metadata outranks the sub-agent header", () => {
    const headers = new Headers({
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
      "x-openai-subagent": "memory_consolidation",
    });
    expect(detectMemoryModelPhase(body("gpt-5.6-terra"), headers)).toBeNull();
    expect(detectMemoryModelPhase(body("gpt-5.6-terra"), new Headers({ "x-openai-subagent": "memory_consolidation" }))).toBe("consolidation");
    // Any other internal turn category is not a memory turn.
    expect(detectMemoryModelPhase(body(), new Headers({ "x-openai-subagent": "collab_spawn" }))).toBeNull();
    expect(detectMemoryModelPhase(body(), new Headers({ "x-openai-subagent": "review" }))).toBeNull();
    // Malformed client metadata is not absent metadata: the header fallback stays closed.
    for (const malformed of ["bad", 42, ["x"], true, null]) {
      expect(detectMemoryModelPhase(
        { ...body("gpt-5.6-terra"), client_metadata: malformed },
        new Headers({ "x-openai-subagent": "memory_consolidation" }),
      )).toBeNull();
    }
  });

  test("an ordinary turn, absent metadata, or malformed metadata is never a memory turn", () => {
    expect(detectMemoryModelPhase(body(), new Headers())).toBeNull();
    expect(detectMemoryModelPhase(body(), new Headers({ "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "cli" }) }))).toBeNull();
    for (const value of ["{", "null", "[]", '"memory"', JSON.stringify({ request_kind: "memory_consolidation" })]) {
      expect(detectMemoryModelPhase(body(), new Headers({ "x-codex-turn-metadata": value }))).toBeNull();
    }
    // A non-string copy is malformed rather than absent.
    expect(detectMemoryModelPhase({ ...body(), client_metadata: { "x-codex-turn-metadata": 42 } }, new Headers())).toBeNull();
  });

  test("conflicting copies are not treated as a memory turn", () => {
    for (const [header, embedded] of [[extractMetadata(), consolidationMetadata()], [consolidationMetadata(), extractMetadata()], [extractMetadata(), "{"], ["{", extractMetadata()]]) {
      const input = { ...body(), client_metadata: { "x-codex-turn-metadata": embedded } };
      expect(detectMemoryModelPhase(input, new Headers({ "x-codex-turn-metadata": header! }))).toBeNull();
    }
  });

  test("both copies must agree on the same phase", () => {
    const input = { ...body(), client_metadata: { "x-codex-turn-metadata": extractMetadata() } };
    expect(detectMemoryModelPhase(input, new Headers({ "x-codex-turn-metadata": extractMetadata() }))).toBe("extract");
  });

  test("WebSocket frames read the body copy instead of the handshake header", () => {
    const input = { ...body("gpt-5.6-terra"), client_metadata: { "x-codex-turn-metadata": consolidationMetadata() } };
    const headers = new Headers({ "x-codex-turn-metadata": extractMetadata() });
    expect(detectMemoryModelPhase(input, headers)).toBeNull();
    expect(detectMemoryModelPhase(input, headers, { transport: "websocket" })).toBe("consolidation");
  });

  test("the connection's sub-agent header consolidates HTTP turns but not websocket frames", () => {
    const headers = new Headers({ "x-openai-subagent": "memory_consolidation" });
    expect(detectMemoryModelPhase(body("gpt-5.6-terra"), headers)).toBe("consolidation");
    expect(detectMemoryModelPhase(body("gpt-5.6-terra"), headers, { transport: "websocket" })).toBeNull();
  });
});

describe("memory model settings", () => {
  test("a phase without a model is off, and a blank model is not a destination", () => {
    const settings = config();
    expect(configuredMemoryModel(settings, "extract")).toEqual({ model: "gateway/cheap", reasoningEffort: "high" });
    delete settings.memoryModels!.consolidation;
    expect(configuredMemoryModel(settings, "consolidation")).toBeUndefined();
    settings.memoryModels = { extract: { model: "  " } };
    expect(configuredMemoryModel(settings, "extract")).toBeUndefined();
    expect(configuredMemoryModel(undefined, "extract")).toBeUndefined();
  });

  test("the configured effort is written to both wire shapes", () => {
    const parsed = { modelId: "gpt-5.6-luna", options: { reasoning: "low" }, _rawBody: { reasoning: { effort: "low", summary: "auto" } } } as unknown as OcxParsedRequest;
    expect(applyMemoryModelEffort(parsed, config(), "extract")).toEqual({ from: "low", to: "high" });
    expect(parsed.options.reasoning).toBe("high");
    expect(parsed._rawBody!.reasoning).toEqual({ effort: "high", summary: "auto" });
    // Idempotent, and a phase without an effort leaves Codex's own value alone.
    expect(applyMemoryModelEffort(parsed, config(), "extract")).toBeNull();
    expect(applyMemoryModelEffort(parsed, config(), "consolidation")).toEqual({ from: "high", to: "xhigh" });
    const bare = config();
    bare.memoryModels = { extract: { model: "gateway/cheap" } };
    const untouched = { modelId: "gpt-5.6-luna", options: { reasoning: "low" }, _rawBody: {} } as unknown as OcxParsedRequest;
    expect(applyMemoryModelEffort(untouched, bare, "extract")).toBeNull();
    expect(untouched.options.reasoning).toBe("low");
  });
});

describe("memory model config", () => {
  test("validates both phases without resetting providers on malformed hand edits", () => {
    expect(validateConfigCandidate(config()).ok).toBe(true);
    for (const value of [null, [], "cheap", { extract: { model: " " } }, { extract: { model: 42 } },
      { consolidation: { model: "gateway/strong", reasoningEffort: "fast" } },
      { extract: { model: "gateway/cheap", typo: true } }, { extract: {}, unknown: true }]) {
      const raw = { ...config(), memoryModels: value };
      expect(validateConfigCandidate(raw).ok).toBe(false);
      const loaded = configSchema.parse(raw);
      expect(loaded.providers).toEqual(config().providers);
    }
    // A wholly broken block drops entirely; a broken phase drops only that phase, so a typo in
    // one phase can no longer delete the operator's routing for the other.
    for (const value of [null, [], "cheap"]) {
      const loaded = configSchema.parse({ ...config(), memoryModels: value });
      expect(loaded.memoryModels).toBeUndefined();
    }
    const oneBroken = configSchema.parse({ ...config(), memoryModels: { extract: { model: " " }, consolidation: { model: "gateway/strong" } } });
    expect(oneBroken.memoryModels).toEqual({ consolidation: { model: "gateway/strong" } });
  });

  test("an empty block is valid and means both phases stay with Codex", () => {
    const raw = { ...config(), memoryModels: {} };
    expect(validateConfigCandidate(raw).ok).toBe(true);
    expect(configuredMemoryModel(configSchema.parse(raw) as OcxConfig, "extract")).toBeUndefined();
  });

  test("a broken phase warns per phase at load; valid or absent blocks stay silent", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => { warnings.push(String(message)); };
    try {
      const invalid = { ...config(), memoryModels: { extract: { model: "" } } };
      warnDegradedMemoryModels(invalid, configSchema.parse(invalid) as OcxConfig);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("memoryModels.extract is invalid");
      // The route a broken phase keeps is not necessarily Codex's own model: the shadow-call
      // intercept can still match the request.
      expect(warnings[0]).toContain("keeps its existing route");
      // The surviving phase is not repeated, and a wholly broken block keeps the block wording.
      const survivor = { ...config(), memoryModels: { extract: { model: "" }, consolidation: { model: "gateway/strong" } } };
      warnDegradedMemoryModels(survivor, configSchema.parse(survivor) as OcxConfig);
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toContain("memoryModels.extract is invalid");
      const whole = { ...config(), memoryModels: "cheap" };
      warnDegradedMemoryModels(whole, configSchema.parse(whole) as OcxConfig);
      expect(warnings).toHaveLength(3);
      expect(warnings[2]).toContain("memoryModels is invalid");
      warnDegradedMemoryModels(config(), configSchema.parse(config()) as OcxConfig);
      const absent = config();
      delete absent.memoryModels;
      warnDegradedMemoryModels(absent, configSchema.parse(absent) as OcxConfig);
      expect(warnings).toHaveLength(3);
    } finally {
      console.warn = original;
    }
  });

  test("an unrecognized phase key warns instead of vanishing on the next save", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => { warnings.push(String(message)); };
    try {
      const typo = { ...config(), memoryModels: { extrcat: { model: "gateway/cheap" }, consolidation: { model: "gateway/strong" } } };
      const parsed = configSchema.parse(typo) as OcxConfig;
      // The load schema stays permissive, so the misspelled key is stripped while the valid phase
      // survives - which is exactly why the warning has to read the raw object.
      expect(parsed.memoryModels).toEqual({ consolidation: { model: "gateway/strong" } });
      warnDegradedMemoryModels(typo, parsed);
      expect(warnings).toHaveLength(1);
      // The key name is JSON-quoted because it is redacted and escaped before it reaches the log.
      expect(warnings[0]).toContain('memoryModels."extrcat" is not a recognized phase');
    } finally {
      console.warn = original;
    }
  });
});

describe("memory model routing", () => {
  test("WebSocket admission uses each frame's metadata, not its handshake subagent header", async () => {
    const settings = config();
    const called: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      called.push(JSON.parse(String(init?.body)).model);
      const event = { type: "response.completed", sequence_number: 0, response: completion() };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const handler = createWebsocketHandler({ config: settings, deps: {} } as ServeOptionsContext);
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      readyState: 1,
      data: { headers: new Headers({ "x-openai-subagent": "memory_consolidation", session_id: "memory-ws-fixture" }) } as WsData,
      send: (text: string) => { sent.push(JSON.parse(text)); return 1; },
      close() {},
    } as unknown as ServerWebSocket<WsData>;
    const send = (value: Record<string, unknown>) => handler.message(ws, JSON.stringify({ type: "response.create", ...value }));
    const settled = async (count: number) => {
      for (let i = 0; i < 1000; i++) {
        if (sent.filter(frame => frame.type === "response.completed").length >= count) return;
        await Bun.sleep(1);
      }
      throw new Error("WebSocket response did not complete");
    };
    try {
      send({ ...body("gateway/ordinary"), client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "cli" }) } });
      await settled(1);
      send({ ...body("gateway/ordinary"), client_metadata: { "x-codex-turn-metadata": consolidationMetadata() } });
      await settled(2);
      expect(called).toEqual(["ordinary", "strong"]);
    } finally {
      handler.close(ws);
    }
  });

  test("HTTP admission leaves explicit non-memory metadata on the requested route", async () => {
    const settings = config();
    const called: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      called.push(JSON.parse(String(init?.body)).model);
      return Response.json(completion());
    }) as typeof fetch;
    const response = await handleResponses(request(body("gateway/ordinary"), JSON.stringify({ request_kind: "turn", thread_source: "cli" }), {
      "x-openai-subagent": "memory_consolidation",
    }), settings, { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();
    expect(called).toEqual(["ordinary"]);
  });

  test("routes each phase to its own model and effort", async () => {
    const settings = config();
    const calls: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(completion());
    }) as typeof fetch;

    const extractCtx = { model: "", provider: "" } as RequestLogContext;
    const extract = await handleResponses(request(body(), extractMetadata()), settings, extractCtx);
    expect(extract.status).toBe(200);
    await extract.text();
    expect(calls[0]!.model).toBe("cheap");
    expect(calls[0]!.reasoning.effort).toBe("high");
    // The caller's own selector stays in the log; only the served model changed.
    expect(extractCtx.requestedModel).toBe("gpt-5.6-luna");
    expect(extractCtx.model).toBe("cheap");
    expect(extractCtx.routeDecision?.selected.reason).toBe("memory-extract");

    const consolidationCtx = { model: "", provider: "" } as RequestLogContext;
    const consolidation = await handleResponses(request(body("gpt-5.6-terra"), consolidationMetadata()), settings, consolidationCtx);
    expect(consolidation.status).toBe(200);
    await consolidation.text();
    expect(calls[1]!.model).toBe("strong");
    expect(calls[1]!.reasoning.effort).toBe("xhigh");
    expect(consolidationCtx.requestedModel).toBe("gpt-5.6-terra");
    expect(consolidationCtx.routeDecision?.selected.reason).toBe("memory-consolidation");
  });

  test("an unconfigured phase and a turn without the marker keep their own model", async () => {
    const settings = config();
    delete settings.memoryModels!.consolidation;
    const calls: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(completion());
    }) as typeof fetch;

    // Phase 2 with only Phase 1 configured, then a Phase 1 turn with nothing configured.
    const consolidation = await handleResponses(request(body("gateway/normal"), consolidationMetadata()), settings, { model: "", provider: "" });
    expect(consolidation.status).toBe(200);
    await consolidation.text();
    const configured = config();
    delete configured.memoryModels;
    const unconfigured = await handleResponses(request(body("gateway/normal"), extractMetadata()), configured, { model: "", provider: "" });
    expect(unconfigured.status).toBe(200);
    await unconfigured.text();
    // Same model id, no marker: nothing about the phase may reach it.
    const ordinary = await handleResponses(request(body("gateway/normal")), settings, { model: "", provider: "" });
    expect(ordinary.status).toBe(200);
    await ordinary.text();
    expect(calls.map(call => [call.model, call.reasoning.effort])).toEqual([
      ["normal", "low"], ["normal", "low"], ["normal", "low"],
    ]);
  });

  test("a memory turn keeps the phase decision when the shadow intercept would match too", async () => {
    const settings = config();
    settings.shadowCallIntercept = { enabled: true, model: "gateway/helper" };
    const calls: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(completion());
    }) as typeof fetch;
    const logCtx = { model: "", provider: "" } as { model: string; provider: string; shadowCallRewrittenFrom?: string };
    const response = await handleResponses(request(body(), extractMetadata()), settings, logCtx);
    expect(response.status).toBe(200);
    await response.text();
    expect(calls[0]!.model).toBe("cheap");
    expect(calls[0]!.reasoning.effort).toBe("high");
    // Phase 1 shares its model id with the app's helper calls, so the marker is what tells them apart.
    expect(logCtx.shadowCallRewrittenFrom).toBeUndefined();
  });

  test("a target that no longer resolves fails the memory call instead of falling back", async () => {
    const settings = config();
    settings.memoryModels = { extract: { model: "ghost/secret-token" } };
    const calls: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)).model);
      return Response.json(completion());
    }) as typeof fetch;
    const response = await handleResponses(request(body(), extractMetadata()), settings, { model: "", provider: "" });
    expect(response.status).toBe(409);
    const error = await response.json() as { error: { code: string; message: string } };
    expect(error.error.code).toBe(MEMORY_MODEL_TARGET_UNAVAILABLE_CODE);
    expect(error.error.message).not.toContain("secret-token");
    expect(calls).toEqual([]);
  });

  test("an admission denial on the memory target keeps the key's own refusal", async () => {
    const settings = config();
    settings.apiKeys = [{
      id: "scoped", name: "mail", key: "ocx_data_" + "c".repeat(40),
      createdAt: "2026-01-01T00:00:00.000Z", allowedProviders: ["elsewhere"],
    }];
    const calls: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)).model);
      return Response.json(completion());
    }) as typeof fetch;
    const response = await handleResponses(
      request(body(), extractMetadata()),
      settings,
      { model: "", provider: "" },
      { admission: { kind: "configured", keyId: "scoped", source: "bearer" } },
    );
    // The shared resolver rethrows an admission refusal, so the memory path reports the key's
    // scope instead of turning it into an unavailable target.
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { type: string } }).error.type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
    expect(calls).toEqual([]);
  });

  test("the phase decision survives the combo handoff", async () => {
    const settings = config();
    settings.combos = { memory: { targets: [{ provider: "gateway", model: "cheap" }] } };
    settings.memoryModels = { extract: { model: "combo/memory", reasoningEffort: "high" } };
    const calls: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(completion());
    }) as typeof fetch;
    const logCtx = { model: "", provider: "" } as RequestLogContext;
    const response = await handleResponses(request(body(), extractMetadata()), settings, logCtx);
    expect(response.status).toBe(200);
    await response.text();
    expect(calls[0]!.model).toBe("cheap");
    expect(calls[0]!.reasoning.effort).toBe("high");
    // A combo target has to reach the dispatcher as `model`, so the rewritten selector is what the
    // log records as requested; the phase itself is named in the route decision.
    expect(logCtx.requestedModel).toBe("combo/memory");
    expect(logCtx.routeDecision?.selected.reason).toBe("memory-extract");
  });
});
