/**
 * :countTokens reads, decodes and parses a body, so it joins the shared inbound-body allowance like
 * generation does (#3023), without taking a turn slot (devlog 261115 parity, review r1).
 */
import { afterEach, expect, test } from "bun:test";
import { dispatchGeminiRoute } from "../../src/server/index/gemini-routes";
import { inboundBodyBudget } from "../../src/server/inbound-body-budget";
import type { OcxConfig } from "../../src/types";

const config = {
  port: 0, hostname: "127.0.0.1", defaultProvider: "fx",
  providers: { fx: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", authMode: "key", apiKey: "fixture", models: ["m"] } },
} as unknown as OcxConfig;

let turnSlots = 0;
const deps = {
  config, policy: config, requestMetricsLogContext: {},
  drainingResponse: () => new Response(null, { status: 503 }),
  runAdmittedHttpTurn: async () => { turnSlots++; return new Response(null, { status: 500 }); },
} as unknown as Parameters<typeof dispatchGeminiRoute>[2];

function countTokensRequest(): Request {
  const body = Bun.gzipSync(JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello there" }] }] }));
  return new Request("http://127.0.0.1/v1beta/models/fx/m:countTokens", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(body.byteLength) },
    body,
  });
}

/** Yield to the event loop a bounded number of times; no wall-clock wait. */
async function settleUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise(resolve => setImmediate(resolve));
}

afterEach(() => { turnSlots = 0; });

test("an encoded countTokens body waits for the shared allowance before any work runs", async () => {
  const holder = await inboundBodyBudget.acquire(inboundBodyBudget.capacity(), new AbortController().signal);
  let settled = false;
  const req = countTokensRequest();
  const pending = dispatchGeminiRoute(req, new URL(req.url), deps).then(response => { settled = true; return response; });
  try {
    await settleUntil(() => inboundBodyBudget.snapshot().queuedRequests > 0);
    expect(inboundBodyBudget.snapshot().queuedRequests).toBe(1);
    expect(settled).toBe(false);
  } finally {
    holder!.release();
  }
  const response = (await pending)!;
  expect(response.status).toBe(200);
  expect((await response.json() as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
  expect(turnSlots).toBe(0);
  await settleUntil(() => inboundBodyBudget.snapshot().activeLeases === 0);
  expect(inboundBodyBudget.snapshot()).toEqual({ reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
});
