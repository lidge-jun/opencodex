import { describe, expect, test } from "bun:test";
import { cmdAccount } from "../../src/cli/account";
import type { AccountDeps } from "../../src/cli/account-api";
import type { OcxConfig } from "../../src/types";

/**
 * Resolving an account argument that is an alias, and the reserved word `auto`.
 *
 * Kept out of the `#180` matrix file because that one sits at its file-size ratchet cap; the
 * harness these cases need is small enough to stand on its own. The requests are asserted, not
 * just the output: a verb that prints the right sentence while writing the alias through as an
 * id is the failure this exists to catch.
 */
interface Captured {
  method: string;
  path: string;
  body: unknown;
}

interface Harness {
  requests: Captured[];
  accounts: Array<Record<string, unknown>>;
  listFailure: { status: number; error: string } | null;
  run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  writes: () => Captured[];
}

function harness(providers: Record<string, unknown> = {}): Harness {
  const requests: Captured[] = [];
  const state: Harness = {
    requests,
    accounts: [{ id: "chatgpt_1", plan: "pro", quota: null }],
    listFailure: null,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    writes: () => requests.filter(r => r.method === "PUT" && r.path === "/api/codex-auth/active"),
  };
  const config = (): OcxConfig => ({
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      ...providers,
    },
  }) as unknown as OcxConfig;
  const deps: AccountDeps = {
    baseUrl: "http://127.0.0.1:10100",
    loadConfigImpl: config,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const captured: Captured = {
        method: init?.method ?? "GET",
        path: new URL(String(url)).pathname,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      requests.push(captured);
      if (captured.path === "/api/codex-auth/accounts" && captured.method === "GET") {
        if (state.listFailure) {
          return new Response(JSON.stringify({ error: state.listFailure.error }), { status: state.listFailure.status });
        }
        return new Response(JSON.stringify({ accounts: state.accounts }), { status: 200 });
      }
      if (captured.path === "/api/codex-auth/active") {
        const pinned = captured.method === "PUT"
          ? (captured.body as { accountId?: string | null } | undefined)?.accountId ?? null
          : null;
        return new Response(JSON.stringify({ ok: true, activeCodexAccountId: pinned, activeId: pinned }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch,
  };
  state.run = async (args: string[]) => {
    const lines: string[] = [];
    const errs: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
    try {
      const code = await cmdAccount(args, deps);
      return { code, stdout: lines.join("\n"), stderr: errs.join("\n") };
    } finally {
      console.log = log;
      console.error = err;
    }
  };
  return state;
}

describe("ocx account: alias and auto as account arguments", () => {
  test.each(["Main", "MAIN", "__MAIN__", "Auto", "AUTO"])("%s cannot shadow a reserved selector by case", async (reserved) => {
    const h = harness();
    const result = await h.run(["alias", "openai", "chatgpt_1", reserved]);
    expect(result.code).toBe(1);
    expect(h.requests).toHaveLength(0);
  });

  test.each([
    ["use", "openai", "missing"],
    ["priority", "openai", "missing", "first"],
    ["pause", "openai", "missing"],
    ["resume", "openai", "missing"],
    ["clear-cooldown", "openai", "missing"],
    ["alias", "openai", "missing", "work"],
  ])("%s keeps exit code 4 for a missing account", async (...args) => {
    const h = harness();
    const result = await h.run(args);
    expect(result.code).toBe(4);
    expect(h.requests.every(request => request.method === "GET")).toBe(true);
  });

  test("priority reads and remove preserve their local existence-check exit code", async () => {
    const h = harness();
    expect((await h.run(["priority", "openai", "missing"])).code).toBe(1);
    expect((await h.run(["remove", "openai", "missing", "--yes"])).code).toBe(1);
    expect(h.requests.every(request => request.method === "GET")).toBe(true);
  });

  test.each(["main", "__main__"])("%s stays a main-login selector and cannot become a pool alias", async (reserved) => {
    const h = harness();
    const renamed = await h.run(["alias", "openai", "chatgpt_1", reserved]);

    expect(renamed.code).toBe(1);
    expect(renamed.stderr).toContain("reserved");
    expect(h.requests).toHaveLength(0);

    const selected = await h.run(["use", "openai", reserved]);
    expect(selected.code).toBe(0);
    expect(h.writes().at(-1)?.body).toEqual({ accountId: "__main__" });
  });

  test.each([
    {
      family: "OAuth",
      provider: "anthropic",
      config: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
      path: "/api/oauth/accounts/alias",
      body: { provider: "anthropic", accountId: "account_1", alias: "auto" },
    },
    {
      family: "API-key",
      provider: "openrouter",
      config: { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", authMode: "key" },
      path: "/api/providers/keys/alias",
      body: { name: "openrouter", id: "account_1", alias: "auto" },
    },
  ])("$family aliases keep accepting auto as a display name", async ({ provider, config, path, body }) => {
    const h = harness({ [provider]: config });
    const result = await h.run(["alias", provider, "account_1", "auto", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, provider, alias: "auto" });
    expect(h.requests).toEqual([{ method: "PUT", path, body }]);
  });

  test("use resolves an alias to the stored account id", async () => {
    const h = harness();
    h.accounts.push({ id: "chatgpt_2", alias: "sub2", plan: "pro", quota: null });
    const result = await h.run(["use", "openai", "sub2"]);

    expect(result.code).toBe(0);
    expect(h.writes().at(-1)?.body).toEqual({ accountId: "chatgpt_2" });
    expect(result.stdout).toContain("chatgpt_2");
  });

  test("use auto clears the pin and says the pool decides from here", async () => {
    const h = harness();
    const result = await h.run(["use", "openai", "auto"]);

    expect(result.code).toBe(0);
    expect(h.writes().at(-1)?.body).toEqual({ accountId: null });
    expect(result.stdout).toContain("automatic account selection");
    expect(result.stderr).not.toContain("may override this pin");
  });

  test("missing and ambiguous aliases keep distinct errors before any write", async () => {
    const h = harness();
    h.accounts.push(
      { id: "chatgpt_2", alias: "Work", plan: "pro", quota: null },
      { id: "chatgpt_3", alias: "work", plan: "pro", quota: null },
    );
    const missing = await h.run(["use", "openai", "nope"]);
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain('Account not found: no Codex account has the id or alias "nope"');
    const ambiguous = await h.run(["use", "openai", "WORK"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("names 2 accounts");
    expect(h.writes()).toHaveLength(0);
    // An exact match wins over the case-folded one.
    const exact = await h.run(["use", "openai", "Work"]);
    expect(exact.code).toBe(0);
    expect(h.writes().at(-1)?.body).toEqual({ accountId: "chatgpt_2" });
  });

  test("priority, pause and clear-cooldown accept the alias too", async () => {
    const h = harness();
    h.accounts.push({ id: "chatgpt_2", alias: "sub2", plan: "pro", quota: null });
    const priority = await h.run(["priority", "openai", "sub2", "first"]);
    expect(priority.code).toBe(0);
    expect(h.requests.filter(r => r.path === "/api/codex-auth/accounts/priority").at(-1)?.body)
      .toMatchObject({ id: "chatgpt_2" });
    const pause = await h.run(["pause", "openai", "sub2"]);
    expect(pause.code).toBe(0);
    expect(h.requests.filter(r => r.path === "/api/codex-auth/accounts/pause").at(-1)?.body)
      .toEqual({ id: "chatgpt_2", paused: true });
    const missing = await h.run(["pause", "openai", "nope"]);
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain('Account not found: no Codex account has the id or alias "nope"');
  });

  test("auto is reserved for Codex pool verbs, and a broken account list falls back to the id as given", async () => {
    const h = harness();
    const rename = await h.run(["alias", "openai", "chatgpt_1", "auto"]);
    expect(rename.code).toBe(1);
    expect(rename.stderr).toContain("reserved");
    expect(h.requests.some(r => r.path === "/api/codex-auth/accounts/alias")).toBe(false);
    const pause = await h.run(["pause", "openai", "auto"]);
    expect(pause.code).toBe(1);
    expect(pause.stderr).toContain("reserved");
    // The list only serves alias resolution: without it the argument is sent as an id, as before.
    h.listFailure = { status: 500, error: "list unavailable" };
    const raw = await h.run(["use", "openai", "chatgpt_1"]);
    expect(raw.code).toBe(0);
    expect(h.writes().at(-1)?.body).toEqual({ accountId: "chatgpt_1" });
  });
});
