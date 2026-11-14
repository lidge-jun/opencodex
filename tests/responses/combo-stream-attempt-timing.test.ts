/**
 * Combo failover and attempt timing.
 *
 * 1. A combo that fails over still relays the surviving target's stream as it arrives: the combo
 *    preflight holds bytes only until the first output event, so later deltas reach the client
 *    at the upstream's pace instead of in one burst at the end.
 * 2. A key rotation inside one combo target seals the earlier key as its own attempt. The live
 *    attempt is timed from the rotation, so the request's attempt durations never add up to more
 *    time than the request took.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleComboResponses, handleResponses } from "../../src/server/responses/core";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { noteProviderAttemptSend, type RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
const reset = (): void => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
};
beforeEach(() => {
  reset();
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  reset();
});

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const DELTAS = 5;
const GAP_MS = 120;

function event(payload: Record<string, unknown>): string {
  return `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** A Responses SSE whose text deltas are spaced GAP_MS apart. */
function pacedResponsesStream(): Response {
  const frames = [
    event({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }),
    event({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
    ...Array.from({ length: DELTAS }, (_, i) => event({
      type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: `w${i} `,
    })),
    event({
      type: "response.completed",
      response: {
        id: "resp_1", status: "completed",
        output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }],
        usage: { input_tokens: 2, output_tokens: DELTAS, total_tokens: DELTAS + 2 },
      },
    }),
  ];
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
        if (frame.includes("output_text.delta")) await sleep(GAP_MS);
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const rateLimited = () => Response.json({ error: { message: "rate limited", type: "rate_limit_error" } }, { status: 429 });

function provider(name: string, extra: Record<string, unknown> = {}) {
  return {
    adapter: "openai-responses",
    baseUrl: `https://${name}.example/v1`,
    authMode: "key",
    apiKey: `sk-${name}-1`,
    models: [`model-${name}`],
    ...extra,
  };
}

function comboConfig(providers: Record<string, unknown>, targets: string[]): OcxConfig {
  return {
    defaultProvider: targets.at(-1),
    providers,
    combos: { fan: { strategy: "failover", targets: targets.map(name => ({ provider: name, model: `model-${name}` })) } },
  } as unknown as OcxConfig;
}

async function run(
  config: OcxConfig,
  logCtx: RequestLogContext,
  dispatchers = { handleComboResponses, handleResponses },
): Promise<Response> {
  const req = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/fan", stream: true, input: "hello" }),
  });
  return executeComboResponses(req, await req.clone().json(), "fan", config, logCtx, {
    translatorBudget: createTranslatorBudget(),
  }, dispatchers);
}

/** Read the body and return the arrival time of each chunk that carries a text delta. */
async function deltaArrivals(response: Response, startedAt: number): Promise<number[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const arrivals: number[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return arrivals;
    const text = decoder.decode(next.value, { stream: true });
    const count = text.split("\n").filter(line => line.startsWith("data:") && line.includes("\"response.output_text.delta\"")).length;
    for (let i = 0; i < count; i++) arrivals.push(performance.now() - startedAt);
  }
}

describe("combo failover streaming", () => {
  test("the surviving target's deltas reach the client at the upstream's pace", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).host;
      return host.startsWith("bad") ? rateLimited() : pacedResponsesStream();
    }) as typeof fetch;
    const startedAt = performance.now();
    const response = await run(comboConfig({ bad: provider("bad"), good: provider("good") }, ["bad", "good"]), { model: "", provider: "" });
    expect(response.status).toBe(200);
    const arrivals = await deltaArrivals(response, startedAt);
    expect(arrivals).toHaveLength(DELTAS);
    // A buffered relay would deliver every delta within a few ms of the last one.
    expect(arrivals.at(-1)! - arrivals[0]!).toBeGreaterThanOrEqual(GAP_MS * (DELTAS - 2));
  }, 15_000);
});

describe("combo attempt timing across a key rotation", () => {
  test("each key's attempt is timed on its own and the sum fits inside the request", async () => {
    const KEY_LATENCY_MS = 150;
    globalThis.fetch = (async () => pacedResponsesStream()) as typeof fetch;
    const config = comboConfig({ pool: provider("pool"), good: provider("good") }, ["pool", "good"]);
    const keyed = (entryId: string) => ({
      ...config.providers.pool!,
      _apiKeyAttempt: { entryId, reference: `sk-pool-${entryId}` },
    });
    // The pooled target stands in for a child that rotates keys once and is refused on both: the
    // rotation runs through the same request-log seam a real key or account rotation does.
    const rotatingChild: typeof handleResponses = async (_req, _config, childLog) => {
      noteProviderAttemptSend(childLog, "pool", keyed("k1"), undefined);
      await sleep(KEY_LATENCY_MS);
      noteProviderAttemptSend(childLog, "pool", keyed("k2"), undefined, "key-429");
      await sleep(KEY_LATENCY_MS);
      return rateLimited();
    };
    const dispatchers = {
      handleComboResponses,
      handleResponses: ((req, cfg, childLog, ...rest) => childLog.provider === "pool"
        ? rotatingChild(req, cfg, childLog, ...rest)
        : handleResponses(req, cfg, childLog, ...rest)) as typeof handleResponses,
    };
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const startedAt = Date.now();
    const response = await run(config, logCtx, dispatchers);
    expect(response.status).toBe(200);
    await response.text();
    const elapsed = Date.now() - startedAt;

    const attempts = logCtx.attempts ?? [];
    const poolAttempts = attempts.filter(attempt => attempt.provider === "pool");
    expect(poolAttempts).toHaveLength(2);
    expect(poolAttempts[1]!.recoveryKinds).toEqual(["key-429"]);
    for (const attempt of poolAttempts) {
      // Timed from its own send: one key's latency, not the target's running total.
      expect(attempt.durationMs).toBeLessThan(KEY_LATENCY_MS * 2 - 40);
    }
    const sum = attempts.reduce((total, attempt) => total + (attempt.durationMs ?? 0), 0);
    expect(sum).toBeLessThanOrEqual(elapsed + 5);
  }, 15_000);
});
