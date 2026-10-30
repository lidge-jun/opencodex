import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { captureOAuthAccountSelection, getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { bindAnthropicSessionAffinity, clearAnthropicAccountPoolState, resolveAnthropicAccountForSession,
  promoteAnthropicActiveAccount, recordAnthropicAccount429, resetAnthropicRoutingForManualSelection } from "../../../src/oauth/anthropic-routing";
import type { OcxConfig } from "../../../src/types";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;
let clock: ReturnType<typeof spyOn> | undefined;
const config = { providers: { anthropic: { adapter: "anthropic", authMode: "oauth" } },
  anthropicAccountPool: { enabled: true, autoSwitchThreshold: 0 } } as unknown as OcxConfig;
const session = "private-session-L7-never-persist-raw";
async function accountMutation(path: "active" | "pause", body: Record<string, unknown>) {
  const { handleOauthAccountRoutes } = await import("../../../src/server/management/oauth-account-routes");
  const req = new Request(`http://127.0.0.1:10100/api/oauth/accounts/${path}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return handleOauthAccountRoutes({
    req, url: new URL(req.url), config, deps: {}, version: "test", principal: "gui-session",
    syncClaudeAgentDefsBestEffort: async () => {},
  });
}
async function flush() {
  // This owner exists with the implementation; keeping the regression runnable on dev
  // proves the behavioral failure rather than a missing-export failure.
  const store = await import("../../../src/oauth/anthropic-session-affinity-store").catch(() => null);
  await store?.flushAnthropicSessionAffinity();
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-affinity-restart-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
});
afterEach(async () => {
  clock?.mockRestore(); clock = undefined;
  await flush();
  clearAnthropicAccountPoolState();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});
async function seed() {
  for (const id of ["A", "B"]) await saveCredential("anthropic", {
    access: `fixture-access-${id}`, refresh: `fixture-refresh-${id}`, expires: Date.now() + 3_600_000, accountId: id,
  });
  const [a, b] = getAccountSet("anthropic")!.accounts;
  await setActiveAccount("anthropic", a!.id);
  await promoteAnthropicActiveAccount(a!.id, captureOAuthAccountSelection("anthropic"), { config });
  bindAnthropicSessionAffinity(session, a!.id);
  return { a: a!.id, b: b!.id };
}
test("transient detour commit preserves binding after pause expires", async () => {
  const { a, b } = await seed();
  let now = Date.now(); clock = spyOn(Date, "now").mockImplementation(() => now);
  recordAnthropicAccount429(config, a, "0.01", now);
  expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(b);
  now += 20;
  await promoteAnthropicActiveAccount(b, captureOAuthAccountSelection("anthropic"), { config, sessionKey: session });
  expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(a);
});
test("restored binding precedes startup active preference", async () => {
  const { a, b } = await seed();
  await flush();
  await setActiveAccount("anthropic", b);
  clearAnthropicAccountPoolState();
  expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(a);
});
test("runtime manual selection overrides binding", async () => {
  const { b } = await seed();
  await setActiveAccount("anthropic", b);
  resetAnthropicRoutingForManualSelection(b);
  expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(b);
});

test("manual selection success survives restart without a shutdown flush", async () => {
  const { b } = await seed();
  await flush();
  const response = await accountMutation("active", { provider: "anthropic", accountId: b });
  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject({ ok: true, activeAccountId: b });
  // Drop process-local state immediately after the success response. No explicit
  // flush or shutdown hook may repair disk state before hydration is checked.
  clearAnthropicAccountPoolState();
  expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(b);
}, 20_000);

for (const action of ["active", "pause"] as const) {
  test(`${action} reports an unpersisted reset and an unchanged retry completes it`, async () => {
    const { a, b } = await seed();
    await flush();
    const { AnthropicSessionAffinityStore, anthropicAffinityPath } = await import("../../../src/oauth/anthropic-session-affinity-store");
    const original = AnthropicSessionAffinityStore.prototype.flushConfirmed;
    let attempts = 0;
    const confirmation = spyOn(AnthropicSessionAffinityStore.prototype, "flushConfirmed")
      .mockImplementation(function (this: InstanceType<typeof AnthropicSessionAffinityStore>) {
        return ++attempts === 1 ? Promise.resolve(false) : original.call(this);
      });
    const body = action === "active" ? { provider: "anthropic", accountId: b }
      : { provider: "anthropic", accountId: a, paused: true };
    try {
      const failed = await accountMutation(action, body);
      expect(failed?.status).toBe(503);
      expect(await failed!.json()).toMatchObject({ code: "affinity_reset_not_persisted", activeAccountId: b,
        retryable: true, ...(action === "active" ? { selectionCommitted: true } : { pauseCommitted: true }) });
      expect(getAccountSet("anthropic")?.activeAccountId).toBe(b);
      const retry = await accountMutation(action, body);
      expect(retry?.status).toBe(200);
      const completed = await retry!.json();
      if (action === "pause") expect(completed).toMatchObject({ activeAccountChanged: false, paused: true });
      expect(attempts).toBe(2);
      expect(JSON.parse(readFileSync(anthropicAffinityPath(home, "anthropic"), "utf8")).entries).toEqual([]);
      clearAnthropicAccountPoolState();
      expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(b);
    } finally { confirmation.mockRestore(); }
  }, 20_000);
}

test("explicit pause reset retry survives loss of process-local pending state", async () => {
  const { a, b } = await seed();
  await saveCredential("anthropic", { access: "fixture-access-C", refresh: "fixture-refresh-C",
    expires: Date.now() + 3_600_000, accountId: "C" });
  const c = getAccountSet("anthropic")!.accounts.find(row => row.id !== a && row.id !== b)!.id;
  await setActiveAccount("anthropic", a);
  bindAnthropicSessionAffinity(session, c);
  await flush();
  const { AnthropicSessionAffinityStore, anthropicAffinityPath } = await import("../../../src/oauth/anthropic-session-affinity-store");
  const original = AnthropicSessionAffinityStore.prototype.flushConfirmed;
  let attempts = 0;
  const confirmation = spyOn(AnthropicSessionAffinityStore.prototype, "flushConfirmed")
    .mockImplementation(function (this: InstanceType<typeof AnthropicSessionAffinityStore>) {
      return ++attempts === 1 ? Promise.resolve(false) : original.call(this);
    });
  try {
    const body = { provider: "anthropic", accountId: a, paused: true };
    expect((await accountMutation("pause", body))?.status).toBe(503);
    clearAnthropicAccountPoolState(); // Abrupt restart: no graceful flush repairs the snapshot.
    expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(c);
    expect((await accountMutation("pause", { ...body, retryAffinityReset: "true" }))?.status).toBe(400);
    expect((await accountMutation("pause", body))?.status).toBe(200);
    expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(c);
    const retry = await accountMutation("pause", { ...body, retryAffinityReset: true });
    expect(retry?.status).toBe(200);
    expect(await retry!.json()).toMatchObject({ activeAccountId: b, activeAccountChanged: false });
    expect(JSON.parse(readFileSync(anthropicAffinityPath(home, "anthropic"), "utf8")).entries).toEqual([]);
    clearAnthropicAccountPoolState();
    expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(b);
  } finally { confirmation.mockRestore(); }
}, 20_000);

test("pausing an unrelated inactive account confirms an outstanding selection reset", async () => {
  const { a, b } = await seed();
  await flush();
  const { AnthropicSessionAffinityStore, anthropicAffinityPath } = await import("../../../src/oauth/anthropic-session-affinity-store");
  const original = AnthropicSessionAffinityStore.prototype.flushConfirmed;
  let attempts = 0;
  const confirmation = spyOn(AnthropicSessionAffinityStore.prototype, "flushConfirmed")
    .mockImplementation(function (this: InstanceType<typeof AnthropicSessionAffinityStore>) {
      return ++attempts === 1 ? Promise.resolve(false) : original.call(this);
    });
  try {
    const selection = await accountMutation("active", { provider: "anthropic", accountId: b });
    expect(selection?.status).toBe(503);
    const unrelated = await accountMutation("pause", { provider: "anthropic", accountId: a, paused: true });
    expect(unrelated?.status).toBe(200);
    expect(await unrelated!.json()).toMatchObject({ activeAccountId: b, activeAccountChanged: false });
    expect(attempts).toBe(2);
    expect(JSON.parse(readFileSync(anthropicAffinityPath(home, "anthropic"), "utf8")).entries).toEqual([]);
  } finally { confirmation.mockRestore(); }
}, 20_000);
test("normal transient detour returns to the original and refreshes idle lifetime", async () => {
  const { a, b } = await seed();
  let now = Date.now(); clock = spyOn(Date, "now").mockImplementation(() => now);
  bindAnthropicSessionAffinity(session, a, now - 24 * 60 * 60_000 + 5);
  recordAnthropicAccount429(config, a, "0.1", now);
  expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(b);
  await promoteAnthropicActiveAccount(b, captureOAuthAccountSelection("anthropic"), { config, sessionKey: session });
  now += 200;
  expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(a);
});
test("shared-quota rejection rebinds even after a short Retry-After expires", async () => {
  const { a, b } = await seed();
  let now = Date.now(); clock = spyOn(Date, "now").mockImplementation(() => now);
  recordAnthropicAccount429(config, a, "0.01", now, new Headers({ "anthropic-ratelimit-unified-5h-status": "rejected" }));
  now += 20;
  await promoteAnthropicActiveAccount(b, captureOAuthAccountSelection("anthropic"), { config, sessionKey: session });
  expect(resolveAnthropicAccountForSession(session, config).accountId).toBe(b);
});
test.each([
  ["shared five-hour", false], ["model-specific", false], ["shared five-hour", true], ["model-specific", true],
] as const)("measured %s exhaustion commits a replacement binding (earlier expired throttle: %p)", async (kind, throttled) => {
  const { a, b } = await seed();
  const model = "claude-opus-5-5";
  if (throttled) {
    // A short throttle that has already expired must not outrank the measured exhaustion below.
    const start = Date.now();
    let now = start; clock = spyOn(Date, "now").mockImplementation(() => now);
    recordAnthropicAccount429(config, a, "0.01", now);
    now = start + 50;
  }
  setCachedProviderAccountQuotaForTests("anthropic", a, kind === "shared five-hour"
    ? { fiveHourPercent: 100 } : { customWindows: [{ label: "Opus", scope: "model", percent: 100 }] });
  setCachedProviderAccountQuotaForTests("anthropic", b, { fiveHourPercent: 10 });
  const selected = resolveAnthropicAccountForSession(session, config, Date.now(), null, model);
  expect(selected.accountId).toBe(b);
  expect(await promoteAnthropicActiveAccount(b, captureOAuthAccountSelection("anthropic"), {
    config, sessionKey: session, model, reason: selected.reason,
  })).not.toBeNull();
  setCachedProviderAccountQuotaForTests("anthropic", a, { fiveHourPercent: 0 });
  expect(resolveAnthropicAccountForSession(session, config, Date.now(), null, model)).toMatchObject({ accountId: b, reason: "affinity" });
});
