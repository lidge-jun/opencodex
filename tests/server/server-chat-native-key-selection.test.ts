import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { apiKeyAccountLogLabel } from "../../src/codex/account-label";
import { captureProviderApiKeySelection } from "../../src/providers/api-key-selection";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, getKeyCooldownUntil, recordDistributedKeyFailure } from "../../src/providers/key-failover";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { handleChatCompletions } from "../../src/server/chat-completions";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeCompactionFixture } from "../helpers/compaction-routing-fixtures";

const NAME = "native-chat-pacing";
const KEYS = ["fixture-key-alpha", "fixture-key-beta", "fixture-key-gamma"];
const realFetch = globalThis.fetch;
let home: string;
let previousHome: string | undefined;
let releaseOwner: () => void;
let seen: { key: string | null; url: string; body: unknown }[];
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-chat-key-pacing-"));
  process.env.OPENCODEX_HOME = home;
  releaseOwner = acquireOwnedSpendHome();
  seen = [];
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
  globalThis.fetch = (async (input, init) => {
    seen.push({ key: new Headers(init?.headers).get("authorization"), url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "chatcmpl-key-selection", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "fixture reply" }, finish_reason: "stop" }] });
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  releaseOwner();
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
  await removeCompactionFixture(home);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});
function fixture(keyCap = true): OcxConfig {
  const config = { port: 0, defaultProvider: NAME, providers: { [NAME]: {
    adapter: "openai-chat", baseUrl: "https://gateway.example/v1", authMode: "key",
    apiKey: KEYS[0], apiKeySelectionRevision: "saved-revision",
    apiKeyPool: KEYS.map((key, index) => ({ id: `k${index + 1}`, key, addedAt: index + 1 })),
    requestPacing: { enabled: true, keySelection: "round-robin",
      ...(keyCap ? { keys: { maxConcurrentRequests: 1 } } : { maxConcurrentRequests: 1 }) },
  } } } as OcxConfig;
  saveConfig(config);
  return config;
}
function status(config: OcxConfig) { return providerRequestPacingStatus(NAME, config.providers[NAME]!); }
function keyStatus(config: OcxConfig, id: string) { return status(config).keys!.find(key => key.id === id)!; }
function cool(config: OcxConfig, index: number) {
  const selection = { ...captureProviderApiKeySelection({ ...config.providers[NAME]!, apiKey: KEYS[index] }), distributed: true };
  expect(recordDistributedKeyFailure(config, NAME, selection, 429, Date.now(), "30")).toBe(true);
}
async function queue(config: OcxConfig, id: string) {
  const deadline = Date.now() + 2_000;
  while (keyStatus(config, id).queued !== 1) {
    if (Date.now() >= deadline) throw new Error(`key ${id} never queued: ${JSON.stringify(status(config))}`);
    await Bun.sleep(5);
  }
}
function start(config: OcxConfig, abort: AbortController) {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const req = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]), body: JSON.stringify({ model: `${NAME}/test`, messages: [{ role: "user", content: "fixture question" }], stream: false }) });
  const pending = handleChatCompletions(req, config, logCtx).then(async response => ({ response, text: await response.text(), logCtx }));
  void pending.catch(() => {});
  return pending;
}
function unchanged(config: OcxConfig) {
  expect(config.providers[NAME]!.apiKey).toBe(KEYS[0]);
  expect(config.providers[NAME]!.apiKeySelectionRevision).toBe("saved-revision");
  const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
  expect(saved.providers[NAME]!.apiKey).toBe(KEYS[0]);
  expect(saved.providers[NAME]!.apiKeySelectionRevision).toBe("saved-revision");
  expect(saved.providers[NAME]!._apiKeyAttempt).toBeUndefined();
}
function noLeaks(config: OcxConfig) {
  expect(status(config)).toMatchObject({ queued: 0, inFlight: 0 });
  for (const key of status(config).keys!) expect(key).toMatchObject({ queued: 0, inFlight: 0 });
}
function success(result: Awaited<ReturnType<typeof start>>, index: number) {
  expect(result.response.status).toBe(200);
  expect(result.text).toContain("fixture reply");
  expect(seen.map(entry => entry.key)).toEqual([`Bearer ${KEYS[index]}`]);
  expect(seen[0]!.url).toBe("https://gateway.example/v1/chat/completions");
  expect(result.logCtx.accountLogLabel).toBe(apiKeyAccountLogLabel(NAME, { entryId: `k${index + 1}`, reference: KEYS[index] }));
  expect(result.logCtx.attempts).toHaveLength(1);
  expect(result.logCtx.attempts![0]!.sendCount).toBe(1);
  expect(result.logCtx.attempts![0]!.accountLogLabel).toBe(result.logCtx.accountLogLabel);
}
for (const cancel of [false, true]) test(`chat cooled queued A readmits B (abort=${cancel})`, async () => {
  const config = fixture();
  const first = await waitForProviderRequestSlot(NAME, config.providers[NAME]!);
  const second = await waitForProviderRequestSlot(NAME, { ...config.providers[NAME]!, apiKey: KEYS[1] });
  const abort = new AbortController();
  const pending = start(config, abort);
  try {
    await queue(config, "k1"); cool(config, 0); first.release();
    await queue(config, "k2");
    expect(keyStatus(config, "k1")).toMatchObject({ inFlight: 0, queued: 0, starts: 2 });
    expect(keyStatus(config, "k2")).toMatchObject({ inFlight: 1, queued: 1, starts: 1 });
    expect(seen).toEqual([]);
    if (cancel) {
      abort.abort();
      const result = await pending;
      expect(result.response.status).toBe(499);
      expect(seen).toEqual([]);
      expect(status(config).queued).toBe(0);
      second.release();
    } else { second.release(); success(await pending, 1); }
    unchanged(config); noLeaks(config);
  } finally { abort.abort(); first.release(); second.release(); await pending.catch(() => undefined); }
}, 10_000);
for (const exhausted of [false, true]) test(`chat revalidates B cooling during readmission (exhausted=${exhausted})`, async () => {
  const config = fixture();
  const first = await waitForProviderRequestSlot(NAME, config.providers[NAME]!);
  const second = await waitForProviderRequestSlot(NAME, { ...config.providers[NAME]!, apiKey: KEYS[1] });
  const abort = new AbortController();
  const pending = start(config, abort);
  try {
    await queue(config, "k1"); cool(config, 0); first.release();
    await queue(config, "k2"); cool(config, 1);
    if (exhausted) cool(config, 2);
    second.release();
    const result = await pending;
    if (exhausted) {
      expect(result.response.status).toBe(429);
      expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(seen).toEqual([]);
    } else success(result, 2);
    unchanged(config); noLeaks(config);
  } finally { abort.abort(); first.release(); second.release(); await pending.catch(() => undefined); }
}, 10_000);
test("chat reselects behind the provider cap without a keys rule", async () => {
  const config = fixture(false);
  const held = await waitForProviderRequestSlot(NAME, config.providers[NAME]!);
  const abort = new AbortController();
  const pending = start(config, abort);
  try {
    await queue(config, "k1"); cool(config, 0); held.release();
    success(await pending, 1);
    expect(keyStatus(config, "k1").starts).toBe(2);
    expect(keyStatus(config, "k2").starts).toBe(1);
    unchanged(config); noLeaks(config);
  } finally { abort.abort(); held.release(); await pending.catch(() => undefined); }
});
test("chat refreshes a queued stale revision and sends the rebuilt destination", async () => {
  const config = fixture();
  const held = await waitForProviderRequestSlot(NAME, config.providers[NAME]!);
  const abort = new AbortController();
  const pending = start(config, abort);
  try {
    await queue(config, "k1");
    config.providers[NAME]!.apiKeySelectionRevision = "updated-revision";
    config.providers[NAME]!.baseUrl = "https://replacement.example/v1";
    held.release();
    const result = await pending;
    expect(result.response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://replacement.example/v1/chat/completions");
    expect(seen[0]!.key).toBe(`Bearer ${KEYS[1]}`);
    expect(result.logCtx.accountLogLabel).toBe(apiKeyAccountLogLabel(NAME, { entryId: "k2", reference: KEYS[1] }));
    noLeaks(config);
  } finally { abort.abort(); held.release(); await pending.catch(() => undefined); }
});

test("chat refuses after three queued rebuilds without spending a physical send", async () => {
  const config = fixture();
  const extra = ["fixture-key-delta", "fixture-key-epsilon"];
  config.providers[NAME]!.apiKeyPool!.push(...extra.map((key, index) => ({ id: `k${index + 4}`, key })));
  const keys = [...KEYS, ...extra];
  const held = await Promise.all(keys.map(apiKey => waitForProviderRequestSlot(NAME, { ...config.providers[NAME]!, apiKey })));
  const abort = new AbortController();
  const pending = start(config, abort);
  try {
    for (let index = 0; index < 4; index++) {
      await queue(config, `k${index + 1}`);
      const selection = { ...captureProviderApiKeySelection({ ...config.providers[NAME]!, apiKey: keys[index] }), distributed: true };
      expect(recordDistributedKeyFailure(config, NAME, selection, 429, Date.now(), "30")).toBe(true);
      held[index]!.release();
    }
    const result = await pending;
    expect(result.response.status).toBe(502);
    expect(seen).toEqual([]);
    expect(keyStatus(config, "k5").starts).toBe(1);
    for (const slot of held) slot.release();
    unchanged(config); noLeaks(config);
  } finally { abort.abort(); for (const slot of held) slot.release(); await pending.catch(() => undefined); }
}, 10_000);

for (const statusCode of [401, 429]) test(`chat wire override ${statusCode} does not reject unused distributed pool keys`, async () => {
  const config = fixture();
  config.providers[NAME]!.headers = { Authorization: "Bearer fixture-key-override" };
  globalThis.fetch = (async (input, init) => {
    seen.push({ key: new Headers(init?.headers).get("authorization"), url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ error: { type: statusCode === 401 ? "authentication_error" : "rate_limit_error", message: "fixture overridden credential refusal" } }, { status: statusCode });
  }) as typeof fetch;
  const result = await start(config, new AbortController());
  expect(result.response.status).toBe(statusCode);
  expect(result.text).toContain("fixture overridden credential refusal");
  expect(seen.map(entry => entry.key)).toEqual(["Bearer fixture-key-override"]);
  for (let index = 0; index < KEYS.length; index++) expect(getKeyCooldownUntil(NAME, `k${index + 1}`)).toBeNull();
  unchanged(config); noLeaks(config);
});

test("chat owned 401 rotates the rejected distributed credential before output", async () => {
  const config = fixture();
  const reply = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (seen.length === 0) {
      seen.push({ key: new Headers(init?.headers).get("authorization"), url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ error: { type: "authentication_error", message: "fixture selected credential refusal" } }, { status: 401 });
    }
    return reply(input, init);
  }) as typeof fetch;
  const result = await start(config, new AbortController());
  expect(result.response.status).toBe(200);
  expect(result.text).toContain("fixture reply");
  expect(seen.map(entry => entry.key)).toEqual([`Bearer ${KEYS[0]}`, `Bearer ${KEYS[1]}`]);
  expect(getKeyCooldownUntil(NAME, "k1")).not.toBeNull();
  expect(getKeyCooldownUntil(NAME, "k2")).toBeNull();
  unchanged(config); noLeaks(config);
});

for (const statusCode of [401, 429]) for (const rewrite of ["credential", "destination", "none"] as const) for (const retry of [false, true]) {
  test(`chat physical ${statusCode} ownership after ${rewrite} rewrite (retry=${retry})`, async () => {
    const config = fixture();
    if (retry) config.providers[NAME]!.retryOn429 = { attempts: 1, intervalMs: 0, respectRetryAfter: false };
    const off = registerUpstreamRewriter("fixture-key-owner", target => {
      if (rewrite === "credential") target.headers.set("authorization", "Bearer fixture-plugin-key");
      if (rewrite === "destination") target.url = "https://replacement.example/v1/chat/completions";
    });
    const reply = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (seen.length) return reply(input, init);
      seen.push({ key: new Headers(init?.headers).get("authorization"), url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ error: { type: "upstream_error", message: "fixture refusal" } }, { status: statusCode });
    }) as typeof fetch;
    try {
      const result = await start(config, new AbortController());
      if (rewrite === "none") {
        expect(result.response.status).toBe(200);
        const sameKeyRetry = retry && statusCode === 429;
        expect(seen.map(row => row.key)).toEqual([`Bearer ${KEYS[0]}`, `Bearer ${KEYS[sameKeyRetry ? 0 : 1]}`]);
        if (sameKeyRetry) expect(getKeyCooldownUntil(NAME, "k1")).toBeNull();
        else expect(getKeyCooldownUntil(NAME, "k1")).not.toBeNull();
      } else {
        const sameKeyRetry = retry && statusCode === 429;
        expect(result.response.status).toBe(sameKeyRetry ? 200 : statusCode);
        expect(seen).toHaveLength(sameKeyRetry ? 2 : 1);
        for (const row of seen) {
          expect(row.key).toBe(rewrite === "credential" ? "Bearer fixture-plugin-key" : `Bearer ${KEYS[0]}`);
          expect(row.url).toBe(rewrite === "destination" ? "https://replacement.example/v1/chat/completions" : "https://gateway.example/v1/chat/completions");
        }
        expect(getKeyCooldownUntil(NAME, "k1")).toBeNull();
      }
      for (const id of ["k2", "k3"]) expect(getKeyCooldownUntil(NAME, id)).toBeNull();
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
    } else { success(result, 1); }
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
    expect(config.providers[NAME]!.apiKey).toBe(KEYS[1]);
    expect(saved.providers[NAME]!.apiKey).toBe(KEYS[1]);
    expect(saved.providers[NAME]!.apiKeySelectionRevision).toBe("manual-key-switch");
    expect(saved.providers[NAME]!._apiKeyAttempt).toBeUndefined();
    noLeaks(config);
  } finally { abort.abort(); heldA.release(); heldB.release(); await pending.catch(() => undefined); }
}, 10_000);
