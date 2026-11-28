import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdAccount, formatAccountTable, type AccountDeps } from "../../src/cli/account";
import { fetchRows } from "../../src/cli/account-api";
import { apiKeyQuotaText, projectApiKeyQuotaRows } from "../../src/cli/account-key-quota";
import { providerQuotaLine } from "../../src/cli/account-extended";
import { handleOauthAccountRoutes } from "../../src/server/management/oauth-account-routes";
import { getProviderQuotaReportCache } from "../../src/providers/quota/report-cache";
import * as quotaApi from "../../src/providers/quota";
import { readProviderApiKeyQuotas, clearProviderApiKeyQuotaCache } from "../../src/providers/quota-key-accounts";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home: string;
let logs: string[];
let errors: string[];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-cli-key-quota-"));
  process.env.OPENCODEX_HOME = home;
  logs = []; errors = [];
  logSpy = spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
  errorSpy = spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
  clearProviderApiKeyQuotaCache();
});
afterEach(() => {
  logSpy.mockRestore(); errorSpy.mockRestore();
  clearProviderApiKeyQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function config(name = "openrouter"): OcxConfig {
  return { port: 0, defaultProvider: name, providers: { [name]: {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "fixture-first", apiKeyPool: [{ id: "first", key: "fixture-first" }, { id: "second", key: "fixture-second" }],
  } } };
}
function row(extra: Record<string, unknown> = {}) {
  return { id: "first", masked: "fixt****irst", quotaMode: "probe", ...extra };
}
function body(keys: unknown[] = [row()]) { return { activeId: "first", keys }; }
function depsFor(reply: unknown): AccountDeps {
  return { baseUrl: "http://localhost:10100", loadConfigImpl: () => config(), fetchImpl: (async input => {
    const path = new URL(String(input)).pathname;
    return Response.json(path === "/api/oauth/providers" ? { providers: [] }
      : path === "/api/codex-auth/accounts" ? { accounts: [] }
      : path === "/api/codex-auth/active" ? { activeCodexAccountId: null } : reply);
  }) as typeof fetch };
}

test("unknown budget windows survive CLI projection and have no fabricated percentage", () => {
  const quota = { updatedAt: 1, unknownBudgetWindows: [{ label: "API budget (EDU)", resetAt: 1796083200000 }] };
  const result = projectApiKeyQuotaRows(body([row({ quota })]), "mistral");
  expect(apiKeyQuotaText(result.rows[0]!)).toContain("API budget (EDU) unknown");
  expect(providerQuotaLine("mistral", { provider: "mistral", quota })).toContain("API budget (EDU) unknown");
});

test("measured budget display details survive both CLI quota views", () => {
  const quota = { updatedAt: 1, customWindows: [
    { label: "API budget", displayLabel: "API budget (EUR 2.50 of EUR 20.00 used; EDU)", percent: 12.5 },
    { label: "Vibe budget", displayLabel: "Vibe budget (EUR 0.20 of EUR 10.00 used; EDU)", percent: 2 },
  ] };
  const result = projectApiKeyQuotaRows(body([row({ quota })]), "mistral");
  for (const text of [apiKeyQuotaText(result.rows[0]!), providerQuotaLine("mistral", { provider: "mistral", quota })]) {
    expect(text).toContain("API budget (EUR 2.50 of EUR 20.00 used; EDU)");
    expect(text).toContain("Vibe budget (EUR 0.20 of EUR 10.00 used; EDU)");
  }
});

test("display labels cannot inject terminal lines into CLI quota output", () => {
  const quota = { updatedAt: 1, customWindows: [{ label: "API budget", displayLabel: "budget\nunsafe", percent: 10 }] };
  const result = projectApiKeyQuotaRows(body([row({ quota })]), "mistral");
  for (const text of [apiKeyQuotaText(result.rows[0]!), providerQuotaLine("mistral", { provider: "mistral", quota })]) {
    expect(text).not.toContain("\n");
  }
  expect(() => projectApiKeyQuotaRows(body([row({ quota: { updatedAt: 1, customWindows: [{ label: "x", percent: 1, displayLabel: 4 }] } })]), "mistral")).toThrow("Malformed");
});

test("stable labels without a display label are safe in account refresh", () => {
  const quota = { updatedAt: 1, customWindows: [{ label: "budget\u001b[31m\nunsafe", percent: 10 }] };
  const text = providerQuotaLine("mistral", { provider: "mistral", quota });
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("\n");
});

test("account refresh strips terminal controls from unknown budget labels", async () => {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const report = { provider: "openrouter", quota: { unknownBudgetWindows: [{ label: `API budget${escape}]0;spoof${bell}` }] } };
  expect(await cmdAccount(["refresh", "openrouter"], depsFor({ reports: [report] }))).toBe(0);
  const output = logs.join("\n");
  expect(output).toContain("API budget");
  expect(output).toContain("unknown");
  expect(output).not.toContain(escape);
  expect(output).not.toContain(bell);
});

test("account refresh strips terminal controls from custom window labels", async () => {
  const escape = String.fromCharCode(27);
  const report = { provider: "openrouter", quota: { customWindows: [{ label: `window${escape}[2J`, percent: 12 }] } };
  expect(await cmdAccount(["refresh", "openrouter"], depsFor({ reports: [report] }))).toBe(0);
  const output = logs.join("\n");
  expect(output).toContain("window");
  expect(output).toContain("12%");
  expect(output).not.toContain(escape);
});

test("quota intent uses encoded fixed query and redirect:error only on opt-in", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const deps: AccountDeps = { ...depsFor(body()), loadConfigImpl: () => config("team/key +"),
    fetchImpl: (async (input, init) => { calls.push({ url: String(input), init }); return Response.json(body()); }) as typeof fetch };
  for (const args of [[], ["--refresh"], ["--quota"], ["--quota", "--refresh"]]) {
    expect(await cmdAccount(["list", "team/key +", ...args, "--json"], deps)).toBe(0);
  }
  expect(calls.map(c => new URL(c.url).search)).toEqual([
    "?name=team%2Fkey%20%2B", "?name=team%2Fkey%20%2B", "?name=team%2Fkey%20%2B&quota=1", "?name=team%2Fkey%20%2B&quota=1&refresh=1",
  ]);
  expect(calls.map(c => c.init?.redirect)).toEqual([undefined, undefined, "error", "error"]);
  expect(calls.every(c => c.init?.method === "GET" && c.init.body === undefined)).toBe(true);
});

test("projects every public quota field including zero and excludes private fields at every depth", async () => {
  const quota = { updatedAt: 0, fiveHourPercent: 0, fiveHourResetAt: 123, weeklyPercent: 5, weeklyResetAt: 456,
    monthlyPercent: 9, monthlyResetAt: 789, kiroCreditsUsed: 0, kiroCreditsLimit: 100,
    customWindows: [{ label: "family", percent: 0, resetAt: 0, scope: "model", passiveObservedAt: 0, rejected: true }],
    creditsUsd: { used: 0, limit: 10, remaining: 10, percent: 0, expiresAt: 0, unlimited: false } };
  const polluted = { ...quota, rawKey: "PRIVATE-CANARY", isCurrent: true, epoch: 42,
    customWindows: quota.customWindows.map(w => ({ ...w, rawKey: "PRIVATE-CANARY" })),
    creditsUsd: { ...quota.creditsUsd, rawKey: "PRIVATE-CANARY" } };
  expect(await cmdAccount(["list", "openrouter", "--quota", "--json"], depsFor(body([row({ quota: polluted, key: "PRIVATE-CANARY", epoch: 42 })])))).toBe(0);
  const output = JSON.parse(logs.join("\n"));
  expect(output.accounts[0].quota).toEqual(quota);
  expect(output.accounts[0].quotaMode).toBe("probe");
  expect(output.accounts[0].active).toBe(true);
  expect(logs.join("\n")).not.toContain("PRIVATE-CANARY");
  expect(logs.join("\n")).not.toContain("isCurrent");
  expect(logs.join("\n")).not.toContain("epoch");
});

test("empty pool works without quotaMode and legacy listing remains compatible", async () => {
  expect(await cmdAccount(["list", "openrouter", "--quota", "--json"], depsFor({ activeId: null, keys: [] }))).toBe(0);
  expect(JSON.parse(logs.pop()!).accounts).toEqual([]);
  expect(await cmdAccount(["list", "openrouter", "--json"], depsFor(body([{ id: "old" }])))).toBe(0);
  expect(JSON.parse(logs.pop()!).accounts[0].id).toBe("old");
});

test("nonempty older-server replies are unverified and fail explicit and fan-out opt-in lists", async () => {
  for (const target of [["openrouter"], []]) {
    logs.length = 0; errors.length = 0;
    expect(await cmdAccount(["list", ...target, "--quota", "--json"], depsFor(body([{ id: "old" }])))).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("unverified");
  }
});

test("malformed consumed envelopes and quota fields fail without printing arbitrary values", async () => {
  const malformed = [null, [], {}, { activeId: 1, keys: [] }, { activeId: null, keys: null },
    body([null]), body([row({ id: 5 })]), body([row({ active: "yes" })]), body([row({ masked: {} })]),
    body([row({ quotaMode: "PRIVATE-CANARY" })]), body([row({ quotaUnavailable: "no" })]),
    body([row({ quotaFailure: "PRIVATE-CANARY" })]), body([row({ quota: [] })]), body([row({ quota: {} })]),
    ...["0", null, "PRIVATE-CANARY"].map(value => body([row({ quota: { updatedAt: value } })])),
    body([row({ quota: { updatedAt: 0, weeklyPercent: null } })]),
    body([row({ quota: { updatedAt: 0, customWindows: {} } })]),
    ...[{ label: 4, percent: 0 }, { label: "x", percent: "0" }, { label: "x", percent: 0, resetAt: null },
      { label: "x", percent: 0, scope: "all" }, { label: "x", percent: 0, rejected: false },
      { label: "x", percent: 0, passiveObservedAt: "bad" }].map(w => body([row({ quota: { updatedAt: 0, customWindows: [w] } })])),
    body([row({ quota: { updatedAt: 0, creditsUsd: { used: 0, limit: 0, remaining: 0 } } })]),
    body([row({ quota: { updatedAt: 0, creditsUsd: { used: 0, limit: 0, remaining: 0, percent: 0, unlimited: "false" } } })]),
  ];
  for (const reply of malformed) for (const target of [["openrouter"], []]) {
    logs.length = 0; errors.length = 0;
    expect(await cmdAccount(["list", ...target, "--quota", "--json"], depsFor(reply))).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("Malformed");
    expect(errors.join("\n")).not.toContain("PRIVATE-CANARY");
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    expect(() => projectApiKeyQuotaRows(body([row({ quota: { updatedAt: value } })]), "openrouter")).toThrow("Malformed");
    expect(() => projectApiKeyQuotaRows(body([row({ quota: { updatedAt: 0, creditsUsd: { used: value, limit: 0, remaining: 0, percent: 0 } } })]), "openrouter")).toThrow("Malformed");
    expect(() => projectApiKeyQuotaRows(body([row({ quota: { updatedAt: 0, customWindows: [{ label: "x", percent: value }] } })]), "openrouter")).toThrow("Malformed");
  }
});

test("human quota distinguishes unsupported, unmeasured, unavailable, passive and real zero", () => {
  const rows = projectApiKeyQuotaRows(body([
    row({ quotaMode: "unsupported" }), row(), row({ quota: null }),
    row({ quotaUnavailable: true, quota: null, quotaFailure: "timeout" }),
    row({ quotaMode: "passive" }), row({ quotaMode: "passive", quota: { updatedAt: 0, weeklyPercent: 0 } }),
    row({ quota: { updatedAt: 0, monthlyPercent: 0, kiroCreditsUsed: 0, kiroCreditsLimit: 100,
      customWindows: [{ label: "budget\nline", percent: 0 }], creditsUsd: { used: 0, limit: 10, remaining: 10, percent: 0 } } }),
  ]), "openrouter").rows;
  const text = formatAccountTable(rows, true);
  for (const expected of ["unsupported", "probe: not measured", "probe: unavailable (timeout)", "passive: not measured", "passive: wk 0%", "mo 0%", "USD 0/10 used; 10 remaining (0%)", "credits 0/100"]) expect(text).toContain(expected);
  expect(text.split("\n")).toHaveLength(rows.length + 1);
  expect(formatAccountTable(rows)).not.toContain("QUOTA");
});

function handlerDeps(fixture: OcxConfig): AccountDeps {
  return { baseUrl: "http://localhost:10100", loadConfigImpl: () => fixture, fetchImpl: (async (input, init) => {
    const req = new Request(String(input), init);
    const response = await handleOauthAccountRoutes({ req, url: new URL(req.url), config: fixture, version: "test", deps: {},
      convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }), syncClaudeAgentDefsBestEffort: async () => {} });
    if (!response) throw new Error("unhandled fixture route");
    return response;
  }) as typeof fetch };
}

test("actual handler and synthetic probe preserve opt-in cache/refresh and current/removed/replaced identities", async () => {
  const fixture = config();
  let probes = 0;
  let race: "none" | "remove" | "replace" = "none";
  const quotaSpy = spyOn(quotaApi, "fetchProviderApiKeyQuotas").mockImplementation((c, name, force) =>
    readProviderApiKeyQuotas(c, name, force ?? false, async provider => {
      probes++;
      if (provider.apiKey === "fixture-second" && race === "remove") fixture.providers.openrouter.apiKeyPool!.splice(1, 1);
      if (provider.apiKey === "fixture-first" && race === "replace") fixture.providers.openrouter.apiKeyPool![0]!.key = "fixture-replaced";
      return { kind: "quota", quota: { updatedAt: Date.now(), weeklyPercent: provider.apiKey === "fixture-first" ? 0 : 60 } };
    }));
  try {
    const deps = handlerDeps(fixture);
    const original = JSON.stringify(fixture);
    const aggregateCache = JSON.stringify(getProviderQuotaReportCache());
    for (const flags of [[], ["--refresh"]]) expect(await cmdAccount(["list", "openrouter", ...flags, "--json"], deps)).toBe(0);
    expect(probes).toBe(0);
    for (const expected of [2, 2, 4]) {
      expect(await cmdAccount(["list", "openrouter", "--quota", ...(expected === 4 ? ["--refresh"] : []), "--json"], deps)).toBe(0);
      expect(probes).toBe(expected);
      const accounts = JSON.parse(logs.pop()!).accounts;
      expect(accounts.map((r: { quota: { weeklyPercent: number } }) => r.quota.weeklyPercent)).toEqual([0, 60]);
    }
    expect(JSON.stringify(fixture)).toBe(original);
    race = "remove";
    expect(await cmdAccount(["list", "openrouter", "--quota", "--refresh", "--json"], deps)).toBe(0);
    expect(JSON.parse(logs.pop()!).accounts.map((r: { id: string }) => r.id)).toEqual(["first"]);
    race = "replace";
    expect(await cmdAccount(["list", "openrouter", "--quota", "--refresh", "--json"], deps)).toBe(0);
    const output = logs.pop()!;
    const account = JSON.parse(output).accounts[0];
    expect(account.id).toBe("first"); expect(account.quota).toBeNull(); expect(account.quotaUnavailable).toBe(true);
    expect(output).not.toContain("weeklyPercent");
    expect(output).not.toContain("fixture-replaced"); expect(output).not.toContain("fixture-first");
    expect(output).not.toContain("isCurrent"); expect(output).not.toContain("epoch");
    expect(JSON.stringify(getProviderQuotaReportCache())).toBe(aggregateCache);
  } finally { quotaSpy.mockRestore(); }
});

test("actual unsupported destination never invokes quota probe", async () => {
  const fixture = config(); fixture.providers.openrouter.baseUrl = "https://example.invalid";
  const probe = spyOn(quotaApi, "fetchProviderApiKeyQuotas");
  try {
    expect(await cmdAccount(["list", "openrouter", "--quota", "--refresh", "--json"], handlerDeps(fixture))).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(JSON.parse(logs.pop()!).accounts.map((r: { quotaMode: string }) => r.quotaMode)).toEqual(["unsupported", "unsupported"]);
  } finally { probe.mockRestore(); }
});

test("quota GET refuses a real redirect before the destination receives credentials", async () => {
  let hits = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return Response.json(body()); } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${destination.port}/destination`) });
  try {
    const result = await fetchRows({}, `http://127.0.0.1:${source.port}`, "openrouter", "api-key", {});
    expect(result.networkDown).toBe(true); expect(hits).toBe(0);
  } finally { source.stop(true); destination.stop(true); }
});


test("absence, explicit null and unavailable last-good remain distinct in JSON", async () => {
  const keys = [row(), row({ quota: null }), row({ quota: { updatedAt: 1, weeklyPercent: 7 }, quotaUnavailable: true })];
  expect(await cmdAccount(["list", "openrouter", "--quota", "--json"], depsFor(body(keys)))).toBe(0);
  const accounts = JSON.parse(logs.pop()!).accounts;
  expect(Object.hasOwn(accounts[0], "quota")).toBe(false);
  expect(accounts[1].quota).toBeNull();
  expect(accounts[2].quota).toEqual({ updatedAt: 1, weeklyPercent: 7 });
  expect(accounts[2].quotaUnavailable).toBe(true);
  expect(formatAccountTable(projectApiKeyQuotaRows(body(keys), "openrouter").rows, true)).toContain("probe: unavailable");
});

test("quota key rows keep the pause flag and only known pause details", () => {
  const rows = projectApiKeyQuotaRows(body([
    row({ disabled: true, pauseDetails: { reason: "subscription_expired", pausedAt: 1 } }),
    row({ id: "second", disabled: true, pauseDetails: { reason: "reason_from_a_newer_proxy", pausedAt: 2 } }),
    row({ id: "third" }),
  ]), "openrouter").rows;
  expect(rows[0]).toMatchObject({ paused: true, pauseDetails: { reason: "subscription_expired", pausedAt: 1 } });
  expect(rows[1]!.paused).toBe(true);
  expect(rows[1]!.pauseDetails).toBeUndefined();
  expect(rows[2]!.paused).toBe(false);
});

test("#8397 unsupported keys say why the balance is unknown and carry no value", async () => {
  const fixture = config(); fixture.providers.openrouter.baseUrl = "https://example.invalid";
  const deps = handlerDeps(fixture);
  const cheap = await (await deps.fetchImpl!("http://localhost:10100/api/providers/keys?name=openrouter")).json();
  expect(cheap.keys.map((key: { quotaUnknownReason?: string }) => key.quotaUnknownReason)).toEqual(["no_balance_source", "no_balance_source"]);
  expect(await cmdAccount(["list", "openrouter", "--quota", "--json"], deps)).toBe(0);
  for (const account of JSON.parse(logs.pop()!).accounts) {
    expect(account).toMatchObject({ quotaMode: "unsupported", quotaUnknownReason: "no_balance_source" });
    expect(Object.hasOwn(account, "quota")).toBe(false);
    expect(Object.hasOwn(account, "quotaReadAt")).toBe(false);
  }
  expect(await cmdAccount(["list", "openrouter", "--quota"], deps)).toBe(0);
  const text = logs.join("\n");
  expect(text).toContain("balance UNKNOWN (no balance source)");
  expect(text).not.toMatch(/\b0%/);
});

test("#8397 probe rows report when the balance was read, and read_failed when the read failed", async () => {
  const fixture = config();
  const before = Date.now();
  const quotaSpy = spyOn(quotaApi, "fetchProviderApiKeyQuotas").mockImplementation((c, name, force) =>
    readProviderApiKeyQuotas(c, name, force ?? false, async provider => provider.apiKey === "fixture-first"
      ? { kind: "quota", quota: { updatedAt: Date.now(), monthlyPercent: 0 } }
      : { kind: "unavailable" }));
  try {
    const deps = handlerDeps(fixture);
    expect(await cmdAccount(["list", "openrouter", "--quota", "--json"], deps)).toBe(0);
    const [ok, failed] = JSON.parse(logs.pop()!).accounts;
    expect(ok.quota.monthlyPercent).toBe(0);
    expect(ok.quotaReadAt).toBeGreaterThanOrEqual(before);
    expect(Object.hasOwn(ok, "quotaUnknownReason")).toBe(false);
    expect(failed).toMatchObject({ quota: null, quotaUnavailable: true, quotaUnknownReason: "read_failed" });
    expect(failed.quotaReadAt).toBeGreaterThanOrEqual(before);
    expect(await cmdAccount(["list", "openrouter", "--quota"], deps)).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain("probe: mo 0%; read just now");
    expect(text).toContain("probe: unavailable; balance UNKNOWN (read failed); read just now");
  } finally { quotaSpy.mockRestore(); }
});

test("#8397 human text gives the reason and the age of the last read; unknown reasons are dropped", () => {
  const now = Date.now();
  const rows = projectApiKeyQuotaRows(body([
    row({ quotaMode: "unsupported", quotaUnknownReason: "no_balance_source" }),
    row({ quota: { updatedAt: now - 180_000, monthlyPercent: 12 }, quotaReadAt: now - 180_000 }),
    row({ quota: null, quotaUnavailable: true, quotaFailure: "timeout", quotaUnknownReason: "read_failed", quotaReadAt: now - 2 * 3_600_000 }),
    row({ quotaMode: "passive", quotaUnknownReason: "passive_not_observed" }),
    row({ quotaMode: "unsupported", quotaUnknownReason: "reason_from_a_newer_proxy" }),
    row({ quota: null, quotaUnavailable: true, quotaUnknownReason: "not_read" }),
    row({ quota: null, quotaUnknownReason: "not_reported", quotaReadAt: now - 60_000 }),
  ]), "openrouter").rows;
  expect(rows[0]).toMatchObject({ quotaUnknownReason: "no_balance_source" });
  expect(rows[1]).toMatchObject({ quotaReadAt: now - 180_000 });
  expect(rows[4]!.quotaUnknownReason).toBeUndefined();
  const lines = formatAccountTable(rows, true).split("\n");
  expect(lines[1]).toContain("unsupported: balance UNKNOWN (no balance source)");
  expect(lines[2]).toContain("probe: mo 12%; read 3 min ago");
  expect(lines[3]).toContain("probe: unavailable (timeout); balance UNKNOWN (read failed); read 2 h ago");
  expect(lines[4]).toContain("passive: balance UNKNOWN (not observed yet)");
  expect(lines[5]).toContain("unsupported: balance UNKNOWN (no balance source)");
  expect(lines[6]).toContain("probe: unavailable; balance UNKNOWN (not read)");
  expect(lines[7]).toContain("probe: balance UNKNOWN (provider reported none); read 1 min ago");
  for (const line of [lines[1], lines[3], lines[4], lines[5], lines[6], lines[7]]) expect(line).not.toMatch(/\b0%|USD 0/);
  // Display-only: a malformed read time is dropped, not fatal to the listing.
  expect(Object.hasOwn(projectApiKeyQuotaRows(body([row({ quotaReadAt: "yesterday" })]), "openrouter").rows[0]!, "quotaReadAt")).toBe(false);
});

