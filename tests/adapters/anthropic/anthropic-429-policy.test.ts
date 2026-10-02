/** Physical response attribution through the real adapter and response/search loops. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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


import { classifyAnthropic429, anthropicRetryAfterMs, anthropicRatePauseUntil } from "../../../src/oauth/anthropic-rate-limit-policy";
import { bindAnthropicRefusalCredential, rotateAnthropicAccountOnResponse } from "../../../src/oauth/anthropic-account-refusal";
import { credentialGeneration, getAccountCredential } from "../../../src/oauth/store";
import { bindAnthropicSessionAffinity, resolveAnthropicAccountForSession } from "../../../src/oauth/anthropic-routing";

test.each([
  [{}, "request-scoped-unknown"],
  [{ "retry-after": "invalid" }, "request-scoped-unknown"],
  [{ "retry-after": "0.001" }, "transient-rate"],
  [{ "anthropic-ratelimit-unified-status": "allowed" }, "transient-rate"],
  [{ "anthropic-ratelimit-unified-7d_oi-status": "rejected", "anthropic-ratelimit-unified-5h-status": "allowed" }, "family-quota"],
  [{ "anthropic-ratelimit-unified-7d_oi-status": "rejected", "anthropic-ratelimit-unified-7d-status": "rejected" }, "shared-quota"],
  [{ "anthropic-ratelimit-unified-5h-status": "rejected" }, "shared-quota"],
] as const)("classifies trusted unified headers %#", (headers, expected) => {
  expect(classifyAnthropic429(new Headers(headers))).toBe(expected);
});

test("Retry-After validates dates, fractions and invalid deadlines", () => {
  const now = Date.UTC(2026, 9, 2);
  expect(anthropicRetryAfterMs("0.25", now)).toBe(250);
  expect(anthropicRetryAfterMs(new Date(now + 2000).toUTCString(), now)).toBe(2000);
  for (const value of [null, "", "0", "-1", "NaN", "1e308", "invalid"]) expect(anthropicRetryAfterMs(value, now)).toBeUndefined();
});

function refused(headers: Record<string, string> = {}) {
  return Response.json({ error: { type: "rate_limit_error", message: "synthetic request refusal" } }, { status: 429, headers });
}

test.each(["main", "continuation", "search"])("%s physical headerless refusal retries once on A and never walks the roster", async lane => {
  const ids = await seed(3);
  const config = configFor(body => lane === "continuation" && sent.length === 1 ? answer(body.stream === true, "0.1", "0.2", "") : refused());
  if (lane === "continuation") config.emptyCompletionRetry = true;
  if (lane === "search") config.webSearchSidecar = { backend: "anthropic", enabled: true };
  const response = await post(config, lane === "search" ? { tools: [{ type: "web_search" }] } : {});
  await response.text();
  expect(sent).toHaveLength(lane === "continuation" ? 3 : 2);
  expect(sent.every(row => row.authorization === `Bearer ${credential(0).access}`)).toBe(true);
  expect(ids.map(id => getAnthropicAccountHealthSnapshot(id))).toEqual([null, null, null]);
  if (lane === "main") expect(response.headers.get("retry-after")).toBeNull();
});

test.each(["main", "continuation", "search"])("%s physical transient refusal takes at most one sibling detour", async lane => {
  const ids = await seed(3);
  const config = configFor(body => lane === "continuation" && sent.length === 1 ? answer(body.stream === true, "0.1", "0.2", "") : refused({ "retry-after": "30" }));
  if (lane === "continuation") config.emptyCompletionRetry = true;
  if (lane === "search") config.webSearchSidecar = { backend: "anthropic", enabled: true };
  const response = await post(config, lane === "search" ? { tools: [{ type: "web_search" }] } : {});
  await response.text();
  expect(new Set(sent.map(row => row.authorization)).size).toBe(2);
  expect(sent).toHaveLength(lane === "continuation" ? 3 : 2);
  expect(ids.map(id => getAnthropicAccountHealthSnapshot(id))).toEqual([null, null, null]);
  expect(anthropicRatePauseUntil(ids[0]!)).toBeDefined();
  expect(anthropicRatePauseUntil(ids[1]!)).toBeDefined();
  expect(anthropicRatePauseUntil(ids[2]!)).toBeUndefined();
});

test("same-account throttle backoff preserves healthy affinity", async () => {
  const [a] = await seed();
  const config = configFor(body => sent.length === 1 ? refused({ "retry-after": "0.001" }) : answer(body.stream === true));
  config.anthropicAccountPool = { enabled: true };
  bindAnthropicSessionAffinity("synthetic-session", a!);
  const response = await post(config);
  await response.text();
  expect(sent).toHaveLength(2);
  expect(sent[0]!.authorization).toBe(sent[1]!.authorization);
  expect(resolveAnthropicAccountForSession("synthetic-session", config).accountId).toBe(a!);
  expect(getAnthropicAccountHealthSnapshot(a!)).toBeNull();
});

test("default single-account refusal has no new retry or health mutation", async () => {
  const [a] = await seed(1);
  const response = await post(configFor(() => refused({ "retry-after": "0.001" })));
  await response.text();
  expect(sent).toHaveLength(1);
  expect(getAnthropicAccountHealthSnapshot(a!)).toBeNull();
  expect(anthropicRatePauseUntil(a!)).toBeUndefined();
});

test("final-budget shared refusal records health; transient only pauses; unknown stays request-local", async () => {
  const [a] = await seed();
  const config = configFor(() => answer(false));
  for (const headers of [{}, { "retry-after": "30" }, { "anthropic-ratelimit-unified-5h-status": "rejected" }]) {
    clearAnthropicAccountPoolState();
    const response = refused(headers);
    const cred = getAccountCredential("anthropic", a!)!;
    bindAnthropicRefusalCredential(response, { provider: "anthropic", accountId: a!, accessToken: cred.access, generation: credentialGeneration(cred) });
    expect(await rotateAnthropicAccountOnResponse(response, { config, accountId: a!, canRetry: false })).toBeNull();
    expect(getAnthropicAccountHealthSnapshot(a!) !== null).toBe("anthropic-ratelimit-unified-5h-status" in headers);
  }
});

test("aborted and non-replayable refusals never mutate or replay", async () => {
  const [a] = await seed();
  const config = configFor(() => answer(false));
  const response = refused({ "retry-after": "30" });
  const cred = getAccountCredential("anthropic", a!)!;
  bindAnthropicRefusalCredential(response, { provider: "anthropic", accountId: a!, accessToken: cred.access, generation: credentialGeneration(cred) });
  const controller = new AbortController(); controller.abort();
  expect(await rotateAnthropicAccountOnResponse(response, { config, accountId: a!, canRetry: true, signal: controller.signal })).toBeNull();
  expect(getAnthropicAccountHealthSnapshot(a!)).toBeNull();
});

import { markResponseNonReplayable } from "../../../src/lib/upstream-retry";
test("ambiguous-send marker forbids quota health mutation", async () => {
  const [a] = await seed();
  const response = refused({ "anthropic-ratelimit-unified-5h-status": "rejected" });
  const cred = getAccountCredential("anthropic", a!)!;
  bindAnthropicRefusalCredential(response, { provider: "anthropic", accountId: a!, accessToken: cred.access, generation: credentialGeneration(cred) });
  markResponseNonReplayable(response);
  expect(await rotateAnthropicAccountOnResponse(response, { config: configFor(() => answer(false)), accountId: a!, canRetry: true })).toBeNull();
  expect(getAnthropicAccountHealthSnapshot(a!)).toBeNull();
});

test("streamed continuation after output cannot retry a headerless refusal", async () => {
  await seed();
  const response = await post(configFor(body => sent.length === 1
    ? answer(body.stream === true, "0.1", "0.2", "I will modify the file now.") : refused()), {
    stream: true, input: "Please modify the file now",
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
  });
  await response.text();
  expect(sent).toHaveLength(2);
});


import { recordAnthropicAccountRefusal } from "../../../src/oauth/anthropic-routing";
import { pauseAnthropicRateAdmission } from "../../../src/oauth/anthropic-rate-limit-policy";

test.each([undefined, "invalid", "0", "past", "future"])("aggregate shared rejection uses reset %s or the default", async reset => {
  const [a] = await seed();
  const now = Date.now();
  const headers = new Headers({ "anthropic-ratelimit-unified-status": "rejected" });
  const resetAt = Math.floor((now + 300_000) / 1000) * 1000;
  if (reset !== undefined) headers.set("anthropic-ratelimit-unified-reset",
    reset === "future" ? String(resetAt / 1000) : reset === "past" ? String((now - 1000) / 1000) : reset);
  expect(classifyAnthropic429(headers, now)).toBe("shared-quota");
  expect(recordAnthropicAccountRefusal(configFor(() => answer(false)), a!, 429, null, now, headers)).toBe(true);
  expect(getAnthropicAccountHealthSnapshot(a!, now)).toEqual({
    cooldownUntil: reset === "future" ? resetAt : now + 60_000,
    cooldownSource: reset === "future" ? "reset-derived" : "default",
  });
});

test.each([false, true])("early throttle timer retries unless a concurrent pause extends it (%s)", async extended => {
  const [a] = await seed();
  const response = refused({ "retry-after": "0.02" });
  const cred = getAccountCredential("anthropic", a!)!;
  bindAnthropicRefusalCredential(response, { provider: "anthropic", accountId: a!, accessToken: cred.access, generation: credentialGeneration(cred) });
  const start = Date.now(); let clock = start;
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  try {
    const retry = rotateAnthropicAccountOnResponse(response, {
      config: configFor(() => answer(false)), accountId: a!, canRetry: true, requestKey: {},
    });
    clock = start + 19;
    if (extended) pauseAnthropicRateAdmission(a!, start + 200);
    expect(await retry).toBe(extended ? null : a!);
    expect(anthropicRatePauseUntil(a!)).toBe(extended ? start + 200 : undefined);
  } finally { now.mockRestore(); }
});
