import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";
import { captureProviderApiKeySelection } from "../../src/providers/api-key-selection";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, getKeyCooldownUntil, recordDistributedKeyFailure } from "../../src/providers/key-failover";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, setProviderRequestPacingLimitsForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeCompactionFixture } from "../helpers/compaction-routing-fixtures";

const NAME = "native-key-fixture";
const KEYS = ["fixture-key-alpha", "fixture-key-beta"];
const originalFetch = globalThis.fetch;
let home: string;
let previousHome: string | undefined;
let releaseOwner: () => void;
let seen: string[];
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-keys-"));
  process.env.OPENCODEX_HOME = home;
  releaseOwner = acquireOwnedSpendHome();
  seen = [];
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  releaseOwner();
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
  await removeCompactionFixture(home);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});
function fixture(): OcxConfig {
  const config = { port: 0, defaultProvider: NAME, providers: { [NAME]: {
    adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key",
    apiKey: KEYS[0], apiKeySelectionRevision: "fixture-revision",
    apiKeyPool: KEYS.map((key, index) => ({ id: `k${index + 1}`, key, addedAt: index + 1 })),
    requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
  } } } as OcxConfig;
  saveConfig(config);
  return config;
}
function start(config: OcxConfig, signal?: AbortSignal) {
  const req = new Request("http://localhost/v1/responses", { method: "POST", signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: `${NAME}/test`, input: "fixture question", stream: false, store: false }),
  });
  return handleResponses(req, config, { model: "", provider: "" }).then(async response => ({ response, text: await response.text() }));
}
function intercept(reply: (headers: Headers) => Response | Promise<Response>) {
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://gateway.example/v1/responses");
    const headers = new Headers(init?.headers);
    seen.push(headers.get("authorization")!);
    return reply(headers);
  }) as typeof fetch;
}
function unchanged(config: OcxConfig) {
  for (const provider of [config.providers[NAME]!, JSON.parse(readFileSync(join(home, "config.json"), "utf8")).providers[NAME]]) {
    expect(provider.apiKey).toBe(KEYS[0]);
    expect(provider.apiKeySelectionRevision).toBe("fixture-revision");
    expect(provider._apiKeyAttempt).toBeUndefined();
  }
  const status = providerRequestPacingStatus(NAME, config.providers[NAME]!);
  expect(status.queued).toBe(0); expect(status.inFlight ?? 0).toBe(0);
}
const completed = () => Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [] });
for (const status of [401, 429] as const) test(`native Responses cools genuine distributed ${status} without replay`, async () => {
  const config = fixture(); const began = Date.now();
  intercept(headers => headers.get("authorization") === `Bearer ${KEYS[0]}`
    ? Response.json({ error: { message: "fixture refusal", type: "upstream_error" } }, { status, headers: { "retry-after": "45" } }) : completed());
  const first = await start(config);
  expect(first.response.status).toBe(status);
  if (status === 429) expect(first.response.headers.get("retry-after")).toBe("45");
  expect(seen).toHaveLength(1);
  expect(getKeyCooldownUntil(NAME, "k1")).toBeGreaterThanOrEqual(began + (status === 401 ? 600_000 : 45_000));
  expect((await start(config)).response.status).toBe(200);
  expect((await start(config)).response.status).toBe(200);
  expect(seen).toEqual([`Bearer ${KEYS[0]}`, `Bearer ${KEYS[1]}`, `Bearer ${KEYS[1]}`]);
  unchanged(config);
});
test("native same-key 429 retry succeeds without cooling the credential", async () => {
  const config = fixture(); config.providers[NAME]!.retryOn429 = { attempts: 1, intervalMs: 1 };
  intercept(() => seen.length === 1 ? Response.json({ error: { message: "fixture capacity" } }, { status: 429, headers: { "retry-after": "0" } }) : completed());
  expect((await start(config)).response.status).toBe(200);
  expect(seen).toEqual([`Bearer ${KEYS[0]}`, `Bearer ${KEYS[0]}`]);
  expect(getKeyCooldownUntil(NAME, "k1")).toBeNull();
  unchanged(config);
});
for (const mode of ["override", "synthetic", "revision"] as const) test(`native Responses does not cool an unowned refusal (${mode})`, async () => {
  const config = fixture();
  if (mode === "override") config.providers[NAME]!.headers = { Authorization: "Bearer fixture-header-override" };
  intercept(() => {
    if (mode === "revision") config.providers[NAME]!.apiKeySelectionRevision = "replacement-revision";
    const response = Response.json({ error: { message: "fixture refusal" } }, { status: 401 });
    if (mode === "synthetic") markResponseNonReplayable(response);
    return response;
  });
  expect((await start(config)).response.status).toBe(401);
  expect(getKeyCooldownUntil(NAME, "k1")).toBeNull();
  expect(getKeyCooldownUntil(NAME, "k2")).toBeNull();
  expect(seen).toHaveLength(1);
});
async function queued(config: OcxConfig) {
  const deadline = Date.now() + 2_000;
  while (providerRequestPacingStatus(NAME, config.providers[NAME]!).queued !== 1) {
    if (Date.now() >= deadline) throw new Error("native fixture never queued");
    await Bun.sleep(5);
  }
}
function cool(config: OcxConfig, index: number) {
  expect(recordDistributedKeyFailure(config, NAME, {
    ...captureProviderApiKeySelection({ ...config.providers[NAME]!, apiKey: KEYS[index] }), distributed: true,
  }, 429, Date.now(), "45")).toBe(true);
}
for (const mode of ["exhausted", "expired", "cancelled"] as const) test(`queued native key refusal maps to local status (${mode})`, async () => {
  const config = fixture();
  if (mode === "expired") setProviderRequestPacingLimitsForTest({ maxQueueAgeMs: 50 });
  intercept(completed);
  const first = await waitForProviderRequestSlot(NAME, config.providers[NAME]!);
  const second = await waitForProviderRequestSlot(NAME, { ...config.providers[NAME]!, apiKey: KEYS[1] });
  const abort = new AbortController();
  const pending = start(config, abort.signal); void pending.catch(() => {});
  try {
    await queued(config); cool(config, 0);
    if (mode === "exhausted") cool(config, 1);
    first.release();
    if (mode !== "exhausted") await queued(config);
    if (mode === "cancelled") abort.abort();
    const result = await pending;
    expect(result.response.status).toBe(mode === "cancelled" ? 499 : 429);
    if (mode !== "cancelled") expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(seen).toEqual([]);
    second.release(); unchanged(config);
  } finally { abort.abort(); first.release(); second.release(); await pending.catch(() => undefined); }
}, 10_000);
for (const mode of ["exhausted", "expired", "cancelled"] as const) test(`native replay admission keeps local refusal semantics (${mode})`, async () => {
  const config = fixture();
  config.providers[NAME]!.retryOn429 = { attempts: 1, intervalMs: 1, respectRetryAfter: false };
  let holder: ReturnType<typeof waitForProviderRequestSlot> | undefined;
  intercept(() => {
    holder = waitForProviderRequestSlot(NAME, config.providers[NAME]!);
    return Response.json({ error: { message: "fixture capacity" } }, { status: 429, headers: { "retry-after": "45" } });
  });
  const abort = new AbortController();
  const pending = start(config, abort.signal); void pending.catch(() => {});
  while (!holder) await Bun.sleep(5);
  const slot = await holder;
  try {
    await queued(config);
    if (mode === "expired") {
      // Existing waiter uses the new bound on the next queue evaluation.
      setProviderRequestPacingLimitsForTest({ maxQueueAgeMs: 30 });
      const wake = new AbortController();
      const waiter = waitForProviderRequestSlot(NAME, config.providers[NAME]!, "other", wake.signal);
      void waiter.catch(() => {}); wake.abort(); await waiter.catch(() => {});
    } else if (mode === "exhausted") {
      cool(config, 0); cool(config, 1); slot.release();
    } else abort.abort();
    const result = await pending;
    expect(result.response.status).toBe(mode === "cancelled" ? 499 : 429);
    if (mode !== "cancelled") expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    if (mode === "expired") expect(getKeyCooldownUntil(NAME, "k1")).toBeGreaterThan(Date.now());
    if (mode === "cancelled") expect(getKeyCooldownUntil(NAME, "k1")).toBeNull();
  } finally { abort.abort(); slot.release(); await pending.catch(() => undefined); }
}, 10_000);
for (const mode of ["active", "disabled"] as const) test(`native Responses retains opt-out key behavior (${mode})`, async () => {
  const config = fixture();
  if (mode === "active") config.providers[NAME]!.requestPacing!.keySelection = "active";
  else config.providers[NAME]!.requestPacing!.enabled = false;
  intercept(() => Response.json({ error: { message: "fixture rejection" } }, { status: 401 }));
  for (let i = 0; i < 3; i++) expect((await start(config)).response.status).toBe(401);
  expect(seen).toEqual(Array(3).fill(`Bearer ${KEYS[0]}`));
  expect(getKeyCooldownUntil(NAME, "k1")).toBeNull();
  unchanged(config);
});
test("native Responses cools a terminal 429 after the configured same-key retry", async () => {
  const config = fixture();
  config.providers[NAME]!.retryOn429 = { attempts: 1, intervalMs: 1, respectRetryAfter: false };
  intercept(() => Response.json({ error: { message: "fixture capacity" } }, { status: 429, headers: { "retry-after": "45" } }));
  const result = await start(config);
  expect(result.response.status).toBe(429);
  expect(result.response.headers.get("retry-after")).toBe("45");
  expect(seen).toEqual([`Bearer ${KEYS[0]}`, `Bearer ${KEYS[0]}`]);
  expect(getKeyCooldownUntil(NAME, "k1")).toBeGreaterThan(Date.now());
  unchanged(config);
});
test("an in-flight 401 extends the same key's earlier short 429 cooldown", async () => {
  const config = fixture(); config.providers[NAME]!.requestPacing!.keys!.maxConcurrentRequests = 2;
  let rejectFirst: ((response: Response) => void) | undefined;
  let firstKeySends = 0;
  intercept(headers => {
    if (headers.get("authorization") !== `Bearer ${KEYS[0]}`) return completed();
    if (++firstKeySends === 1) return new Promise<Response>(resolve => { rejectFirst = resolve; });
    return Response.json({ error: { message: "fixture capacity" } }, { status: 429, headers: { "retry-after": "1" } });
  });
  const pending = start(config);
  while (!rejectFirst) await Bun.sleep(5);
  try {
    expect((await start(config)).response.status).toBe(200);
    expect((await start(config)).response.status).toBe(429);
    expect(getKeyCooldownUntil(NAME, "k1")).toBeGreaterThan(Date.now());
  } finally { rejectFirst(Response.json({ error: { message: "fixture rejection" } }, { status: 401 })); }
  expect((await pending).response.status).toBe(401);
  expect(getKeyCooldownUntil(NAME, "k1")).toBeGreaterThanOrEqual(Date.now() + 599_000);
  unchanged(config);
});
test("a synthetic replay refusal retains the preceding genuine key rejection", async () => {
  const config = fixture();
  config.providers[NAME]!.retryOn429 = { attempts: 1, intervalMs: 1, respectRetryAfter: false };
  intercept(() => {
    const response = Response.json({ error: { message: "fixture capacity" } }, {
      status: seen.length === 1 ? 429 : 502, headers: { "retry-after": "45" },
    });
    if (seen.length > 1) markResponseNonReplayable(response);
    return response;
  });
  expect((await start(config)).response.status).toBe(502);
  expect(getKeyCooldownUntil(NAME, "k1")).toBeGreaterThan(Date.now());
  unchanged(config);
});
