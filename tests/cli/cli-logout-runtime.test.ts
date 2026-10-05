import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { handleLogoutCommand, type LogoutCommandDeps } from "../../src/cli/logout-command";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const SECRET = "synthetic-private-value";
let home: TempHome;
let log: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let oldToken: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-logout-runtime-");
  writeFileSync(home.path("auth.json"), "untouched-store");
  oldToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  expect(readFileSync(home.path("auth.json"), "utf8")).toBe("untouched-store");
  expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain(SECRET);
  log.mockRestore(); error.mockRestore(); network.mockRestore();
  if (oldToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = oldToken;
  home.remove();
});
function fixture(reply: unknown = { success: true }, status = 200) {
  const store = new Set(["anthropic", "custom-provider"]);
  const calls: { url: string; method?: string; redirect?: RequestRedirect }[] = [];
  let mutations = 0, probes = 0;
  const deps: LogoutCommandDeps = {
    removeCredential: async provider => { mutations++; return store.delete(provider) ? "removed" : "not-found"; },
    findLiveProxy: async () => { probes++; return { port: 32000 + probes, hostname: "127.0.0.1", pid: 1, source: "runtime" }; },
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), method: init?.method, redirect: init?.redirect });
      if (reply instanceof Error) throw reply;
      return Response.json(reply, { status });
    }) as typeof fetch,
  };
  return { deps, store, calls, mutations: () => mutations, probes: () => probes };
}
const output = () => JSON.parse(log.mock.calls[0]![0] as string);

describe("logout explicit local/live target", () => {
  for (const provider of ["anthropic", "custom-provider"]) test(`${provider} local disposition comes from one mutation`, async () => {
    const f = fixture();
    expect(await handleLogoutCommand([provider, "--json"], f.deps)).toBe(0);
    expect(output()).toEqual({ schemaVersion: 1, ok: true, provider, removed: true });
    expect(f.store.has(provider)).toBe(false); expect(f.mutations()).toBe(1);
    expect(f.calls).toHaveLength(0); expect(f.probes()).toBe(0);
    log.mockClear();
    expect(await handleLogoutCommand([provider, "--json"], f.deps)).toBe(4);
    expect(output()).toEqual({ schemaVersion: 1, ok: false, provider, removed: false, reason: "not_found" });
    expect(f.mutations()).toBe(2);
  });
  test("two callers cannot both claim the same store removal", async () => {
    const f = fixture();
    expect(await Promise.all([handleLogoutCommand(["anthropic", "--json"], f.deps), handleLogoutCommand(["anthropic", "--json"], f.deps)])).toEqual([0, 4]);
    expect(f.mutations()).toBe(2);
  });
  test("local human not-found uses stderr and exit4", async () => {
    const f = fixture();
    expect(await handleLogoutCommand(["missing"], f.deps)).toBe(4);
    expect(log).not.toHaveBeenCalled(); expect(error.mock.calls[0]?.[0]).toBe("No stored credential for 'missing'.");
  });
  for (const args of [[], ["--json"], ["-j"], ["—json"], ["anthropic", "other"], ["anthropic", "--live", "--live"], ["anthropic", "--json", "--json"], ["anthropic", "--json=true"], ["anthropic", `--unknown=${SECRET}`], ["anthropic", "--live", "--id", "a"]]) {
    test(`invalid argv ${JSON.stringify(args).replace(SECRET, "REDACTED")} touches neither target`, async () => {
      const f = fixture();
      expect(await handleLogoutCommand(args, f.deps)).toBe(2);
      expect(f.mutations()).toBe(0); expect(f.probes()).toBe(0); expect(f.calls).toHaveLength(0);
    });
  }
  for (const provider of ["openai", "codex", "chatgpt", "custom-provider", "missing"]) test(`${provider} unsupported live logout refuses before any store or target`, async () => {
    const f = fixture();
    expect(await handleLogoutCommand([provider, "--live", "--json"], f.deps)).toBe(2);
    expect(f.mutations()).toBe(0); expect(f.probes()).toBe(0); expect(f.calls).toHaveLength(0);
  });
  for (const provider of ["anthropic", "github-copilot", "kiro"]) test(`${provider} live does one POST and reports only observed success`, async () => {
    const f = fixture({ success: true, removed: true, accessToken: SECRET });
    expect(await handleLogoutCommand([provider, "--live", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ url: `http://127.0.0.1:32001/api/oauth/logout?provider=${provider}`, method: "POST", redirect: "error" }]);
    expect(output()).toEqual({ schemaVersion: 1, success: true, provider, live: true });
    expect(f.mutations()).toBe(0); expect(f.probes()).toBe(1);
    expect(f.store.has("anthropic")).toBe(true);
  });
  for (const status of [400, 401, 403, 404, 409, 500, 503]) test(`HTTP ${status} cannot fall back or retry`, async () => {
    const f = fixture({ error: SECRET, token: SECRET }, status);
    expect(await handleLogoutCommand(["anthropic", "--live", "--json"], f.deps)).toBe(status === 404 ? 4 : status === 409 ? 5 : 1);
    expect(f.calls).toHaveLength(1); expect(f.mutations()).toBe(0); expect(log).not.toHaveBeenCalled();
    expect(f.store.has("anthropic")).toBe(true);
  });
  for (const reply of [{ success: false }, { ok: true }, { success: "true" }, null, [], new Error(SECRET)]) test(`unverified live reply ${JSON.stringify(reply)} is nonzero with no local fallback`, async () => {
    const f = fixture(reply);
    expect(await handleLogoutCommand(["anthropic", "--live", "--json"], f.deps)).toBe(1);
    expect(f.mutations()).toBe(0); expect(f.calls).toHaveLength(1); expect(log).not.toHaveBeenCalled();
  });
  test("runtime discovery failure touches no local credentials", async () => {
    const f = fixture();
    f.deps.findLiveProxy = async () => null;
    expect(await handleLogoutCommand(["anthropic", "--live", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(0); expect(f.mutations()).toBe(0);
  });
  test("local store exception stays private and never tries the proxy", async () => {
    const f = fixture();
    f.deps.removeCredential = async () => { throw new Error(SECRET); };
    expect(await handleLogoutCommand(["anthropic", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(0); expect(f.probes()).toBe(0); expect(log).not.toHaveBeenCalled();
  });
});
