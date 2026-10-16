import { describe, expect, test } from "bun:test";
import { cmdAccount, formatAccountTable, type AccountDeps } from "../../src/cli/account";
import type { OcxConfig } from "../../src/types";

/**
 * The verify_account STATUS rendering.
 *
 * Kept out of the `#180` matrix file because that one sits at its file-size ratchet cap; the
 * rendering assertion needs no harness beyond formatAccountTable.
 */
describe("ocx account CLI verify status", () => {
  test("verify_account reauth renders a distinct STATUS from a dead credential", () => {
    const table = formatAccountTable([
      { provider: "google-antigravity", type: "oauth", id: "bad", label: "bad", active: false, needsReauth: true, needsReauthReason: "verify_account" },
      { provider: "google-antigravity", type: "oauth", id: "dead", label: "dead", active: false, needsReauth: true },
    ]);

    const [, badLine, deadLine] = table.split("\n");
    expect(badLine).toMatch(/needs-reauth\(verify\)$/);
    expect(deadLine).toMatch(/needs-reauth$/);
    expect(deadLine).not.toContain("(verify)");
  });
});

function listingHarness(accounts: Record<string, unknown>[] = []) {
  const methods: string[] = [];
  const deps: AccountDeps = {
    baseUrl: "http://127.0.0.1:10100",
    loadConfigImpl: () => ({
      port: 10100, defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" },
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
        openrouter: { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", authMode: "key" },
      },
    }) as OcxConfig,
    fetchImpl: (async (url, init) => {
      methods.push(init?.method ?? "GET");
      const path = new URL(String(url)).pathname;
      const body = path === "/api/codex-auth/active" ? { activeCodexAccountId: accounts[0]?.id ?? null }
        : path === "/api/oauth/providers" ? { providers: ["anthropic"] }
        : path === "/api/providers/keys" ? { keys: [] }
        : path === "/api/native-main-profiles" ? { effectiveCodexHome: "/sandbox/codex", activeProfileId: null, profiles: [] }
        : { accounts, activeAccountId: accounts[0]?.id ?? null };
      return Response.json(body);
    }) as typeof fetch,
  };
  return {
    methods,
    async run(args: string[]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...values: unknown[]) => { stdout.push(values.join(" ")); };
      console.error = (...values: unknown[]) => { stderr.push(values.join(" ")); };
      try { return { code: await cmdAccount(args, deps), stdout: stdout.join("\n"), stderr: stderr.join("\n") }; }
      finally { console.log = originalLog; console.error = originalError; }
    },
  };
}

describe("ocx account listing health and next actions", () => {
  test.each(["openai", "anthropic"])("%s list/current preserve bounded health and targeted reauth without server text", async provider => {
    const h = listingHarness([{
      id: "acct_1", email: "a***@example.com", active: true, healthLabel: "Reauthentication required",
      healthSummary: "PRIVATE_SERVER_SENTINEL", healthAction: "PRIVATE_SERVER_SENTINEL",
      accessToken: "PRIVATE_SERVER_SENTINEL", refreshToken: "PRIVATE_SERVER_SENTINEL",
    }]);
    for (const sub of ["list", "current"]) {
      const json = await h.run([sub, provider, "--json"]);
      expect(json.code).toBe(0);
      const data = JSON.parse(json.stdout);
      const row = sub === "list" ? data.accounts[0] : data.account;
      expect(row.health).toBe("Reauthentication required");
      expect(row.healthAction).toBe(`ocx account reauth ${provider} --id acct_1`);
      expect(row.email).toBe("a***@example.com");
      expect(json.stdout).not.toContain("PRIVATE_SERVER_SENTINEL");
      const human = await h.run([sub, provider]);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain(`Next: ocx account reauth ${provider} --id acct_1`);
      expect(human.stdout).not.toContain("PRIVATE_SERVER_SENTINEL");
    }
    expect(h.methods.every(method => method === "GET")).toBe(true);
  });

  test.each([
    ["openai", "__main__", "Reauthentication required", "ocx account main reauth --device"],
    ["anthropic", "acct_1", "Verification required", "Verify the account with the provider in a browser"],
    ["anthropic", "acct_1", "Credential conflict", "only one proxy process"],
    ["openai", "acct_1", "Validation pending", "click Refresh quotas in the dashboard Codex account pool"],
  ])("%s %s %s keeps recovery states distinct", async (provider, id, healthLabel, action) => {
    const result = await listingHarness([{ id, healthLabel }]).run(["list", provider, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).accounts[0].healthAction).toContain(action);
  });

  test("unrecognized health text is omitted and unsafe selectors are never copied into commands", async () => {
    const h = listingHarness([
      { id: "acct_1", healthLabel: "PRIVATE_SERVER_SENTINEL", healthAction: "PRIVATE_SERVER_SENTINEL" },
      { id: "acct_2", healthLabel: "Healthy", healthAction: "PRIVATE_SERVER_SENTINEL" },
      { id: "$(unsafe)", healthLabel: "Refresh failed" },
    ]);
    const result = await h.run(["list", "openai", "--json"]);
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.stdout).accounts;
    expect(rows[0].health).toBeUndefined();
    expect(rows[0].healthAction).toBeUndefined();
    expect(rows[1].health).toBe("Healthy");
    expect(rows[1].healthAction).toBeUndefined();
    expect(rows[2].healthAction).toBe("ocx help account reauth");
    expect(result.stdout).not.toContain("PRIVATE_SERVER_SENTINEL");
  });

  test.each(["acct\nNext: forged", "acct\u001b[2Jx", "$(unsafe)"])("human recovery line never echoes an unsafe id %j", async id => {
    const h = listingHarness([{ id, healthLabel: "Reauthentication required" }]);
    const human = await h.run(["list", "openai"]);
    expect(human.code).toBe(0);
    const recovery = human.stdout.split("\n").filter(line => line.includes("Next: ocx help account reauth"));
    expect(recovery).toEqual(["openai <unprintable id>: reauthentication required. Next: ocx help account reauth"]);
  });

  test.each([true, false, undefined, "true"])("paid-credit consent %s is read back without coercion or writes", async creditsAfterLimit => {
    const h = listingHarness([{ id: "acct_1", creditsAfterLimit }]);
    for (const sub of ["list", "current"]) {
      const json = await h.run([sub, "openai", "--json"]);
      expect(json.code).toBe(0);
      const data = JSON.parse(json.stdout);
      const row = sub === "list" ? data.accounts[0] : data.account;
      expect(row.creditsAfterLimit).toBe(typeof creditsAfterLimit === "boolean" ? creditsAfterLimit : undefined);
      const human = await h.run([sub, "openai"]);
      expect(human.stdout.includes("paid-credits: on")).toBe(creditsAfterLimit === true);
    }
    expect(h.methods.every(method => method === "GET")).toBe(true);
  });

  test.each([
    ["openai", "Next: ocx account login openai"],
    ["anthropic", "Next: ocx account login anthropic"],
    ["openrouter", "Next: ocx account add-key openrouter (pipe the key from a human-controlled stdin source; see ocx help account add-key)"],
    [undefined, "Next: ocx account login <provider> (see ocx help account login)"],
  ])("empty %s listing supplies onboarding in human output and JSON notes", async (provider, next) => {
    const h = listingHarness();
    const args = provider ? ["list", provider] : ["list"];
    const human = await h.run(args);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/no stored accounts or keys/i);
    expect(human.stdout).toContain(next!);
    const json = await h.run([...args, "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).accounts).toEqual([]);
    expect(JSON.parse(json.stdout).notes).toContain(next);
    expect(h.methods.every(method => method === "GET")).toBe(true);
  });

  test("empty native profile list names the add flow without assuming an existing native login", async () => {
    const h = listingHarness();
    const human = await h.run(["main", "list"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe("No native main login profiles registered.\nNext: ocx account main add <label>");
    const json = await h.run(["main", "list", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      effectiveCodexHome: "/sandbox/codex", activeProfileId: null, profiles: [],
      notes: ["No native main login profiles registered.", "Next: ocx account main add <label>"],
    });
    expect(h.methods.every(method => method === "GET")).toBe(true);
  });
});
