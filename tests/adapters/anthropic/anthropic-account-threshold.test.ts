import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../../../src/codex/pool-rotation";
import { subscribeAccountSelections } from "../../../src/lib/account-selection-events";
import { effectiveAnthropicAccountThreshold, parseAnthropicAccountThreshold } from "../../../src/oauth/anthropic-account-threshold";
import { bindAnthropicSessionAffinity, clearAnthropicAccountPoolState, promoteAnthropicActiveAccount,
  resetAnthropicRoutingForManualSelection, resolveAnthropicAccountForSession, rotateAnthropicAccountOn429 } from "../../../src/oauth/anthropic-routing";
import { captureOAuthAccountSelection, getAccountCredential, getAccountSet, removeAccount, replaceProviderAccountSet,
  saveAccountCredential, saveCredential, setAccountPaused, setActiveAccount, setAnthropicAccountThreshold } from "../../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import type { OcxConfig, OcxAccountPoolQuotaWindow, OcxAccountPoolRotationStrategy } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { handleAnthropicAccountThreshold } from "../../../src/server/management/anthropic-account-threshold";
import { handleOauthAccountRoutes } from "../../../src/server/management/oauth-account-routes";
import type { ManagementContext } from "../../../src/server/management/context";

const oldHome = process.env.OPENCODEX_HOME;
let home: string;
let ids: [string, string, string];
function config(strategy: OcxAccountPoolRotationStrategy = "quota", quotaWindow: OcxAccountPoolQuotaWindow = "five-hour", enabled = true): OcxConfig {
  return { port: 0, defaultProvider: "anthropic", providers: {
    anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
  }, anthropicAccountPool: { enabled, strategy, quotaWindow, autoSwitchThreshold: 80 } };
}
function quota(id: string, percent: number, resetAt = Date.now() + 3600_000) {
  setCachedProviderAccountQuotaForTests("anthropic", id, { fiveHourPercent: percent, weeklyPercent: percent,
    fiveHourResetAt: resetAt, weeklyResetAt: resetAt, updatedAt: Date.now() });
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-threshold-")); process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache();
  for (let i = 0; i < 3; i++) await saveCredential("anthropic", { access: `synthetic-${i}`, refresh: `synthetic-refresh-${i}`,
    expires: Date.now() + 3600_000, accountId: `threshold-${i}` });
  ids = getAccountSet("anthropic")!.accounts.map(row => row.id).sort() as typeof ids;
  await setActiveAccount("anthropic", ids[0]);
  const pick = resolveAnthropicAccountForSession("setup", config());
  await promoteAnthropicActiveAccount(pick.accountId!, captureOAuthAccountSelection("anthropic"), { config: config(), reason: pick.reason });
});
afterEach(() => {
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
  removeTreeWithRetry(home);
});

test("inheritance, null reset, zero and strict integer range", async () => {
  for (const invalid of [undefined, null, "80", true, [], {}, -1, 101, 2.5, NaN, Infinity]) expect(parseAnthropicAccountThreshold(invalid)).toBeNull();
  for (const valid of [0, 1, 80, 100]) expect(parseAnthropicAccountThreshold(valid)).toBe(valid);
  const cfg = config();
  expect(effectiveAnthropicAccountThreshold({ ...cfg, anthropicAccountPool: {} })).toBe(80);
  await setAnthropicAccountThreshold(ids[0], 0);
  expect(effectiveAnthropicAccountThreshold(cfg, getAccountSet("anthropic")!.accounts.find(row => row.id === ids[0]))).toBe(0);
  await setAnthropicAccountThreshold(ids[0], null); cfg.anthropicAccountPool!.autoSwitchThreshold = 63;
  expect(effectiveAnthropicAccountThreshold(cfg, getAccountSet("anthropic")!.accounts.find(row => row.id === ids[0]))).toBe(63);
  expect(await setAnthropicAccountThreshold("missing", 50)).toBe(false);
});

for (const strategy of ["quota", "fill-first"] as const) for (const window of ["five-hour", "weekly", "max-utilization"] as const) {
  test(`${strategy}/${window}: source and successor use their own thresholds`, async () => {
    const [a, b, c] = ids; const cfg = config(strategy, window);
    quota(a, 60); quota(b, 30); quota(c, 70);
    await setAnthropicAccountThreshold(a, 50); await setAnthropicAccountThreshold(b, 20); await setAnthropicAccountThreshold(c, 90);
    expect(resolveAnthropicAccountForSession("new", cfg).accountId).toBe(c);
    await setAnthropicAccountThreshold(a, 0);
    expect(resolveAnthropicAccountForSession("new", cfg).accountId).toBe(a);
    await setAnthropicAccountThreshold(a, 100); quota(a, 99);
    expect(resolveAnthropicAccountForSession("new", cfg).accountId).toBe(a);
    quota(a, 100);
    expect(resolveAnthropicAccountForSession("new", cfg).accountId).toBe(c);
  });
  test(`${strategy}/${window}: unknown and reset-expired source does not force switching`, async () => {
    await setAnthropicAccountThreshold(ids[0], 1); quota(ids[1], 0); quota(ids[2], 0);
    expect(resolveAnthropicAccountForSession("unknown", config(strategy, window)).accountId).toBe(ids[0]);
    quota(ids[0], 100, Date.now() - 1000);
    expect(resolveAnthropicAccountForSession("expired", config(strategy, window)).accountId).toBe(ids[0]);
  });
}

for (const window of ["five-hour", "weekly", "max-utilization"] as const) test(`round-robin/${window} is not usage-driven`, async () => {
  const cfg = config("round-robin", window);
  const before = resolveAnthropicAccountForSession("unbound", cfg);
  for (const id of ids) { quota(id, 99); await setAnthropicAccountThreshold(id, 1); }
  expect(resolveAnthropicAccountForSession("unbound", cfg)).toEqual(before);
});

test("manual, affinity and identity-less strategy priorities remain unchanged", async () => {
  const [a, b] = ids; quota(a, 70); quota(b, 10); await setAnthropicAccountThreshold(a, 20);
  bindAnthropicSessionAffinity("bound", a);
  expect(resolveAnthropicAccountForSession("bound", config()).reason).toBe("affinity");
  for (const strategy of ["round-robin", "fill-first"] as const) expect(resolveAnthropicAccountForSession(null, config(strategy)).accountId).toBe(a);
  await setActiveAccount("anthropic", a); resetAnthropicRoutingForManualSelection(a);
  expect(resolveAnthropicAccountForSession("new", config())).toMatchObject({ accountId: a, reason: "manual" });
});

test.each(["active", "non-active"] as const)("%s threshold edits preserve the pending manual dispatch", async target => {
  const [a, b, c] = ids;
  quota(a, 90); quota(b, 10); quota(c, 70);
  await setActiveAccount("anthropic", a);
  resetAnthropicRoutingForManualSelection(a);

  await setAnthropicAccountThreshold(target === "active" ? a : b, target === "active" ? 20 : 50);
  const first = resolveAnthropicAccountForSession("manual-after-policy", config());
  expect(first).toMatchObject({ accountId: a, reason: "manual" });
  expect(await promoteAnthropicActiveAccount(a, captureOAuthAccountSelection("anthropic"), {
    config: config(), sessionKey: "manual-after-policy", reason: first.reason,
  })).not.toBeNull();

  // The operator's one-shot intent is now consumed; the edited quota policy owns
  // the next unbound session and moves traffic to the lower-usage account.
  expect(resolveAnthropicAccountForSession("policy-after-manual", config())).toMatchObject({ accountId: b, reason: "lowest-usage" });
});

test("policy ownership is visible before the generic selection event", async () => {
  const [a, b, c] = ids;
  quota(a, 90); quota(b, 10); quota(c, 70);
  await setActiveAccount("anthropic", a);
  resetAnthropicRoutingForManualSelection(a);
  const observed: ReturnType<typeof resolveAnthropicAccountForSession>[] = [];
  const unsubscribe = subscribeAccountSelections(event => {
    if (event.provider === "anthropic" && event.kind === "oauth") {
      observed.push(resolveAnthropicAccountForSession("inside-selection-event", config()));
    }
  });
  try {
    await setAnthropicAccountThreshold(b, 50);
  } finally {
    unsubscribe();
  }
  expect(observed).toEqual([expect.objectContaining({ accountId: a, reason: "manual" })]);
  expect(resolveAnthropicAccountForSession("after-selection-event", config())).toMatchObject({ accountId: a, reason: "manual" });
});

test.each(["aba", "same-id"] as const)("ordinary %s revisions cannot be adopted by a later policy event", async transition => {
  const [a, b, c] = ids;
  quota(a, 90); quota(b, 10); quota(c, 70);
  await setActiveAccount("anthropic", a);
  resetAnthropicRoutingForManualSelection(a);
  if (transition === "aba") await setActiveAccount("anthropic", b);
  await setActiveAccount("anthropic", a);
  await setAnthropicAccountThreshold(b, 50);
  expect(resolveAnthropicAccountForSession(`after-${transition}`, config())).toMatchObject({ accountId: b, reason: "lowest-usage" });
});

test("a consumed manual choice stays consumed across successive policy edits", async () => {
  const [a, b, c] = ids;
  quota(a, 90); quota(b, 10); quota(c, 70);
  await setActiveAccount("anthropic", a);
  resetAnthropicRoutingForManualSelection(a);
  const manual = resolveAnthropicAccountForSession("consume-before-policy", config());
  expect(manual).toMatchObject({ accountId: a, reason: "manual" });
  expect(await promoteAnthropicActiveAccount(a, captureOAuthAccountSelection("anthropic"), {
    config: config(), sessionKey: "consume-before-policy", reason: manual.reason,
  })).not.toBeNull();
  await setAnthropicAccountThreshold(b, 50);
  await setAnthropicAccountThreshold(c, 60);
  expect(resolveAnthropicAccountForSession("after-consumed-policy", config())).toMatchObject({ accountId: b, reason: "lowest-usage" });
});

test("a rejected policy persistence neither advances selection nor consumes manual intent", async () => {
  const [a, b, c] = ids;
  quota(a, 90); quota(b, 10); quota(c, 70);
  await setActiveAccount("anthropic", a);
  resetAnthropicRoutingForManualSelection(a);
  const before = captureOAuthAccountSelection("anthropic");
  await expect(setAnthropicAccountThreshold(b, 50, {
    assertBeforePersist: () => { throw new Error("synthetic threshold persist refusal"); },
  })).rejects.toThrow("synthetic threshold persist refusal");
  expect(captureOAuthAccountSelection("anthropic")).toEqual(before);
  expect(resolveAnthropicAccountForSession("after-rejected-policy", config())).toMatchObject({ accountId: a, reason: "manual" });
});

test("successive policy revisions preserve the current manual choice exactly once", async () => {
  const [a, b, c] = ids;
  quota(a, 90); quota(b, 10); quota(c, 70);
  await setActiveAccount("anthropic", a);
  resetAnthropicRoutingForManualSelection(a);
  await setAnthropicAccountThreshold(b, 50);
  await setAnthropicAccountThreshold(c, 60);
  const manual = resolveAnthropicAccountForSession("after-two-policies", config());
  expect(manual).toMatchObject({ accountId: a, reason: "manual" });
  expect(await promoteAnthropicActiveAccount(a, captureOAuthAccountSelection("anthropic"), {
    config: config(), sessionKey: "after-two-policies", reason: manual.reason,
  })).not.toBeNull();
  expect(resolveAnthropicAccountForSession("after-two-policies-consumed", config())).toMatchObject({ accountId: b, reason: "lowest-usage" });
});

test("all-drained fallback remains available; zero candidate stays usable", async () => {
  const [a, b, c] = ids; quota(a, 90); quota(b, 20); quota(c, 50);
  for (const id of ids) await setAnthropicAccountThreshold(id, 10);
  expect(resolveAnthropicAccountForSession("new", config()).accountId).toBe(b);
  await setAnthropicAccountThreshold(c, 0);
  expect(resolveAnthropicAccountForSession("new", config()).accountId).toBe(c);
});

test("unknown successors do not displace the legacy measured fallback without a known under-threshold candidate", async () => {
  quota(ids[0], 90); quota(ids[1], 95);
  expect(resolveAnthropicAccountForSession("unknown-successor", config()).accountId).toBe(ids[0]);
});

test("zero remains available even with a measured exhausted five-hour window under weekly routing", async () => {
  quota(ids[0], 90); quota(ids[1], 100); quota(ids[2], 95);
  await setAnthropicAccountThreshold(ids[1], 0);
  for (const strategy of ["quota", "fill-first"] as const) expect(resolveAnthropicAccountForSession("new", config(strategy, "weekly")).accountId).toBe(ids[1]);
});

test("strict routes stay closed even when drained; fallback widens only empty eligibility", async () => {
  const [a, b, c] = ids; for (const id of ids) { quota(id, 90); await setAnthropicAccountThreshold(id, 10); }
  quota(c, 0);
  const route = { position: 1, accounts: [b, a], fallback: true };
  expect(resolveAnthropicAccountForSession("new", config(), Date.now(), route).accountId).toBe(b);
  await setAccountPaused("anthropic", a, true); await setAccountPaused("anthropic", b, true);
  expect(resolveAnthropicAccountForSession("new", config(), Date.now(), { ...route, fallback: false }).accountId).toBeNull();
  expect(resolveAnthropicAccountForSession("new", config(), Date.now(), route).accountId).toBe(c);
});

test("pool-off proactive and reactive recovery ignore stored per-account thresholds", async () => {
  const [a, b, c] = ids; quota(a, 90); quota(b, 20); quota(c, 50);
  await setAnthropicAccountThreshold(a, 1); await setAnthropicAccountThreshold(b, 1); await setAnthropicAccountThreshold(c, 0);
  expect(resolveAnthropicAccountForSession("new", config("fill-first", "five-hour", false)).accountId).toBe(a);
  expect(rotateAnthropicAccountOn429(config("fill-first", "five-hour", false), a, "60")).toBe(b);
});

test("pool-on fill-first 429 successors use candidate thresholds without escaping route", async () => {
  const [a, b, c] = ids; quota(b, 40); quota(c, 70);
  await setAnthropicAccountThreshold(b, 30); await setAnthropicAccountThreshold(c, 80);
  expect(rotateAnthropicAccountOn429(config("fill-first"), a, "60", null, Date.now(), null,
    { position: 1, accounts: [a, b, c], fallback: false })).toBe(c);
});

test("threshold generation rejects a pre-wait proposal, including non-active candidate edits", async () => {
  const captured = captureOAuthAccountSelection("anthropic");
  await setAnthropicAccountThreshold(ids[1], 25);
  expect(await promoteAnthropicActiveAccount(ids[1], captured, { config: config() })).toBeNull();
  expect(getAccountSet("anthropic")!.activeAccountId).toBe(ids[0]);
});

test("idempotence and ABA generations; queued deletion cannot recreate an account", async () => {
  const a = ids[0];
  await setAnthropicAccountThreshold(a, 0);
  const before = captureOAuthAccountSelection("anthropic");
  await setAnthropicAccountThreshold(a, 0);
  expect(captureOAuthAccountSelection("anthropic")).toEqual(before);
  await setAnthropicAccountThreshold(a, null); await setAnthropicAccountThreshold(a, 0);
  expect(captureOAuthAccountSelection("anthropic")?.revision).not.toBe(before?.revision);
  expect(await promoteAnthropicActiveAccount(a, before, { config: config() })).toBeNull();
  const result = await Promise.all([setAnthropicAccountThreshold(a, 30), removeAccount("anthropic", a), setAnthropicAccountThreshold(a, 90)]);
  expect(result).toEqual([true, true, false]);
  expect(getAccountSet("anthropic")!.accounts.some(row => row.id === a)).toBe(false);
});

test("refresh, pause, replacement and fresh-process reads retain threshold; deletion cleans it", async () => {
  const a = ids[0]; const credential = getAccountCredential("anthropic", a)!;
  await Promise.all([setAnthropicAccountThreshold(a, 0), saveAccountCredential("anthropic", a, { ...credential, access: "synthetic-rotated" }), setAccountPaused("anthropic", a, true)]);
  let account = getAccountSet("anthropic")!.accounts.find(row => row.id === a)!;
  expect(account).toMatchObject({ autoSwitchThresholdOverride: 0, paused: true, credential: { access: "synthetic-rotated" } });
  await replaceProviderAccountSet("anthropic", getAccountSet("anthropic"));
  if (process.platform !== "win32") expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
  const child = Bun.spawnSync([process.execPath, "-e", `import { getAccountSet } from './src/oauth/store.ts'; console.log(getAccountSet('anthropic').accounts.find(a => a.id === ${JSON.stringify(a)}).autoSwitchThresholdOverride);`], { cwd: process.cwd(), env: process.env });
  expect(child.exitCode).toBe(0); expect(child.stdout.toString().trim()).toBe("0");
  await removeAccount("anthropic", a);
  expect(await setAnthropicAccountThreshold(a, 60)).toBe(false);
  expect(getAccountSet("anthropic")!.accounts.some(row => row.id === a)).toBe(false);
});

test("invalid persisted metadata normalizes to inherited without migrating other account state", async () => {
  const path = join(home, "auth.json"); const store = JSON.parse(readFileSync(path, "utf8"));
  store.anthropic.accounts[0].autoSwitchThresholdOverride = "0";
  writeFileSync(path, JSON.stringify(store));
  expect(getAccountSet("anthropic")!.accounts[0]!.autoSwitchThresholdOverride).toBeUndefined();
});

test("API validates provider, account, integer, missing and null; reads durable policy", async () => {
  const put = (body: unknown, cfg = config()) => handleAnthropicAccountThreshold(new Request("http://localhost/api/oauth/accounts/auto-switch", {
    method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), cfg);
  for (const threshold of [undefined, "50", -1, 101, 0.5, true, {}, []]) expect((await put({ provider: "anthropic", accountId: ids[0], threshold })).status).toBe(400);
  for (const threshold of [0, 100, null]) {
    const response = await put({ provider: "anthropic", accountId: ids[0], threshold });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ autoSwitchThresholdOverride: threshold, effectiveAutoSwitchThreshold: threshold ?? 80 });
  }
  expect((await put({ provider: "kiro", accountId: ids[0], threshold: 30 })).status).toBe(400);
  expect((await put({ provider: "anthropic", accountId: "missing", threshold: 30 })).status).toBe(404);
  const cfg = config(); cfg.providers.anthropic!.authMode = "api-key";
  expect((await put({ provider: "anthropic", accountId: ids[0], threshold: 30 }, cfg)).status).toBe(400);
  const fallback = config(); delete fallback.providers.anthropic;
  expect((await put({ provider: "anthropic", accountId: ids[0], threshold: 30 }, fallback)).status).toBe(200);
});

test("concurrent API writes each report its commit without assuming queue order", async () => {
  const put = (threshold: number) => handleAnthropicAccountThreshold(new Request("http://localhost/api/oauth/accounts/auto-switch", {
    method: "PUT", body: JSON.stringify({ provider: "anthropic", accountId: ids[0], threshold }),
    headers: { "content-type": "application/json" },
  }), config());
  const [first, second] = await Promise.all([put(30), put(70)]);
  expect(await first.json()).toMatchObject({ autoSwitchThresholdOverride: 30, effectiveAutoSwitchThreshold: 30 });
  expect(await second.json()).toMatchObject({ autoSwitchThresholdOverride: 70, effectiveAutoSwitchThreshold: 70 });
  expect([30, 70]).toContain(getAccountSet("anthropic")!.accounts.find(row => row.id === ids[0])?.autoSwitchThresholdOverride);
});

test("management dispatcher exposes the saved override/default/effective DTO without credentials", async () => {
  const cfg = config();
  const call = (req: Request) => handleOauthAccountRoutes({ req, url: new URL(req.url), config: cfg, deps: {} } as ManagementContext);
  const put = new Request("http://localhost/api/oauth/accounts/auto-switch", { method: "PUT", body: JSON.stringify({ provider: "anthropic", accountId: ids[0], threshold: 0 }) });
  expect((await call(put))?.status).toBe(200);
  cfg.anthropicAccountPool!.autoSwitchThreshold = 60;
  const response = await call(new Request("http://localhost/api/oauth/accounts?provider=anthropic"));
  const dto = await response!.json();
  expect(dto.accounts.find((row: { id: string }) => row.id === ids[0])).toMatchObject({ autoSwitchThresholdOverride: 0, effectiveAutoSwitchThreshold: 0, autoSwitchThreshold: 60 });
  expect(dto.accounts.find((row: { id: string }) => row.id === ids[1])).toMatchObject({ autoSwitchThresholdOverride: null, effectiveAutoSwitchThreshold: 60, autoSwitchThreshold: 60 });
  expect(JSON.stringify(dto)).not.toContain("synthetic");
});
