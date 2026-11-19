import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, getKeyCooldownUntil } from "../../src/providers/key-failover";
import { CLIENT_ERROR_CONTRACTS, CLAUDE_CONTEXT_OVERFLOW_MESSAGE } from "../../src/lib/client-error-body";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import {
  REPLAY_REFUSAL_NO_RETRY_HEADER,
  REPLAY_REFUSAL_NO_RETRY_VALUE,
  REPLAY_REFUSED_STATUS,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
  isReplayRefusalResponse,
} from "../../src/lib/upstream-retry";
import { DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC } from "../../src/lib/retry-after";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS, removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";
import { HOME_INITIATED_LINK_TUNNEL, relayLinkDataRequest } from "../../src/client/link-relay";
import { handleResponses } from "../../src/server/responses";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { saveCredential } from "../../src/oauth/store";
import * as oauth from "../../src/oauth";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";

/**
 * The acceptance unit for the ambiguous-resend refusal is not the shape of one response: it is
 * how many times the turn physically reaches upstream when a real client is allowed to retry.
 * A single `fetch` cannot see that, because a client with retries enabled is the thing that
 * resends -- the proxy answered correctly and the duplicate inference happened anyway.
 *
 * So these cases run the proxy over a real socket, count the sends at the upstream boundary,
 * and drive it with a client that retries the way the published SDKs do. The four surfaces
 * are asserted against one expectation because a client cannot tell them apart: it sent one
 * turn and the turn may already have executed, whichever endpoint carried it.
 */
const UPSTREAM_HOST = "replay-refusal-parity.example.test";
const originalFetch = globalThis.fetch;
let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  clearKeyCooldowns();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearRequestLogsForTests();
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-replay-refusal-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-replay-refusal-"));
  process.env.OPENCODEX_HOME = testDir;
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  clearKeyCooldowns();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  globalThis.fetch = originalFetch;
  if (testDir) await removeTreeAfterBackgroundWork(testDir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
}, BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS);

/**
 * The retry rule of the official clients, written as they write it.
 *
 * The header name and its two accepted values are deliberately literals here rather than the
 * constants this repository exports. This function stands in for the third party: it has to
 * keep believing what `openai` and `anthropic` believe -- an explicit verdict first, then the
 * 408/409/429/5xx table -- even if our own constant were changed to something no client reads.
 */
function sdkWouldRetry(response: Response): boolean {
  const verdict = response.headers.get("x-should-retry");
  if (verdict === "true") return true;
  if (verdict === "false") return false;
  return response.status === 408 || response.status === 409
    || response.status === 429 || response.status >= 500;
}

/** One logical request through a client whose retries are enabled. */
async function sendWithClientRetries(
  url: URL,
  body: Record<string, unknown>,
  maxRetries = 2,
): Promise<{ response: Response; attempts: number; json: { error?: { code?: string } } }> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const response = await originalFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (attempts > maxRetries || !sdkWouldRetry(response)) {
      return { response, attempts, json: await response.json() as { error?: { code?: string } } };
    }
    // Release the body before the next attempt, as the SDKs do.
    await response.text();
  }
}

/**
 * Count physical upstream sends and answer each one as the fixture dictates. Everything not
 * addressed to the fixture host -- the client's own calls included -- keeps the real fetch.
 */
function countingUpstream(answer: () => Response): () => number {
  let sends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input
      : input instanceof URL ? input.href
        : input.url;
    if (!url.includes(UPSTREAM_HOST)) return originalFetch(input as RequestInfo, init);
    sends += 1;
    return answer();
  }) as typeof fetch;
  return () => sends;
}

/** A half-closed pooled socket: the request has left, and nothing comes back. */
function preHeaderReset(): never {
  throw Object.assign(
    new Error("The socket connection was closed unexpectedly."),
    { code: "ECONNRESET" },
  );
}

function parityConfig(): OcxConfig {
  const provider = (apiKey: string, adapter: string) => ({
    adapter,
    baseUrl: `https://${UPSTREAM_HOST}/v1`,
    authMode: "key",
    apiKey,
    models: ["model"],
  });
  return {
    port: 0,
    defaultProvider: "native",
    providers: {
      // Native Chat keeps the caller on the Chat wire; the bridged row translates through
      // Responses and back, which is the surface that used to lose the refusal.
      native: provider("sk-native", "openai-chat"),
      bridged: provider("sk-bridged", "openai-responses"),
    },
  } as unknown as OcxConfig;
}

const CHAT_TURN = { messages: [{ role: "user", content: "ping" }] };
const CLAUDE_TURN = { max_tokens: 64, messages: [{ role: "user", content: "ping" }] };
const RESPONSES_TURN = { input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }] };

for (const wire of ["responses", "messages"] as const) for (const replacement of [false, true]) {
  test(`review: ${wire} key recovery stops on a header-only no-retry 401 (replacement ${replacement})`, async () => {
    const config = parityConfig();
    config.protocols = { rollout: { managedMessagesNative: true } };
    const provider = config.providers.native!;
    provider.adapter = wire === "messages" ? "anthropic" : "openai-chat";
    provider.apiKeyPool = [
      { id: "primary", key: "sk-native" }, { id: "backup", key: "sk-review-backup" },
      { id: "unused", key: "sk-review-unused" },
    ];
    let sends = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      sends++;
      return Response.json({ error: { type: "authentication_error", message: "Fixture authentication refusal" } },
        { status: 401, headers: !replacement || sends > 1 ? { "x-should-retry": "false" } : {} });
    } });
    for (const provider of Object.values(config.providers)) {
      provider.baseUrl = new URL("/v1", upstream.url).href;
      provider.noProxy = "127.0.0.1";
      provider.allowPrivateNetwork = true;
    }
    saveConfig(config);
    const release = acquireOwnedSpendHome();
    try {
      const request = new Request(`http://localhost/v1/${wire}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "native/model", stream: false, store: false, ...(wire === "messages" ? CLAUDE_TURN : RESPONSES_TURN) }) });
      const response = await (wire === "messages" ? handleClaudeMessages : handleResponses)(request, config, { model: "", provider: "" });
      const payload = await response.text();
      expect({ sends, status: response.status, payload }).toMatchObject({ sends: replacement ? 2 : 1, status: 401 });
      expect(response.status).toBe(401);
      expect(response.headers.get("x-should-retry")).toBe("false");
    } finally { release(); await upstream.stop(true); }
  });
}

for (const envelope of [false, true]) for (const overflow of [false, true]) {
  test(`review: routed Messages retains explicit replay refusal (envelope ${envelope}, overflow ${overflow})`, async () => {
    const config = parityConfig();
    let sends = 0;
    const error = { code: "upstream_response_refused", type: "invalid_request_error",
      message: overflow ? "prompt is too long" : "Fixture replay refusal" };
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      sends++;
      return envelope ? Response.json({ id: "resp_review", object: "response", status: "failed", output: [], error })
        : Response.json({ error }, { status: 400 });
    } });
    for (const provider of Object.values(config.providers)) {
      provider.baseUrl = new URL("/v1", upstream.url).href;
      provider.noProxy = "127.0.0.1";
      provider.allowPrivateNetwork = true;
    }
    saveConfig(config);
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "bridged/model", stream: false, ...CLAUDE_TURN }),
      }), config, { model: "", provider: "" });
      const json = await response.json();
      expect({ sends, status: response.status, error: json.error }).toMatchObject({ sends: 1, status: 429 });
      expect(response.status).toBe(429);
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(response.headers.get("retry-after")).toBeNull();
      expect(json.error).toMatchObject({ code: error.code, message: CLIENT_ERROR_CONTRACTS.replay_refused });
    } finally { release(); await upstream.stop(true); }
  });
}

for (const replacement of [false, true]) {
  test(`review: OAuth account recovery stops on a header-only no-retry 429 (replacement ${replacement})`, async () => {
    clearGenericFailoverHealth();
    for (let index = 0; index < 3; index++) await saveCredential("nous", {
      access: `fixture-access-${index}`, refresh: "", expires: Date.now() + 3_600_000,
      accountId: `fixture-${index}`,
    }, { addAccount: true });
    let sends = 0;
    // The direct route reaches this strict in-memory fetch; an inherited SOCKS proxy must
    // never replace a test executor with a network transport to the registry's fixed host.
    globalThis.fetch = (async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "inference-api.nousresearch.com") throw new Error("Unexpected fixture destination");
      sends++;
      return Response.json({ error: { message: "Fixture account rate limit", type: "rate_limit_error" } },
        { status: 429, headers: !replacement || sends > 1 ? { "x-should-retry": "false" } : {} });
    }) as typeof fetch;
    const config = { port: 0, defaultProvider: "nous", providers: { nous: {
      adapter: "openai-chat", authMode: "oauth", baseUrl: "https://inference-api.nousresearch.com/v1",
      proxy: "direct", models: ["model"],
    } } } as OcxConfig;
    saveConfig(config);
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "nous/model", stream: false, store: false, ...RESPONSES_TURN }),
      }), config, { model: "", provider: "" });
      const payload = await response.text();
      expect({ sends, status: response.status, payload }).toMatchObject({ sends: replacement ? 2 : 1, status: 429 });
      expect(response.headers.get("x-should-retry")).toBe("false");
    } finally { release(); clearGenericFailoverHealth(); }
  });
}

test("review: native Responses header-only no-retry 401 preserves the refusal without OAuth refresh", async () => {
  await saveCredential("cursor", { access: "fixture-access", refresh: "", expires: Date.now() + 3_600_000,
    accountId: "fixture-account" });
  let sends = 0;
  globalThis.fetch = (async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api2.cursor.sh") throw new Error("Unexpected fixture destination");
    sends++;
    return Response.json({ error: { message: "Fixture authentication refusal", type: "authentication_error" } },
      { status: 401, headers: { "x-should-retry": "false" } });
  }) as typeof fetch;
  const config = { port: 0, defaultProvider: "cursor", providers: { cursor: {
    adapter: "openai-responses", authMode: "oauth", baseUrl: "https://api2.cursor.sh",
    proxy: "direct", models: ["model"], modelAdapters: { model: "openai-responses" },
  } } } as OcxConfig;
  saveConfig(config);
  // A mistakenly entered refresh remains local and observable; no test contacts an auth server.
  const refresh = spyOn(oauth, "forceRefreshOAuthAccessSnapshot").mockImplementation(async snapshot => snapshot);
  const release = acquireOwnedSpendHome();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cursor/model", stream: false, store: false, ...RESPONSES_TURN }),
    }), config, { model: "", provider: "" });
    const payload = await response.text();
    expect({ sends, status: response.status, payload }).toMatchObject({ sends: 1, status: 401 });
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(refresh).not.toHaveBeenCalled();
  } finally { release(); refresh.mockRestore(); }
});

test("every HTTP surface answers an ambiguous reset with one send and no client resend", async () => {
  saveConfig(parityConfig());
  const sends = countingUpstream(preHeaderReset);
  const server = startServer(0);
  const surfaces = [
    { name: "native Chat", path: "/v1/chat/completions", body: { model: "native/model", ...CHAT_TURN } },
    { name: "translated Chat", path: "/v1/chat/completions", body: { model: "bridged/model", ...CHAT_TURN } },
    { name: "Responses", path: "/v1/responses", body: { model: "bridged/model", ...RESPONSES_TURN } },
    { name: "routed Claude Messages", path: "/v1/messages", body: { model: "bridged/model", ...CLAUDE_TURN } },
  ];
  try {
    for (const surface of surfaces) {
      const before = sends();
      const { response, attempts, json } = await sendWithClientRetries(
        new URL(surface.path, server.url),
        surface.body,
      );
      // The number this refusal exists to hold at one, per logical request.
      expect({ surface: surface.name, sends: sends() - before, attempts })
        .toEqual({ surface: surface.name, sends: 1, attempts: 1 });
      expect({ surface: surface.name, status: response.status, code: json.error?.code }).toEqual({
        surface: surface.name,
        status: REPLAY_REFUSED_STATUS,
        code: UPSTREAM_RESET_REPLAY_REFUSED_CODE,
      });
      // No wait to honour, and no automatic resend of a turn that may already have run.
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(response.headers.get(REPLAY_REFUSAL_NO_RETRY_HEADER)).toBe(REPLAY_REFUSAL_NO_RETRY_VALUE);
    }
  } finally {
    await server.stop(true);
  }
});

test("translated Chat logs a replay refusal as a transport failure", async () => {
  saveConfig(parityConfig());
  const sends = countingUpstream(preHeaderReset);
  const server = startServer(0);
  try {
    const { response, json } = await sendWithClientRetries(new URL("/v1/chat/completions", server.url), {
      model: "bridged/model", ...CHAT_TURN,
    });
    expect(sends()).toBe(1);
    expect(response.status).toBe(429);
    expect(json.error?.code).toBe("upstream_reset_replay_refused");
    expect(getRequestLogEntries()).toHaveLength(1);
    expect(getRequestLogEntries()[0]).toMatchObject({
      errorCode: "upstream_reset_replay_refused",
      failureCause: "transport-ambiguous",
      upstreamCondition: "upstream_failed",
    });
  } finally {
    await server.stop(true);
  }
});

/**
 * The control that keeps the assertion above honest. A client double that never resends would
 * pin "one send" for any answer at all, so the same client has to be shown resending a real
 * rate limit -- the answer a refusal was indistinguishable from on the translated surfaces.
 */
test("the same client still resends an ordinary upstream rate limit", async () => {
  saveConfig(parityConfig());
  const sends = countingUpstream(() => new Response(
    JSON.stringify({ error: { message: "Too many requests", type: "rate_limit_error" } }),
    { status: 429, headers: { "content-type": "application/json" } },
  ));
  const server = startServer(0);
  try {
    const { response, attempts } = await sendWithClientRetries(
      new URL("/v1/messages", server.url),
      { model: "bridged/model", ...CLAUDE_TURN },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC));
    expect(response.headers.get(REPLAY_REFUSAL_NO_RETRY_HEADER)).toBeNull();
    expect(attempts).toBe(3);
    expect(sends()).toBeGreaterThan(1);
  } finally {
    await server.stop(true);
  }
});

/**
 * The same refusal has to hold inside a combo. The answer to a spent replacement can keep its real
 * status (a 400 naming a context overflow) with only an in-memory marker, and the combo rebuilds a
 * failed attempt as a new response. If that dropped the marker, the combo would read the overflow
 * as target-local and send the same turn to its next target, although the first send may already
 * have run it.
 */
const COMBO_FIRST_HOST = "replay-combo-first.example.test";
const COMBO_SECOND_HOST = "replay-combo-second.example.test";

function comboReplayConfig(): OcxConfig {
  const provider = (host: string, apiKey: string, extra: Record<string, unknown> = {}) => ({
    adapter: "openai-responses",
    baseUrl: `https://${host}/v1`,
    authMode: "key",
    apiKey,
    models: ["model"],
    ...extra,
  });
  return {
    port: 0,
    defaultProvider: "first",
    providers: {
      // The first target opts in to one ambiguous-reset replacement; the second never should be sent.
      first: provider(COMBO_FIRST_HOST, "sk-combo-first", { retryOnReset: {} }),
      second: provider(COMBO_SECOND_HOST, "sk-combo-second"),
    },
    combos: { pair: { strategy: "failover", targets: [
      { provider: "first", model: "model" },
      { provider: "second", model: "model" },
    ] } },
  } as unknown as OcxConfig;
}

test.each([
  { reason: "response limit", nativeMessages: true }, { reason: "caller abort", nativeMessages: true },
  { reason: "response limit", nativeMessages: false }, { reason: "caller abort", nativeMessages: false },
  { reason: "delayed response limit", nativeMessages: true }, { reason: "delayed response limit", nativeMessages: false },
])("a serialized relay $reason keeps one SDK attempt and no combo hop (native Messages $nativeMessages)", async ({ reason, nativeMessages }) => {
  const config = { ...parityConfig(), combos: comboReplayConfig().combos, protocols: { rollout: { managedMessagesNative: nativeMessages } } };
  Object.assign(config.providers, comboReplayConfig().providers);
  config.providers.messages = { ...config.providers.native, adapter: "anthropic" };
  const backupKey = "sk-relay-unused-backup";
  for (const name of ["native", "bridged", "messages", "first"]) {
    const provider = config.providers[name]!;
    provider.retryOn429 = { enabled: true, attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false };
    provider.apiKeyPool = [{ id: "primary", key: provider.apiKey! }, { id: "backup", key: backupKey }];
  }
  saveConfig(config);
  let firstSends = 0;
  let secondSends = 0;
  let backupSends = 0;
  let delayedWire: { url: URL; stop: () => Promise<void> } | undefined;
  const delayedTimers = new Set<ReturnType<typeof setTimeout>>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(COMBO_SECOND_HOST)) {
      secondSends += 1;
      return Response.json({ error: { code: "unexpected_second_target" } }, { status: 400 });
    }
    if (!url.includes(UPSTREAM_HOST) && !url.includes(COMBO_FIRST_HOST)) return originalFetch(input as RequestInfo, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.get("authorization") === `Bearer ${backupKey}` || headers.get("x-api-key") === backupKey) backupSends += 1;
    firstSends += 1;
    const caller = new AbortController();
    const refused = await relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/responses", {
      method: "POST", body: "{}", signal: caller.signal,
    }), { tunnelPort: 12000, admissionKey: `ocx_data_${"d".repeat(40)}` }, {
      tunnel: HOME_INITIATED_LINK_TUNNEL,
      fetchImpl: (async () => {
        if (reason === "caller abort") caller.abort();
        return new Response("ok", { headers: reason !== "caller abort" ? { "x-pad": "x".repeat(100 * 1024) } : {} });
      }) as typeof fetch,
    });
    if (reason === "delayed response limit") {
      if (!delayedWire) {
        // Keep production status, headers and exact bytes; only the HTTP delivery timing changes.
        const bytes = new Uint8Array(await refused.arrayBuffer());
        expect(bytes.byteLength).toBeLessThan(4_096);
        const wire = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
          let timer: ReturnType<typeof setTimeout>;
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(bytes.subarray(0, -1));
            timer = setTimeout(() => { delayedTimers.delete(timer); controller.enqueue(bytes.subarray(-1)); controller.close(); }, 2_500);
            delayedTimers.add(timer);
          }, cancel() { clearTimeout(timer); delayedTimers.delete(timer); } }), { status: refused.status, headers: refused.headers });
        } });
        delayedWire = { url: wire.url, stop: () => wire.stop(true) };
      }
      const started = performance.now();
      const response = await originalFetch(delayedWire.url, { signal: init?.signal });
      expect(performance.now() - started).toBeLessThan(1_000);
      return response;
    }
    // A wire boundary drops WeakSet provenance; only the actual relay body and headers remain.
    return new Response(await refused.text(), { status: refused.status, headers: refused.headers });
  }) as typeof fetch;
  const server = startServer(0);
  const surfaces = [
    { path: "/v1/chat/completions", body: { model: "native/model", ...CHAT_TURN } },
    { path: "/v1/chat/completions", body: { model: "bridged/model", ...CHAT_TURN } },
    { path: "/v1/responses", body: { model: "bridged/model", ...RESPONSES_TURN } },
    { path: "/v1/messages", body: { model: "bridged/model", ...CLAUDE_TURN } },
    { path: "/v1/messages", body: { model: "messages/model", ...CLAUDE_TURN } },
    { path: "/v1/responses", body: { model: "combo/pair", ...RESPONSES_TURN } },
  ];
  try {
    for (const surface of surfaces) {
      const before = firstSends;
      const { response, attempts, json } = await sendWithClientRetries(new URL(surface.path, server.url), surface.body);
      expect({ surface: surface.body.model, status: response.status, json, sends: firstSends - before, attempts }).toMatchObject({
        surface: surface.body.model, status: REPLAY_REFUSED_STATUS, json: { error: { code: "upstream_response_refused" } }, sends: 1, attempts: 1,
      });
      expect({ sends: firstSends - before, secondSends, attempts }).toEqual({ sends: 1, secondSends: 0, attempts: 1 });
      expect(backupSends).toBe(0);
      const name = surface.body.model === "combo/pair" ? "first" : surface.body.model.split("/")[0]!;
      expect(loadConfig().providers[name]?.apiKey).toBe(config.providers[name]!.apiKey);
      expect(getKeyCooldownUntil(name, "primary")).toBeNull();
      const message = (json.error as { message?: string } | undefined)?.message;
      if (surface.path !== "/v1/responses") expect(message).toBe(CLIENT_ERROR_CONTRACTS.replay_refused);
      expect(message).not.toMatch(/rate limit|retry later/i);
      expect(response.status).toBe(REPLAY_REFUSED_STATUS);
      expect(response.headers.get(REPLAY_REFUSAL_NO_RETRY_HEADER)).toBe(REPLAY_REFUSAL_NO_RETRY_VALUE);
      expect(response.headers.get("Retry-After")).toBeNull();
    }
  } finally {
    await server.stop(true);
    await delayedWire?.stop();
    for (const timer of delayedTimers) clearTimeout(timer);
  }
});

test.each([undefined, "upstream_no_response", "upstream_closed_before_response"])("header-only no-retry keeps native Messages overflow normalization (%s)", async code => {
  const config = { ...parityConfig(), protocols: { rollout: { managedMessagesNative: true } } };
  config.providers.messages = { ...config.providers.native!, adapter: "anthropic" };
  saveConfig(config);
  const sends = countingUpstream(() => Response.json({ error: {
    type: "invalid_request_error", message: "prompt is too long", ...(code ? { code } : {}),
  } }, { status: 400, headers: { "x-should-retry": "false" } }));
  const server = startServer(0);
  try {
    const { response, attempts, json } = await sendWithClientRetries(new URL("/v1/messages", server.url),
      { model: "messages/model", ...CLAUDE_TURN });
    expect({ status: response.status, sends: sends(), attempts }).toEqual({ status: 400, sends: 1, attempts: 1 });
    expect((json.error as { message?: string }).message).toBe(CLAUDE_CONTEXT_OVERFLOW_MESSAGE);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(isReplayRefusalResponse(response)).toBe(false);
  } finally { await server.stop(true); }
});

test.each(["upstream_reset_replay_refused", "upstream_response_refused"])("explicit proxy refusal %s outranks native Messages overflow wording", async code => {
  const config = { ...parityConfig(), protocols: { rollout: { managedMessagesNative: true } } };
  config.providers.messages = { ...config.providers.native!, adapter: "anthropic" };
  saveConfig(config);
  const sends = countingUpstream(() => Response.json({ error: {
    type: "invalid_request_error", code, message: "prompt is too long",
  } }, { status: 400 }));
  const server = startServer(0);
  try {
    const { response, attempts, json } = await sendWithClientRetries(new URL("/v1/messages", server.url),
      { model: "messages/model", ...CLAUDE_TURN });
    expect({ status: response.status, sends: sends(), attempts }).toEqual({ status: 429, sends: 1, attempts: 1 });
    expect(json.error).toMatchObject({ code, message: CLIENT_ERROR_CONTRACTS.replay_refused });
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("retry-after")).toBeNull();
  } finally { await server.stop(true); }
});

test("a no-retry quota stops a combo without claiming proxy provenance", async () => {
  const failure = await consumeComboFailure(Response.json({ error: { code: "rate_limit_exceeded", type: "rate_limit_error", message: "Too many requests" } },
    { status: 429, headers: { "x-should-retry": "false" } }));
  expect(failure.nonReplayable).toBe(true);
  expect(isReplayRefusalResponse(failure.response)).toBe(false);
  expect(failure.response.headers.get("x-should-retry")).toBe("false");
  expect(failure.response.headers.get("retry-after")).toBeNull();
  expect((await failure.response.json()).error.code).toBe("rate_limit_exceeded");
});

test.each([false, true])("ordinary quota respects its retry directive (no-retry %s)", async noRetry => {
  const config = parityConfig(), provider = config.providers.native!;
  provider.retryOn429 = { enabled: true, attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false };
  provider.apiKeyPool = [{ id: "primary", key: provider.apiKey! }, { id: "backup", key: "sk-ordinary-backup" }];
  saveConfig(config);
  const keys: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(UPSTREAM_HOST)) return originalFetch(input as RequestInfo, init);
    const key = new Headers(init?.headers).get("authorization")!;
    keys.push(key);
    if (key !== "Bearer sk-ordinary-backup") return Response.json({ error: { code: "rate_limit_exceeded", type: "rate_limit_error", message: "Too many requests" } },
      { status: 429, headers: noRetry ? { "x-should-retry": "false" } : {} });
    return Response.json({ id: "chatcmpl-control", object: "chat.completion", model: "model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  }) as typeof fetch;
  const server = startServer(0);
  try {
    const { response, attempts, json } = await sendWithClientRetries(new URL("/v1/chat/completions", server.url), { model: "native/model", ...CHAT_TURN });
    expect(response.status).toBe(noRetry ? 429 : 200);
    expect(attempts).toBe(1);
    expect(keys).toEqual(noRetry ? ["Bearer sk-native"] : ["Bearer sk-native", "Bearer sk-native", "Bearer sk-ordinary-backup"]);
    expect(loadConfig().providers.native?.apiKey).toBe(noRetry ? "sk-native" : "sk-ordinary-backup");
    if (noRetry) {
      expect(getKeyCooldownUntil("native", "primary")).toBeNull();
      expect(json.error?.code).toBe("rate_limit_exceeded");
      expect(response.headers.get("x-should-retry")).toBe("false");
    } else expect(getKeyCooldownUntil("native", "primary")).not.toBeNull();
  } finally { await server.stop(true); }
});

test("a combo refuses replay after a spent replacement's zero-output stream failure", async () => {
  saveConfig(comboReplayConfig());
  let firstSends = 0;
  let secondSends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(COMBO_FIRST_HOST)) {
      firstSends += 1;
      if (firstSends === 1) preHeaderReset();
      const failure = { type: "response.failed", response: {
        id: "resp_failed", object: "response", status: "failed", output: [],
        error: { code: "server_is_overloaded", message: "Server is overloaded" },
      } };
      return new Response(`event: response.failed\ndata: ${JSON.stringify(failure)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.includes(COMBO_SECOND_HOST)) {
      secondSends += 1;
      return Response.json({ error: { code: "unexpected_second_target" } }, { status: 400 });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const server = startServer(0);
  try {
    const { response, attempts, json } = await sendWithClientRetries(new URL("/v1/responses", server.url), {
      model: "combo/pair", store: false, stream: true, ...RESPONSES_TURN,
    });
    expect({ firstSends, secondSends, attempts }).toEqual({ firstSends: 2, secondSends: 0, attempts: 1 });
    expect(response.status).toBe(REPLAY_REFUSED_STATUS);
    expect(json.error?.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    expect(response.headers.get(REPLAY_REFUSAL_NO_RETRY_HEADER)).toBe(REPLAY_REFUSAL_NO_RETRY_VALUE);
  } finally {
    await server.stop(true);
  }
});

test("a combo keeps a spent replacement's zero-output context overflow", async () => {
  saveConfig(comboReplayConfig());
  let firstSends = 0;
  let secondSends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(COMBO_FIRST_HOST)) {
      firstSends += 1;
      if (firstSends === 1) preHeaderReset();
      const failure = { type: "response.failed", response: {
        id: "resp_overflow", object: "response", status: "failed", output: [],
        error: { type: "invalid_request_error", code: "context_length_exceeded",
          message: "Input exceeds the model context window." },
      } };
      return new Response(`event: response.failed\ndata: ${JSON.stringify(failure)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.includes(COMBO_SECOND_HOST)) {
      secondSends += 1;
      return Response.json({ error: { code: "unexpected_second_target" } }, { status: 400 });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const server = startServer(0);
  try {
    const { response, attempts, json } = await sendWithClientRetries(new URL("/v1/responses", server.url), {
      model: "combo/pair", store: false, stream: true, ...RESPONSES_TURN,
    });
    expect({ firstSends, secondSends, attempts }).toEqual({ firstSends: 2, secondSends: 0, attempts: 1 });
    expect(response.status).toBe(400);
    expect(json.error?.code).toBe("context_length_exceeded");
    expect(JSON.stringify(json)).toContain("Input exceeds the model context window.");
  } finally {
    await server.stop(true);
  }
});

test("the direct path refuses replay after a spent replacement's decrypt failure", async () => {
  const config = parityConfig();
  config.providers.bridged.retryOnReset = {};
  saveConfig(config);
  let upstreamSends = 0;
  const sends = countingUpstream(() => {
    upstreamSends += 1;
    if (upstreamSends === 1) preHeaderReset();
    const failure = { type: "response.failed", response: {
      id: "resp_decrypt_failed", status: "failed",
      error: { type: "server_error", code: "upstream_server_error",
        message: "Encrypted function output content could not be decrypted or decoded." },
    } };
    return new Response(`event: response.failed\ndata: ${JSON.stringify(failure)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  // Canonical key-independent Fernet structure, as in the opaque-blob recovery fixtures.
  const encryptedContent = `${Buffer.concat([
    Buffer.from([0x80]), Buffer.alloc(8), Buffer.alloc(16), Buffer.alloc(16), Buffer.alloc(32),
  ]).toString("base64url")}==`;
  const server = startServer(0);
  try {
    const response = await originalFetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "bridged/model", store: false, stream: true,
        input: [
          { type: "function_call", call_id: "call-encrypted-output", name: "browser_capture", arguments: "{}" },
          { type: "function_call_output", call_id: "call-encrypted-output", output: [
            { type: "encrypted_content", encrypted_content: encryptedContent },
            { type: "input_text", text: "visible tool output" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
          ] },
          { role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
      }),
    });
    expect(sends()).toBe(2);
    expect(response.status).toBe(REPLAY_REFUSED_STATUS);
    expect((await response.json()).error.code).toBe(UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    expect(response.headers.get(REPLAY_REFUSAL_NO_RETRY_HEADER)).toBe(REPLAY_REFUSAL_NO_RETRY_VALUE);
  } finally {
    await server.stop(true);
  }
});

test.each([
  { name: "a context overflow", status: 400, expectedStatus: 400 },
  { name: "a 413", status: 413, expectedStatus: REPLAY_REFUSED_STATUS },
])("a combo never sends a spent replacement's $name to its next target", async ({ status, expectedStatus }) => {
  saveConfig(comboReplayConfig());
  let firstSends = 0;
  let secondSends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(COMBO_FIRST_HOST)) {
      firstSends += 1;
      // The first send leaves and resets before any header; the granted replacement is answered.
      if (firstSends === 1) preHeaderReset();
      return new Response(JSON.stringify({ error: {
        message: "context_length_exceeded", type: "invalid_request_error", code: "context_length_exceeded",
      } }), { status, headers: { "content-type": "application/json" } });
    }
    if (url.includes(COMBO_SECOND_HOST)) {
      secondSends += 1;
      return Response.json({
        id: "resp_second", object: "response", status: "completed", model: "model",
        output: [{ type: "message", id: "msg_second", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "duplicate", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const server = startServer(0);
  try {
    const { response, attempts } = await sendWithClientRetries(new URL("/v1/responses", server.url), {
      model: "combo/pair", store: false, stream: false, ...RESPONSES_TURN,
    });
    expect({ firstSends, secondSends, attempts }).toEqual({ firstSends: 2, secondSends: 0, attempts: 1 });
    expect(response.status).toBe(expectedStatus);
  } finally {
    await server.stop(true);
  }
});

test.each([
  { provider: "bridged", lane: "native" },
  { provider: "native", lane: "translated" },
])("round 5: $lane Responses withholds a header-only 503 diagnostic after a pre-header replacement", async ({ provider }) => {
  const config = parityConfig();
  config.providers[provider]!.retryOnReset = {};
  let sends = 0;
  globalThis.fetch = (async () => {
    if (++sends === 1) preHeaderReset();
    return Response.json({ error: { message: "fixture upstream diagnostic" } }, {
      status: 503, headers: { "x-should-retry": "false", "retry-after": "7" },
    });
  }) as typeof fetch;
  const release = acquireOwnedSpendHome();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: `${provider}/model`, stream: false, store: false, ...RESPONSES_TURN }),
    }), config, { model: "", provider: "" });
    expect(sends).toBe(2);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({ error: {
      type: "upstream_error",
      message: "Provider error 503: upstream diagnostic withheld for a non-replayable failure",
    } });
  } finally { release(); }
});

test.each([{ abort: false }, { abort: true }])("native Responses keeps the probed post-header refusal when its body fails (caller abort=$abort)", async ({ abort }) => {
  const config = parityConfig();
  config.providers.bridged.retryOnReset = {};
  const caller = new AbortController();
  const code = "upstream_response_refused";
  let sends = 0;
  let rereads = 0;
  const replacement = new Response(new ReadableStream({
    pull(controller) {
      rereads++;
      if (abort) caller.abort(new Error("private cancellation reason"));
      controller.error(new Error("fixture replacement body failed"));
    },
  }, { highWaterMark: 0 }), { status: 503 });
  // The bounded probe's clone can return the verdict even though delivery's later read fails.
  const probe = spyOn(replacement, "clone").mockImplementation(() =>
    Response.json({ error: { code, message: "fixture upstream diagnostic" } }, { status: 503 }));
  globalThis.fetch = (async () => {
    if (++sends === 1) return new Response(new ReadableStream({
      pull() { preHeaderReset(); },
    }), { headers: { "content-type": "text/event-stream" } });
    return replacement;
  }) as typeof fetch;
  const release = acquireOwnedSpendHome();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", signal: caller.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "bridged/model", stream: true, store: false, ...RESPONSES_TURN }),
    }), config, { model: "", provider: "" });
    expect(sends).toBe(2);
    expect(probe).toHaveBeenCalled();
    expect(rereads).toBe(1);
    if (abort) {
      expect(response.status).toBe(499);
      expect(await response.json()).toEqual({ error: {
        type: "client_cancelled", code: "client_cancelled", message: "Client cancelled request",
      } });
    } else {
      expect({
        status: response.status,
        shouldRetry: response.headers.get("x-should-retry"),
        retryAfter: response.headers.get("retry-after"),
        body: await response.json(),
      }).toEqual({
        status: REPLAY_REFUSED_STATUS, shouldRetry: "false", retryAfter: null,
        body: { error: { type: "upstream_error", code, message: CLIENT_ERROR_CONTRACTS.replay_refused } },
      });
      expect(isReplayRefusalResponse(response)).toBe(false);
    }
  } finally { release(); probe.mockRestore(); }
});

test("round 5: direct native Responses SSE projects a coded replacement refusal", async () => {
  const config = parityConfig();
  config.providers.bridged.retryOnReset = {};
  let sends = 0;
  const error = { code: "upstream_response_refused", message: "fixture upstream stream diagnostic" };
  const terminal = { type: "response.failed", response: {
    id: "resp_refused", object: "response", status: "failed", output: [], error, retryable: false,
  } };
  globalThis.fetch = (async () => {
    if (++sends === 1) preHeaderReset();
    return new Response(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const release = acquireOwnedSpendHome();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "bridged/model", stream: true, store: false, ...RESPONSES_TURN }),
    }), config, { model: "", provider: "" });
    const body = await response.text();
    expect({ sends, status: response.status }).toEqual({ sends: 2, status: 200 });
    const frames = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(frames.filter(frame => frame.type === "response.failed")).toMatchObject([{
      response: { status: "failed", output: [], retryable: false,
        error: { code: error.code, message: CLIENT_ERROR_CONTRACTS.replay_refused } },
    }]);
    expect(body).not.toContain(error.message);
  } finally { release(); }
});

test.each([
  { wire: "messages", rootCode: false },
  { wire: "messages", rootCode: true },
  { wire: "responses", rootCode: false },
])("round 5: native $wire records a coded 429 without another send (root code=$rootCode)", async ({ wire, rootCode }) => {
  forgetApiKeyRotationCursor("native");
  const config = parityConfig();
  config.protocols = { rollout: { managedMessagesNative: true } };
  const provider = config.providers.native!;
  provider.adapter = wire === "messages" ? "anthropic" : "openai-responses";
  provider.retryOn429 = { attempts: 1, intervalMs: 1, respectRetryAfter: false };
  provider.apiKeyPool = [{ id: "primary", key: provider.apiKey! }, { id: "backup", key: "sk-review-backup" }];
  provider.requestPacing = { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } };
  const paths: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname);
    const code = "upstream_response_refused";
    const error = { message: "fixture quota diagnostic" };
    return Response.json(rootCode ? { code, error } : { error: { code, ...error } }, {
      status: 429, headers: { "retry-after": "45" },
    });
  } });
  provider.baseUrl = new URL("/v1", upstream.url).href;
  provider.noProxy = "127.0.0.1";
  provider.allowPrivateNetwork = true;
  const began = Date.now();
  const release = acquireOwnedSpendHome();
  try {
    saveConfig(config);
    const request = new Request(`http://localhost/v1/${wire}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "native/model", stream: false, store: false, ...(wire === "messages" ? CLAUDE_TURN : RESPONSES_TURN) }),
    });
    const response = await (wire === "messages" ? handleClaudeMessages : handleResponses)(request, config, { model: "", provider: "" });
    const payload = await response.json();
    expect(paths).toEqual([`/v1/${wire}`]);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(payload.error).toMatchObject({ code: "upstream_response_refused", message: CLIENT_ERROR_CONTRACTS.replay_refused });
    expect(isReplayRefusalResponse(response)).toBe(false);
    expect(getKeyCooldownUntil("native", "primary")).toBeGreaterThanOrEqual(began + 45_000);
    expect(getKeyCooldownUntil("native", "backup")).toBeNull();
  } finally { release(); await upstream.stop(true); }
});

test("round 4: a failed native JSON replacement delivers the fixed refusal", async () => {
  const config = parityConfig();
  config.providers.bridged.retryOnReset = {};
  let sends = 0;
  globalThis.fetch = (async () => {
    if (++sends === 1) preHeaderReset();
    return Response.json({
      id: "resp_refused", object: "response", status: "failed", output: [],
      error: { code: "upstream_response_refused", message: "provider-private-detail" },
    }, { headers: { "retry-after": "7" } });
  }) as typeof fetch;
  const release = acquireOwnedSpendHome();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "bridged/model", stream: false, store: false, ...RESPONSES_TURN }),
    }), config, { model: "", provider: "" });
    expect(sends).toBe(2);
    expect(await response.json()).toEqual({ error: {
      type: "upstream_error", code: "upstream_response_refused", message: CLIENT_ERROR_CONTRACTS.replay_refused,
    } });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(isReplayRefusalResponse(response)).toBe(false);
  } finally { release(); }
});

test("an upstream refusal code selects fixed Responses output without synthetic provenance", async () => {
  const config = parityConfig();
  saveConfig(config);
  const sends = countingUpstream(() => Response.json({ error: {
    type: "upstream_error", code: "upstream_response_refused", message: "fixture diagnostic",
  } }, { status: 429, headers: { "x-should-retry": "false", "retry-after": "20", "x-fixture": "upstream header" } }));
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "native/model", ...RESPONSES_TURN }),
  }), config, { model: "", provider: "" });
  expect(sends()).toBe(1);
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: {
    type: "upstream_error", code: "upstream_response_refused", message: CLIENT_ERROR_CONTRACTS.replay_refused,
  } });
  expect(response.headers.get("retry-after")).toBeNull();
  expect(response.headers.get("x-fixture")).toBeNull();
  expect(response.headers.get("x-should-retry")).toBe("false");
  expect(isReplayRefusalResponse(response)).toBe(false);
});

test("hardening: a no-retry combo 403 is sanitized even with the local scope error type", async () => {
  const config = comboReplayConfig();
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return Response.json({
      error: { type: "model_not_allowed_for_key", message: "provider-private-detail", model: "private/model" },
      extra: "private extension",
    }, { status: 403, headers: { "x-should-retry": "false" } });
  }) as typeof fetch;
  const release = acquireOwnedSpendHome();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "combo/pair", stream: false, store: false, ...RESPONSES_TURN }),
    }), config, { model: "", provider: "" });
    expect(sends).toBe(1);
    expect(response.status).toBe(403);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.json()).toEqual({ error: {
      type: "permission_error", code: "permission_denied", message: "The provider denied access to this request.",
    } });
  } finally { release(); }
});

test.each([
  ["upstream_reset_replay_refused", "invalid_request_error"],
  ["upstream_response_refused", "upstream_error"],
])("translated Messages folds %s into a terminal HTTP refusal", async (code, type) => {
  const terminal = { type: "response.failed", response: {
    id: "resp_refused", status: "failed", output: [], retryable: false,
    error: { type, code, message: "prompt is too long: provider-private-detail" },
  } };
  const sends = countingUpstream(() => new Response(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`, {
    headers: { "content-type": "text/event-stream", "retry-after": "7" },
  }));
  const release = acquireOwnedSpendHome();
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "bridged/model", stream: false, ...CLAUDE_TURN }),
    }), parityConfig(), { model: "", provider: "" });
    expect(sends()).toBe(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(sdkWouldRetry(response)).toBe(false);
    expect(isReplayRefusalResponse(response)).toBe(false);
    expect(await response.json()).toEqual({ type: "error", error: {
      type: "rate_limit_error", code, message: CLIENT_ERROR_CONTRACTS.replay_refused,
    } });
  } finally { release(); }
});

test.each(["deadline", "cancel", "cancel after deadline", "upstream directive", "upstream code"] as const)("hardening: native Messages passthrough settles %s after one send", async mode => {
  const config = parityConfig();
  config.claudeCode = { anthropicBaseUrl: `https://${UPSTREAM_HOST}` };
  config.connectTimeoutMs = 20;
  const caller = new AbortController();
  let sends = 0;
  globalThis.fetch = (async (_input, init) => {
    sends++;
    if (mode === "upstream directive") {
      return Response.json({ type: "error", error: { type: "overloaded_error", message: "provider-private-detail" } }, {
        status: 529, headers: { "x-should-retry": "false", "retry-after": "15", "anthropic-ratelimit-requests-remaining": "3" },
      });
    }
    if (mode === "upstream code") {
      return Response.json({ type: "error", error: {
        type: "overloaded_error", code: "upstream_response_refused", message: "provider-private-detail",
      } }, { status: 503, headers: { "retry-after": "15", "anthropic-ratelimit-requests-remaining": "3" } });
    }
    const signal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        if (mode === "cancel after deadline") caller.abort(new Error("private cancellation reason"));
        reject(signal.reason);
      }, { once: true });
      if (mode === "cancel") caller.abort(new Error("private cancellation reason"));
    });
  }) as typeof fetch;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", signal: caller.signal,
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
    body: JSON.stringify({ model: "claude-test", ...CLAUDE_TURN }),
  }), config, { model: "", provider: "" });
  expect(sends).toBe(1);
  const body = await response.json();
  if (mode === "cancel" || mode === "cancel after deadline") {
    expect(response.status).toBe(499);
    expect(body.error.message).toBe("client closed request during anthropic passthrough");
    return;
  }
  expect(response.headers.get("x-should-retry")).toBe("false");
  expect(response.headers.get("retry-after")).toBeNull();
  if (mode === "deadline" || mode === "upstream code") {
    expect(response.status).toBe(429);
    expect(body).toEqual({ type: "error", error: {
      type: "rate_limit_error", code: mode === "deadline" ? UPSTREAM_RESET_REPLAY_REFUSED_CODE : "upstream_response_refused",
      message: CLIENT_ERROR_CONTRACTS.replay_refused,
    } });
  } else {
    expect(response.status).toBe(529);
    expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("3");
    expect(body).toEqual({ type: "error", error: { type: "overloaded_error", message: "The provider is temporarily unavailable; retry later." } });
  }
});

test("hardening: a combo relays a terminal retryable-false failure without hopping", async () => {
  const config = comboReplayConfig();
  let firstSends = 0;
  let secondSends = 0;
  const error = { code: "upstream_server_error", message: "provider-private-detail" };
  const terminal = { type: "response.failed", response: {
    id: "resp_hardening", object: "response", status: "failed", output: [], error, retryable: false,
  } };
  globalThis.fetch = (async input => {
    if (String(input).includes(COMBO_SECOND_HOST)) {
      secondSends++;
      return Response.json({ error: { code: "unexpected_second_target" } }, { status: 400 });
    }
    firstSends++;
    return new Response(`event: response.failed
data: ${JSON.stringify(terminal)}

`, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const release = acquireOwnedSpendHome();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "combo/pair", stream: true, store: false, ...RESPONSES_TURN }),
    }), config, { model: "", provider: "" });
    const body = await response.text();
    expect({ firstSends, secondSends, status: response.status }).toEqual({ firstSends: 1, secondSends: 0, status: 200 });
    const frames = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(frames.filter(frame => frame.type === "response.failed")).toMatchObject([{
      response: { status: "failed", output: [], retryable: false,
        error: { code: error.code, message: "The provider failed to complete the request." } },
    }]);
    expect(body).not.toContain(error.message);
  } finally { release(); }
});
