/** Physical response attribution through the real adapter and response/search loops. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum, getEligibleAnthropicAccounts, getAnthropicAccountHealthSnapshot } from "../../../src/oauth/anthropic-routing";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, saveAccountCredential, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { clearAccountQuotaCache, getCachedProviderAccountQuota, resetProviderQuotaReconcileStateForTests } from "../../../src/providers/quota";
import { clearResponseStateForTests } from "../../../src/responses/state";
import { handleResponses } from "../../../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let originalFetch: typeof globalThis.fetch;
let unexpectedGlobalFetches = 0;
let home: string;
let releaseSpendHome: (() => void) | undefined;
let sent: { authorization: string | null; apiKey: string | null; body: Record<string, unknown> }[];

beforeEach(() => {
  home = "";
  originalFetch = globalThis.fetch;
  unexpectedGlobalFetches = 0;
  globalThis.fetch = (async () => {
    unexpectedGlobalFetches += 1;
    throw new Error("Unexpected global fetch in Anthropic quota dispatch test");
  }) as typeof fetch;
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-quota-dispatch-"));
  process.env.OPENCODEX_HOME = home;
  sent = [];
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  clearResponseStateForTests();
  // Dispatching without starting a server means taking the spend-journal lease here, and
  // releasing it before this case's directory is removed.
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  try {
    // Provider code may catch the guard's rejection; the attempted network call still fails the test.
    expect(unexpectedGlobalFetches).toBe(0);
  } finally {
    try {
      // Cancel the debounced persistence before restoring the real home.
      clearAccountQuotaCache();
      clearAnthropicAccountPoolState();
      forgetAnthropicFailoverQuorum();
      clearGenericFailoverHealth();
      resetProviderQuotaReconcileStateForTests();
      clearResponseStateForTests();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      if (home) removeTreeWithRetry(home);
    }
  }
});

function credential(index: number) {
  return {
    access: `synthetic-anthropic-access-${index}`,
    refresh: `synthetic-anthropic-refresh-${index}`,
    expires: Date.now() + 3_600_000,
    accountId: `synthetic-account-${index}`,
  };
}

async function seed(count = 2): Promise<string[]> {
  for (let index = 0; index < count; index++) {
    await saveCredential("anthropic", credential(index));
  }
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  return ids;
}

function quotaHeaders(fiveHour: string, weekly: string): Record<string, string> {
  return {
    "anthropic-ratelimit-unified-5h-utilization": fiveHour,
    "anthropic-ratelimit-unified-7d-utilization": weekly,
  };
}

function limited(fiveHour = "1", weekly = "0.61"): Response {
  return Response.json({ type: "error", error: { type: "rate_limit_error", message: "synthetic quota exhausted" } }, {
    status: 429,
    headers: { ...quotaHeaders(fiveHour, weekly), "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" },
  });
}

function answer(stream: boolean, fiveHour = "0.23", weekly = "0.47", text = "The answer is complete."): Response {
  const usage = { input_tokens: 8, output_tokens: 6 };
  const message = { id: "msg_synthetic", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage };
  if (!stream) return Response.json(message, { headers: quotaHeaders(fiveHour, weekly) });
  const frames = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
    { type: "message_stop" },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { ...quotaHeaders(fiveHour, weekly), "content-type": "text/event-stream" },
  });
}

function configFor(reply: (body: Record<string, unknown>) => Response | Promise<Response>, headers?: Record<string, string>): OcxConfig {
  const transport = (async (_input, init) => {
    const wireHeaders = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ authorization: wireHeaders.get("authorization"), apiKey: wireHeaders.get("x-api-key"), body });
    return reply(body);
  }) as typeof fetch;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic", baseUrl: "https://anthropic-quota.test", authMode: "oauth",
    models: ["claude-sonnet-4-5"], fetch: transport, ...(headers ? { headers } : {}),
  };
  return {
    port: 0, defaultProvider: "anthropic",
    anthropicAccountPool: { enabled: false, strategy: "round-robin" },
    providers: { anthropic: provider },
  };
}

function post(config: OcxConfig, body: Record<string, unknown> = {}) {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", input: "Answer briefly", stream: false, ...body }),
  }), config, { model: "", provider: "" });
}

function expectQuota(id: string, fiveHourPercent: number, weeklyPercent: number) {
  expect(getCachedProviderAccountQuota("anthropic", id)).toMatchObject({ fiveHourPercent, weeklyPercent });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}



import { anthropicModelFamily, anthropicFamilyRejected, claimAnthropicFamilyRevalidation, observeAnthropicFamilyQuota, ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS } from "../../../src/oauth/anthropic-model-quota";
import { recordAnthropicAccountRefusal, getAnthropicPoolRetryAfterSeconds, resolveAnthropicAccountForSession, bindAnthropicSessionAffinity, resetAnthropicRoutingForManualSelection, commitAnthropicSelectionRouting } from "../../../src/oauth/anthropic-routing";
import { parseAnthropicRateLimitHeaders, recordAnthropicAccountQuotaFromHeaders, setCachedProviderAccountQuotaForTests, fetchProviderAccountQuotas } from "../../../src/providers/quota";
import { accountQuotaCache, accountCacheKey, normalizeAnthropicQuota } from "../../../src/providers/quota/account-cache";
import { saveAccountCredential } from "../../../src/oauth/store";

const FABLE = "claude-fable-5-1";
const SONNET = "claude-sonnet-4-5";
function familyHeaders(percent?: string, rejected = false, reset = Date.now() + 3_600_000) {
  return new Headers({
    ...(percent === undefined ? {} : { "anthropic-ratelimit-unified-7d_oi-utilization": percent }),
    ...(rejected ? { "anthropic-ratelimit-unified-7d_oi-status": "rejected" } : {}),
    "anthropic-ratelimit-unified-7d_oi-reset": String(Math.floor(reset / 1000)),
  });
}
function observe(id: string, headers: Headers) { recordAnthropicAccountQuotaFromHeaders(id, headers, 0); }
function pick(config: OcxConfig, model: string, key?: string, now = Date.now()) {
  return resolveAnthropicAccountForSession(key, config, now, null, model).accountId;
}

test("fixture-confirmed oi is Fable 5, without broad future-family attribution", () => {
  expect(anthropicModelFamily(FABLE)).toBe("Fable");
  expect(anthropicModelFamily("claude-fable-6")).toBeUndefined();
  expect(anthropicModelFamily("other-fable-5")).toBeUndefined();
  expect(parseAnthropicRateLimitHeaders(familyHeaders("1.01"))?.customWindows).toMatchObject([{ label: "Fable", scope: "model", percent: 100 }]);
});

test.each(["quota", "round-robin", "fill-first"] as const)("%s family-only rejection leaves Sonnet manual and affinity on A", async strategy => {
  const [a, b] = await seed();
  const config = configFor(() => answer(false)); config.anthropicAccountPool = { enabled: true, strategy };
  observe(a!, familyHeaders(undefined, true));
  resetAnthropicRoutingForManualSelection(a!);
  bindAnthropicSessionAffinity("family-session", a!);
  expect(pick(config, FABLE, "family-session")).toBe(b!);
  expect(pick(config, SONNET, "family-session")).toBe(a!);
  expect(getAnthropicAccountHealthSnapshot(a!)).toBeNull();
});

test("shared weekly exhaustion prefers B even with Fable headroom, retaining all-drained soft fallback", async () => {
  const [a, b] = await seed();
  const config = configFor(() => answer(false)); config.anthropicAccountPool = { enabled: true };
  setCachedProviderAccountQuotaForTests("anthropic", a!, { weeklyPercent: 100, customWindows: [{ label: "Fable", scope: "model", percent: 10 }], updatedAt: Date.now() });
  setCachedProviderAccountQuotaForTests("anthropic", b!, { weeklyPercent: 20, updatedAt: Date.now() });
  expect(pick(config, FABLE)).toBe(b!);
  setCachedProviderAccountQuotaForTests("anthropic", b!, { weeklyPercent: 100, updatedAt: Date.now() });
  expect(pick(config, FABLE)).toBeTruthy();
});

test("zero is a soft threshold; family verdict still binds only Fable", async () => {
  const [a, b] = await seed();
  const config = configFor(() => answer(false)); config.anthropicAccountPool = { enabled: true, autoSwitchThreshold: 0 };
  setCachedProviderAccountQuotaForTests("anthropic", a!, { customWindows: [{ label: "Fable", scope: "model", percent: 99 }], updatedAt: Date.now() });
  expect(pick(config, FABLE)).toBe(a!);
  observe(a!, familyHeaders(undefined, true));
  expect(pick(config, FABLE)).toBe(b!);
  expect(pick(config, SONNET)).toBe(a!);
});

test("independent resets and absent family headers preserve each window without extending the probe clock", async () => {
  const [a] = await seed();
  const now = Date.now();
  setCachedProviderAccountQuotaForTests("anthropic", a!, { fiveHourPercent: 10, fiveHourResetAt: now + 500, customWindows: [{ label: "Sonnet", scope: "model", percent: 40, resetAt: now + 10_000 }], updatedAt: now });
  const ts = accountQuotaCache.get(accountCacheKey("anthropic", a!))!.ts;
  observe(a!, familyHeaders("0.3", false, now + 20_000));
  observe(a!, new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.2" }));
  const quota = getCachedProviderAccountQuota("anthropic", a!)!;
  expect(quota.customWindows?.map(row => row.label)).toEqual(["Sonnet", "Fable"]);
  expect(accountQuotaCache.get(accountCacheKey("anthropic", a!))!.ts).toBe(ts);
  const later = normalizeAnthropicQuota(quota, now + 11_000)!;
  expect(later.fiveHourPercent).toBeUndefined();
  expect(later.weeklyPercent).toBe(20);
  expect(later.customWindows?.map(row => row.label)).toEqual(["Fable"]);
});

test.each(["NaN", "-0.1", "42", "1e308", "Infinity"])("malformed family utilization %s stays unknown", value => {
  expect(parseAnthropicRateLimitHeaders(familyHeaders(value))).toBeNull();
});

test("rejection without utilization is bounded, expired passive exclusion admits one revalidation", async () => {
  const [a] = await seed();
  const now = Date.now();
  observeAnthropicFamilyQuota(a!, [{ label: "Fable", scope: "model", percent: 100, rejected: true, resetAt: now + 86_400_000 }], now);
  expect(anthropicFamilyRejected(a!, FABLE, now)).toBe(true);
  const later = now + ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS;
  const release = claimAnthropicFamilyRevalidation(a!, FABLE, later);
  expect(release).not.toBeNull();
  expect(claimAnthropicFamilyRevalidation(a!, FABLE, later)).toBeNull();
  expect(anthropicFamilyRejected(a!, SONNET, later)).toBe(false);
  release!();
  expect(anthropicFamilyRejected(a!, FABLE, later)).toBe(false);
});

test("A/B observations interleave independently and credential replacement drops family refusal", async () => {
  const [a, b] = await seed();
  observe(a!, familyHeaders(undefined, true));
  observe(b!, familyHeaders("0.2"));
  expect(anthropicFamilyRejected(a!, FABLE)).toBe(true);
  expect(anthropicFamilyRejected(b!, FABLE)).toBe(false);
  await saveAccountCredential("anthropic", a!, { ...credential(0), access: "synthetic-replacement" });
  expect(anthropicFamilyRejected(a!, FABLE)).toBe(false);
  expect(getCachedProviderAccountQuota("anthropic", a!)).toBeNull();
  expect(getCachedProviderAccountQuota("anthropic", b!)?.customWindows?.[0]?.percent).toBe(20);
});

test.each([false, true])("active probe enumeration=%s preserves absent or retires family evidence authoritatively", async enumerates => {
  const [a] = await seed();
  observe(a!, familyHeaders(undefined, true));
  globalThis.fetch = (async () => Response.json({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 }, ...(enumerates ? { limits: [] } : {}) })) as typeof fetch;
  await fetchProviderAccountQuotas("anthropic", true);
  expect(anthropicFamilyRejected(a!, FABLE)).toBe(!enumerates);
  expect(getCachedProviderAccountQuota("anthropic", a!)?.customWindows?.some(row => row.label === "Fable") ?? false).toBe(!enumerates);
  globalThis.fetch = originalFetch;
});

test("physical Fable refusal switches bearer, while another Sonnet session keeps A eligible", async () => {
  const [a] = await seed();
  const config = configFor(body => sent.length === 1
    ? Response.json({ error: { type: "rate_limit_error", message: "synthetic family refusal" } }, { status: 429, headers: familyHeaders(undefined, true) })
    : answer(body.stream === true));
  config.providers.anthropic!.models = [FABLE, SONNET]; config.anthropicAccountPool = { enabled: true };
  bindAnthropicSessionAffinity("sonnet-session", a!);
  const response = await post(config, { model: "anthropic/" + FABLE }); await response.text();
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(2);
  expect(sent[0]!.authorization).not.toBe(sent[1]!.authorization);
  expect(pick(config, SONNET, "sonnet-session")).toBe(a!);
});

test.each(["NaN", "1e308", "-1", "0", "not-a-reset"])("malformed family reset %s cannot create a deadline", value => {
  const headers = familyHeaders("0.4"); headers.set("anthropic-ratelimit-unified-7d_oi-reset", value);
  expect(parseAnthropicRateLimitHeaders(headers)?.customWindows?.[0]?.resetAt).toBeUndefined();
});

test("stale family exclusion serializes physical revalidation until headers arrive", async () => {
  const [a] = await seed(1);
  const stale = Date.now() - ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS;
  observeAnthropicFamilyQuota(a!, [{ label: "Fable", scope: "model", percent: 100, rejected: true }], stale);
  const entered = deferred<void>(); const headers = deferred<Response>();
  const config = configFor(() => { entered.resolve(); return headers.promise; });
  config.providers.anthropic!.models = [FABLE]; config.anthropicAccountPool = { enabled: true };
  const first = post(config, { model: "anthropic/" + FABLE });
  await entered.promise;
  const second = await post(config, { model: "anthropic/" + FABLE });
  expect(second.status).toBe(429); await second.text();
  expect(sent).toHaveLength(1);
  const response = answer(false); response.headers.set("anthropic-ratelimit-unified-7d_oi-utilization", "0.2");
  headers.resolve(response);
  expect((await first).status).toBe(200);
  expect(anthropicFamilyRejected(a!, FABLE)).toBe(false);
});

test("malformed enumeration cannot retire absent family evidence", async () => {
  const [a] = await seed(); observe(a!, familyHeaders(undefined, true));
  globalThis.fetch = (async () => Response.json({ five_hour: { utilization: 10 }, limits: [null] })) as typeof fetch;
  await fetchProviderAccountQuotas("anthropic", true);
  expect(anthropicFamilyRejected(a!, FABLE)).toBe(true);
  globalThis.fetch = originalFetch;
});

test("family verdict remains authoritative without overwriting a reported utilization counter", async () => {
  const [a] = await seed(); observe(a!, familyHeaders("0.3", true));
  expect(getCachedProviderAccountQuota("anthropic", a!)?.customWindows?.[0]?.percent).toBe(30);
  expect(anthropicFamilyRejected(a!, FABLE)).toBe(true);
});

test("multiple shared/family holds advertise the latest required deadline per account", async () => {
  const [a] = await seed(1);
  const now = Date.now();
  observeAnthropicFamilyQuota(a!, [{ label: "Fable", scope: "model", percent: 100, rejected: true, resetAt: now + 600_000 }], now);
  expect(getAnthropicPoolRetryAfterSeconds(now, null, FABLE)).toBe(600);
  expect(getAnthropicPoolRetryAfterSeconds(now, null, SONNET)).toBeNull();
  const config = configFor(() => answer(false)); config.anthropicAccountPool = { enabled: true };
  recordAnthropicAccountRefusal(config, a!, 429, null, now, new Headers({
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String((now + 300_000) / 1000),
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String((now + 400_000) / 1000),
  }));
  expect(getAnthropicPoolRetryAfterSeconds(now, null, FABLE)).toBe(600);
  expect(getAnthropicPoolRetryAfterSeconds(now, null, SONNET)).toBe(400);
});

test("a sidecar family refusal after a published search call cannot rotate or replay", async () => {
  await seed();
  globalThis.fetch = (async () => Response.json({ content: [{ type: "text", text: "Synthetic search result" }], usage: { input_tokens: 1, output_tokens: 1 } })) as typeof fetch;
  const config = configFor(() => {
    if (sent.length > 1) return Response.json({ error: { type: "rate_limit_error", message: "synthetic family refusal" } }, { status: 429, headers: familyHeaders(undefined, true) });
    const frames = [
      { type: "message_start", message: { id: "msg_search", type: "message", role: "assistant", model: FABLE, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_search", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"synthetic query"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  config.providers.anthropic!.models = [FABLE]; config.anthropicAccountPool = { enabled: true };
  config.webSearchSidecar = { enabled: true, backend: "anthropic" };
  const response = await post(config, { model: "anthropic/" + FABLE, stream: true, tools: [{ type: "web_search" }] });
  const body = await response.text();
  expect(body).toContain("web_search_call");
  expect(sent).toHaveLength(2);
  expect(sent[0]!.authorization).toBe(sent[1]!.authorization);
  globalThis.fetch = originalFetch;
});

test("an older active probe cannot erase a newer family refusal", async () => {
  const [a] = await seed();
  const entered = deferred<void>(); const result = deferred<Response>();
  globalThis.fetch = (async () => { entered.resolve(); return result.promise; }) as typeof fetch;
  const probe = fetchProviderAccountQuotas("anthropic", true);
  await entered.promise;
  observe(a!, familyHeaders(undefined, true));
  result.resolve(Response.json({ five_hour: { utilization: 10 }, limits: [] }));
  await probe;
  expect(anthropicFamilyRejected(a!, FABLE)).toBe(true);
  expect(getCachedProviderAccountQuota("anthropic", a!)?.customWindows?.[0]?.rejected).toBe(true);
  globalThis.fetch = originalFetch;
});
