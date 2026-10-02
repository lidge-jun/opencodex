/** Physical response attribution through the real adapter and response/search loops. */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
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

const actualResolver = await import("../../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
let adapterRequestsFollow = false;
mock.module("../../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(...args: Parameters<typeof actualResolveAdapter>) {
    const adapter = actualResolveAdapter(...args);
    if (!adapterRequestsFollow) return adapter;
    return {
      ...adapter,
      // Exercise the production OAuth dispatch callback with adapter-owned request options.
      // Keep the real request builder/parser; only this caller asks for default-follow.
      fetchResponse: (request: Parameters<NonNullable<typeof adapter.fetchResponse>>[0], context: Parameters<NonNullable<typeof adapter.fetchResponse>>[1]) =>
        context!.executor!(request.url, {
          method: request.method, headers: request.headers, body: request.body,
          signal: context?.abortSignal, redirect: "follow",
        }),
    };
  },
}));

const originalHome = process.env.OPENCODEX_HOME;
let originalFetch: typeof globalThis.fetch;
let unexpectedGlobalFetches = 0;
let home: string;
let releaseSpendHome: (() => void) | undefined;
let sent: { authorization: string | null; apiKey: string | null; body: Record<string, unknown> }[];

beforeEach(() => {
  adapterRequestsFollow = false;
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
  adapterRequestsFollow = false;
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

test.each([307, 308])("OAuth provider override pins manual dispatch after adapter init for %i", async status => {
  await seed(1);
  adapterRequestsFollow = true;
  let targetHits = 0;
  let originHits = 0;
  const redirects: Array<RequestRedirect | undefined> = [];
  const statuses: number[] = [];
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    targetHits++;
    return answer(false);
  } });
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    originHits++;
    return new Response("redirect", { status, headers: { location: `http://127.0.0.1:${target.port}/target` } });
  } });
  const config = configFor(() => { throw new Error("unused canned transport"); });
  (config.providers.anthropic as OcxProviderConfig & { fetch: typeof fetch }).fetch = (async (input, init) => {
    expect(new URL(String(input)).hostname).toBe("anthropic-quota.test");
    redirects.push(init?.redirect);
    // Remap only the URL; the production callback must supply the safe request options.
    const result = await originalFetch(`http://127.0.0.1:${origin.port}/messages`, init);
    statuses.push(result.status);
    return result;
  }) as typeof fetch;
  try {
    const response = await post(config);
    await response.text();
    expect(targetHits).toBe(0);
    expect(originHits).toBe(1);
    expect(redirects).toEqual(["manual"]);
    expect(statuses).toEqual([status]);
  } finally {
    await origin.stop(true);
    await target.stop(true);
  }
});

test("main A429 -> B200 records both physical responses against their sending accounts", async () => {
  const [a, b] = await seed();
  const config = configFor(body => {
    if (sent.length === 1) return limited();
    expect(sent.length).toBe(2);
    // A must already be measured before the replacement response exists.
    expectQuota(a!, 100, 61);
    expect(getCachedProviderAccountQuota("anthropic", b!)).toBeNull();
    return answer(body.stream === true);
  });
  const response = await post(config);
  const responseText = await response.text();
  expect(response.status).toBe(200);
  expect(responseText).toContain("The answer is complete.");
  expect(sent.map(row => row.authorization)).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
  expectQuota(a!, 100, 61);
  expectQuota(b!, 23, 47);
});

test("terminal 429 after both accounts are exhausted records both refused physical responses", async () => {
  const [a, b] = await seed();
  const response = await post(configFor(() => {
    if (sent.length === 1) return limited();
    expect(sent.length).toBe(2);
    expectQuota(a!, 100, 61);
    return limited("0.89", "1");
  }));
  await response.text();
  expect(response.status).toBe(429);
  expect(sent.map(row => row.authorization)).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
  expectQuota(a!, 100, 61);
  expectQuota(b!, 89, 100);
});

test("manual active switch while A is pending keeps A's measurement off B", async () => {
  const [a, b] = await seed();
  const entered = deferred<void>();
  const returned = deferred<Response>();
  const config = configFor(() => { entered.resolve(); return returned.promise; });
  const pending = post(config);
  await entered.promise;
  let response!: Response;
  try {
    expect(sent[0]!.authorization).toBe(`Bearer ${credential(0).access}`);
    expect(await setActiveAccount("anthropic", b!)).toBe(true);
  } finally {
    returned.resolve(answer(false, "0.37", "0.53"));
    response = await pending;
    await response.text();
  }
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(getAccountSet("anthropic")!.activeAccountId).toBe(b!);
  expectQuota(a!, 37, 53);
  expect(getCachedProviderAccountQuota("anthropic", b!)).toBeNull();
});

test("credential replacement while A is pending skips its old-generation response", async () => {
  const [a, b] = await seed();
  const entered = deferred<void>();
  const returned = deferred<Response>();
  const pending = post(configFor(() => { entered.resolve(); return returned.promise; }));
  await entered.promise;
  let response!: Response;
  try {
    expect(sent[0]!.authorization).toBe(`Bearer ${credential(0).access}`);
    await saveAccountCredential("anthropic", a!, { ...credential(0), access: "synthetic-replacement-access", refresh: "synthetic-replacement-refresh" });
  } finally {
    returned.resolve(answer(false));
    response = await pending;
    await response.text();
  }
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(getAccountSet("anthropic")!.accounts.find(row => row.id === a)!.credential.access).toBe("synthetic-replacement-access");
  expect(getCachedProviderAccountQuota("anthropic", a!)).toBeNull();
  expect(getCachedProviderAccountQuota("anthropic", b!)).toBeNull();
});

const overriddenHeaders: { label: string; headers: Record<string, string>; authorization: string; apiKey: string | null }[] = [
  { label: "overridden bearer", headers: { Authorization: "Bearer synthetic-override" }, authorization: "Bearer synthetic-override", apiKey: null },
  { label: "additional x-api-key", headers: { "x-api-key": "synthetic-api-key" }, authorization: `Bearer ${credential(0).access}`, apiKey: "synthetic-api-key" },
];
test.each(overriddenHeaders)("$label skips quota attribution even when a selected OAuth account exists", async ({ headers, authorization, apiKey }) => {
  const ids = await seed();
  const response = await post(configFor(body => answer(body.stream === true), headers));
  await response.text();
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ authorization, apiKey });
  for (const id of ids) expect(getCachedProviderAccountQuota("anthropic", id)).toBeNull();
});

test("real web-search routed loop records A429 and B200 through fetchForRequest", async () => {
  const [a, b] = await seed();
  const config = configFor(body => {
    // The search loop forces upstream streaming although the client asks for JSON.
    expect(body.stream).toBe(true);
    if (sent.length === 1) return limited();
    expect(sent.length).toBe(2);
    expectQuota(a!, 100, 61);
    return answer(true);
  });
  config.webSearchSidecar = { backend: "anthropic", enabled: true };
  const response = await post(config, { tools: [{ type: "web_search" }] });
  const responseText = await response.text();
  expect(response.status).toBe(200);
  expect(responseText).toContain("The answer is complete.");
  expect(sent.map(row => row.authorization)).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
  expectQuota(a!, 100, 61);
  expectQuota(b!, 23, 47);
});

test("real terminal continuation records A429 before retrying the continuation on B", async () => {
  const [a, b] = await seed();
  const config = configFor(body => {
    // The real guard recognizes an actionable request plus a short execution announcement,
    // with available tools and no tool call. A normal completed answer does not trigger it.
    if (sent.length === 1) return answer(body.stream === true, "0.11", "0.31", "I will modify the file now.");
    if (sent.length === 2) {
      expectQuota(a!, 11, 31);
      return limited();
    }
    expect(sent.length).toBe(3);
    expectQuota(a!, 100, 61);
    return answer(body.stream === true);
  });
  const response = await post(config, {
    input: "Please modify the file now",
    tools: [{ type: "function", name: "read_file", description: "read a file", parameters: { type: "object" } }],
  });
  const responseText = await response.text();
  expect(response.status).toBe(200);
  expect(responseText).toContain("The answer is complete.");
  expect(sent.map(row => row.authorization)).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
  expectQuota(a!, 100, 61);
  expectQuota(b!, 23, 47);
});

test("real image bridge routed loop records A429 and B200 through fetchForRequest", async () => {
  const [a, b] = await seed();
  const config = configFor(body => {
    expect(body.stream).toBe(true);
    // Only the bridge installs this synthetic tool for the hosted image_generation input.
    expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "custom_image_gen" })]));
    if (sent.length === 1) return limited();
    expect(sent.length).toBe(2);
    expectQuota(a!, 100, 61);
    return answer(true);
  });
  config.images = { bridgeEnabled: true };
  config.providers.xai = {
    adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "synthetic-image-key",
  };
  const response = await post(config, { stream: true, tools: [{ type: "image_generation" }] });
  const responseText = await response.text();
  expect(response.status).toBe(200);
  expect(responseText).toContain("The answer is complete.");
  expect(sent.map(row => row.authorization)).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
  expectQuota(a!, 100, 61);
  expectQuota(b!, 23, 47);
});

// BUG-R6340: account refusals recover only before output; generic 403s stay terminal.
function accountRefusal(message = "Your account does not have access to Claude Code", type = "permission_error") {
  return Response.json({ type: "error", error: { type, message } }, { status: 403 });
}

test.each([false, true])("account entitlement 403 fails over and clears sticky eligibility (pool=%s)", async enabled => {
  const [a, b] = await seed();
  const config = configFor(body => sent.length === 1 ? accountRefusal() : answer(body.stream === true));
  config.anthropicAccountPool = { enabled, stickyLimit: 1 };
  const response = await post(config, { prompt_cache_key: "same-session" });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("The answer is complete.");
  expect(sent.map(row => row.authorization)).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
  expect(getEligibleAnthropicAccounts()).toEqual([b!]);
  expect(getAnthropicAccountHealthSnapshot(a!)).not.toBeNull();
  const subsequent = await post(config, { prompt_cache_key: "same-session" });
  expect(subsequent.status).toBe(200);
  await subsequent.text();
  expect(sent[2]!.authorization).toBe(`Bearer ${credential(1).access}`);
});

test.each([
  ["Your Claude subscription has expired", "permission_error"],
  ["Your account does not have an active subscription", "permission_error"],
  ["Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", "billing_error"],
])("credential 403 recovers: %s", async (message, type) => {
  await seed();
  const response = await post(configFor(body => sent.length === 1 ? accountRefusal(message, type) : answer(body.stream === true)), { stream: true });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("The answer is complete.");
  expect(sent).toHaveLength(2);
});

test.each([
  ["Request blocked by content policy", "permission_error"],
  ["You do not have permission to access this resource", "permission_error"],
  ["Your account does not have access to this model", "permission_error"],
  ["Subscription required to access this content", "permission_error"],
  ["Your account does not have access to Claude Code", "invalid_request_error"],
  ["Request denied: Your account does not have access to Claude Code", "permission_error"],
])("request-level or ambiguous 403 stays terminal: %s (%s)", async (message, type) => {
  const ids = await seed();
  const response = await post(configFor(() => accountRefusal(message, type)));
  expect(response.status).toBe(403);
  await response.text();
  expect(sent).toHaveLength(1);
  expect(getEligibleAnthropicAccounts()).toEqual(ids);
});

test("all accounts refused retain the upstream 403 and cool each account", async () => {
  const ids = await seed();
  const response = await post(configFor(() => accountRefusal()));
  expect(response.status).toBe(403);
  expect(await response.text()).toContain("Your account does not have access to Claude Code");
  expect(sent).toHaveLength(2);
  for (const id of ids) expect(getAnthropicAccountHealthSnapshot(id)).not.toBeNull();
});

test.each(["search", "image"])("real %s sidecar recovers account 403", async kind => {
  const [a, b] = await seed();
  const config = configFor(() => sent.length === 1 ? accountRefusal() : answer(true));
  if (kind === "search") config.webSearchSidecar = { backend: "anthropic", enabled: true };
  else {
    config.images = { bridgeEnabled: true };
    config.providers.xai = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "synthetic-image-key" };
  }
  const response = await post(config, { stream: true, tools: [{ type: kind === "search" ? "web_search" : "image_generation" }] });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("The answer is complete.");
  expect(sent).toHaveLength(2);
  expect(getEligibleAnthropicAccounts()).toEqual([b!]);
  expect(getAnthropicAccountHealthSnapshot(a!)).not.toBeNull();
});

test("empty pre-output continuation recovers account 403", async () => {
  await seed();
  const config = configFor(body => {
    if (sent.length === 1) return answer(body.stream === true, "0.1", "0.2", "");
    if (sent.length === 2) return accountRefusal();
    return answer(body.stream === true);
  });
  config.emptyCompletionRetry = true;
  const response = await post(config, { stream: true });
  expect(await response.text()).toContain("The answer is complete.");
  expect(sent.map(row => row.authorization)).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
});

test("403 continuation after assistant output never switches accounts", async () => {
  const ids = await seed();
  const response = await post(configFor(body => sent.length === 1
    ? answer(body.stream === true, "0.1", "0.2", "I will modify the file now.") : accountRefusal()), {
    stream: true, input: "Please modify the file now",
    tools: [{ type: "function", name: "read_file", description: "read a file", parameters: { type: "object" } }],
  });
  expect(await response.text()).toContain("I will modify the file now.");
  expect(sent.map(row => row.authorization)).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(0).access}`]);
  expect(getEligibleAnthropicAccounts()).toEqual(ids);
});


test.each(overriddenHeaders)("403 with $label cannot cool the selected stored credential", async ({ headers }) => {
  const ids = await seed();
  const response = await post(configFor(() => accountRefusal(), headers));
  expect(response.status).toBe(403);
  await response.text();
  expect(sent).toHaveLength(1);
  expect(getEligibleAnthropicAccounts()).toEqual(ids);
});

test("late 403 from a replaced credential cannot cool its replacement", async () => {
  const ids = await seed();
  const entered = deferred<void>();
  const returned = deferred<Response>();
  const pending = post(configFor(() => { entered.resolve(); return returned.promise; }));
  await entered.promise;
  await saveAccountCredential("anthropic", ids[0]!, {
    ...credential(0), access: "synthetic-renewed-access", refresh: "synthetic-renewed-refresh",
  });
  returned.resolve(accountRefusal());
  const response = await pending;
  expect(response.status).toBe(403);
  await response.text();
  expect(sent).toHaveLength(1);
  expect(getEligibleAnthropicAccounts()).toEqual(ids);
});

test.each([
  "not JSON",
  JSON.stringify({ error: { message: "Your account does not have access to Claude Code" } }),
  JSON.stringify({ error: { type: "permission_error", code: "invalid_prompt", message: "Your account does not have access to Claude Code" } }),
  JSON.stringify({ error: { type: "permission_error", message: "Your account does not have access to Claude Code" }, padding: "x".repeat(70_000) }),
])("unproven 403 body leaves eligibility unchanged (%#)", async body => {
  const ids = await seed();
  const response = await post(configFor(() => new Response(body, { status: 403 })));
  expect(response.status).toBe(403);
  await response.text();
  expect(sent).toHaveLength(1);
  expect(getEligibleAnthropicAccounts()).toEqual(ids);
});

test("account 403 cools the final sender even when the request's rotation cap is spent", async () => {
  const ids = await seed(5);
  const response = await post(configFor(() => accountRefusal()));
  expect(response.status).toBe(403);
  await response.text();
  expect(sent).toHaveLength(4);
  for (let index = 0; index < 4; index++) expect(getAnthropicAccountHealthSnapshot(ids[index]!)).not.toBeNull();
  expect(getEligibleAnthropicAccounts()).toEqual([ids[4]!]);
});

test("strict model route does not widen on an account 403", async () => {
  const ids = await seed();
  const config = configFor(() => accountRefusal());
  config.anthropicAccountPool = { enabled: true, routes: [{ name: "restricted", match: "claude-sonnet-4-5", accounts: [ids[0]!] }] };
  const response = await post(config);
  expect(response.status).toBe(403);
  await response.text();
  expect(sent).toHaveLength(1);
  expect(getEligibleAnthropicAccounts()).toEqual([ids[1]!]);
});


test("Claude Messages bridge fails over on account entitlement 403", async () => {
  await seed();
  const config = configFor(body => sent.length === 1 ? accountRefusal() : answer(body.stream === true));
  config.anthropicAccountPool = { enabled: true };
  const { handleClaudeMessages } = await import("../../../src/server/claude-messages");
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", messages: [{ role: "user", content: "Answer briefly" }], max_tokens: 64, stream: false }),
  }), config, { model: "", provider: "" });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("The answer is complete.");
  expect(sent.map(row => row.authorization)).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
});


test("a generic 403 on the replacement is terminal and does not cool that replacement", async () => {
  const [a, b] = await seed();
  const response = await post(configFor(() => sent.length === 1 ? accountRefusal() : accountRefusal("Request blocked by content policy")));
  expect(response.status).toBe(403);
  expect(await response.text()).toContain("Request blocked by content policy");
  expect(sent).toHaveLength(2);
  expect(getAnthropicAccountHealthSnapshot(a!)).not.toBeNull();
  expect(getAnthropicAccountHealthSnapshot(b!)).toBeNull();
});

test.each(["search", "image"])("real %s sidecar leaves request-level 403 terminal", async kind => {
  const ids = await seed();
  const config = configFor(() => accountRefusal("Request blocked by content policy"));
  if (kind === "search") config.webSearchSidecar = { backend: "anthropic", enabled: true };
  else {
    config.images = { bridgeEnabled: true };
    config.providers.xai = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "synthetic-image-key" };
  }
  const response = await post(config, { stream: true, tools: [{ type: kind === "search" ? "web_search" : "image_generation" }] });
  expect(response.status).toBe(403);
  await response.text();
  expect(sent).toHaveLength(1);
  expect(getEligibleAnthropicAccounts()).toEqual(ids);
});
