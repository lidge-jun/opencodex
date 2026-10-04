import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { handleAccountAuthCommand } from "../../src/cli/account-auth";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const SECRET = "synthetic-private-value";
let home: TempHome;
let log: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>, sleep: ReturnType<typeof spyOn>;
let oldToken: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-login-options-");
  writeFileSync(home.path("auth.json"), "untouched-store");
  oldToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden"); });
  sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  expect(readFileSync(home.path("auth.json"), "utf8")).toBe("untouched-store");
  expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain(SECRET);
  log.mockRestore(); error.mockRestore(); network.mockRestore(); sleep.mockRestore();
  if (oldToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = oldToken;
  home.remove();
});
type Call = { url: string; method: string; redirect?: RequestRedirect; body?: unknown };
function fixture(replies: unknown[] = [{ url: "https://example.test/auth", flowId: "flow-1", browserLaunch: "skipped" }], httpStatus = 200) {
  const calls: Call[] = [];
  let probes = 0, reads = 0;
  const deps: RuntimeApiDeps = {
    stdinImpl: new Readable({ read() { reads++; this.push(`${SECRET}\n`); this.push(null); } }),
    findLiveProxy: async () => { probes++; return { port: 32000 + probes, hostname: "127.0.0.1", pid: 1, source: "runtime" }; },
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", redirect: init?.redirect, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const reply = replies[calls.length - 1];
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error("Unexpected request");
      return Response.json(reply, { status: httpStatus });
    }) as typeof fetch,
  };
  return { deps, calls, probes: () => probes, reads: () => reads };
}
const output = () => JSON.parse(log.mock.calls[0]![0] as string);

describe("login flow-specific options", () => {
  for (const provider of ["anthropic", "kiro", "kimi", "nous", "github-copilot"]) {
    for (const add of [undefined, "on", "off"]) test(`${provider} fresh add-account ${add ?? "omitted"}`, async () => {
      const f = fixture();
      expect(await handleAccountAuthCommand("login", [provider, ...(add ? ["--add-account", add] : []), "--no-wait", "--json"], f.deps)).toBe(0);
      expect(f.calls[0]?.body).toEqual({ provider, addAccount: add !== "off" });
      expect(f.reads()).toBe(0);
      expect(f.probes()).toBe(1);
      expect(f.calls[0]?.redirect).toBe("error");
    });
  }
  for (const browser of [undefined, "on", "off"]) {
    for (const provider of ["openai", "codex", "chatgpt", "anthropic"]) test(`${provider} browser ${browser ?? "omitted"}`, async () => {
      const f = fixture();
      expect(await handleAccountAuthCommand("login", [provider, ...(browser ? ["--open-browser", browser] : []), "--no-wait", "--json"], f.deps)).toBe(0);
      expect(f.calls[0]?.body).toEqual({ ...(provider === "anthropic" ? { provider, addAccount: true } : {}), ...(browser ? { openBrowser: browser === "on" } : {}) });
    });
  }
  test("reauth omission preserves its original payload", async () => {
    const f = fixture();
    expect(await handleAccountAuthCommand("reauth", ["anthropic", "--id", "account-1", "--no-wait", "--json"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ provider: "anthropic", addAccount: false, accountId: "account-1", reauth: true });
  });
  const invalid = [
    ["openai", "--add-account", "on"], ["codex", "--add-account", "off"],
    ["anthropic", "--reauth", "--add-account", "off"],
    ...["on", "off"].flatMap(value => [
      ["openai", "--device", "--open-browser", value],
      ...["kimi", "nous", "github-copilot"].map(p => [p, "--open-browser", value]),
      ["kiro", "--method", "google", "--open-browser", value],
      ["kiro", "--method", "builder-id", "--add-account", value],
    ]),
    ["anthropic", "--open-browser", "on", "--open-browser=off"],
    ["anthropic", "--add-account", "on", "--add-account", "off"],
    ["anthropic", "--open-browser", SECRET], ["anthropic", "--add-account", SECRET],
    ["anthropic", "--id", "account-1"], ["anthropic", "--json", "--json"],
  ];
  for (const [index, args] of invalid.entries()) test(`refusal ${index} precedes stdin and target discovery`, async () => {
    const f = fixture();
    expect(await handleAccountAuthCommand("login", [...args, "--code", "-"], f.deps)).toBe(2);
    expect(f.calls).toHaveLength(0); expect(f.probes()).toBe(0); expect(f.reads()).toBe(0);
  });
  test("Codex device omission preserves its device payload and public grant", async () => {
    const f = fixture([{ flowId: "flow-1", deviceCode: "USER-CODE", url: "https://example.test/verify", accessToken: SECRET }]);
    expect(await handleAccountAuthCommand("login", ["openai", "--device", "--no-wait", "--json"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ device: true });
    expect(output().deviceCode).toBe("USER-CODE");
    expect(output().accessToken).toBeUndefined();
  });
  test("Kiro native projection excludes its private device grant and credentials", async () => {
    const f = fixture([{ flowId: "flow-k", method: "google", state: "pending", userCode: "USER", verificationUri: "https://example.test/verify", expiresAt: 123, deviceCode: SECRET, clientSecret: SECRET, refreshToken: SECRET, error: SECRET }]);
    expect(await handleAccountAuthCommand("login", ["kiro", "--method", "google", "--no-wait", "--json"], f.deps)).toBe(0);
    expect(output()).toEqual({ flowId: "flow-k", method: "google", state: "pending", userCode: "USER", verificationUri: "https://example.test/verify", expiresAt: 123 });
  });
  for (const provider of ["openai", "anthropic"]) test(`${provider} start/code/poll stay pinned and never echo code`, async () => {
    const f = fixture([
      { flowId: "flow-1", url: "https://example.test/auth", refreshToken: SECRET },
      { ok: true, input: SECRET },
      { status: "done", loggedIn: true, done: true, accountId: "acct-1", email: "m***@example.test", accessToken: SECRET, refreshToken: SECRET, authorization: SECRET },
    ]);
    expect(await handleAccountAuthCommand("login", [provider, "--code", "-", "--json"], f.deps)).toBe(0);
    expect(f.probes()).toBe(1); expect(f.reads()).toBe(1); expect(f.calls).toHaveLength(3);
    expect(f.calls.every(c => c.url.startsWith("http://127.0.0.1:32001/") && c.redirect === "error")).toBe(true);
    expect(f.calls[1]?.body).toEqual(provider === "openai" ? { flowId: "flow-1", input: SECRET } : { provider, input: SECRET });
    expect(output().accountId).toBe("acct-1");
    if (provider === "openai") expect(output().flowId).toBe("flow-1");
  });
  for (const flag of ["validationPending", "catalogRefreshPending"]) test(`Codex ${flag} remains a nonzero partial result`, async () => {
    const f = fixture([{ flowId: "flow-1" }, { status: "done", accountId: "acct-1", [flag]: true, refreshToken: SECRET }]);
    expect(await handleAccountAuthCommand("login", ["openai", "--json"], f.deps)).toBe(1);
    expect(output()[flag]).toBe(true); expect(output().accountId).toBe("acct-1");
    expect(f.calls).toHaveLength(2);
  });
  for (const status of ["expired", "cancelled", "error"]) test(`Codex ${status} does not restart the flow`, async () => {
    const f = fixture([{ flowId: "flow-1" }, { status, error: SECRET }]);
    expect(await handleAccountAuthCommand("login", ["openai", "--json"], f.deps)).not.toBe(0);
    expect(f.calls).toHaveLength(2); expect(log).not.toHaveBeenCalled();
  });
  for (const status of [401, 403, 409, 503]) test(`HTTP ${status} admits no retry and hides raw errors`, async () => {
    const f = fixture([{ error: SECRET, detail: SECRET }], status);
    expect(await handleAccountAuthCommand("login", ["anthropic", "--no-wait", "--json"], f.deps)).toBe(status === 409 ? 5 : 1);
    expect(f.calls).toHaveLength(1); expect(log).not.toHaveBeenCalled();
  });
  test("transport failure is fixed and does not restart", async () => {
    const f = fixture([new Error(SECRET)]);
    expect(await handleAccountAuthCommand("login", ["anthropic", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1);
  });
  test("provider status projects nested accounts and omits arbitrary errors", async () => {
    const f = fixture([{}, { loggedIn: true, done: true, activeAccountId: "a", accounts: [{ id: "a", active: true, plan: null, credential: { accessToken: SECRET }, alias: "test", needsReauthReason: SECRET }], refreshToken: SECRET }]);
    expect(await handleAccountAuthCommand("login", ["anthropic", "--json"], f.deps)).toBe(0);
    expect(output().accounts).toEqual([{ id: "a", alias: "test", active: true, plan: null }]);
  });
  test("generic terminal failure does not poll or retry again", async () => {
    const f = fixture([{}, { loggedIn: false, done: true, error: SECRET }]);
    expect(await handleAccountAuthCommand("login", ["anthropic", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(2);
  });
});

describe("login terminal and code boundaries", () => {
  for (const state of ["done", "failed", "expired", "cancelled"]) test(`Kiro terminal ${state} preserves flow and does not restart`, async () => {
    const f = fixture([{ flowId: "flow-k", method: "github", state: "pending" }, { flowId: "flow-k", method: "github", state, warning: "duplicate_profile_arn", deviceCode: SECRET, error: SECRET }]);
    expect(await handleAccountAuthCommand("login", ["kiro", "--method", "github", "--json"], f.deps)).toBe(state === "done" ? 0 : 2);
    expect(f.calls).toHaveLength(2); expect(f.probes()).toBe(1);
    expect(f.calls[1]).toEqual({ url: "http://127.0.0.1:32001/api/oauth/status?provider=kiro&flowId=flow-k", method: "GET", redirect: "error" });
    if (state === "done") expect(output()).toEqual({ flowId: "flow-k", method: "github", state, warning: "duplicate_profile_arn" });
  });
  for (const provider of ["openai", "anthropic"]) test(`${provider} code refusal prevents success/poll/retry`, async () => {
    const f = fixture([{ flowId: "flow-1" }, { ok: false, error: SECRET }]);
    expect(await handleAccountAuthCommand("login", [provider, "--code", "-", "--no-wait", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(2); expect(log).not.toHaveBeenCalled();
  });
  test("Codex missing flow never silently discards submitted stdin code", async () => {
    const f = fixture([{ url: "https://example.test/auth" }]);
    expect(await handleAccountAuthCommand("login", ["openai", "--code", "-", "--no-wait", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1); expect(log).not.toHaveBeenCalled();
  });
  test("unknown login flag cannot echo credential-shaped input", async () => {
    const f = fixture();
    expect(await handleAccountAuthCommand("login", ["anthropic", `--unknown=${SECRET}`, "--code", "-"], f.deps)).toBe(2);
    expect(f.calls).toHaveLength(0); expect(f.reads()).toBe(0);
  });
  test("human instructions preserve intended lines but escape terminal controls", async () => {
    mkdirSync(home.codexHome, { recursive: true });
    const source = new URL("../../src/cli/account-auth.ts", import.meta.url).pathname;
    const script = `import {handleAccountAuthCommand} from ${JSON.stringify(source)};
      globalThis.fetch = async () => { throw new Error('Network forbidden'); };
      const result = await handleAccountAuthCommand('login', ['openai','--no-wait'], {
        baseUrl:'http://127.0.0.1:32100',
        fetchImpl: async () => Response.json({flowId:'flow-1',url:'https://example.test/auth',instructions:'First line\\nSecond line\\u001b[31m',accessToken:'${SECRET}'})
      }); process.exit(result ?? 1);`;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: home.root, env: { ...process.env, HOME: home.root }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(""); expect(exit).toBe(0);
    expect(stdout).toContain("First line\nSecond line");
    expect(stdout).not.toContain("\u001b"); expect(stdout).not.toContain(SECRET);
    expect(stdout).toContain("Flow: flow-1");
  });
});

describe("typed public login completion", () => {
  for (const value of [null, "false", 0, {}, []]) test(`malformed pending ${JSON.stringify(value)} cannot become completed success`, async () => {
    const f = fixture([{ flowId: "flow-1" }, { status: "done", validationPending: value }]);
    expect(await handleAccountAuthCommand("login", ["openai", "--json"], f.deps)).toBe(1);
    expect(log).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(2);
  });
  test("start cannot print a non-string handoff field", async () => {
    const f = fixture([{ url: { accessToken: SECRET }, flowId: "flow-1" }]);
    expect(await handleAccountAuthCommand("login", ["openai", "--no-wait", "--json"], f.deps)).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });
});
