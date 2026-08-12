import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdAccount, classifyAccount, formatAccountTable, type AccountDeps } from "../src/cli/account";
import type { AccountStdin } from "../src/cli/account-api";
import { printSubcommandUsage } from "../src/cli/help";
import {
  DEFAULT_ACCOUNT_PRIORITY,
  MAX_ACCOUNT_PRIORITY,
  MIN_ACCOUNT_PRIORITY,
} from "../src/codex/pool-rotation";
import {
  ACCOUNT_PRIORITY_PRESETS,
  accountPriorityPresetKey,
  DEFAULT_ACCOUNT_PRIORITY as GUI_DEFAULT_PRIORITY,
  MAX_ACCOUNT_PRIORITY as GUI_MAX_PRIORITY,
  MIN_ACCOUNT_PRIORITY as GUI_MIN_PRIORITY,
} from "../gui/src/account-priority";
import type { OcxConfig } from "../src/types";
import { ACCOUNT_IMPORT_MAX_BYTES } from "../src/oauth/account-import";

const RAW_SENTINEL = "test-key-rawsentinel1234567890";
const MASKED_SENTINEL = "test****7890";

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
let oauthLoginStatus: Record<string, unknown> = { loggedIn: false };
let codexLoginStatus: Record<string, unknown> = { status: "pending" };
let codexDeleteCatalogRefreshPending = false;
let importResultOverride: unknown | undefined;
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
    return json({
      ok: true,
      catalogRefreshPending: codexDeleteCatalogRefreshPending,
      internalError: "private-delete-detail",
    });
  }

  if (req.method === "PUT" && url.pathname === "/api/codex-auth/accounts/alias") {
    const payload = body as { id: string; alias: string };
    const account = codexAccounts.find(entry => entry.id === payload.id);
    if (!account) return json({ error: "account not found" }, 404);
    account.alias = payload.alias;
    return json({ ok: true, id: payload.id, alias: payload.alias || null });
  }

  if (req.method === "PUT" && url.pathname === "/api/codex-auth/accounts/priority") {
    const payload = body as { id: string; priority: number | null };
    const account = codexAccounts.find(entry => entry.id === payload.id);
    if (!account) return json({ error: "account not found" }, 404);
    account.priority = payload.priority ?? 0;
    return json({ ok: true, id: payload.id, priority: account.priority });
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

  if (req.method === "POST" && url.pathname === "/api/oauth/accounts/import") {
    const payload = body as { provider?: string; format?: string; document?: unknown };
    if (payload.provider !== "google-antigravity") return json({ code: "unsupported_provider" }, 400);
    if (payload.format !== "cockpit-tools") return json({ code: "unsupported_format" }, 400);
    if (!Array.isArray(payload.document)) return json({ code: "invalid_document" }, 400);
    if (importResultOverride !== undefined) return json(importResultOverride);
    return json({
      totalCount: payload.document.length,
      importedCount: payload.document.length,
      updatedCount: 0,
      failedCount: 0,
      unsupportedCount: 0,
      results: payload.document.map((_, index) => ({ index, status: "imported", code: "imported" })),
    });
  }

  if (req.method === "PUT" && url.pathname === "/api/oauth/accounts/alias") {
    const payload = body as { accountId: string; alias: string };
    const account = oauthAccounts.find(entry => entry.id === payload.accountId);
    if (!account) return json({ error: "account not found" }, 404);
    account.alias = payload.alias;
    return json({ ok: true });
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

  if (req.method === "PUT" && url.pathname === "/api/providers/keys/alias") {
    const payload = body as { id: string; alias: string };
    const entry = keyEntries.find(key => key.id === payload.id);
    if (!entry) return json({ error: "key not found" }, 404);
    entry.label = payload.alias;
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

  if (req.method === "POST" && url.pathname === "/api/oauth/login") {
    return json({ url: "https://auth.example/authorize", instructions: "Sign in, then paste the redirect URL." });
  }

  if (req.method === "POST" && url.pathname === "/api/codex-auth/login") {
    return json({ url: "https://auth.example/authorize", flowId: "flow-mock" });
  }

  if (req.method === "POST" && url.pathname === "/api/codex-auth/login/code") {
    return json({ ok: true, accepted: true });
  }

  if (req.method === "GET" && url.pathname === "/api/codex-auth/login-status") {
    return json(codexLoginStatus);
  }

  if (req.method === "POST" && url.pathname === "/api/oauth/login/code") {
    return json({ ok: true, accepted: true });
  }

  if (req.method === "GET" && url.pathname === "/api/oauth/status") {
    return json(oauthLoginStatus);
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

test("the login URL reaches piped stdout before the polling window (#1007)", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", fileURLToPath(new URL("./helpers/account-login-pipe-child.ts", import.meta.url))],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // Read incrementally with a sub-second deadline: the URL block must
    // arrive while the child is still polling (still authenticating).
    const reader = child.stdout.getReader();
    const deadline = AbortSignal.timeout(5_000);
    let received = "";
    while (!received.includes("auth.example/authorize")) {
      const { value, done } = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => ({ value: undefined, done: true }) as const),
      ]);
      if (done) break;
      if (value) received += new TextDecoder().decode(value);
    }
    expect(received).toContain("https://auth.example/authorize?flow=pipe-test");
    expect(received).toContain("Flow: flow-pipe");
    // The child is STILL authenticating (the whole point of the flush).
    expect(child.exitCode).toBeNull();
    void deadline;
  } finally {
    child.kill();
    await child.exited.catch(() => {});
  }
}, 15_000);

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
    { id: "chatgpt_1", email: "j***@example.com", plan: "pro", needsReauth: true, priority: 1, quota: null },
  ];
  oauthAccounts = [
    { id: "acct_1", email: "a***@example.com" },
    { id: "acct_2" },
  ];
  oauthActiveId = "acct_1";
  oauthLoginStatus = { loggedIn: false };
  codexLoginStatus = { status: "pending" };
  codexDeleteCatalogRefreshPending = false;
  importResultOverride = undefined;
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
    expect(result.stdout).toMatch(/^PROVIDER\s{2,}TYPE\s{2,}ID\s{2,}PLAN\/LABEL\s{2,}PRIORITY\s{2,}STATUS/m);
    expect(result.stdout).toMatch(/^openai\s+codex\s+main\s+plus\s+0/m);
    // The sign, not just the header: an order above the default must render "+1" so the
    // column reads as a position on an axis rather than a magnitude. Without this the
    // whole suite passes with priorityText's `+${n}` branch collapsed to String(n).
    expect(result.stdout).toMatch(/^openai\s+codex\s+chatgpt_1\s+\S+\s+\+1\s/m);
    expect(result.stdout).toMatch(/^anthropic\s+oauth\s+acct_1\s+a\*\*\*@example\.com\s+-\s+active/m);
    expect(result.stdout).toMatch(/^openrouter\s+api-key\s+key_1\s+test\*\*\*\*7890 \(personal\)\s+-\s+active/m);
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
    expect(result.stdout).toContain("selected");
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
      {
        baseUrl: "http://127.0.0.1:1",
        loadConfigImpl: fixtureConfig,
        fetchImpl: async () => { throw new TypeError("connection refused"); },
      },
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

  test("WP2 regression: use openai main prints takes-effect-immediately and auto-switch override notes", async () => {
    const result = await run(["use", "openai", "main"]);

    expect(result.code).toBe(0);
    // A manual switch clears thread affinity outright (resetCodexRoutingForManualSelection
    // calls clearThreadAccountMap as its first statement), so running threads do NOT keep
    // their account -- they rebind on their next request, and the route reports
    // appliesImmediately: true. Only requests already in flight keep what they captured.
    // Do not reword back toward "new sessions" or "running threads keep their account":
    // this test previously asserted that clause, which is what kept it alive.
    expect(result.stderr).toContain("Takes effect immediately");
    expect(result.stderr).toContain("in-flight requests keep the account they captured");
    expect(result.stderr).not.toContain("running threads keep their current account");
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
    expect(table).toContain("selected");
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
    // Recording fetchImpl proves no HTTP call is even attempted — the --yes
    // guard fires at arg-parse time, before resolveBaseUrl (Carver C-gate).
    const calls: string[] = [];
    const recordingFetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await run(
      ["remove", "openai", "chatgpt_1"],
      { ...defaultDeps(), fetchImpl: recordingFetch },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ocx account remove openai chatgpt_1 --yes");
    expect(calls).toHaveLength(0);
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

  test("pending Codex removal keeps success and prints generic recovery guidance", async () => {
    codexDeleteCatalogRefreshPending = true;
    const result = await run(["remove", "openai", "chatgpt_1", "--yes"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("auto (no pin");
    expect(result.stderr).toContain("ocx sync");
    expect(result.stderr).toContain("account change was saved");
    expect(result.output).not.toContain("private-delete-detail");
  });

  test("JSON Codex removal retains the pending flag without a human warning", async () => {
    codexDeleteCatalogRefreshPending = true;
    const result = await run(["remove", "openai", "chatgpt_1", "--yes", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: true,
      catalogRefreshPending: true,
    }));
    expect(result.stdout).not.toContain("private-delete-detail");
    expect(result.stderr).toBe("");
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
    const key = "test-key-1234567890abcdef";
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
    const key = "test-key-1234567890abcdef";
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
    const key = "test-key-1234567890abcdef";
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

  test("C-gate fold: add-key redacts a key containing JSON-escaped characters", async () => {
    const key = 'sk-"x\\test';
    const human = await run(
      ["add-key", "openrouter", "--label", key],
      { ...defaultDeps(), stdinImpl: stdinFrom(`${key}\n`) },
    );
    const machine = await run(
      ["add-key", "openrouter", "--label", key, "--json"],
      { ...defaultDeps(), stdinImpl: stdinFrom(`${key}\n`) },
    );

    expect(human.stdout).toContain("[redacted]");
    expect(machine.stdout).toContain("[redacted]");
    // Raw key must not appear in any form — literal or JSON-escaped (Carver Medium).
    expect(human.output).not.toContain(key);
    expect(machine.output).not.toContain(key);
    expect(machine.output).not.toContain('sk-\\"x\\\\test');
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
      catalogRefreshPending: false,
    });

    deleteFailure = { status: 500, error: "json delete failed" };
    const failed = await run(["remove", "anthropic", "acct_1", "--yes", "--json"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(JSON.parse(failed.stderr)).toEqual({ error: "json delete failed" });
  });

  test("37: alias updates Codex, OAuth, and API-key display names without changing ids", async () => {
    const codex = await run(["alias", "openai", "chatgpt_1", "Work Plus", "--json"]);
    const oauth = await run(["alias", "anthropic", "acct_1", "Work Claude"]);
    const key = await run(["rename", "openrouter", "key_1", "Production"]);
    expect(codex.code).toBe(0);
    expect(JSON.parse(codex.stdout)).toEqual({ ok: true, provider: "openai", id: "chatgpt_1", alias: "Work Plus" });
    expect(oauth.code).toBe(0);
    expect(key.code).toBe(0);
    expect(requests).toContainEqual(expect.objectContaining({ method: "PUT", path: "/api/codex-auth/accounts/alias" }));
    expect(requests).toContainEqual(expect.objectContaining({ method: "PUT", path: "/api/oauth/accounts/alias" }));
    expect(requests).toContainEqual(expect.objectContaining({ method: "PUT", path: "/api/providers/keys/alias" }));
  });

  describe("37b: account priority sets and reads Codex selection order", () => {
    const priorityRequests = () => requests.filter(r => r.path === "/api/codex-auth/accounts/priority");
    const unreachableDeps = (): AccountDeps => ({
      ...defaultDeps(),
      fetchImpl: async () => { throw new TypeError("connection refused"); },
    });

    test("a numeric value is sent as an integer and echoed back signed", async () => {
      const result = await run(["priority", "openai", "chatgpt_1", "-1"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("openai: chatgpt_1 selection order is now -1 (later)");
      expect(priorityRequests()).toEqual([
        expect.objectContaining({ method: "PUT", body: { id: "chatgpt_1", priority: -1 } }),
      ]);
    });

    // The signed form is what the command itself prints back, so it has to round-trip.
    test("a leading-plus integer parses to the same value as the bare spelling", async () => {
      const result = await run(["priority", "openai", "chatgpt_1", "+2"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("openai: chatgpt_1 selection order is now +2 (first)");
      expect(priorityRequests()).toEqual([
        expect.objectContaining({ method: "PUT", body: { id: "chatgpt_1", priority: 2 } }),
      ]);
    });

    test.each([
      ["first", 2],
      ["Earlier", 1],
      ["normal", 0],
      ["later", -1],
      ["LAST", -2],
    ] as const)("the preset word %s maps to %d", async (word, expected) => {
      const result = await run(["priority", "openai", "chatgpt_1", word]);

      expect(result.code).toBe(0);
      expect(priorityRequests()).toEqual([
        expect.objectContaining({ body: { id: "chatgpt_1", priority: expected } }),
      ]);
    });

    // The five presets live in three places that cannot import one another: the dashboard
    // select, the CLI's preset words, and the core range. Driving the CLI from the GUI's own
    // list means a change to either side fails here instead of silently disagreeing about
    // what "First" means.
    test("the dashboard select and the CLI preset words describe the same five orders", async () => {
      const presets = ACCOUNT_PRIORITY_PRESETS.map(value => ({
        value,
        word: accountPriorityPresetKey(value)?.replace("accountPool.priority", "").toLowerCase(),
      }));
      expect(presets.map(preset => preset.word)).toEqual(["first", "earlier", "normal", "later", "last"]);

      for (const { value, word } of presets) {
        requests.length = 0;
        const result = await run(["priority", "openai", "chatgpt_1", word!]);

        expect(result.code).toBe(0);
        expect(priorityRequests()).toEqual([
          expect.objectContaining({ body: { id: "chatgpt_1", priority: value } }),
        ]);
      }
    });

    test("the dashboard mirrors the core priority range", () => {
      expect({ fallback: GUI_DEFAULT_PRIORITY, min: GUI_MIN_PRIORITY, max: GUI_MAX_PRIORITY }).toEqual({
        fallback: DEFAULT_ACCOUNT_PRIORITY,
        min: MIN_ACCOUNT_PRIORITY,
        max: MAX_ACCOUNT_PRIORITY,
      });
    });

    test("main is translated to the internal id the API expects", async () => {
      const result = await run(["priority", "openai", "main", "last", "--json"]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        provider: "openai",
        id: "__main__",
        priority: -2,
        preset: "last",
      });
    });

    test("reset sends null", async () => {
      await run(["priority", "openai", "chatgpt_1", "reset"]);

      expect(priorityRequests()).toEqual([
        expect.objectContaining({ body: { id: "chatgpt_1", priority: null } }),
      ]);
    });

    test("an omitted value reads the stored order without writing", async () => {
      const result = await run(["priority", "openai", "chatgpt_1"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("openai: chatgpt_1 selection order is +1 (earlier)");
      expect(priorityRequests()).toEqual([]);
    });

    test("the read emits the same JSON envelope as the write", async () => {
      const result = await run(["priority", "openai", "chatgpt_1", "--json"]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        provider: "openai",
        id: "chatgpt_1",
        priority: 1,
        preset: "earlier",
      });
      expect(priorityRequests()).toEqual([]);
    });

    test("reading main resolves the alias and reports the unset default", async () => {
      const result = await run(["priority", "openai", "main"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("openai: main selection order is 0 (normal)");
      expect(priorityRequests()).toEqual([]);
    });

    test("reading an unknown id exits one and names the account", async () => {
      const result = await run(["priority", "openai", "nope"]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("no openai account nope");
      expect(result.stderr).toContain("Usage:");
    });

    // The inherited names guard the preset lookup: `word in PRIORITY_PRESETS` would
    // resolve them off Object.prototype and send a non-number to the proxy.
    test.each(["2.5", "abc", "101", "-101", "constructor", "__proto__", "toString"])(
      "rejects %s before any HTTP call",
      async value => {
        const recording: Array<string> = [];
        const result = await run(["priority", "openai", "chatgpt_1", value], {
          ...defaultDeps(),
          fetchImpl: (async (input: RequestInfo | URL) => {
            recording.push(String(input));
            throw new Error("must not be called");
          }) as typeof fetch,
        });

        expect(result.code).toBe(1);
        expect(recording).toEqual([]);
      },
    );

    test("a trailing extra argument falls through to usage", async () => {
      const result = await run(["priority", "openai", "chatgpt_1", "first", "extra"]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Usage:");
      expect(result.stderr).toContain("ocx account priority");
      expect(priorityRequests()).toEqual([]);
    });

    test("non-Codex providers are rejected", async () => {
      const result = await run(["priority", "anthropic", "acct_1", "first"]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("only applies to the openai Codex account pool");
    });

    // Both paths reach the proxy through different helpers — the read through
    // fetchCodexRows, the write through apiJson — so each needs its own guard.
    test.each([
      ["the read", ["priority", "openai", "chatgpt_1"]],
      ["the write", ["priority", "openai", "chatgpt_1", "first"]],
    ] as const)("%s reports an unreachable proxy instead of throwing", async (_label, args) => {
      const result = await run([...args], unreachableDeps());

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Proxy not reachable");
      expect(result.stderr).toContain("ocx start");
      expect(result.stderr).toContain("ocx ensure");
    });

    test("the advisory note goes to stderr so --json stdout stays parseable", async () => {
      const result = await run(["priority", "openai", "chatgpt_1", "later", "--json"]);

      expect(result.code).toBe(0);
      // Both advisory lines, asserted exactly: the pin release is a side effect of a command
      // that reads as purely declarative, so it has to stay stated rather than drift out.
      expect(result.stderr).toBe([
        "Takes effect from the next unbound request; running threads keep their current account until drained.",
        'Also releases any manual "use this account now" pin, on any account.',
      ].join("\n"));
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        provider: "openai",
        id: "chatgpt_1",
        priority: -1,
        preset: "later",
      });
    });
  });

  describe("38: the authorization code never has to travel through argv", () => {
    // An OAuth redirect URL carries a short-lived credential. Passed as an
    // argument it lands in shell history and is readable via `ps` for as long
    // as the command runs. The interactive login already reads it from a
    // prompt; the headless path did not, and that is what these cover.
    const SECRET = "https://cb.example/callback?code=SUPERSECRET123&state=abc";

    test("a piped code produces the same request body as an argument would", async () => {
      const piped = await run(
        ["code", "anthropic", "--json"],
        { ...defaultDeps(), stdinImpl: stdinFrom(`${SECRET}\n`) },
      );
      const pipedPost = requests.at(-1);

      const passed = await run(["code", "anthropic", SECRET, "--json"]);
      const passedPost = requests.at(-1);

      expect(piped.code).toBe(0);
      expect(passed.code).toBe(0);
      expect(pipedPost?.body).toEqual({ provider: "anthropic", input: SECRET });
      expect(pipedPost?.body).toEqual(passedPost?.body);

      // Same result, different exposure: only the argv path warns, and the
      // warning names the problem without repeating the credential.
      expect(piped.stderr).toBe("");
      expect(passed.stderr).toContain("shell history");
      expect(passed.output).not.toContain("SUPERSECRET123");
    });

    test("`-` is the documented way to say stdin, and it does not warn", async () => {
      const positional = await run(
        ["code", "anthropic", "-", "--json"],
        { ...defaultDeps(), stdinImpl: stdinFrom(`${SECRET}\n`) },
      );

      expect(positional.code).toBe(0);
      expect(requests.at(-1)?.body).toEqual({ provider: "anthropic", input: SECRET });
      expect(positional.stderr).toBe("");
    });

    test("--code=<value> is accepted and warned about, because rejecting it prints the value", async () => {
      // `takeOption` only understands `--code value`, so `--code=value` used to
      // fall through to rejectArgs, which reported the whole argument —
      // writing the authorization code to stderr. Refusing the syntax leaked
      // more than accepting it.
      const result = await run(["code", "anthropic", `--code=${SECRET}`, "--json"]);

      expect(result.code).toBe(0);
      expect(requests.at(-1)?.body).toEqual({ provider: "anthropic", input: SECRET });
      expect(result.stderr).toContain("shell history");
      expect(result.output).not.toContain("SUPERSECRET123");
    });

    test("a rejected argument list redacts the secret option instead of echoing it", async () => {
      // `code` parses --code now, so the leak has to be reached through a
      // subcommand that does not: mistyping `cancel --code=<secret>` (or any
      // other command in this family) still lands the whole argument in
      // rejectArgs, which reports what it was given.
      const mistyped = await run(["cancel", "anthropic", `--code=${SECRET}`]);

      // CliUsageError is exit 2 in this CLI; the point of the case is the body
      // of the message, not the code.
      expect(mistyped.code).toBe(2);
      expect(mistyped.stderr).toContain("--code=<redacted>");
      expect(mistyped.output).not.toContain("SUPERSECRET123");

      // And the same protection where the option is understood but the rest of
      // the line is not.
      const extra = await run(["code", "anthropic", "-", `--code=${SECRET}`, "extra"]);
      expect(extra.code).toBe(2);
      expect(extra.output).not.toContain("SUPERSECRET123");
    });

    test("--flow is parsed as a flag, not swallowed as the code", async () => {
      // The positional used to be taken before the flags, so
      // `code openai --flow f1` read `--flow` as the credential and then
      // rejected `f1` as unexpected.
      const result = await run(
        ["code", "openai", "--flow", "flow-123", "--json"],
        { ...defaultDeps(), stdinImpl: stdinFrom(`${SECRET}\n`) },
      );

      expect(result.code).toBe(0);
      expect(requests.at(-1)).toEqual(expect.objectContaining({
        method: "POST",
        path: "/api/codex-auth/login/code",
        body: { flowId: "flow-123", input: SECRET },
      }));
      expect(result.output).not.toContain("--flow");
    });

    test("an empty pipe is a usage error, not an empty credential POST", async () => {
      const before = requests.length;
      const result = await run(
        ["code", "anthropic"],
        { ...defaultDeps(), stdinImpl: stdinFrom("   \n") },
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("input was empty");
      expect(requests).toHaveLength(before);
    });

    test("a silent pipe times out and cleans up its listeners", async () => {
      const silent = new PassThrough() as AccountStdin;
      silent.isTTY = false;
      const result = await run(
        ["code", "anthropic"],
        { ...defaultDeps(), stdinImpl: silent, stdinTimeoutMs: 5 },
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("timed out");
      expect(silent.listenerCount("data")).toBe(0);
      expect(silent.listenerCount("end")).toBe(0);
      expect(silent.listenerCount("error")).toBe(0);
    });

    test("a space-separated --code is redacted too, not just the equals form", async () => {
      // The equals form is one token; the space form is two, and reporting the
      // leftovers verbatim printed the second one. Mistyping the option on a
      // command that does not parse it is the reachable path.
      const cancel = await run(["cancel", "anthropic", "--code", SECRET]);

      expect(cancel.code).toBe(2);
      expect(cancel.stderr).toContain("--code <redacted>");
      expect(cancel.output).not.toContain("SUPERSECRET123");

      const reset = await run(["reset-credits", "main", "--code", SECRET]);
      expect(reset.output).not.toContain("SUPERSECRET123");
    });

    test("repeating --code is refused instead of leaving the second value to be echoed", async () => {
      // The parser took the first occurrence only, so the second flag and its
      // value fell through to rejectArgs — which reported them.
      for (const argv of [
        ["code", "anthropic", "--code", "FIRST", "--code", SECRET],
        ["login", "anthropic", "--code", "FIRST", "--code", SECRET],
      ]) {
        const result = await run(argv);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("more than once");
        expect(result.output).not.toContain("SUPERSECRET123");
        expect(result.output).not.toContain("FIRST");
      }
    });

    test("the inline form consumes its own token only, not the rest of the line", async () => {
      // `splice(index)` instead of `splice(index, 1)` removes everything after
      // the option too: --json stops working and a genuinely wrong argument is
      // silently accepted, both without any visible failure.
      const withJson = await run(["code", "anthropic", `--code=${SECRET}`, "--json"]);
      expect(withJson.code).toBe(0);
      expect(() => JSON.parse(withJson.stdout)).not.toThrow();

      // A stray token after the inline option is still seen. Here it is read
      // as the positional code, which collides with --code and is refused; the
      // point is that it is not silently swallowed.
      const withGarbage = await run(["code", "anthropic", `--code=${SECRET}`, "nonsense"]);
      expect(withGarbage.code).toBe(2);
      expect(withGarbage.stderr).toContain("not both");

      // And with the collision removed, an unknown flag still reaches the
      // rejection instead of disappearing.
      const withUnknownFlag = await run(["code", "anthropic", `--code=${SECRET}`, "--nope"]);
      expect(withUnknownFlag.code).toBe(2);
      expect(withUnknownFlag.stderr).toContain("--nope");
    });

    test("--code= with nothing after it is a usage error, not an empty credential", async () => {
      const result = await run(["code", "anthropic", "--code="]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("requires a value");
    });

    test("only the first line of a pipe is the credential", async () => {
      // Resolving the whole buffer would fold a trailing line into the value,
      // so a pasted block with a stray newline would POST something the user
      // never typed.
      const result = await run(
        ["code", "anthropic", "--json"],
        { ...defaultDeps(), stdinImpl: stdinFrom(`${SECRET}\ntrailing junk\n`) },
      );

      expect(result.code).toBe(0);
      expect(requests.at(-1)?.body).toEqual({ provider: "anthropic", input: SECRET });
    });

    test("giving the code twice is refused rather than silently preferring one", async () => {
      const result = await run(["code", "anthropic", SECRET, "--code", SECRET]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("not both");
      expect(result.output).not.toContain("SUPERSECRET123");
    });

    test("a flag-shaped code after --code is still hidden", async () => {
      // Redaction used to stop at the first `--`, reading the next token as a
      // flag rather than a value. The shell hands over whatever was typed, so
      // a credential that happens to start with `--`, or one placed after the
      // end-of-options separator, went straight into the usage error.
      const dashed = await run(["cancel", "anthropic", "--code", "--SUPERSECRET123"]);
      expect(dashed.code).toBe(2);
      expect(dashed.output).not.toContain("SUPERSECRET123");
      expect(dashed.stderr).toContain("<redacted>");

      const separated = await run(["cancel", "anthropic", "--code", "--", "SUPERSECRET123"]);
      expect(separated.code).toBe(2);
      expect(separated.output).not.toContain("SUPERSECRET123");
      expect(separated.stderr).toContain("<redacted>");
    });

    test("a second positional is hidden, while a mistyped flag is still named", async () => {
      // An unquoted redirect URL splits on spaces, so the tail of the code
      // arrives as extra positionals. Reporting them verbatim is the same leak
      // by another route.
      const split = await run(["code", "anthropic", "first", "SUPERSECRET123"]);
      expect(split.code).toBe(2);
      expect(split.output).not.toContain("SUPERSECRET123");
      expect(split.stderr).toContain("<redacted>");

      // Hiding values must not hide the diagnosis: a wrong flag is not a
      // credential and stays readable.
      const flag = await run(["code", "anthropic", "first", "--nope"]);
      expect(flag.code).toBe(2);
      expect(flag.stderr).toContain("--nope");
    });

    test("a stdin that already ended fails at once instead of waiting out the timeout", async () => {
      // `something | something-else | ocx account code <p>` can hand over a
      // stream that is already drained. Listening on it hears nothing, so the
      // command sat for the full two minutes and then blamed a slow paste.
      const drained = new PassThrough() as AccountStdin;
      drained.isTTY = false;
      drained.resume();
      drained.end("");
      await new Promise(resolve => drained.once("end", resolve));

      const started = Date.now();
      const result = await run(
        ["code", "anthropic"],
        { ...defaultDeps(), stdinImpl: drained, stdinTimeoutMs: 30_000 },
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("input was empty");
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    test("the credential survives being split across chunks and CRLF line ends", async () => {
      // Overwriting the buffer instead of appending, or resolving an empty
      // string at end-of-stream, both truncate the code silently.
      const chunked = new PassThrough() as AccountStdin;
      chunked.isTTY = false;
      const pending = run(["code", "anthropic", "--json"], { ...defaultDeps(), stdinImpl: chunked });
      chunked.write(SECRET.slice(0, 20));
      chunked.write(`${SECRET.slice(20)}\r\n`);
      const result = await pending;

      expect(result.code).toBe(0);
      expect(requests.at(-1)?.body).toEqual({ provider: "anthropic", input: SECRET });
    });

    test("a bare carriage return ends the line too", async () => {
      // The read stops at either line character. Narrowing it to \n alone
      // would fold a CR-terminated paste and everything after it into the
      // value, and the request would carry something the user never typed.
      const cr = new PassThrough() as AccountStdin;
      cr.isTTY = false;
      const pending = run(["code", "anthropic", "--json"], { ...defaultDeps(), stdinImpl: cr });
      cr.write(`${SECRET}\rtrailing junk`);
      const result = await pending;

      expect(result.code).toBe(0);
      expect(requests.at(-1)?.body).toEqual({ provider: "anthropic", input: SECRET });
    });

    test("a code that arrives without a trailing newline is still read", async () => {
      const noNewline = new PassThrough() as AccountStdin;
      noNewline.isTTY = false;
      const pending = run(["code", "anthropic", "--json"], { ...defaultDeps(), stdinImpl: noNewline });
      noNewline.end(SECRET);
      const result = await pending;

      expect(result.code).toBe(0);
      expect(requests.at(-1)?.body).toEqual({ provider: "anthropic", input: SECRET });
    });

    test("a plain login still opens the browser flow instead of waiting on stdin", async () => {
      // The stdin default belongs to `account code`. If it reached `login`,
      // every ordinary `ocx account login <provider>` would block on a prompt.
      const silent = new PassThrough() as AccountStdin;
      silent.isTTY = false;
      const result = await run(
        ["login", "anthropic", "--no-wait", "--json"],
        { ...defaultDeps(), stdinImpl: silent, stdinTimeoutMs: 5 },
      );

      expect(result.code).toBe(0);
      expect(requests.some(request => request.path === "/api/oauth/login/code")).toBe(false);
    });

  });

  test("39: a login error wins over a retained OAuth credential", async () => {
    oauthLoginStatus = {
      loggedIn: true,
      done: true,
      error: "The credential was saved, but the provider entry was not written.",
    };
    const sleepSpy = spyOn(Bun, "sleep").mockImplementation(async () => {});
    try {
      const result = await run(["login", "anthropic"]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("provider entry was not written");
      expect(result.stdout).not.toContain("Logged in to anthropic");
    } finally {
      sleepSpy.mockRestore();
    }
  });

  test("Cockpit import accepts only bounded file/stdin sources and never renders the token", async () => {
    const canary = "cli-cockpit-canary-DO-NOT-LEAK";
    const document = JSON.stringify([{ email: "user@example.com", refresh_token: canary }]);

    const beforeInline = requests.length;
    const inline = await run([
      "import", "google-antigravity", "--format", "cockpit-tools", document,
    ]);
    expect(inline.code).toBe(1);
    expect(requests).toHaveLength(beforeInline);
    expect(inline.output).not.toContain(canary);

    const unsupported = await run([
      "import", "openai", "--format", "cockpit-tools", "--file", "/definitely/not/read.json",
    ]);
    expect(unsupported.code).toBe(1);
    expect(unsupported.stderr).toContain("unsupported_provider");
    expect(unsupported.stderr).not.toContain("source_read_failed");

    const stdin = await run([
      "import", "google-antigravity", "--format", "cockpit-tools", "--stdin", "--json",
    ], { ...defaultDeps(), stdinImpl: stdinFrom(document) });
    expect(stdin.code).toBe(0);
    expect(JSON.parse(stdin.stdout)).toEqual({
      totalCount: 1,
      importedCount: 1,
      updatedCount: 0,
      failedCount: 0,
      unsupportedCount: 0,
      results: [{ index: 0, status: "imported", code: "imported" }],
    });
    expect(stdin.output).not.toContain(canary);
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/oauth/accounts/import",
      body: {
        provider: "google-antigravity",
        format: "cockpit-tools",
        document: [{ email: "user@example.com", refresh_token: canary }],
      },
    });

    const directory = mkdtempSync(join(tmpdir(), "ocx-cli-account-import-"));
    const path = join(directory, "accounts.json");
    writeFileSync(path, document);
    try {
      const file = await run([
        "import", "google-antigravity", "--format", "cockpit-tools", "--file", path,
      ]);
      expect(file.code).toBe(0);
      expect(file.stdout).toContain("1 imported, 0 updated, 0 failed");
      expect(file.output).not.toContain(canary);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    const beforeOversized = requests.length;
    const oversized = await run([
      "import", "google-antigravity", "--format", "cockpit-tools", "--stdin",
    ], { ...defaultDeps(), stdinImpl: stdinFrom("x".repeat(ACCOUNT_IMPORT_MAX_BYTES + 1)) });
    expect(oversized.code).toBe(1);
    expect(oversized.stderr).toContain("invalid_document");
    expect(requests).toHaveLength(beforeOversized);
  });

  test("Cockpit import parses options before provider and rejects residual secrets before I/O", async () => {
    const canary = "options-before-provider-canary-DO-NOT-LEAK";
    const document = '[{"email":"user@example.com","refresh_token":"safe-fixture-token"}]';
    const ordered = await run([
      "import", "--json", "--format", "cockpit-tools", "--stdin", "google-antigravity",
    ], { ...defaultDeps(), stdinImpl: stdinFrom(document) });
    expect(ordered.code).toBe(0);
    expect(JSON.parse(ordered.stdout).importedCount).toBe(1);
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/oauth/accounts/import",
    });

    const beforeExtra = requests.length;
    const extra = await run([
      "import", "--format", "cockpit-tools", "--stdin", "google-antigravity", canary,
    ], { ...defaultDeps(), stdinImpl: stdinFrom(document) });
    expect(extra.code).toBe(1);
    expect(requests).toHaveLength(beforeExtra);
    expect(extra.output).not.toContain(canary);
  });

  test("Cockpit import source admission fails closed before POST", async () => {
    const canary = "source-admission-canary-DO-NOT-LEAK";
    const document = '[{"email":"user@example.com","refresh_token":"safe-fixture-token"}]';
    const sourceCases: Array<{ args: string[]; deps?: AccountDeps; expected?: string }> = [
      {
        args: ["import", "google-antigravity", "--format", "cockpit-tools", "--stdin", "--file", `/not-read-${canary}.json`],
        deps: { ...defaultDeps(), stdinImpl: stdinFrom(document) },
      },
      { args: ["import", "google-antigravity", "--format", "cockpit-tools"] },
      { args: ["import", "google-antigravity", "--format", "cockpit-tools", "--file"] },
      { args: ["import", "google-antigravity", "--format", "cockpit-tools", "--file", ""] },
      {
        args: ["import", "google-antigravity", "--format", "cockpit-tools", "--stdin"],
        deps: { ...defaultDeps(), stdinImpl: stdinFrom(document, true) },
        expected: "stdin_required",
      },
      {
        args: ["import", "google-antigravity", "--format", "cockpit-tools", "--stdin"],
        deps: { ...defaultDeps(), stdinImpl: stdinFrom("x".repeat(ACCOUNT_IMPORT_MAX_BYTES + 1)) },
        expected: "invalid_document",
      },
    ];

    for (const fixture of sourceCases) {
      const before = requests.length;
      const result = await run(fixture.args, fixture.deps ?? defaultDeps());
      expect(result.code).toBe(1);
      expect(requests).toHaveLength(before);
      if (fixture.expected) expect(result.stderr).toContain(fixture.expected);
      expect(result.output).not.toContain(canary);
    }

    const silent = new PassThrough() as AccountStdin;
    silent.isTTY = false;
    const beforeSilent = requests.length;
    const timedOut = await run([
      "import", "google-antigravity", "--format", "cockpit-tools", "--stdin",
    ], { ...defaultDeps(), stdinImpl: silent, stdinTimeoutMs: 5 });
    expect(timedOut.code).toBe(1);
    expect(timedOut.stderr).toContain("stdin_timeout");
    expect(requests).toHaveLength(beforeSilent);
    expect(silent.listenerCount("data")).toBe(0);
    expect(silent.listenerCount("end")).toBe(0);
    expect(silent.listenerCount("error")).toBe(0);
  });

  test("Cockpit import aborts only its hung POST at the injected timeout", async () => {
    let capturedSignal: AbortSignal | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? null;
      return await new Promise<Response>((_resolve, reject) => {
        if (!capturedSignal) return reject(new Error("missing signal"));
        if (capturedSignal.aborted) return reject(capturedSignal.reason);
        capturedSignal.addEventListener("abort", () => reject(capturedSignal?.reason), { once: true });
      });
    }) as typeof fetch;

    const result = await run([
      "import", "google-antigravity", "--format", "cockpit-tools", "--stdin",
    ], {
      ...defaultDeps(),
      fetchImpl,
      importTimeoutMs: 5,
      stdinImpl: stdinFrom('[{"email":"user@example.com","refresh_token":"safe-fixture-token"}]'),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("import_timeout after 5ms");
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("Cockpit import clears its POST timer after a successful response", async () => {
    let capturedSignal: AbortSignal | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? null;
      return json({
        totalCount: 1,
        importedCount: 1,
        updatedCount: 0,
        failedCount: 0,
        unsupportedCount: 0,
        results: [{ index: 0, status: "imported", code: "imported" }],
      });
    }) as typeof fetch;

    const result = await run([
      "import", "google-antigravity", "--format", "cockpit-tools", "--stdin", "--json",
    ], {
      ...defaultDeps(),
      fetchImpl,
      importTimeoutMs: 5,
      stdinImpl: stdinFrom('[{"email":"user@example.com","refresh_token":"safe-fixture-token"}]'),
    });
    expect(result.code).toBe(0);
    expect(capturedSignal?.aborted).toBe(false);
    await Bun.sleep(15);
    expect(capturedSignal?.aborted).toBe(false);
  });

  test("Cockpit import rejects malformed HTTP 200 result DTO without echoing payload", async () => {
    const canary = "ya29.token-shaped-cockpit-response-canary-DO-NOT-LEAK";
    const validRecord = { index: 0, status: "imported", code: "imported" };
    const validResult = {
      totalCount: 1,
      importedCount: 1,
      updatedCount: 0,
      failedCount: 0,
      unsupportedCount: 0,
      results: [validRecord],
    };
    const malformedResults: unknown[] = [
      { ...validResult, debug: canary },
      { ...validResult, results: [{ ...validRecord, token: canary }] },
      { ...validResult, importedCount: -1 },
      { ...validResult, importedCount: 0.5 },
      { ...validResult, importedCount: Number.MAX_SAFE_INTEGER + 1 },
      { totalCount: 1, importedCount: 1, updatedCount: 0, failedCount: 0, results: [validRecord] },
      { ...validResult, totalCount: 2, importedCount: 2, results: [validRecord, validRecord] },
      { ...validResult, results: [{ ...validRecord, index: 1 }] },
      { ...validResult, results: [{ status: "imported", code: "imported" }] },
      { ...validResult, importedCount: 0, failedCount: 1 },
      { ...validResult, results: [{ ...validRecord, code: "updated" }] },
      { ...validResult, importedCount: 0, failedCount: 1, results: [{ index: 0, status: "failed", code: "invalid_document" }] },
      { ...validResult, importedCount: 0, unsupportedCount: 1, results: [{ index: 0, status: "unsupported", code: "credential_rejected" }] },
      [validResult],
    ];

    for (const malformed of malformedResults) {
      importResultOverride = malformed;
      const result = await run([
        "import", "google-antigravity", "--format", "cockpit-tools", "--stdin", "--json",
      ], {
        ...defaultDeps(),
        stdinImpl: stdinFrom('[{"email":"user@example.com","refresh_token":"safe-fixture-token"}]'),
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Error: invalid_response");
      expect(result.output).not.toContain(canary);
    }
  });

  test("Cockpit import renders an accepted mixed result and exits non-zero", async () => {
    importResultOverride = {
      totalCount: 3,
      importedCount: 1,
      updatedCount: 0,
      failedCount: 1,
      unsupportedCount: 1,
      results: [
        { index: 0, status: "imported", code: "imported" },
        { index: 1, status: "failed", code: "credential_rejected" },
        { index: 2, status: "unsupported", code: "unsupported_format" },
      ],
    };
    const result = await run([
      "import", "google-antigravity", "--format", "cockpit-tools", "--stdin",
    ], {
      ...defaultDeps(),
      stdinImpl: stdinFrom('[{"email":"user@example.com","refresh_token":"safe-fixture-token"}]'),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1 imported, 0 updated, 1 failed, 1 unsupported");
    expect(result.stdout).toContain("#2 failed (credential_rejected)");
    expect(result.stdout).toContain("#3 unsupported (unsupported_format)");
  });

  test("pending Codex login keeps success and prints generic recovery guidance", async () => {
    codexLoginStatus = {
      status: "done",
      catalogRefreshPending: true,
      internalError: "private-login-detail",
    };
    const sleepSpy = spyOn(Bun, "sleep").mockImplementation(async () => {});
    try {
      const result = await run(["login", "openai"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Logged in.");
      expect(result.stderr).toContain("ocx sync");
      expect(result.output).not.toContain("private-login-detail");
    } finally {
      sleepSpy.mockRestore();
    }
  });

  test("JSON Codex login retains the pending flag without a human warning", async () => {
    codexLoginStatus = { status: "done", catalogRefreshPending: true };
    const sleepSpy = spyOn(Bun, "sleep").mockImplementation(async () => {});
    try {
      const result = await run(["login", "openai", "--json"]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        status: "done",
        catalogRefreshPending: true,
      });
      expect(result.stderr).toBe("");
    } finally {
      sleepSpy.mockRestore();
    }
  });
});
