import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { apiKeyAccountLogLabel } from "../../src/codex/account-label";
import { configureSharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { captureProviderApiKeySelection } from "../../src/providers/api-key-selection";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, getKeyCooldownUntil, recordDistributedKeyFailure } from "../../src/providers/key-failover";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const NAME = "native-key-selection";
const KEYS = ["fixture-key-alpha", "fixture-key-beta", "fixture-key-gamma"];
const MESSAGE = { id: "msg_key_selection", type: "message", role: "assistant", model: "claude-x",
  content: [{ type: "text", text: "fixture reply" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 3 } };
let home: string;
let previousHome: string | undefined;
let releaseOwner: () => void;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let seen: { key: string | null; authorization?: string | null; path: string; body: unknown }[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-key-selection-"));
  process.env.OPENCODEX_HOME = home;
  releaseOwner = acquireOwnedSpendHome();
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
  seen = [];
});

afterEach(async () => {
  await upstream?.stop(true); upstream = undefined;
  releaseOwner();
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function fixture(count = 2, rejectFirst = false, keyCap = true, statuses: number[] = []): OcxConfig {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    seen.push({ key: req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null, authorization: req.headers.get("authorization"), path: new URL(req.url).pathname, body: await req.json() });
    const status = statuses[seen.length - 1] ?? (rejectFirst && seen.length === 1 ? 401 : 200);
    if (status !== 200) return Response.json({ type: "error",
      error: { type: status === 401 ? "authentication_error" : "rate_limit_error", message: "rejected fixture key" } },
      { status, headers: status === 429 ? { "retry-after": "30" } : undefined });
    return Response.json(MESSAGE);
  } });
  const config = { port: 0, defaultProvider: NAME, protocols: { rollout: { managedMessagesNative: true } },
    providers: { [NAME]: { adapter: "anthropic", baseUrl: `http://127.0.0.1:${upstream.port}`,
      authMode: "key", allowPrivateNetwork: true, apiKey: KEYS[0], apiKeySelectionRevision: "saved-revision",
      models: ["claude-x"], apiKeyPool: KEYS.slice(0, count).map((key, index) => ({ id: `k${index + 1}`, key, addedAt: index + 1 })),
      requestPacing: { enabled: true, keySelection: "round-robin",
        ...(keyCap ? { keys: { maxConcurrentRequests: 1 } } : { maxConcurrentRequests: 1 }) },
    } } } as OcxConfig;
  saveConfig(config);
  return config;
}

function provider(config: OcxConfig): OcxProviderConfig { return config.providers[NAME]!; }
function status(config: OcxConfig) { return providerRequestPacingStatus(NAME, provider(config)); }
function keyStatus(config: OcxConfig, id: string) { return status(config).keys!.find(key => key.id === id)!; }
function cool(config: OcxConfig, index: number): void {
  const selection = { ...captureProviderApiKeySelection({ ...provider(config), apiKey: KEYS[index] }), distributed: true };
  expect(recordDistributedKeyFailure(config, NAME, selection, 429, Date.now(), "30")).toBe(true);
}
async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(5);
  }
}
function queue(config: OcxConfig, id: string) {
  return waitUntil(() => keyStatus(config, id).queued === 1, `key ${id} never queued: ${JSON.stringify(status(config))}`);
}
function start(config: OcxConfig, abort: AbortController) {
  const requestId = `native-key-selection-${crypto.randomUUID()}`;
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  const pending = handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST",
    headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model: `${NAME}/claude-x`, max_tokens: 64,
      messages: [{ role: "user", content: "fixture question" }], stream: false }),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() })
    .then(async response => ({ response, text: await response.text(), requestId }));
  void pending.catch(() => {});
  return pending;
}
function unchanged(config: OcxConfig) {
  expect(provider(config).apiKey).toBe(KEYS[0]);
  expect(provider(config).apiKeySelectionRevision).toBe("saved-revision");
  const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
  expect(persisted.providers[NAME]!.apiKey).toBe(KEYS[0]);
  expect(persisted.providers[NAME]!.apiKeySelectionRevision).toBe("saved-revision");
  expect(persisted.providers[NAME]!._apiKeyAttempt).toBeUndefined();
}
function noLeaks(config: OcxConfig) {
  expect(status(config)).toMatchObject({ queued: 0, inFlight: 0 });
  for (const key of status(config).keys!) expect(key).toMatchObject({ queued: 0, inFlight: 0 });
}
function nativeSuccess(result: Awaited<ReturnType<typeof start>>) {
  expect(result.response.status).toBe(200);
  expect(JSON.parse(result.text).content).toEqual(MESSAGE.content);
  expect(getRequestLogEntries().find(row => row.requestId === result.requestId)?.protocolTrace?.mode).toBe("native");
  expect(seen.every(entry => entry.path === "/v1/messages")).toBe(true);
}

describe("native Messages distributed key selection", () => {
  for (const status of [401, 429]) test(`an overridden wire key C${status} never cools or replays selected A/B`, async () => {
    const config = fixture(2, false, true, [status]);
    provider(config).headers = { "x-api-key": KEYS[2]! };
    // A credential mismatch also refuses an explicitly requested same-key 429 retry.
    provider(config).retryOn429 = { attempts: 1, intervalMs: 1, respectRetryAfter: false };
    saveConfig(config);
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      const result = await pending;
      expect(result.response.status).toBe(status);
      expect(seen.map(entry => entry.key)).toEqual([KEYS[2]]);
      expect(seen[0]!.path).toBe("/v1/messages");
      expect(getKeyCooldownUntil(NAME, "k1")).toBeNull();
      expect(getKeyCooldownUntil(NAME, "k2")).toBeNull();
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); await pending.catch(() => undefined); }
  });

  test("mixed A429 B401 C200 recovers across the ladder without changing saved selection", async () => {
    const config = fixture(3, false, true, [429, 401, 200]);
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      const result = await pending;
      nativeSuccess(result);
      expect(seen.map(entry => entry.key)).toEqual(KEYS);
      expect(seen[1]!.body).toEqual(seen[0]!.body);
      expect(seen[2]!.body).toEqual(seen[0]!.body);
      const row = getRequestLogEntries().find(entry => entry.requestId === result.requestId)!;
      expect(row.attempts!.map(attempt => attempt.sendCount)).toEqual([1, 1, 1]);
      expect(row.attempts!.map(attempt => attempt.accountLogLabel)).toEqual(KEYS.map((reference, index) =>
        apiKeyAccountLogLabel(NAME, { entryId: `k${index + 1}`, reference })));
      expect(row.attempts!.map(attempt => attempt.status)).toEqual([429, 401, 200]);
      expect(getKeyCooldownUntil(NAME, "k1")).toBeGreaterThan(Date.now() + 25_000);
      expect(getKeyCooldownUntil(NAME, "k2")).toBeGreaterThan(Date.now());
      expect(getKeyCooldownUntil(NAME, "k3")).toBeNull();
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); await pending.catch(() => undefined); }
  });

  for (const terminal of [401, 429]) test(`mixed failures record terminal B${terminal} at the finite send limit`, async () => {
    const config = fixture(2, false, true, [429, terminal]);
    provider(config).transientRetryOn5xx = { attempts: 2 };
    saveConfig(config);
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      const result = await pending;
      expect(result.response.status).toBe(terminal);
      expect(seen.map(entry => entry.key)).toEqual(KEYS.slice(0, 2));
      expect(getKeyCooldownUntil(NAME, "k1")).toBeGreaterThan(Date.now() + 25_000);
      expect(getKeyCooldownUntil(NAME, "k2")).toBeGreaterThan(Date.now() + 25_000);
      const exhausted = await start(config, abort);
      expect(exhausted.response.status).toBe(429);
      expect(Number(exhausted.response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(seen).toHaveLength(2);
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); await pending.catch(() => undefined); }
  });

  test("same-key retries precede cooldown and share their counter across mixed recovery", async () => {
    const config = fixture(3, false, true, [429, 401, 429, 200]);
    provider(config).retryOn429 = { attempts: 1, intervalMs: 0, respectRetryAfter: false };
    provider(config).transientRetryOn5xx = { attempts: 4 };
    saveConfig(config);
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      nativeSuccess(await pending);
      expect(seen.map(entry => entry.key)).toEqual([KEYS[0], KEYS[0], KEYS[1], KEYS[2]]);
      expect(getKeyCooldownUntil(NAME, "k1")).not.toBeNull();
      expect(getKeyCooldownUntil(NAME, "k2")).not.toBeNull();
      expect(getKeyCooldownUntil(NAME, "k3")).toBeNull();
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); await pending.catch(() => undefined); }
  });

  test("a shared physical-send refusal records the last genuine 429 without cooling an unsent key", async () => {
    const config = fixture(2, false, true, [429, 429, 429, 429, 200]);
    provider(config).retryOn429 = { attempts: 6, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false };
    saveConfig(config);
    configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: 100_000 } }, undefined, [NAME]));
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      const result = await pending;
      expect(result.response.status).toBe(429);
      expect(JSON.parse(result.text).error.type).toBe("send_budget_exhausted");
      expect(seen.map(entry => entry.key)).toEqual(Array(4).fill(KEYS[0]));
      expect(getKeyCooldownUntil(NAME, "k1")).toBeGreaterThan(Date.now() + 25_000);
      expect(getKeyCooldownUntil(NAME, "k2")).toBeNull();
      const next = await start(config, abort);
      nativeSuccess(next);
      expect(seen.map(entry => entry.key)).toEqual([...Array(4).fill(KEYS[0]), KEYS[1]]);
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); await pending.catch(() => undefined); }
  });

  test("401 recovers A to B without changing the saved key or revision", async () => {
    const config = fixture(2, true);
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      nativeSuccess(await pending);
      expect(seen.map(entry => entry.key)).toEqual(KEYS.slice(0, 2));
      expect(seen[1]!.body).toEqual(seen[0]!.body);
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); await pending.catch(() => undefined); }
  });

  for (const cancel of [false, true]) test(`cooled queued A releases its permit and readmits B (abort=${cancel})`, async () => {
    const config = fixture();
    const first = await waitForProviderRequestSlot(NAME, provider(config));
    const second = await waitForProviderRequestSlot(NAME, { ...provider(config), apiKey: KEYS[1] });
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      await queue(config, "k1");
      expect(seen).toEqual([]);
      cool(config, 0); first.release();
      await queue(config, "k2");
      expect(first.released).toBe(true);
      expect(keyStatus(config, "k1")).toMatchObject({ inFlight: 0, queued: 0, starts: 2 });
      expect(keyStatus(config, "k2")).toMatchObject({ inFlight: 1, queued: 1, starts: 1 });
      expect(status(config).inFlight).toBe(1);
      expect(seen).toEqual([]);
      if (cancel) {
        abort.abort();
        await pending.catch(() => undefined);
        expect(seen).toEqual([]);
        expect(status(config).queued).toBe(0);
        second.release();
      } else {
        second.release(); nativeSuccess(await pending);
        expect(seen.map(entry => entry.key)).toEqual([KEYS[1]]);
      }
      unchanged(config); noLeaks(config);
    } finally {
      abort.abort(); first.release(); second.release(); await pending.catch(() => undefined);
    }
  }, 10_000);

  test("round-robin without a keys rule reselects behind the provider concurrency cap", async () => {
    const config = fixture(2, false, false);
    expect(provider(config).requestPacing!.keys).toBeUndefined();
    const held = await waitForProviderRequestSlot(NAME, provider(config));
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      await queue(config, "k1"); cool(config, 0);
      expect(seen).toEqual([]);
      held.release(); nativeSuccess(await pending);
      expect(seen.map(entry => entry.key)).toEqual([KEYS[1]]);
      expect(keyStatus(config, "k1").starts).toBe(2);
      expect(keyStatus(config, "k2").starts).toBe(1);
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); held.release(); await pending.catch(() => undefined); }
  });

  for (const exhausted of [false, true]) test(`revalidates B after readmission when B cools while queued (exhausted=${exhausted})`, async () => {
    const config = fixture(3);
    const first = await waitForProviderRequestSlot(NAME, provider(config));
    const second = await waitForProviderRequestSlot(NAME, { ...provider(config), apiKey: KEYS[1] });
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      await queue(config, "k1"); cool(config, 0); first.release();
      await queue(config, "k2");
      expect(keyStatus(config, "k1").inFlight).toBe(0);
      expect(seen).toEqual([]);
      cool(config, 1);
      if (exhausted) cool(config, 2);
      second.release();
      const result = await pending;
      if (exhausted) {
        expect(result.response.status).toBe(429);
        expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(seen).toEqual([]);
      } else {
        nativeSuccess(result);
        expect(seen.map(entry => entry.key)).toEqual([KEYS[2]]);
      }
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); first.release(); second.release(); await pending.catch(() => undefined); }
  }, 10_000);
});

for (const statusCode of [401, 429]) for (const overridden of [false, true]) test(`Messages bearer ${statusCode} owns the configured key transport (override=${overridden})`, async () => {
  const config = fixture(2, false, true, [statusCode, 200]);
  provider(config).apiKeyTransport = "bearer";
  saveConfig(config);
  if (overridden) provider(config).headers = { Authorization: "Bearer fixture-bearer-override" };
  const result = await start(config, new AbortController());
  if (overridden) {
    expect(result.response.status).toBe(statusCode);
    expect(seen.map(entry => entry.key)).toEqual(["fixture-bearer-override"]);
    expect(getKeyCooldownUntil(NAME, "k1")).toBeNull();
    expect(getKeyCooldownUntil(NAME, "k2")).toBeNull();
  } else {
    nativeSuccess(result);
    expect(seen.map(entry => entry.key)).toEqual(KEYS.slice(0, 2));
    expect(seen.map(entry => entry.authorization)).toEqual(KEYS.slice(0, 2).map(key => `Bearer ${key}`));
    expect(getKeyCooldownUntil(NAME, "k1")).not.toBeNull();
    expect(getKeyCooldownUntil(NAME, "k2")).toBeNull();
  }
  unchanged(config); noLeaks(config);
});

for (const statusCode of [401, 429]) for (const transport of ["bearer", "x-api-key"] as const) {
  for (const rewrite of ["credential", "destination"] as const) test(`Messages physical ${transport} ${statusCode} ownership after ${rewrite} rewrite`, async () => {
    const config = fixture(2, false, true, [statusCode, 200]);
    provider(config).apiKeyTransport = transport;
    saveConfig(config);
    const off = registerUpstreamRewriter("fixture-key-owner", target => {
      if (rewrite === "credential") target.headers.set(transport === "bearer" ? "authorization" : "x-api-key",
        transport === "bearer" ? "Bearer fixture-plugin-key" : "fixture-plugin-key");
      if (rewrite === "destination") target.url += "?physical-owner=other";
    });
    try {
      const result = await start(config, new AbortController());
      expect(result.response.status).toBe(statusCode);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.key).toBe(rewrite === "credential" ? "fixture-plugin-key" : KEYS[0]);
      expect(getKeyCooldownUntil(NAME, "k1")).toBeNull();
      expect(getKeyCooldownUntil(NAME, "k2")).toBeNull();
      unchanged(config); noLeaks(config);
    } finally { off(); }
  });
}

for (const cancel of [false, true]) test(`active manual key switch readmits the selected key (cancel=${cancel})`, async () => {
  const config = fixture();
  config.providers[NAME]!.requestPacing = { enabled: true, keys: { maxConcurrentRequests: 1 } };
  saveConfig(config);
  const heldA = await waitForProviderRequestSlot(NAME, config.providers[NAME]!);
  const heldB = await waitForProviderRequestSlot(NAME, { ...config.providers[NAME]!, apiKey: KEYS[1] });
  const abort = new AbortController();
  const pending = start(config, abort);
  try {
    await queue(config, "k1");
    config.providers[NAME]!.apiKey = KEYS[1];
    config.providers[NAME]!.apiKeySelectionRevision = "manual-key-switch";
    saveConfig(config);
    heldA.release();
    await queue(config, "k2");
    expect(keyStatus(config, "k1")).toMatchObject({ queued: 0, inFlight: 0 });
    expect(seen).toEqual([]);
    if (cancel) abort.abort();
    else heldB.release();
    const result = await pending;
    if (cancel) {
      expect(result.response.status).toBe(499);
      expect(seen).toEqual([]);
      heldB.release();
    } else { nativeSuccess(result);
      expect(seen.map(entry => entry.key)).toEqual([KEYS[1]]); }
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
    expect(config.providers[NAME]!.apiKey).toBe(KEYS[1]);
    expect(saved.providers[NAME]!.apiKey).toBe(KEYS[1]);
    expect(saved.providers[NAME]!.apiKeySelectionRevision).toBe("manual-key-switch");
    expect(saved.providers[NAME]!._apiKeyAttempt).toBeUndefined();
    noLeaks(config);
  } finally { abort.abort(); heldA.release(); heldB.release(); await pending.catch(() => undefined); }
}, 10_000);
