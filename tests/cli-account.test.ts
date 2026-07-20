import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { cmdAccount, classifyAccount, formatAccountTable, type AccountDeps } from "../src/cli/account";
import type { AccountStdin } from "../src/cli/account-api";
import { printSubcommandUsage } from "../src/cli/help";
import type { OcxConfig } from "../src/types";

const RAW_SENTINEL = "sk-rawsentinel1234567890";
const MASKED_SENTINEL = "sk-ra****7890";

interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body?: unknown;
}

interface MockFailure {
  status: number;
  error: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let activeCodexAccountId: string | null = "chatgpt_1";
let autoSwitchThreshold = 80;
let activeReadFailure: { status: number; error: string } | null = null;
let oauthListFailure: { provider: string; status: number; error: string } | null = null;
let keyListFailure: { provider: string; status: number; error: string } | null = null;
let codexRefreshFailure: MockFailure | null = null;
let autoSwitchUpdateFailure: MockFailure | null = null;
let deleteFailure: MockFailure | null = null;
let postDeleteReadFailure: MockFailure | null = null;
let addKeyFailure: MockFailure | null = null;
let lastDeletedType: "codex" | "oauth" | "api-key" | null = null;
let codexAccounts: Array<Record<string, unknown>> = [];
let oauthAccounts: Array<Record<string, unknown>> = [];
let oauthActiveId: string | null = "acct_1";
let keyEntries: Array<Record<string, unknown>> = [];
let keyActiveId: string | null = "key_1";
let logs: string[] = [];
let errors: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;
const requests: RecordedRequest[] = [];

function fixtureConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
      },
      kiro: {
        adapter: "anthropic",
        baseUrl: "https://q.us-east-1.amazonaws.com",
        authMode: "oauth",
      },
      "github-copilot": {
        adapter: "openai-chat",
        baseUrl: "https://api.githubcopilot.com",
        authMode: "oauth",
      },
      openrouter: {
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        authMode: "key",
        apiKey: RAW_SENTINEL,
      },
      ollama: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        authMode: "local",
        apiKey: RAW_SENTINEL,
      },
      "forward-custom": {
        adapter: "openai-chat",
        baseUrl: "https://forward.invalid/v1",
        authMode: "forward",
      },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function mockManagementApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const body = req.method === "PUT" || req.method === "POST" ? await req.json() : undefined;
  requests.push({ method: req.method, path: url.pathname, search: url.search, body });

  if (req.method === "GET" && url.pathname === "/api/codex-auth/accounts") {
    if (url.searchParams.get("refresh") === "1" && codexRefreshFailure) {
      return json({ error: codexRefreshFailure.error }, codexRefreshFailure.status);
    }
    if (lastDeletedType === "codex" && postDeleteReadFailure) {
      return json({ error: postDeleteReadFailure.error }, postDeleteReadFailure.status);
    }
    return json({ accounts: codexAccounts });
  }

  if (req.method === "DELETE" && url.pathname === "/api/codex-auth/accounts") {
    if (deleteFailure) return json({ error: deleteFailure.error }, deleteFailure.status);
    const id = url.searchParams.get("id");
    codexAccounts = codexAccounts.filter(account => account.id !== id);
    if (activeCodexAccountId === id) activeCodexAccountId = null;
    lastDeletedType = "codex";
    return json({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/active") {
    if (req.method === "PUT") {
      const accountId = (body as { accountId?: string }).accountId;
      activeCodexAccountId = accountId ?? null;
      return json({ ok: true, activeCodexAccountId });
    }
    if (req.method === "GET") {
      if (activeReadFailure) return json({ error: activeReadFailure.error }, activeReadFailure.status);
      return json({ activeCodexAccountId, autoSwitchThreshold });
    }
  }

  if (req.method === "PUT" && url.pathname === "/api/codex-auth/auto-switch") {
    if (autoSwitchUpdateFailure) {
      return json({ error: autoSwitchUpdateFailure.error }, autoSwitchUpdateFailure.status);
    }
    autoSwitchThreshold = (body as { threshold: number }).threshold;
    return json({ ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/oauth/providers") {
    return json({ providers: ["anthropic", "kiro", "xai"] });
  }

  if (req.method === "GET" && url.pathname === "/api/provider-quotas") {
    return json({
      generatedAt: Date.now(),
      reports: [{
        provider: "anthropic",
        label: "Anthropic",
        source: "anthropic:usage",
        quota: { fiveHourPercent: 31, fiveHourResetAt: 1_800_000_000, updatedAt: 1_700_000_000 },
        updatedAt: 1_700_000_000,
      }],
    });
  }

  if (req.method === "GET" && url.pathname === "/api/oauth/accounts") {
    const provider = url.searchParams.get("provider");
    if (oauthListFailure?.provider === provider) {
      return json({ error: oauthListFailure.error }, oauthListFailure.status);
    }
    if (provider === "anthropic" && lastDeletedType === "oauth" && postDeleteReadFailure) {
      return json({ error: postDeleteReadFailure.error }, postDeleteReadFailure.status);
    }
    if (provider === "anthropic") {
      return json({ activeAccountId: oauthActiveId, accounts: oauthAccounts.map(account => ({
        ...account,
        active: account.id === oauthActiveId,
      })) });
    }
    if (provider === "kiro") {
      return json({
        activeAccountId: "kiro_1",
        accounts: [{ id: "kiro_1", email: "k***@example.com", active: true }],
      });
    }
    return json({ activeAccountId: null, accounts: [] });
  }

  if (req.method === "PUT" && url.pathname === "/api/oauth/accounts/active") {
    const accountId = (body as { accountId?: string }).accountId;
    if (accountId === "nope") {
      return json({ error: "anthropic account nope was not found" }, 404);
    }
    return json({ ok: true, activeAccountId: accountId });
  }

  if (req.method === "DELETE" && url.pathname === "/api/oauth/accounts") {
    if (deleteFailure) return json({ error: deleteFailure.error }, deleteFailure.status);
    const id = url.searchParams.get("id");
    oauthAccounts = oauthAccounts.filter(account => account.id !== id);
    if (oauthActiveId === id) oauthActiveId = (oauthAccounts[0]?.id as string | undefined) ?? null;
    lastDeletedType = "oauth";
    return json({ ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/providers/keys") {
    const provider = url.searchParams.get("name");
    if (keyListFailure?.provider === provider) {
      return json({ error: keyListFailure.error }, keyListFailure.status);
    }
    if (provider === "openrouter" && lastDeletedType === "api-key" && postDeleteReadFailure) {
      return json({ error: postDeleteReadFailure.error }, postDeleteReadFailure.status);
    }
    if (provider === "openrouter") {
      return json({ activeId: keyActiveId, keys: keyEntries.map(entry => ({
        ...entry,
        active: entry.id === keyActiveId,
      })) });
    }
    return json({ error: "provider key pool not found" }, 404);
  }

  if (req.method === "PUT" && url.pathname === "/api/providers/keys/active") {
    return json({ ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/providers/keys") {
    if (addKeyFailure) return json({ error: addKeyFailure.error }, addKeyFailure.status);
    const payload = body as { key: string; label?: string };
    const id = "key_added";
    keyEntries.push({ id, label: payload.label, masked: "sk-te****cdef" });
    keyActiveId = id;
    return json({ ok: true, id }, 201);
  }

  if (req.method === "DELETE" && url.pathname === "/api/providers/keys") {
    if (deleteFailure) return json({ error: deleteFailure.error }, deleteFailure.status);
    const id = url.searchParams.get("id");
    keyEntries = keyEntries.filter(entry => entry.id !== id);
    if (keyActiveId === id) keyActiveId = (keyEntries[0]?.id as string | undefined) ?? null;
    lastDeletedType = "api-key";
    return json({ ok: true });
  }

  return json({ error: `unhandled mock endpoint: ${req.method} ${url.pathname}` }, 404);
}

function defaultDeps(): AccountDeps {
  return { baseUrl, loadConfigImpl: fixtureConfig };
}

function stdinFrom(value: string, isTTY = false): AccountStdin {
  const input = Readable.from([value]) as AccountStdin;
  input.isTTY = isTTY;
  return input;
}

async function run(args: string[], deps: AccountDeps = defaultDeps()): Promise<CommandResult> {
  logs.length = 0;
  errors.length = 0;
  const code = await cmdAccount(args, deps);
  const stdout = logs.join("\n");
  const stderr = errors.join("\n");
  return { code, stdout, stderr, output: [stdout, stderr].filter(Boolean).join("\n") };
}

beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: mockManagementApi });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  activeCodexAccountId = "chatgpt_1";
  autoSwitchThreshold = 80;
  activeReadFailure = null;
  oauthListFailure = null;
  keyListFailure = null;
  codexRefreshFailure = null;
  autoSwitchUpdateFailure = null;
  deleteFailure = null;
  postDeleteReadFailure = null;
  addKeyFailure = null;
  lastDeletedType = null;
  codexAccounts = [
    {
      id: "__main__",
      email: "m***@example.com",
      plan: "plus",
      isMain: true,
      quota: {
        weeklyPercent: 42,
        monthlyPercent: 17,
        weeklyResetAt: 1_800_000_000,
        monthlyResetAt: 1_900_000_000,
      },
    },
    { id: "chatgpt_1", email: "j***@example.com", plan: "pro", needsReauth: true, quota: null },
  ];
  oauthAccounts = [
    { id: "acct_1", email: "a***@example.com" },
    { id: "acct_2" },
  ];
  oauthActiveId = "acct_1";
  keyEntries = [{
    id: "key_1",
    label: "personal",
    masked: MASKED_SENTINEL,
    apiKey: RAW_SENTINEL,
  }];
  keyActiveId = "key_1";
  requests.length = 0;
  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("ocx account CLI (issue #180 matrix)", () => {
  test("1: list renders all three account families, main alias, and padded columns", async () => {
    const result = await run(["list"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^PROVIDER\s{2,}TYPE\s{2,}ID\s{2,}PLAN\/LABEL\s{2,}STATUS/m);
    expect(result.stdout).toMatch(/^openai\s+codex\s+main\s+plus/m);
    expect(result.stdout).toMatch(/^anthropic\s+oauth\s+acct_1\s+a\*\*\*@example\.com\s+active/m);
    expect(result.stdout).toMatch(/^openrouter\s+api-key\s+key_1\s+sk-ra\*\*\*\*7890 \(personal\)\s+active/m);
    expect(result.stdout).not.toContain("__main__");

    const lines = result.stdout.split("\n");
    const typeColumn = lines[0]!.indexOf("TYPE");
    expect(lines.find(line => line.startsWith("openai"))!.indexOf("codex")).toBe(typeColumn);
    expect(lines.find(line => line.startsWith("anthropic"))!.indexOf("oauth")).toBe(typeColumn);
    expect(lines.find(line => line.startsWith("openrouter"))!.indexOf("api-key")).toBe(typeColumn);
  });

  test("2: list --json parses and preserves the raw __main__ id", async () => {
    const result = await run(["list", "--json"]);
    const parsed = JSON.parse(result.stdout) as { accounts: Array<{ id: string; type: string }> };

    expect(result.code).toBe(0);
    expect(parsed.accounts.some(row => row.id === "__main__")).toBe(true);
    expect(new Set(parsed.accounts.map(row => row.type))).toEqual(new Set(["codex", "oauth", "api-key"]));
  });

  test("3: empty providers are skipped by default and shown with --all", async () => {
    const normal = await run(["list"]);
    const withAll = await run(["list", "--all"]);

    expect(normal.code).toBe(0);
    expect(normal.output).not.toContain("xai");
    expect(withAll.code).toBe(0);
    expect(withAll.output).toContain("xai: no stored accounts or keys");
  });

  test("4: current openai prints the pinned id and plan", async () => {
    const result = await run(["current", "openai"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("chatgpt_1");
    expect(result.stdout).toContain("pro");
    expect(result.stdout).toContain("next session");
  });

  test("5: current openai explains automatic selection when active is null", async () => {
    activeCodexAccountId = null;
    const result = await run(["current", "openai"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("auto (no pin");
    expect(result.stdout).toContain("lowest-usage account is selected per request");
  });

  test("6: use anthropic acct_1 sends the OAuth PUT body and exits zero", async () => {
    const result = await run(["use", "anthropic", "acct_1"]);
    const put = requests.find(request =>
      request.method === "PUT" && request.path === "/api/oauth/accounts/active"
    );

    expect(result.code).toBe(0);
    expect(put?.body).toEqual({ provider: "anthropic", accountId: "acct_1" });
  });

  test("7: use openai main maps the alias to __main__", async () => {
    const result = await run(["use", "openai", "main"]);
    const put = requests.find(request =>
      request.method === "PUT" && request.path === "/api/codex-auth/active"
    );

    expect(result.code).toBe(0);
    expect(put?.body).toEqual({ accountId: "__main__" });
  });

  test("8: an unknown provider exits one and stderr names candidates", async () => {
    const result = await run(["use", "nosuch", "x"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown provider "nosuch"');
    expect(result.stderr).toContain("Known candidates:");
    expect(result.stderr).toContain("openai");
    expect(result.stderr).toContain("anthropic");
  });

  test("9: an OAuth API 404 exits one and surfaces the server error", async () => {
    const result = await run(["use", "anthropic", "nope"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("anthropic account nope was not found");
  });

  test("10: proxy-down exits one with ocx start and ensure guidance", async () => {
    const result = await run(
      ["list"],
      { baseUrl: "http://127.0.0.1:1", loadConfigImpl: fixtureConfig },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ocx start");
    expect(result.stderr).toContain("ocx ensure");
  });

  test("11: list projects only masked API-key DTO fields", async () => {
    const human = await run(["list"]);
    const machine = await run(["list", "--json"]);
    const parsed = JSON.parse(machine.stdout) as { accounts: Array<Record<string, unknown>> };
    const keyRow = parsed.accounts.find(row => row.type === "api-key");

    expect(human.stdout).toContain(MASKED_SENTINEL);
    expect(machine.stdout).toContain(MASKED_SENTINEL);
    expect(keyRow).not.toHaveProperty("apiKey");
    expect(human.output).not.toContain(RAW_SENTINEL);
    expect(machine.output).not.toContain(RAW_SENTINEL);
  });

  test("12: list kiro prints the single-slot replacement note", async () => {
    const result = await run(["list", "kiro"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("single login slot");
    expect(result.stdout).toContain("re-login replaces the current account");
  });

  test("13: bare account and use without an id return usage errors", async () => {
    const bare = await run([]);
    const missingId = await run(["use", "anthropic"]);

    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("Usage:");
    expect(bare.stderr).toContain("ocx account list");
    expect(missingId.code).toBe(1);
    expect(missingId.stderr).toContain("Usage:");
    expect(missingId.stderr).toContain("ocx account use");
  });

  test("14: fan-out skips local/forward providers while explicit ollama errors", async () => {
    const fanOut = await run(["list"]);
    const explicit = await run(["list", "ollama"]);

    expect(fanOut.code).toBe(0);
    expect(fanOut.output).not.toContain("ollama");
    expect(fanOut.output).not.toContain("forward-custom");
    expect(explicit.code).toBe(1);
    expect(explicit.stderr).toContain("has no credentials");
  });

  test("15: fan-out applies family- and provenance-specific error propagation", async () => {
    oauthListFailure = { provider: "anthropic", status: 401, error: "proxy authentication required" };
    const authFailure = await run(["list"]);

    expect(authFailure.code).toBe(1);
    expect(authFailure.stderr).toContain("proxy authentication required");
    expect(authFailure.stdout).toBe("");

    oauthListFailure = { provider: "anthropic", status: 400, error: "unknown oauth provider" };
    const inconsistentLiveProvider = await run(["list"]);

    expect(inconsistentLiveProvider.code).toBe(1);
    expect(inconsistentLiveProvider.stderr).toContain("unknown oauth provider");

    oauthListFailure = { provider: "github-copilot", status: 400, error: "unknown oauth provider" };
    const staleConfigOAuth = await run(["list"]);

    expect(staleConfigOAuth.code).toBe(0);
    expect(staleConfigOAuth.stderr).toBe("");

    oauthListFailure = null;
    keyListFailure = { provider: "openrouter", status: 404, error: "unknown provider" };
    const staleKeyProvider = await run(["list"]);

    expect(staleKeyProvider.code).toBe(0);
    expect(staleKeyProvider.stderr).toBe("");
  });

  test("16: a failed Codex active read is not reported as automatic selection", async () => {
    activeReadFailure = { status: 500, error: "active account read failed" };
    const result = await run(["current", "openai"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("active account read failed");
    expect(result.output).not.toContain("auto (no pin");
  });

  test("17: local providers reject credential listing even when config contains an API key", async () => {
    const result = await run(["list", "ollama"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has no credentials");
  });

  // --- Regression guards restored from the first suite (Aquinas A-gate finding 1) ---

  test("WP2 regression: list marks a needsReauth codex account in the STATUS column", async () => {
    const result = await run(["list", "openai"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("chatgpt_1");
    expect(result.stdout).toContain("needs-reauth");
  });

  test("WP2 regression: use openai main prints next-session and auto-switch override notes", async () => {
    const result = await run(["use", "openai", "main"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("new Codex sessions");
    expect(result.stderr).toContain("running threads keep their current account");
    expect(result.stderr).toContain("auto-switch (threshold 80%) may override this pin");
  });

  test("WP2 regression: classifyAccount routes a key-overridden OAuth provider to api-key", () => {
    const config = fixtureConfig();
    (config.providers as Record<string, { authMode?: string }>).xai = { authMode: "key" };

    expect(classifyAccount(config, "xai")).toEqual({ type: "api-key" });
    expect(classifyAccount(config, "anthropic")).toEqual({ type: "oauth" });
    expect(classifyAccount(config, "openai")).toEqual({ type: "codex" });
    expect(classifyAccount(config, "ollama")).toHaveProperty("error");
    expect(classifyAccount(config, "no-such-provider")).toHaveProperty("error");
  });

  test("WP2 regression: formatAccountTable renders __main__ as main with next-session status", () => {
    const table = formatAccountTable([
      { provider: "openai", type: "codex", id: "__main__", label: "plus", active: true },
    ]);

    expect(table).toContain("main");
    expect(table).not.toContain("__main__");
    expect(table).toContain("next session");
  });

  test("18: refresh openai forces quota refresh and distinguishes unknown quota", async () => {
    const human = await run(["refresh", "openai"]);
    const machine = await run(["refresh", "openai", "--json"]);
    const parsed = JSON.parse(machine.stdout) as { accounts: Array<Record<string, unknown>> };

    expect(human.code).toBe(0);
    expect(requests.some(request =>
      request.path === "/api/codex-auth/accounts" && request.search === "?refresh=1"
    )).toBe(true);
    expect(human.stdout).toContain("weekly 42%");
    expect(human.stdout).toContain("monthly 17%");
    expect(human.stdout).toContain("resets 2027-");
    expect(human.stdout).toContain("chatgpt_1 j***@example.com pro quota: unknown needs-reauth");
    expect(parsed.accounts.find(row => row.id === "__main__")?.quota).toEqual({
      weeklyPercent: 42,
      monthlyPercent: 17,
      weeklyResetAt: 1_800_000_000,
      monthlyResetAt: 1_900_000_000,
    });
    expect(parsed.accounts.find(row => row.id === "chatgpt_1")?.quota).toBeNull();
  });

  test("19: refresh OAuth and key providers use the provider quota endpoint", async () => {
    const oauth = await run(["refresh", "anthropic"]);
    const oauthJson = await run(["refresh", "anthropic", "--json"]);
    const keyPool = await run(["refresh", "openrouter"]);
    const keyPoolJson = await run(["refresh", "openrouter", "--json"]);

    expect(oauth.code).toBe(0);
    expect(oauth.stdout).toContain("5h 31%");
    expect(oauth.stdout).toContain("resets 2027-");
    expect(JSON.parse(oauthJson.stdout)).toEqual({
      provider: "anthropic",
      report: {
        provider: "anthropic",
        label: "Anthropic",
        source: "anthropic:usage",
        quota: { fiveHourPercent: 31, fiveHourResetAt: 1_800_000_000, updatedAt: 1_700_000_000 },
        updatedAt: 1_700_000_000,
      },
    });
    expect(keyPool.code).toBe(0);
    expect(keyPool.stdout).toContain("no quota report available for openrouter");
    expect(keyPoolJson.code).toBe(0);
    expect(JSON.parse(keyPoolJson.stdout)).toEqual({ provider: "openrouter", report: null });
    expect(requests.filter(request =>
      request.path === "/api/provider-quotas" && request.search === "?refresh=1"
    )).toHaveLength(4);
  });

  test("20: auto-switch on, off, threshold and status use the exact contracts", async () => {
    const on = await run(["auto-switch", "openai", "on"]);
    const off = await run(["auto-switch", "openai", "off"]);
    const threshold = await run(["auto-switch", "openai", "threshold", "55"]);
    const status = await run(["auto-switch", "openai", "status", "--json"]);
    const puts = requests.filter(request => request.path === "/api/codex-auth/auto-switch");

    expect(on.code).toBe(0);
    expect(off.code).toBe(0);
    expect(threshold.code).toBe(0);
    expect(puts.map(request => request.body)).toEqual([
      { threshold: 80 },
      { threshold: 0 },
      { threshold: 55 },
    ]);
    expect(JSON.parse(status.stdout)).toEqual({
      provider: "openai",
      autoSwitchThreshold: 55,
      enabled: true,
    });
  });

  test("21: auto-switch rejects wrong providers, invalid thresholds and missing providers", async () => {
    const wrongProvider = await run(["auto-switch", "anthropic", "on"]);
    const invalidThreshold = await run(["auto-switch", "openai", "threshold", "101"]);
    const missingProvider = await run(["auto-switch"]);

    expect(wrongProvider.code).toBe(1);
    expect(wrongProvider.stderr).toContain("auto-switch only applies to the openai Codex account pool");
    expect(invalidThreshold.code).toBe(1);
    expect(invalidThreshold.stderr).toContain("integer 0-100");
    expect(missingProvider.code).toBe(1);
    expect(missingProvider.stderr).toContain("Usage:");
  });

  test("22: remove without --yes prints the re-run hint and sends no request", async () => {
    const result = await run(
      ["remove", "openai", "chatgpt_1"],
      { ...defaultDeps(), baseUrl: "http://127.0.0.1:1" },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ocx account remove openai chatgpt_1 --yes");
    expect(requests).toHaveLength(0);
  });

  test("23: remove pre-check rejects an unknown id without DELETE", async () => {
    const result = await run(["remove", "openai", "nope", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"nope" was not found');
    expect(requests.some(request => request.method === "DELETE")).toBe(false);
  });

  test("24: removing the pinned Codex account reports automatic selection", async () => {
    const result = await run(["remove", "openai", "chatgpt_1", "--yes"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("auto (no pin");
    expect(requests.some(request =>
      request.method === "DELETE" && request.path === "/api/codex-auth/accounts"
    )).toBe(true);
  });

  test("25: removing the active OAuth account reports the promoted account", async () => {
    const result = await run(["remove", "anthropic", "acct_1", "--yes"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("active account is now acct_2");
  });

  test("26: removing the last API key reports no keys remaining", async () => {
    const result = await run(["remove", "openrouter", "key_1", "--yes"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no keys remaining");
  });

  test("27: removing the main Codex login is refused without DELETE", async () => {
    const result = await run(["remove", "openai", "main", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("main Codex App login cannot be removed");
    expect(requests).toHaveLength(0);
  });

  test("28: add-key reads a pipe, posts the key and never prints it", async () => {
    const key = "sk-test-1234567890abcdef";
    const result = await run(
      ["add-key", "openrouter", "--label", "production", "--json"],
      { ...defaultDeps(), stdinImpl: stdinFrom(`${key}\n`) },
    );
    const post = requests.find(request => request.method === "POST");

    expect(result.code).toBe(0);
    expect(post?.body).toEqual({ name: "openrouter", key, label: "production" });
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, id: "key_added", label: "production" });
    expect(result.output).not.toContain(key);
  });

  test("29: add-key rejects TTY and empty stdin without POST", async () => {
    const tty = new PassThrough() as AccountStdin;
    tty.isTTY = true;
    const ttyResult = await run(["add-key", "openrouter"], { ...defaultDeps(), stdinImpl: tty });
    const emptyResult = await run(
      ["add-key", "openrouter"],
      { ...defaultDeps(), stdinImpl: stdinFrom("  \n") },
    );

    expect(ttyResult.code).toBe(1);
    expect(ttyResult.stderr).toContain("<<< \"$MY_KEY\"");
    expect(ttyResult.stderr).not.toContain("echo <key>");
    expect(emptyResult.code).toBe(1);
    expect(emptyResult.stderr).toContain("input was empty");
    expect(requests.some(request => request.method === "POST")).toBe(false);
  });

  test("30: delete and post-delete verification failures remain distinct", async () => {
    deleteFailure = { status: 500, error: "delete failed upstream" };
    const deleteFailed = await run(["remove", "anthropic", "acct_1", "--yes"]);

    expect(deleteFailed.code).toBe(1);
    expect(deleteFailed.stderr).toContain("delete failed upstream");

    deleteFailure = null;
    postDeleteReadFailure = { status: 500, error: "post-delete read failed" };
    const verifyFailed = await run(["remove", "anthropic", "acct_1", "--yes"]);

    expect(verifyFailed.code).toBe(1);
    expect(verifyFailed.stderr).toContain("delete may have succeeded");
    expect(verifyFailed.stderr).toContain("post-delete read failed");
  });

  test("31: add-key surfaces POST failure and cleans stdin timeout listeners", async () => {
    const key = "sk-test-1234567890abcdef";
    addKeyFailure = { status: 400, error: "key rejected" };
    const postFailed = await run(
      ["add-key", "openrouter"],
      { ...defaultDeps(), stdinImpl: stdinFrom(`${key}\n`) },
    );

    expect(postFailed.code).toBe(1);
    expect(postFailed.stderr).toContain("key rejected");
    expect(postFailed.output).not.toContain(key);

    addKeyFailure = null;
    const silent = new PassThrough() as AccountStdin;
    silent.isTTY = false;
    const timedOut = await run(
      ["add-key", "openrouter"],
      { ...defaultDeps(), stdinImpl: silent, stdinTimeoutMs: 5 },
    );

    expect(timedOut.code).toBe(1);
    expect(timedOut.stderr).toContain("timed out waiting for API key");
    expect(silent.listenerCount("data")).toBe(0);
    expect(silent.listenerCount("end")).toBe(0);
    expect(silent.listenerCount("error")).toBe(0);
  });

  test("32: refresh and auto-switch surface server failures", async () => {
    codexRefreshFailure = { status: 500, error: "quota refresh failed" };
    const refresh = await run(["refresh", "openai"]);

    codexRefreshFailure = null;
    activeReadFailure = { status: 500, error: "status read failed" };
    const status = await run(["auto-switch", "openai", "status"]);

    activeReadFailure = null;
    autoSwitchUpdateFailure = { status: 400, error: "threshold rejected" };
    const update = await run(["auto-switch", "openai", "on"]);

    expect(refresh.code).toBe(1);
    expect(refresh.stderr).toContain("quota refresh failed");
    expect(status.code).toBe(1);
    expect(status.stderr).toContain("status read failed");
    expect(update.code).toBe(1);
    expect(update.stderr).toContain("threshold rejected");
  });

  test("33: add-key redacts label containment and help lists the full family", async () => {
    const key = "sk-test-1234567890abcdef";
    const label = `prod-${key}-${key}`;
    const human = await run(
      ["add-key", "openrouter", "--label", label],
      { ...defaultDeps(), stdinImpl: stdinFrom(`${key}\n`) },
    );
    const machine = await run(
      ["add-key", "openrouter", "--label", label, "--json"],
      { ...defaultDeps(), stdinImpl: stdinFrom(`${key}\n`) },
    );

    expect(human.stdout).toContain("prod-[redacted]-[redacted]");
    expect(machine.stdout).toContain("prod-[redacted]-[redacted]");
    expect(human.output).not.toContain(key);
    expect(machine.output).not.toContain(key);

    logs.length = 0;
    printSubcommandUsage("account");
    const help = logs.join("\n");
    for (const command of ["refresh", "auto-switch", "remove", "add-key"]) {
      expect(help).toContain(command);
    }
  });

  test("34: remove reports key promotion, last OAuth removal, and an unchanged Codex pin", async () => {
    keyEntries = [
      { id: "key_1", label: "first", masked: "sk-fi****1111" },
      { id: "key_2", label: "second", masked: "sk-se****2222" },
      { id: "key_3", label: "third", masked: "sk-th****3333" },
    ];
    keyActiveId = "key_1";
    const key = await run(["remove", "openrouter", "key_1", "--yes"]);

    oauthAccounts = [{ id: "acct_1", email: "a***@example.com" }];
    oauthActiveId = "acct_1";
    const oauth = await run(["remove", "anthropic", "acct_1", "--yes"]);

    codexAccounts.push({ id: "chatgpt_2", email: "n***@example.com", plan: "plus" });
    activeCodexAccountId = "chatgpt_1";
    const codex = await run(["remove", "openai", "chatgpt_2", "--yes"]);

    expect(key.code).toBe(0);
    expect(key.stdout).toContain("active key is now key_2");
    expect(oauth.code).toBe(0);
    expect(oauth.stdout).toContain("no accounts remaining");
    expect(codex.code).toBe(0);
    expect(codex.stdout).toContain("removed account chatgpt_2");
    expect(codex.stdout).not.toContain("auto (no pin");
    expect(activeCodexAccountId).toBe("chatgpt_1");
  });

  test("35: add-key rejects OAuth and Codex families without sending a POST", async () => {
    const anthropic = await run(["add-key", "anthropic"]);
    const openai = await run(["add-key", "openai"]);
    const posts = requests.filter(request =>
      request.method === "POST" && request.path === "/api/providers/keys"
    );

    expect(anthropic.code).toBe(1);
    expect(anthropic.stderr).toContain("add-key only applies to API-key providers");
    expect(openai.code).toBe(1);
    expect(openai.stderr).toContain("add-key only applies to API-key providers");
    expect(posts).toHaveLength(0);
  });

  test("36: refresh and remove emit exact JSON envelopes", async () => {
    const refresh = await run(["refresh", "openai", "--json"]);
    const refreshed = JSON.parse(refresh.stdout) as Record<string, unknown>;

    expect(refresh.code).toBe(0);
    expect(Object.keys(refreshed)).toEqual(["accounts"]);
    expect((refreshed.accounts as Array<Record<string, unknown>>)[0]?.quota).toEqual({
      weeklyPercent: 42,
      monthlyPercent: 17,
      weeklyResetAt: 1_800_000_000,
      monthlyResetAt: 1_900_000_000,
    });

    const removed = await run(["remove", "openai", "chatgpt_1", "--yes", "--json"]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({
      ok: true,
      provider: "openai",
      id: "chatgpt_1",
      removedActive: true,
      promotedActiveId: null,
    });

    deleteFailure = { status: 500, error: "json delete failed" };
    const failed = await run(["remove", "anthropic", "acct_1", "--yes", "--json"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(JSON.parse(failed.stderr)).toEqual({ error: "json delete failed" });
  });
});
