import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { handleAccountPolicyCommand } from "../../src/cli/account-policy";
import { cmdAutoSwitch, cmdRoutes } from "../../src/cli/account-extended";
import type { AccountDeps } from "../../src/cli/account-api";
import { unifiedPoolSettingsDto } from "../../src/oauth/pool-settings-capability";
import { createTempHome, type TempHome } from "../helpers/temp-home";
let home: TempHome;
let out: ReturnType<typeof spyOn>, err: ReturnType<typeof spyOn>;
beforeEach(() => { home = createTempHome("ocx-cli-anthropic2-"); out = spyOn(console, "log").mockImplementation(() => {}); err = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { out.mockRestore(); err.mockRestore(); home.remove(); });
const grants = { accountId: "same", eligible: false, ineligibleReason: "no_grant", atLimit: false, grants: [], nextGrantId: null, weeklyResetsAt: null, cooldownUntil: null, pendingOperation: null, journalAvailable: true };
test("reset status explicitly targets B and rejects A or missing identity", async () => {
  for (const provider of ["anthropic2", "anthropic", undefined]) {
    const calls: { url: URL; method: string }[] = [];
    const deps = { baseUrl: "http://127.0.0.1:10100", fetchImpl: (async (input, init) => { calls.push({ url: new URL(String(input)), method: init?.method ?? "GET" }); return Response.json({ ...grants, provider, secret: "PRIVATE" }); }) as typeof fetch };
    const code = await handleAccountPolicyCommand("anthropic-reset-grants", ["same", "--provider", "anthropic2", "--json"], deps);
    expect(code).toBe(provider === "anthropic2" ? 0 : 1);
    expect(calls).toHaveLength(1); expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.searchParams.get("provider")).toBe("anthropic2");
    expect(calls[0]!.url.searchParams.get("accountId")).toBe("same");
    expect(JSON.stringify(out.mock.calls)).not.toContain("PRIVATE"); out.mockClear();
  }
});
test("legacy reset remains A without a provider query; invalid providers make no request", async () => {
  const calls: string[] = [];
  const deps = { baseUrl: "http://127.0.0.1:10100", fetchImpl: (async input => { calls.push(String(input)); return Response.json(grants); }) as typeof fetch };
  expect(await handleAccountPolicyCommand("anthropic-reset-grants", ["--json"], deps)).toBe(0);
  expect(new URL(calls[0]!).search).toBe("");
  expect(await handleAccountPolicyCommand("anthropic-reset-grants", ["--provider", "anthropic3"], deps)).toBe(2);
  expect(calls).toHaveLength(1);
});
test("B pool keeps shared kind and sends B writes", async () => {
  const dto = unifiedPoolSettingsDto({ providers: {} }, "anthropic2", "anthropic");
  const calls: Record<string, unknown>[] = [];
  const deps = { baseUrl: "http://127.0.0.1:10100", fetchImpl: (async (_input, init) => {
    if (!init?.body) return Response.json(dto);
    const body = JSON.parse(String(init.body)); calls.push(body); return Response.json({ ...dto, ...body });
  }) as typeof fetch };
  expect(await handleAccountPolicyCommand("pool", ["anthropic2", "--threshold", "22", "--quota-window", "weekly", "--json"], deps)).toBe(0);
  expect(calls).toEqual([{ provider: "anthropic2", autoSwitchThreshold: 22, quotaWindow: "weekly" }]);
});
test("B threshold and route commands use B and reject a mismatched receipt", async () => {
  const calls: { url: string; body?: Record<string, unknown> }[] = []; let echoed = "anthropic2";
  const deps: AccountDeps = { baseUrl: "http://127.0.0.1:10100", loadConfigImpl: () => ({ providers: { anthropic2: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", anthropicOAuthInstance: "anthropic2" } } }),
    fetchImpl: (async (input, init) => { const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url: String(input), body }); return Response.json({ provider: echoed, accountId: "same", autoSwitchThresholdOverride: 9, effectiveAutoSwitchThreshold: 9, routes: null }); }) as typeof fetch };
  expect(await cmdAutoSwitch(["anthropic2", "threshold", "9", "--account", "same", "--json"], deps)).toBe(0);
  expect(calls[0]!.body).toEqual({ provider: "anthropic2", accountId: "same", threshold: 9 });
  echoed = "anthropic";
  expect(await cmdAutoSwitch(["anthropic2", "threshold", "9", "--account", "same"], deps)).not.toBe(0);
  expect(await cmdRoutes(["anthropic2", "--json"], deps)).not.toBe(0);
  expect(new URL(calls.at(-1)!.url).searchParams.get("provider")).toBe("anthropic2");
});
