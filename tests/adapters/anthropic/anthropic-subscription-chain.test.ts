/**
 * One model id, three billing paths: an Anthropic OAuth subscription pool, Cursor's copy of the
 * same model, then a pay-per-use Anthropic API key. A failover combo whose alias is the model id
 * the clients already send gives that order; `metered` keeps issued keys off the API-key target,
 * and the pool's `quotaRecheckMs` brings a spent subscription back before its weekly reset.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../../src/types";
import type { DataPlaneAdmission } from "../../../src/server/auth-cors";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const MODEL = "claude-opus-5-5";
const ISSUED_KEY_ID = "issued-key";
let cursorLimited = false;
let cursorOverflow = false;
let astraBodies: Record<string, unknown>[] = [];
let cursorModels: string[] = [];
let cursorEfforts: unknown[] = [];

const actualResolver = await import("../../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
mock.module("../../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter !== "cursor") return actualResolveAdapter(provider, cacheRetention);
    return {
      name: "cursor",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream() { yield { type: "error", message: "fixture uses runTurn" } as AdapterEvent; },
      async runTurn(parsed: { modelId: string; options?: { reasoning?: unknown } }, _incoming: unknown, emit: (event: AdapterEvent) => void) {
        cursorModels.push(parsed.modelId);
        cursorEfforts.push(parsed.options?.reasoning);
        if (cursorOverflow) {
          emit({ type: "error", status: 400, message: "Cursor context limit exceeded: Cursor Connect error resource limit exceeded: Error", code: "context_length_exceeded" });
          return;
        }
        if (cursorLimited) {
          emit({ type: "error", status: 429, message: "You've hit your usage limit", code: "rate_limit_exceeded" });
          return;
        }
        emit({ type: "text_delta", text: "cursor answered" });
        emit({ type: "done" });
      },
    } as unknown as ProviderAdapter;
  },
}));

const { handleChatCompletions } = await import("../../../src/server/chat-completions");
const { saveCredential, getAccountSet, setActiveAccount } = await import("../../../src/oauth/store");
const {
  clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum, getAnthropicAccountHealthSnapshot,
} = await import("../../../src/oauth/anthropic-routing");
const { clearComboSelectionState } = await import("../../../src/combos/resolve");
const { clearComboTargetCooldowns } = await import("../../../src/combos/failover");
const { clearGenericFailoverHealth } = await import("../../../src/oauth/generic-account-failover");
const { clearAccountQuotaCache } = await import("../../../src/providers/quota");

type Lane = "subscription" | "api-key";
type Sent = { lane: Lane; authorization: string | null; apiKey: string | null; body: Record<string, unknown> };
let sent: Sent[] = [];
let subscriptionSpent = false;
let apiKeyLimited = false;
let home = "";
let releaseSpendHome: (() => void) | undefined;
const originalHome = process.env.OPENCODEX_HOME;

function sse(): Response {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response([
    event("message_start", { type: "message_start", message: { id: "msg_chain", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "anthropic answered" } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
    event("message_stop", { type: "message_stop" }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

/** The 2026-09-28 shape: a spent weekly window with an 88.5-hour Retry-After. */
function weeklySpent(): Response {
  return Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "usage limit reached" } },
    { status: 429, headers: { "anthropic-ratelimit-unified-7d-status": "rejected", "retry-after": "318747" } },
  );
}

function transport(lane: Lane): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      lane,
      authorization: headers.get("authorization"),
      apiKey: headers.get("x-api-key"),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const limited = lane === "subscription" ? subscriptionSpent : apiKeyLimited;
    return limited ? weeklySpent() : sse();
  }) as typeof fetch;
}

function config(options: { combo?: boolean; quotaRecheckMs?: number; allowMetered?: boolean; astra?: boolean } = {}): OcxConfig {
  const subscription = { adapter: "anthropic", baseUrl: "https://subscription.test", authMode: "oauth", models: [MODEL], fetch: transport("subscription") };
  const apiKey = { adapter: "anthropic", baseUrl: "https://api-key.test", authMode: "key", apiKey: "${CHAIN_TEST_ANTHROPIC_KEY}", models: [MODEL], fetch: transport("api-key") };
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: {
      anthropic: subscription as OcxProviderConfig,
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth", models: [MODEL] },
      ...(options.astra ? {} : { "anthropic-metered": apiKey as OcxProviderConfig }),
      ...(options.astra ? { astra: {
        adapter: "openai-chat", baseUrl: "https://astra.test/v1", authMode: "key", apiKey: "fake-astra",
        fastWire: { kind: "service-tier", canonicalToWire: { priority: "priority" }, foreignCallerTiers: "verbatim" },
        supportsServiceTier: true,
        models: ["gpt-6-astra"], fetch: astraTransport,
      } } : {}),
    },
    ...(options.quotaRecheckMs ? { anthropicAccountPool: { quotaRecheckMs: options.quotaRecheckMs } } : {}),
    apiKeys: [{
      id: ISSUED_KEY_ID, name: "issued", key: "ocx_data_issued_key_for_chain_test", createdAt: "2026-10-09T00:00:00.000Z",
      allowedModels: [MODEL],
      ...(options.allowMetered ? { allowMeteredComboTargets: true } : {}),
    }],
    ...(options.combo === false ? {} : {
      combos: {
        "claude-chain": {
          alias: `anthropic/${MODEL}`,
          strategy: "failover",
          targets: [
            { provider: "anthropic", model: MODEL },
            { provider: "cursor", model: MODEL },
            ...(options.astra ? [] : [{ provider: "anthropic-metered", model: MODEL, metered: true }]),
            ...(options.astra ? [{ provider: "astra", model: "gpt-6-astra", reasoningEffort: "high", serviceTier: "priority" }] : []),
          ],
        },
      },
    }),
  } as OcxConfig;
}

const LOOPBACK: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
const ISSUED: DataPlaneAdmission = { kind: "configured", keyId: ISSUED_KEY_ID, source: "bearer" };

async function chat(cfg: OcxConfig, admission: DataPlaneAdmission = LOOPBACK) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: req => handleChatCompletions(req, cfg, { model: "", provider: "" },
      { requestId: "chain-test", start: Date.now(), admission } as never),
  });
  try {
  const response = await fetch(new URL("/v1/chat/completions", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: `anthropic/${MODEL}`,
      stream: false,
      reasoning_effort: "medium",
      messages: [{ role: "system", content: "S".repeat(5000) }, { role: "user", content: "hi" }],
    }),
  });
  return { status: response.status, text: await response.text() };
  } finally {
    await server.stop(true);
  }
}

const lanes = () => sent.map(entry => entry.lane);

const astraTransport: typeof fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
  astraBodies.push(JSON.parse(String(init?.body ?? "{}")));
  return new Response([
    `data: ${JSON.stringify({ id: "astra", object: "chat.completion.chunk", model: "gpt-6-astra", choices: [{ index: 0, delta: { role: "assistant", content: "astra answered" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "astra", object: "chat.completion.chunk", model: "gpt-6-astra", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}, { preconnect: fetch.preconnect });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-subscription-chain-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CHAIN_TEST_ANTHROPIC_KEY = "sk-ant-chain-test";
  releaseSpendHome = acquireOwnedSpendHome();
  for (let index = 0; index < 2; index++) {
    await saveCredential("anthropic", {
      access: `subscription-access-${index}`, refresh: `subscription-refresh-${index}`,
      expires: Date.now() + 3_600_000, accountId: `subscription-account-${index}`,
    });
  }
  await setActiveAccount("anthropic", getAccountSet("anthropic")!.accounts[0]!.id);
  await saveCredential("cursor", { access: "cursor-access", refresh: "cursor-refresh", expires: Date.now() + 3_600_000, accountId: "cursor-account" });
  sent = []; cursorModels = []; cursorEfforts = [];
  subscriptionSpent = false; cursorLimited = false; apiKeyLimited = false;
  cursorOverflow = false; astraBodies = [];
  clearComboSelectionState(); clearComboTargetCooldowns(); clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum(); clearGenericFailoverHealth(); clearAccountQuotaCache();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearComboSelectionState(); clearComboTargetCooldowns(); clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum(); clearGenericFailoverHealth(); clearAccountQuotaCache();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  delete process.env.CHAIN_TEST_ANTHROPIC_KEY;
  removeTreeWithRetry(home);
});

test("a healthy subscription serves the aliased id with the same wire body as the plain route", async () => {
  expect((await chat(config({ combo: false }))).status).toBe(200);
  const plainBody = sent[0]!.body;
  sent = [];
  clearAnthropicAccountPoolState();

  const response = await chat(config());
  expect(response.status).toBe(200);
  expect(response.text).toContain("anthropic answered");
  expect(lanes()).toEqual(["subscription"]);
  expect(sent[0]!.authorization).toStartWith("Bearer subscription-access-");
  expect(JSON.stringify({ ...sent[0]!.body, metadata: undefined })).toBe(JSON.stringify({ ...plainBody, metadata: undefined }));
  expect(JSON.stringify(sent[0]!.body)).toContain("cache_control");
});

test("every subscription account spent moves to Cursor's claude-opus-5-5 at the same effort", async () => {
  subscriptionSpent = true;
  const response = await chat(config());
  expect(response.status).toBe(200);
  expect(response.text).toContain("cursor answered");
  expect(cursorModels).toEqual([MODEL]);
  expect(cursorEfforts).toEqual(["medium"]);
  expect(lanes().every(lane => lane === "subscription")).toBe(true);
});

test("subscription and Cursor limited moves a local caller to the API key with x-api-key and cache_control", async () => {
  subscriptionSpent = true;
  cursorLimited = true;
  const response = await chat(config());
  expect(response.status).toBe(200);
  const metered = sent.filter(entry => entry.lane === "api-key");
  expect(metered).toHaveLength(1);
  expect(metered[0]!.apiKey).toBe("sk-ant-chain-test");
  expect(metered[0]!.authorization).toBeNull();
  expect(JSON.stringify(metered[0]!.body)).toContain("cache_control");
});

test("all three limited returns the limit to the caller so its own fallback takes over", async () => {
  subscriptionSpent = true;
  cursorLimited = true;
  apiKeyLimited = true;
  const response = await chat(config());
  expect(response.status).toBe(429);
  expect(sent.filter(entry => entry.lane === "api-key")).toHaveLength(1);
});

test("an issued key stops before the metered target and gets the error instead", async () => {
  subscriptionSpent = true;
  cursorLimited = true;
  const response = await chat(config(), ISSUED);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.text).not.toContain("answered");
  expect(cursorModels).toEqual([MODEL]);
  expect(sent.filter(entry => entry.lane === "api-key")).toHaveLength(0);
});

test("an issued key that opts in may reach the metered target", async () => {
  subscriptionSpent = true;
  cursorLimited = true;
  const response = await chat(config({ allowMetered: true }), ISSUED);
  expect(response.status).toBe(200);
  expect(sent.filter(entry => entry.lane === "api-key")).toHaveLength(1);
});

test("quotaRecheckMs caps a spent account's weekly cooldown so a recovered subscription is used again", async () => {
  subscriptionSpent = true;
  const recheckMs = 5 * 60_000;
  const before = Date.now();
  expect((await chat(config({ quotaRecheckMs: recheckMs }))).text).toContain("cursor answered");
  const cooled = getAccountSet("anthropic")!.accounts
    .map(account => getAnthropicAccountHealthSnapshot(account.id))
    .filter(snapshot => snapshot !== null);
  expect(cooled.length).toBeGreaterThan(0);
  for (const snapshot of cooled) {
    expect(snapshot!.cooldownUntil!).toBeLessThanOrEqual(Date.now() + recheckMs);
    expect(snapshot!.cooldownUntil!).toBeGreaterThanOrEqual(before + recheckMs);
  }

  subscriptionSpent = false;
  sent = []; cursorModels = [];
  const later = Date.now() + recheckMs + 1;
  const realNow = Date.now;
  Date.now = () => later;
  try {
    const response = await chat(config({ quotaRecheckMs: recheckMs }));
    expect(response.text).toContain("anthropic answered");
  } finally {
    Date.now = realNow;
  }
  expect(lanes()).toEqual(["subscription"]);
  expect(cursorModels).toEqual([]);
});

test("without quotaRecheckMs the stated 88-hour reset still holds the account out", async () => {
  subscriptionSpent = true;
  await chat(config());
  const snapshots = getAccountSet("anthropic")!.accounts
    .map(account => getAnthropicAccountHealthSnapshot(account.id))
    .filter(snapshot => snapshot !== null);
  expect(snapshots.length).toBeGreaterThan(0);
  for (const snapshot of snapshots) expect(snapshot!.cooldownUntil! - Date.now()).toBeGreaterThan(80 * 3_600_000);
});

test("an intervening request during pool cooldown cannot postpone the five-minute subscription recheck", async () => {
  subscriptionSpent = true;
  const cfg = config({ quotaRecheckMs: 300_000 });
  const start = Date.now();
  const realNow = Date.now;
  try {
    Date.now = () => start;
    expect((await chat(cfg)).text).toContain("cursor answered");
    Date.now = () => start + 240_000;
    expect((await chat(cfg)).text).toContain("cursor answered");
    subscriptionSpent = false;
    sent = []; cursorModels = [];
    Date.now = () => start + 300_001;
    expect((await chat(cfg)).text).toContain("anthropic answered");
    expect(lanes()).toEqual(["subscription"]);
    expect(cursorModels).toEqual([]);
  } finally {
    Date.now = realNow;
  }
});

for (const fallback of ["cursor", "astra"] as const) {
  test(`subscription-only three-stage chain returns from ${fallback} after the original recheck deadline`, async () => {
    const cfg = config({ quotaRecheckMs: 300_000, astra: true });
    subscriptionSpent = true;
    cursorLimited = fallback !== "cursor";
    const start = Date.now();
    const realNow = Date.now;
    Date.now = () => start;
    try {
      const first = await chat(cfg);
      expect(first.status).toBe(200);
      expect(first.text).toContain(`${fallback} answered`);
      if (fallback === "astra") {
        expect(lanes()).toEqual(["subscription", "subscription"]);
        expect(cursorModels).toEqual([MODEL]);
        expect(astraBodies).toHaveLength(1);
        expect(astraBodies[0]?.reasoning_effort).toBe("high");
        expect(astraBodies[0]?.service_tier).toBe("priority");
      }
      Date.now = () => start + 240_000;
      expect((await chat(cfg)).status).toBe(200);
      subscriptionSpent = false;
      sent = []; cursorModels = []; astraBodies = [];
      Date.now = () => start + 300_001;
      const recovered = await chat(cfg);
      expect(recovered.status).toBe(200);
      expect(recovered.text).toContain("anthropic answered");
      expect(lanes()).toEqual(["subscription"]);
      expect(cursorModels).toEqual([]);
      expect(astraBodies).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });
}

test("Cursor context rejection hops to Astra without poisoning the next request", async () => {
  subscriptionSpent = true;
  cursorOverflow = true;
  const cfg = config({ quotaRecheckMs: 300_000, astra: true });
  expect((await chat(cfg)).text).toContain("astra answered");
  expect(lanes()).not.toContain("api-key");
  cursorOverflow = false;
  sent = []; cursorModels = [];
  expect((await chat(cfg)).text).toContain("cursor answered");
  expect(cursorModels).toEqual([MODEL]);
  expect(lanes()).not.toContain("api-key");
});

test("buffered combo preflight preserves Cursor's structured rate-limit status", async () => {
  cursorLimited = true;
  const cfg = config({ astra: true });
  const combo = cfg.combos?.["claude-chain"];
  if (!combo) throw new Error("Missing fixture combo");
  combo.targets = [{ provider: "cursor", model: MODEL }];
  const response = await chat(cfg);
  expect(response.status).toBe(429);
  expect(JSON.parse(response.text).error.code).toBe("rate_limit_exceeded");
});
