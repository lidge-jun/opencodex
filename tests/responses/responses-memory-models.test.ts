import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MEMORY_MODEL_TARGET_UNAVAILABLE_CODE,
  applyMemoryModelEffort,
  configuredMemoryModel,
  detectMemoryModelPhase,
} from "../../src/server/responses/memory-models";
import { handleResponses } from "../../src/server/responses";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { warnDegradedMemoryModels } from "../../src/config/load-degrade";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig, OcxParsedRequest } from "../../src/types";

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

  test("takes the phase from the sub-agent header when the metadata copy carries none", () => {
    const headers = new Headers({
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
      "x-openai-subagent": "memory_consolidation",
    });
    expect(detectMemoryModelPhase(body("gpt-5.6-terra"), headers)).toBe("consolidation");
    // Any other internal turn category is not a memory turn.
    expect(detectMemoryModelPhase(body(), new Headers({ "x-openai-subagent": "collab_spawn" }))).toBeNull();
    expect(detectMemoryModelPhase(body(), new Headers({ "x-openai-subagent": "review" }))).toBeNull();
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
      expect(loaded.memoryModels).toBeUndefined();
      expect(loaded.providers).toEqual(config().providers);
    }
  });

  test("an empty block is valid and means both phases stay with Codex", () => {
    const raw = { ...config(), memoryModels: {} };
    expect(validateConfigCandidate(raw).ok).toBe(true);
    expect(configuredMemoryModel(configSchema.parse(raw) as OcxConfig, "extract")).toBeUndefined();
  });

  test("a dropped hand-edited block warns at load; valid or absent blocks stay silent", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => { warnings.push(String(message)); };
    try {
      const invalid = { ...config(), memoryModels: { extract: { model: "" } } };
      warnDegradedMemoryModels(invalid, configSchema.parse(invalid) as OcxConfig);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("memoryModels is invalid");
      warnDegradedMemoryModels(config(), configSchema.parse(config()) as OcxConfig);
      const absent = config();
      delete absent.memoryModels;
      warnDegradedMemoryModels(absent, configSchema.parse(absent) as OcxConfig);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = original;
    }
  });
});

describe("memory model routing", () => {
  test("routes each phase to its own model and effort", async () => {
    const settings = config();
    const calls: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(completion());
    }) as typeof fetch;

    const extractCtx = { model: "", provider: "" } as { model: string; provider: string; requestedModel?: string };
    const extract = await handleResponses(request(body(), extractMetadata()), settings, extractCtx);
    expect(extract.status).toBe(200);
    await extract.text();
    expect(calls[0]!.model).toBe("cheap");
    expect(calls[0]!.reasoning.effort).toBe("high");
    // The caller's own selector stays in the log; only the served model changed.
    expect(extractCtx.requestedModel).toBe("gpt-5.6-luna");
    expect(extractCtx.model).toBe("cheap");

    const consolidationCtx = { model: "", provider: "" } as { model: string; provider: string; requestedModel?: string };
    const consolidation = await handleResponses(request(body("gpt-5.6-terra"), consolidationMetadata()), settings, consolidationCtx);
    expect(consolidation.status).toBe(200);
    await consolidation.text();
    expect(calls[1]!.model).toBe("strong");
    expect(calls[1]!.reasoning.effort).toBe("xhigh");
    expect(consolidationCtx.requestedModel).toBe("gpt-5.6-terra");
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
    settings.memoryModels = { extract: { model: "ghost/cheap" } };
    const calls: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)).model);
      return Response.json(completion());
    }) as typeof fetch;
    const response = await handleResponses(request(body(), extractMetadata()), settings, { model: "", provider: "" });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe(MEMORY_MODEL_TARGET_UNAVAILABLE_CODE);
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
    const logCtx = { model: "", provider: "" } as { model: string; provider: string; requestedModel?: string };
    const response = await handleResponses(request(body(), extractMetadata()), settings, logCtx);
    expect(response.status).toBe(200);
    await response.text();
    expect(calls[0]!.model).toBe("cheap");
    expect(calls[0]!.reasoning.effort).toBe("high");
    // A combo target has to reach the dispatcher as `model`, so the rewritten selector is what the
    // log records as requested; the phase itself is named in the route decision.
    expect(logCtx.requestedModel).toBe("combo/memory");
  });
});
