import { describe, expect, test } from "bun:test";
import { cmdPause, cmdPauseExhausted, cmdStrategy, cmdSticky } from "../src/cli/account-extended";
import type { AccountDeps } from "../src/cli/account-api";

/**
 * #2702: pause, resume, pause-exhausted, strategy, and sticky existed as server routes with
 * no CLI caller, so steering the account pool was dashboard-only.
 *
 * The requests are asserted, not just the output. A verb that prints the right sentence while
 * calling the wrong route or method is the failure these tests exist to catch -- and the
 * method is a real trap here, since the issue reports POST and the server implements PUT.
 */
interface Captured {
  method: string;
  path: string;
  body: unknown;
}

function deps(
  respond: (captured: Captured) => { status?: number; json: unknown },
  calls: Captured[],
): AccountDeps {
  return {
    baseUrl: "http://127.0.0.1:10100",
    loadConfigImpl: () => ({ providers: { openai: { adapter: "codex" } } }) as never,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const captured: Captured = {
        method: init?.method ?? "GET",
        path: new URL(String(url)).pathname,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(captured);
      const { status = 200, json } = respond(captured);
      return new Response(JSON.stringify(json), { status });
    }) as unknown as typeof fetch,
  };
}

function capture(): { lines: string[]; errors: string[]; restore: () => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  return { lines, errors, restore: () => { console.log = log; console.error = err; } };
}

describe("ocx account pause / resume", () => {
  test("pause PUTs the shared route with paused true", async () => {
    const calls: Captured[] = [];
    const out = capture();
    let code: number;
    try {
      code = await cmdPause(["openai", "acct_1"], deps(() => ({ json: { ok: true } }), calls), true);
    } finally { out.restore(); }
    expect(code).toBe(0);
    // PUT, not POST: the issue text says POST and the server implements PUT.
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.path).toBe("/api/codex-auth/accounts/pause");
    expect(calls[0]?.body).toEqual({ id: "acct_1", paused: true });
    expect(out.lines.join("\n")).toContain("paused");
  });

  test("resume uses the SAME route with paused false", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      await cmdPause(["openai", "acct_1"], deps(() => ({ json: { ok: true } }), calls), false);
    } finally { out.restore(); }
    expect(calls[0]?.path).toBe("/api/codex-auth/accounts/pause");
    expect(calls[0]?.body).toEqual({ id: "acct_1", paused: false });
    expect(out.lines.join("\n")).toContain("resumed");
  });

  test("main resolves to the main account id", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      await cmdPause(["openai", "main"], deps(() => ({ json: { ok: true } }), calls), true);
    } finally { out.restore(); }
    expect((calls[0]?.body as { id: string }).id).not.toBe("main");
  });

  test("pausing warns about unbinding and fallback selection", async () => {
    // Both are server-side effects of this route, not consequences an operator would infer
    // from the word "pause".
    const out = capture();
    try {
      await cmdPause(["openai", "acct_1"], deps(() => ({ json: { ok: true } }), []), true);
    } finally { out.restore(); }
    expect(out.errors.join("\n")).toContain("unbound");
  });

  test("resuming does not print the pause side-effect warning", async () => {
    const out = capture();
    try {
      await cmdPause(["openai", "acct_1"], deps(() => ({ json: { ok: true } }), []), false);
    } finally { out.restore(); }
    expect(out.errors.join("\n")).not.toContain("unbound");
  });

  test("a 404 surfaces the server's reason and a non-zero code", async () => {
    const out = capture();
    let code: number;
    try {
      code = await cmdPause(["openai", "nope"], deps(() => ({ status: 404, json: { error: "Account not found" } }), []), true);
    } finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(out.errors.join("\n")).toContain("Account not found");
  });
});

describe("ocx account pause-exhausted", () => {
  test("reports which accounts were paused", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      await cmdPauseExhausted(["openai"], deps(() => ({
        json: { ok: true, pausedAccountIds: ["acct_1", "acct_2"], checkedAccountCount: 3, failedAccountCount: 0 },
      }), calls));
    } finally { out.restore(); }
    expect(calls[0]?.method).toBe("PUT");
    expect(out.lines.join("\n")).toContain("acct_1");
  });

  test("a partial quota-refresh failure is reported, not swallowed", async () => {
    // Accounts whose quota refresh failed were never evaluated. Silence would read as
    // "none were exhausted", which is a different and wrong conclusion.
    const out = capture();
    try {
      const code = await cmdPauseExhausted(["openai"], deps(() => ({
        json: { ok: true, pausedAccountIds: [], checkedAccountCount: 1, failedAccountCount: 2 },
      }), []));
      expect(code).toBe(1);
    } finally { out.restore(); }
    expect(out.errors.join("\n")).toContain("2 account(s)");
  });

  test("a partial failure is not ok:true under --json", async () => {
    const out = capture();
    try {
      const code = await cmdPauseExhausted(["openai", "--json"], deps(() => ({
        json: { ok: true, pausedAccountIds: ["acct_1"], checkedAccountCount: 2, failedAccountCount: 1 },
      }), []));
      expect(code).toBe(1);
    } finally { out.restore(); }
    const payload = JSON.parse(out.lines.join("\n")) as { ok: boolean; complete: boolean; failedAccountCount: number };
    expect(payload.ok).toBe(false);
    expect(payload.complete).toBe(false);
    expect(payload.failedAccountCount).toBe(1);
  });

  test("no exhausted accounts says so instead of printing an empty list", async () => {
    const out = capture();
    try {
      await cmdPauseExhausted(["openai"], deps(() => ({
        json: { ok: true, pausedAccountIds: [], checkedAccountCount: 2, failedAccountCount: 0 },
      }), []));
    } finally { out.restore(); }
    expect(out.lines.join("\n")).toContain("no exhausted accounts");
  });
});

describe("ocx account strategy / sticky", () => {
  test("a bare invocation READS and never writes", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      await cmdStrategy(["openai"], deps(() => ({
        json: { accountPoolStrategy: "round-robin", accountPoolStickyLimit: 4 },
      }), calls));
    } finally { out.restore(); }
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(out.lines.join("\n")).toContain("round-robin");
  });

  test("strategy and sticky share one write route", async () => {
    const strategyCalls: Captured[] = [];
    const stickyCalls: Captured[] = [];
    const out = capture();
    try {
      await cmdStrategy(["openai", "fill-first"], deps(() => ({ json: { accountPoolStrategy: "fill-first", accountPoolStickyLimit: 1 } }), strategyCalls));
      await cmdSticky(["openai", "7"], deps(() => ({ json: { accountPoolStrategy: "fill-first", accountPoolStickyLimit: 7 } }), stickyCalls));
    } finally { out.restore(); }
    expect(strategyCalls[0]?.path).toBe("/api/codex-auth/pool-strategy");
    expect(stickyCalls[0]?.path).toBe("/api/codex-auth/pool-strategy");
    expect(strategyCalls[0]?.body).toEqual({ strategy: "fill-first" });
    // Sent as a number so the server sees the type it validates.
    expect(stickyCalls[0]?.body).toEqual({ stickyLimit: 7 });
  });

  test("the APPLIED value is echoed, not the requested one", async () => {
    // The server normalizes. Printing the request would hide a normalization the operator
    // should see.
    const out = capture();
    try {
      await cmdSticky(["openai", "9"], deps(() => ({ json: { accountPoolStrategy: "quota", accountPoolStickyLimit: 3 } }), []));
    } finally { out.restore(); }
    expect(out.lines.join("\n")).toContain("3");
    expect(out.lines.join("\n")).not.toContain("9");
  });

  test("an invalid value is NOT rejected client-side; the server's 400 is surfaced", async () => {
    // The server owns the 1-100 contract. A duplicated bound is a second thing to keep in
    // sync, and its 400 is actionable now that the CLI prints `reason`.
    const calls: Captured[] = [];
    const out = capture();
    let code: number;
    try {
      code = await cmdSticky(["openai", "9999"], deps(() => ({ status: 400, json: { error: "stickyLimit must be an integer 1-100" } }), calls));
    } finally { out.restore(); }
    expect(calls).toHaveLength(1);
    expect(code).not.toBe(0);
    expect(out.errors.join("\n")).toContain("1-100");
  });
});

/**
 * The sibling gap the plan named: `/api/oauth/accounts/pool` is the SAME capability for the
 * Anthropic pool and had no verb either. A CLI that can steer one pool and not the other is a
 * trap, so the decision recorded here is one verb pair over both pools rather than a second
 * `provider-strategy`/`provider-sticky` pair.
 *
 * The route is genuinely different, and each difference gets an assertion: its own read path,
 * unprefixed response keys, and a MANDATORY `provider` in the write body without which it
 * answers 400 (`oauth-account-routes.ts:344`).
 */
describe("ocx account strategy / sticky on the anthropic pool", () => {
  function anthropicDeps(
    respond: (captured: Captured) => { status?: number; json: unknown },
    calls: Captured[],
  ): AccountDeps {
    return {
      baseUrl: "http://127.0.0.1:10100",
      // No `adapter: "codex"`: anthropic classifies as a public OAuth provider, which is what
      // routes it to the other pool.
      loadConfigImpl: () => ({ providers: { anthropic: {} } }) as never,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(String(url));
        const captured: Captured = {
          method: init?.method ?? "GET",
          path: parsed.pathname + parsed.search,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        };
        calls.push(captured);
        const { status = 200, json } = respond(captured);
        return new Response(JSON.stringify(json), { status });
      }) as unknown as typeof fetch,
    };
  }

  test("a bare read uses the pool route with provider in the query, not the codex active route", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      await cmdStrategy(["anthropic"], anthropicDeps(() => ({ json: { strategy: "round-robin", stickyLimit: 5 } }), calls));
    } finally { out.restore(); }
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/api/oauth/accounts/pool?provider=anthropic");
    // Unprefixed keys: this route spells the same settings without `accountPool`.
    expect(out.lines.join("\n")).toContain("round-robin");
  });

  test("a write carries the MANDATORY provider key alongside the field", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      await cmdSticky(["anthropic", "6"], anthropicDeps(() => ({ json: { ok: true, strategy: "quota", stickyLimit: 6 } }), calls));
    } finally { out.restore(); }
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.path).toBe("/api/oauth/accounts/pool");
    // Omitting `provider` here earns a 400 from the real route, so it is asserted exactly.
    expect(calls[0]?.body).toEqual({ provider: "anthropic", stickyLimit: 6 });
    expect(out.lines.join("\n")).toContain("6");
  });

  test("--json uses pool-neutral key names so a consumer need not branch on which pool answered", async () => {
    const out = capture();
    try {
      await cmdStrategy(["anthropic", "--json"], anthropicDeps(() => ({ json: { strategy: "fill-first", stickyLimit: 2 } }), []));
    } finally { out.restore(); }
    expect(JSON.parse(out.lines.join("\n"))).toMatchObject({ provider: "anthropic", strategy: "fill-first", stickyLimit: 2 });
  });

  test("the codex pool keeps its own prefixed keys mapped onto the same neutral output", async () => {
    const out = capture();
    try {
      await cmdStrategy(["openai", "--json"], deps(() => ({ json: { accountPoolStrategy: "quota", accountPoolStickyLimit: 1 } }), []));
    } finally { out.restore(); }
    expect(JSON.parse(out.lines.join("\n"))).toMatchObject({ provider: "openai", strategy: "quota", stickyLimit: 1 });
  });

  test("a provider without an OAuth pool is refused WITHOUT a round-trip", async () => {
    const calls: Captured[] = [];
    const out = capture();
    let code: number;
    try {
      code = await cmdStrategy(["gemini"], {
        baseUrl: "http://127.0.0.1:10100",
        loadConfigImpl: () => ({ providers: { gemini: {} } }) as never,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ method: init?.method ?? "GET", path: new URL(String(url)).pathname, body: undefined });
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      });
    } finally { out.restore(); }
    expect(code).not.toBe(0);
    // The route would answer 400; spending the request to learn that is the thing avoided.
    expect(calls).toHaveLength(0);
    expect(out.errors.join("\n")).toContain("pool settings apply to OAuth account pools");
  });
});

describe("generic OAuth pool-settings contract (#695)", () => {
  const { cmdAutoSwitch } = require("../src/cli/account-extended") as typeof import("../src/cli/account-extended");
  function genericDeps(
    respond: (captured: Captured) => { status?: number; json: unknown },
    calls: Captured[],
    providers: Record<string, unknown> = { "google-antigravity": { authMode: "oauth" } },
  ): AccountDeps {
    return {
      baseUrl: "http://127.0.0.1:10100",
      loadConfigImpl: () => ({ providers }) as never,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(String(url));
        const captured: Captured = {
          method: init?.method ?? "GET",
          path: parsed.pathname + parsed.search,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        };
        calls.push(captured);
        const { status = 200, json } = respond(captured);
        return new Response(JSON.stringify(json), { status });
      }) as unknown as typeof fetch,
    };
  }

  test("strategy on google-antigravity goes to the shared pool route with the provider key", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      await cmdStrategy(["google-antigravity", "round-robin"], genericDeps(() => ({ json: { ok: true, strategy: "round-robin", stickyLimit: null } }), calls));
    } finally { out.restore(); }
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/api/oauth/accounts/pool", body: { provider: "google-antigravity", strategy: "round-robin" } });
  });

  test("auto-switch on a generic provider writes autoSwitchThreshold through the pool route", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      expect(await cmdAutoSwitch(["google-antigravity", "threshold", "90"], genericDeps(() => ({ json: { ok: true, autoSwitchThreshold: 90 } }), calls))).toBe(0);
    } finally { out.restore(); }
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/api/oauth/accounts/pool", body: { provider: "google-antigravity", autoSwitchThreshold: 90 } });
    expect(out.lines.join("\n")).toContain("threshold 90%");
  });

  test("api-key providers are still refused before any request", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      expect(await cmdStrategy(["deepseek", "quota"], genericDeps(() => ({ json: {} }), calls, { deepseek: { apiKey: "x" } }))).not.toBe(0);
    } finally { out.restore(); }
    expect(calls).toHaveLength(0);
    expect(out.errors.join("\n")).toContain("API-key provider");
  });
});
