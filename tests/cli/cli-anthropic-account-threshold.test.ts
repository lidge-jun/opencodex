import { expect, test } from "bun:test";
import { cmdAutoSwitch } from "../../src/cli/account-extended";
import type { AccountDeps } from "../../src/cli/account-api";

test("Anthropic CLI writes explicit account policy and resets inheritance", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const deps: AccountDeps = { baseUrl: "http://127.0.0.1:10100",
    loadConfigImpl: () => ({ providers: { anthropic: { adapter: "anthropic", authMode: "oauth" } } }) as never,
    fetchImpl: (async (url, init) => {
      const body = JSON.parse(String(init?.body)); calls.push({ path: new URL(String(url)).pathname, body });
      return Response.json({ autoSwitchThresholdOverride: body.threshold, effectiveAutoSwitchThreshold: body.threshold ?? 80 });
    }) as typeof fetch };
  const log = console.log; const error = console.error; const output: string[] = [];
  console.log = value => { output.push(String(value)); }; console.error = () => {};
  try {
    for (const [action, value] of [["off", 0], ["on", 80], ["inherit", null]] as const) {
      expect(await cmdAutoSwitch(["anthropic", action, "--account", "a", "--json"], deps)).toBe(0);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ accountId: "a", autoSwitchThresholdOverride: value });
      expect(calls.at(-1)).toEqual({ path: "/api/oauth/accounts/auto-switch", body: { provider: "anthropic", accountId: "a", threshold: value } });
    }
    expect(await cmdAutoSwitch(["anthropic", "threshold", "100", "--account", "a"], deps)).toBe(0);
    const count = calls.length;
    for (const args of [["threshold", "101"], ["threshold", "1.5"], ["threshold", "-1"], ["inherit", "extra"]]) {
      expect(await cmdAutoSwitch(["anthropic", ...args, "--account", "a"], deps)).toBe(2);
    }
    expect(await cmdAutoSwitch(["anthropic", "off"], deps)).toBe(2);
    expect(calls.length).toBe(count);
  } finally { console.log = log; console.error = error; }
});

test("status is read-only and reports inheritance instead of guessing on an old proxy", async () => {
  const calls: string[] = []; let supported = true;
  const deps: AccountDeps = { baseUrl: "http://127.0.0.1:10100",
    loadConfigImpl: () => ({ providers: { anthropic: { adapter: "anthropic", authMode: "oauth" } } }) as never,
    fetchImpl: (async (_url, init) => { calls.push(init?.method ?? "GET"); return Response.json({ accounts: [{ id: "a",
      ...(supported ? { autoSwitchThresholdOverride: null, effectiveAutoSwitchThreshold: 65 } : {}) }] }); }) as typeof fetch };
  const log = console.log; const error = console.error; const output: string[] = [];
  console.log = value => { output.push(String(value)); }; console.error = () => {};
  try {
    expect(await cmdAutoSwitch(["anthropic", "status", "--account", "a", "--json"], deps)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ autoSwitchThresholdOverride: null, effectiveAutoSwitchThreshold: 65 });
    supported = false;
    expect(await cmdAutoSwitch(["anthropic", "status", "--account", "a"], deps)).not.toBe(0);
    expect(calls).toEqual(["GET", "GET"]);
  } finally { console.log = log; console.error = error; }
});

test("malformed status responses fail without throwing or displaying an invented threshold", async () => {
  const log = console.log; const error = console.error; console.log = () => {}; console.error = () => {};
  try {
    for (const body of [null, [], {}, { accounts: [{ id: "a", autoSwitchThresholdOverride: null }] }]) {
      const deps: AccountDeps = { baseUrl: "http://127.0.0.1:10100",
        loadConfigImpl: () => ({ providers: { anthropic: { adapter: "anthropic", authMode: "oauth" } } }) as never,
        fetchImpl: (async () => Response.json(body)) as typeof fetch };
      expect(await cmdAutoSwitch(["anthropic", "status", "--account", "a"], deps)).not.toBe(0);
    }
  } finally { console.log = log; console.error = error; }
});
