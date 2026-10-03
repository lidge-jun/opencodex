import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { ACCOUNT_CAPABILITIES } from "../../src/cli/capabilities-accounts";
import { CAPABILITIES as BASE } from "../../src/cli/capabilities-base";
import { cmdAccount } from "../../src/cli/account";
import { cmdNativeMainAccount } from "../../src/cli/account-main";
import { handleAccountAuthCommand } from "../../src/cli/account-auth";
import type { AccountDeps } from "../../src/cli/account-api";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";

type Captured = { method: string; path: string; body?: unknown };
let home: TempHome;
let previousToken: string | undefined;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-capability-account-");
  previousToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  output.mockRestore(); errors.mockRestore();
  if (previousToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousToken;
  home.remove();
});

function fake(calls: Captured[], respond?: (call: Captured) => unknown): AccountDeps {
  const config: OcxConfig = { port: 1, defaultProvider: "openai", providers: {
    openai: { adapter: "openai-responses", baseUrl: "https://fixture.invalid", codexAccountMode: "pool" },
    anthropic: { adapter: "anthropic", baseUrl: "https://fixture.invalid", authMode: "oauth" },
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid", authMode: "key" },
  } };
  return {
    baseUrl: "http://127.0.0.1:1", loadConfigImpl: () => config,
    fetchImpl: (async (input, init) => {
      expect(new Headers(init?.headers).has("X-OpenCodex-API-Key")).toBe(false);
      const url = new URL(String(input));
      const call = { method: init?.method ?? "GET", path: url.pathname + url.search,
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) };
      calls.push(call);
      if (respond) return Response.json(respond(call));
      if (url.pathname === "/api/codex-auth/accounts") return Response.json({ accounts: [{ id: "acct-1", alias: "work" }, { id: "auto" }] });
      if (url.pathname === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: "acct-1" });
      if (url.pathname === "/api/oauth/accounts") return Response.json({ accounts: [{ id: "oauth-1", alias: "work", active: true }], activeAccountId: "oauth-1" });
      return Response.json({ ok: true });
    }) as typeof fetch,
    spawnCodexLoginImpl: () => { throw new Error("native login must never launch in discovery tests"); },
  };
}

function capability(key: string) {
  const row = ACCOUNT_CAPABILITIES.find(row => row.command.join(" ") === key);
  expect(row).toBeDefined();
  return row!;
}

describe("account discovery follows actual family-specific workflows", () => {
  test("logout documents the existing local grammar without executing credential removal", () => {
    const source = readFileSync(repoPath("src", "cli", "dispatch.ts"), "utf8");
    const usage = /console\.error\(`Usage: (ocx logout <provider> \[--json\])  /.exec(source)?.[1];
    expect(capability("logout").usage).toBe(usage);
    expect(capability("logout").routes).toEqual([]);
    expect(capability("logout").mutates).toBe(true);
    expect(capability("logout").json).toBe("envelope");
  });
  test("new leaves do not shadow baseline and every leaf has explicit usage", () => {
    const keys = ACCOUNT_CAPABILITIES.map(row => row.command.join(" "));
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of ACCOUNT_CAPABILITIES) {
      expect(BASE.some(base => base.command.join(" ") === row.command.join(" "))).toBe(false);
      expect(row.usage?.startsWith(`ocx ${row.command.join(" ")}`)).toBe(true);
    }
  });

  test("current reads OAuth accounts and projects an account envelope", async () => {
    expect(capability("account current").routes).toContainEqual({ method: "GET", path: "/api/oauth/accounts" });
    const calls: Captured[] = [];
    expect(await cmdAccount(["current", "anthropic", "--json"], fake(calls))).toBe(0);
    expect(calls).toEqual([{ method: "GET", path: "/api/oauth/accounts?provider=anthropic" }]);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ provider: "anthropic", type: "oauth", activeId: "oauth-1", account: { id: "oauth-1" } });
  });

  test("a real auto ID remains selectable while clear sends null without a roster read", async () => {
    expect(capability("account use").routes).toContainEqual({ method: "PUT", path: "/api/codex-auth/active" });
    expect(capability("account clear").routes).toEqual([{ method: "PUT", path: "/api/codex-auth/active" }]);
    const calls: Captured[] = [];
    expect(await cmdAccount(["use", "openai", "auto", "--json"], fake(calls))).toBe(0);
    expect(calls.filter(call => call.method === "PUT")).toEqual([{ method: "PUT", path: "/api/codex-auth/active", body: { accountId: "auto" } }]);
    calls.length = 0;
    expect(await cmdAccount(["clear", "openai", "--json"], fake(calls))).toBe(0);
    expect(calls).toEqual([{ method: "PUT", path: "/api/codex-auth/active", body: { accountId: null } }]);
  });

  test.each([
    { args: ["use", "anthropic", "oauth-1", "--json"], route: "/api/oauth/accounts/active", body: { provider: "anthropic", accountId: "oauth-1" } },
    { args: ["use", "fixture", "key-1", "--json"], route: "/api/providers/keys/active", body: { name: "fixture", id: "key-1" } },
    { args: ["alias", "fixture", "key-1", "-", "--json"], route: "/api/providers/keys/alias", body: { name: "fixture", id: "key-1", alias: "" } },
    { args: ["alias", "anthropic", "oauth-1", "label", "--json"], route: "/api/oauth/accounts/alias", body: { provider: "anthropic", accountId: "oauth-1", alias: "label" } },
    { args: ["alias", "openai", "work", "-", "--json"], route: "/api/codex-auth/accounts/alias", body: { id: "acct-1", alias: "" } },
    { args: ["priority", "openai", "work", "reset", "--json"], route: "/api/codex-auth/accounts/priority", body: { id: "acct-1", priority: null } },
  ])("$args uses the correct family body", async ({ args, route, body }) => {
    expect(capability(`account ${args[0]}`).routes).toContainEqual({ method: "PUT", path: route });
    const calls: Captured[] = [];
    expect(await cmdAccount(args, fake(calls))).toBe(0);
    expect(calls.filter(call => call.method === "PUT")).toEqual([{ method: "PUT", path: route, body }]);
  });

  test("cooldown resolves an Anthropic alias before its account-scoped write", async () => {
    expect(capability("account clear-cooldown").routes).toContainEqual({ method: "POST", path: "/api/oauth/accounts/clear-cooldown" });
    const calls: Captured[] = [];
    expect(await cmdAccount(["clear-cooldown", "anthropic", "WORK", "--json"], fake(calls))).toBe(0);
    expect(calls).toEqual([
      { method: "GET", path: "/api/oauth/accounts?provider=anthropic" },
      { method: "POST", path: "/api/oauth/accounts/clear-cooldown", body: { provider: "anthropic", accountId: "oauth-1" } },
    ]);
  });

  test.each([
    { key: "account main doctor", args: ["doctor", "--json"], route: "/api/native-main-profiles/doctor" },
    { key: "account main list", args: ["list", "--json"], route: "/api/native-main-profiles" },
    { key: "account main reauth status", args: ["reauth", "status", "--flow", "flow/id", "--json"], route: "/api/codex-auth/main/reauth-device?flowId=flow%2Fid" },
  ])("$key reads its own namespace", async ({ key, args, route }) => {
    expect(capability(key).routes).toEqual([{ method: "GET", path: route.split("?")[0] }]);
    expect(capability(key).mutates).toBe(false);
    const calls: Captured[] = [];
    expect(await cmdNativeMainAccount(args, fake(calls))).toBe(0);
    expect(calls).toEqual([{ method: "GET", path: route }]);
  });

  test("safe non-rollback recovery has its own explicit POST contract", async () => {
    expect(capability("account main recover").mutates).toBe(true);
    const calls: Captured[] = [];
    expect(await cmdNativeMainAccount(["recover", "--json"], fake(calls, () => ({ recovered: false })))).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: "/api/native-main-profiles/recover", body: { rollback: false } }]);
  });

  test("reset-credit reads never consume and map main to the native ID", async () => {
    expect(capability("account reset-credits").routes).toContainEqual({ method: "GET", path: "/api/codex-auth/reset-credits" });
    const calls: Captured[] = [];
    expect(await handleAccountAuthCommand("reset-credits", ["main", "--json"], fake(calls))).toBe(0);
    expect(calls).toEqual([{ method: "GET", path: "/api/codex-auth/reset-credits?accountId=__main__" }]);
  });

  test("deletion and physical-login writes refuse unsafe grammar before any request", async () => {
    const calls: Captured[] = [];
    const deps = fake(calls);
    expect(capability("account remove").flags.find(flag => flag.name === "--yes")?.required).toBe(true);
    expect(capability("account main switch").flags.find(flag => flag.name === "--yes")?.required).toBe(true);
    expect(capability("account main add").json).toBe("none");
    expect(await cmdAccount(["remove", "openai", "work", "--json"], deps)).not.toBe(0);
    expect(await cmdAccount(["remove", "openai", "main", "--yes", "--json"], deps)).not.toBe(0);
    expect(await cmdNativeMainAccount(["switch", "profile", "--json"], deps)).not.toBe(0);
    expect(await cmdNativeMainAccount(["recover", "--rollback", "--json"], deps)).not.toBe(0);
    expect(await cmdNativeMainAccount(["add", "profile", "--json"], deps)).not.toBe(0);
    expect(await cmdNativeMainAccount(["register"], deps)).not.toBe(0);
    expect(capability("account main register").usage).toBe("ocx account main register <label> [--json]");
    expect(calls).toEqual([]);
  });

  test("auth secrets, unsupported imports and spending stay behind safe refusal cases", async () => {
    const calls: Captured[] = [];
    const deps = fake(calls);
    expect(capability("account reauth").routes).toContainEqual({ method: "POST", path: "/api/codex-auth/login" });
    expect(await handleAccountAuthCommand("reauth", ["kiro", "--method", "builder-id", "--json"], deps)).not.toBe(0);
    expect(await handleAccountAuthCommand("cancel", ["openai", "--json"], deps)).not.toBe(0);
    expect(capability("account cancel").usage).toBe("ocx account cancel <provider> [--flow <flow-id>] [--json]");
    expect(await cmdNativeMainAccount(["reauth", "cancel", "--json"], deps)).not.toBe(0);
    expect(capability("account main reauth cancel").flags.find(flag => flag.name === "--flow")?.required).toBe(true);
    expect(await handleAccountAuthCommand("reset-credits", ["main", "--consume", "--json"], deps)).not.toBe(0);
    expect(capability("account import").usage).toContain("google-antigravity --format cockpit-tools");
    expect(await cmdAccount(["import", "unsupported", "--format", "cockpit-tools", "--file", home.path("nonexistent")], deps)).not.toBe(0);
    expect(capability("account add-key").routes).toEqual([{ method: "POST", path: "/api/providers/keys" }]);
    const stdin = Object.assign(Readable.from([]), { isTTY: true });
    expect(await cmdAccount(["add-key", "fixture", "--json"], { ...deps, stdinImpl: stdin })).not.toBe(0);
    expect(capability("account code").flags.find(flag => flag.name === "--code")?.value).toBe("string");
    expect(await handleAccountAuthCommand("code", ["openai", "--json"], { ...deps, stdinImpl: Readable.from([]) })).not.toBe(0);
    expect(calls).toEqual([]);
  });
});
