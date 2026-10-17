import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";
import { saveConfig } from "../../src/config";
import { apiKeyAccountLogLabel } from "../../src/codex/account-label";
import { captureProviderApiKeySelection } from "../../src/providers/api-key-selection";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, getKeyCooldownUntil, recordDistributedKeyFailure } from "../../src/providers/key-failover";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { handleResponsesCompact } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeCompactionFixture } from "../helpers/compaction-routing-fixtures";

const NAME = "openai-apikey";
const KEYS = ["fixture-key-alpha", "fixture-key-beta", "fixture-key-gamma"];
const realFetch = globalThis.fetch;
let home: string;
let previousHome: string | undefined;
let releaseOwner: () => void;
let seen: { key: string | null; url: string; body: unknown; headers: Headers }[];
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-compact-key-pacing-"));
  process.env.OPENCODEX_HOME = home;
  releaseOwner = acquireOwnedSpendHome();
  seen = [];
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
  globalThis.fetch = (async (input, init) => {
    seen.push({ key: new Headers(init?.headers).get("authorization"), url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture reply" }] }] });
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
    adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key",
    apiKey: KEYS[0], apiKeySelectionRevision: "saved-revision",
    apiKeyPool: KEYS.map((key, index) => ({ id: `k${index + 1}`, key, addedAt: index + 1 })),
    requestPacing: { enabled: true, keySelection: "round-robin",
      ...(keyCap ? { keys: { maxConcurrentRequests: 1 } } : { maxConcurrentRequests: 1 }) },
  } } } as OcxConfig;
  saveConfig(config);
  return config;
}
function status(config: OcxConfig) { return providerRequestPacingStatus(config.defaultProvider!, config.providers[config.defaultProvider!]!); }
function keyStatus(config: OcxConfig, id: string) { return status(config).keys!.find(key => key.id === id)!; }
function cool(config: OcxConfig, index: number) {
  const selection = { ...captureProviderApiKeySelection({ ...config.providers[config.defaultProvider!]!, apiKey: KEYS[index] }), distributed: true };
  expect(recordDistributedKeyFailure(config, config.defaultProvider!, selection, 429, Date.now(), "30")).toBe(true);
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
  const req = new Request("http://localhost/v1/responses/compact", { method: "POST", headers: { "content-type": "application/json" },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]), body: JSON.stringify({ model: `${config.defaultProvider}/test`, input: [{ role: "user", content: "fixture question" }], stream: false }) });
  const pending = handleResponsesCompact(req, config, logCtx).then(async response => ({ response, text: await response.text(), logCtx }));
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
  expect(seen[0]!.url).toBe("https://api.openai.com/v1/responses/compact");
  expect(result.logCtx.accountLogLabel).toBe(apiKeyAccountLogLabel(NAME, { entryId: `k${index + 1}`, reference: KEYS[index] }));
}
for (const cancel of [false, true]) test(`compact cooled queued A readmits B (abort=${cancel})`, async () => {
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
for (const exhausted of [false, true]) test(`compact revalidates B cooling during readmission (exhausted=${exhausted})`, async () => {
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
test("compact reselects behind the provider cap without a keys rule", async () => {
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
test("compact refreshes a queued stale revision and sends rebuilt Authorization and static headers", async () => {
  const config = fixture();
  const held = await waitForProviderRequestSlot(NAME, config.providers[NAME]!);
  const abort = new AbortController();
  const pending = start(config, abort);
  try {
    await queue(config, "k1");
    config.providers[NAME]!.apiKeySelectionRevision = "updated-revision";
    config.providers[NAME]!.headers = { "x-current-static": "replacement" };
    held.release();
    const result = await pending;
    expect(result.response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/responses/compact");
    expect(seen[0]!.key).toBe(`Bearer ${KEYS[1]}`);
    expect(seen[0]!.headers.get("x-current-static")).toBe("replacement");
    expect(result.logCtx.accountLogLabel).toBe(apiKeyAccountLogLabel(NAME, { entryId: "k2", reference: KEYS[1] }));
    noLeaks(config);
  } finally { abort.abort(); held.release(); await pending.catch(() => undefined); }
});

test("compact refuses after three queued rebuilds without spending a physical send", async () => {
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

test("compact 401 after queued reselection cools the physical key B without replaying", async () => {
  const config = fixture();
  const first = await waitForProviderRequestSlot(NAME, config.providers[NAME]!);
  const abort = new AbortController();
  const wireFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    await wireFetch(input, init);
    return Response.json({ error: { message: "invalid fixture key" } }, { status: 401 });
  }) as typeof fetch;
  const pending = start(config, abort);
  try {
    await queue(config, "k1"); cool(config, 0);
    const firstCooldown = getKeyCooldownUntil(NAME, "k1");
    first.release();
    const result = await pending;
    expect(result.response.status).toBe(401);
    expect(seen.map(entry => entry.key)).toEqual([`Bearer ${KEYS[1]}`]);
    expect(result.logCtx.accountLogLabel).toBe(apiKeyAccountLogLabel(NAME, { entryId: "k2", reference: KEYS[1] }));
    expect(getKeyCooldownUntil(NAME, "k1")).toBe(firstCooldown);
    expect(getKeyCooldownUntil(NAME, "k2")).not.toBeNull();
    expect(getKeyCooldownUntil(NAME, "k3")).toBeNull();
    unchanged(config); noLeaks(config);
  } finally { abort.abort(); first.release(); await pending.catch(() => undefined); }
});

test("direct compact distributed 429 cools each physical key without same-request replay", async () => {
  const config = fixture();
  globalThis.fetch = (async (input, init) => {
    seen.push({ key: new Headers(init?.headers).get("authorization"), url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json({ error: { message: "fixture capacity" } }, { status: 429, headers: { "retry-after": "60" } });
  }) as typeof fetch;
  const began = Date.now();
  for (let index = 0; index < 4; index++) {
    const result = await start(config, new AbortController());
    expect(result.response.status).toBe(429);
    expect(seen).toHaveLength(Math.min(index + 1, 3));
  }
  expect(seen.map(row => row.key)).toEqual(KEYS.map(key => `Bearer ${key}`));
  for (let index = 0; index < 3; index++) expect(getKeyCooldownUntil(NAME, `k${index + 1}`)).toBeGreaterThanOrEqual(began + 60_000);
  unchanged(config); noLeaks(config);
});

test("a synthetic non-replayable compact 429 never cools a distributed key", async () => {
  const config = fixture();
  globalThis.fetch = (async () => {
    const response = Response.json({ error: { message: "fixture local refusal" } }, { status: 429, headers: { "retry-after": "60" } });
    markResponseNonReplayable(response); return response;
  }) as typeof fetch;
  const result = await start(config, new AbortController());
  expect(result.response.status).toBe(429);
  for (let index = 0; index < 3; index++) expect(getKeyCooldownUntil(NAME, `k${index + 1}`)).toBeNull();
  unchanged(config); noLeaks(config);
});

for (const statusCode of [401, 429]) test(`compact static Authorization ${statusCode} retains pool availability`, async () => {
  const config = fixture();
  config.providers[NAME]!.supportsNativeCompactEndpoint = true;
  config.providers[NAME]!.headers = { Authorization: "Bearer fixture-override" };
  globalThis.fetch = (async (input, init) => {
    seen.push({ key: new Headers(init?.headers).get("authorization"), url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json({ error: { message: "fixture refusal" } }, { status: statusCode });
  }) as typeof fetch;
  for (let request = 0; request < 4; request++) {
    expect((await start(config, new AbortController())).response.status).toBe(statusCode);
    expect(seen).toHaveLength(request + 1);
    for (const id of ["k1", "k2", "k3"]) expect(getKeyCooldownUntil(NAME, id)).toBeNull();
  }
  expect(seen.map(row => row.key)).toEqual(Array(4).fill("Bearer fixture-override"));
  unchanged(config); noLeaks(config);
});

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

for (const reselect of [false, true]) test(`gateway compact preserves custom transport after key admission (reselect=${reselect})`, async () => {
  const config = fixture();
  const provider = config.providers[NAME]!;
  config.providers = { "gateway-key-fixture": provider };
  config.defaultProvider = "gateway-key-fixture";
  provider.baseUrl = "https://gateway.example/v1";
  provider.responsesPath = "/custom-responses";
  provider.supportsNativeCompactEndpoint = true;
  provider.headers = { "x-gateway-static": "initial" };
  saveConfig(config);
  const held = reselect ? await waitForProviderRequestSlot(config.defaultProvider, provider) : undefined;
  const abort = new AbortController();
  const pending = start(config, abort);
  try {
    if (reselect) {
      await queue(config, "k1");
      cool(config, 0);
      provider.headers = { "x-gateway-static": "replacement" };
      provider.responsesPath = "/refreshed-responses";
      provider.apiKeySelectionRevision = "gateway-revision";
      held!.release();
    }
    const result = await pending;
    expect(result.response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe(`Bearer ${KEYS[reselect ? 1 : 0]}`);
    expect(seen[0]!.url).toBe(`https://gateway.example/v1/${reselect ? "refreshed-responses" : "custom-responses"}/compact`);
    expect(seen[0]!.headers.get("x-gateway-static")).toBe(reselect ? "replacement" : "initial");
    expect(seen[0]!.headers.get("chatgpt-account-id")).toBeNull();
    expect(seen[0]!.body).toMatchObject({ model: "test", input: [{ role: "user", content: "fixture question" }] });
    noLeaks(config);
  } finally { abort.abort(); held?.release(); await pending.catch(() => undefined); }
});
