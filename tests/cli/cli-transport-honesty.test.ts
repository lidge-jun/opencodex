import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeApiError, runtimeRequest } from "../../src/cli/runtime-api";
import { apiError, apiJson, proxyUnreachable } from "../../src/cli/account-api";
import { assertNotAdminToken, assertServiceAuthEnvironment } from "../../src/service";
import { dataPlaneCredentialCollisionCheck } from "../../src/cli/doctor";
import type { AccountDeps } from "../../src/cli/account-api";
import { repoPath } from "../helpers/repo-root";

/**
 * wp2 (#2696 #2697 #2698): the CLI must not lie about a failed management call.
 *
 * Three defects made unattended operation impossible: a runner that discarded its
 * handler's exit code, an error renderer that dropped the server's `reason`/`hint`,
 * and a service installer that would happily write a management token into the
 * data-plane secret and fence the whole management API closed.
 */

const DISPATCH_SOURCE = readFileSync(repoPath("src", "cli", "dispatch.ts"), "utf8");

/**
 * Matches `await someHandler(...); return 0;` — the shape that silently discards a
 * handler's failure.
 *
 * Two scoping decisions, both learned from a review that caught this test being too
 * narrow:
 *
 * - `[^;]*` rather than `[^)]*`: argument lists here contain nested calls
 *   (`deps.args.slice(1)`), so a `[^)]*` form stops at the inner `)` and matches
 *   neither the provider nor the models runner. It would have greened while the
 *   regression it guards was present.
 * - `[\w.]+` rather than `handle\w+`: anchoring on the `handle*` naming convention made
 *   the guard blind to `tray`, whose handler is `windowsTrayCommand` and which carried
 *   the identical defect. The defect class is "await a handler, then return a literal
 *   0", not "await a function whose name begins with handle".
 *
 * Exemptions belong in the allowlist below, where they need a stated reason — not in
 * the pattern, where they would be invisible.
 */
const SWALLOWED_EXIT_CODE = /await\s+[\w.]+\([^;]*\);\s*\n\s*return 0;/g;

/**
 * Runners whose handler cannot return a failure through `process.exitCode`, so a
 * literal 0 is honest.
 *
 * Every entry was found by this guard rather than assumed, and each was verified by
 * reading its handler. The mechanism differs between them, which is why the reason
 * matters more than the name:
 *
 * - `debug` — `handleDebugCommand` calls `process.exit(1)` on every failure path (12
 *   sites in debug.ts, including the fallthrough), so control cannot reach `return 0`
 *   after a failure.
 * - `login` — exits 1 for an unknown provider; for a real OAuth failure `runLogin`
 *   THROWS and the error propagates out past the runner.
 * - `update` — `runUpdate` calls `process.exit(1)` on every failure path (6 sites in
 *   update/index.ts). Its early `return 0` is the deliberate `--help` short-circuit.
 * - `__refresh-version`, `__tray-host`, `__gui-update-worker` — hidden helpers whose
 *   handlers never assign `process.exitCode`, so there is no code to preserve.
 *   `__gui-update-worker` returns 1 directly for a missing job id.
 *
 * This is narrower than "these commands always succeed", and it is not a claim that
 * their exit-code handling is ideal — a throw-based failure produces an unhandled
 * rejection rather than a chosen exit code. Making that uniform belongs to wp3b
 * (devlog 025), not to this phase's management-transport scope.
 *
 * Adding a name here requires a reason of this kind, verified in the handler. A review
 * of this phase caught `tray` sitting outside the then-narrower pattern with the
 * identical defect, which is why the pattern is now name-agnostic and the exemptions
 * live here instead.
 */
const CANNOT_FAIL_ALLOWLIST = new Set([
  "debug",
  "login",
  "update",
  "__refresh-version",
  "__tray-host",
  "__gui-update-worker",
]);

function swallowingRunners(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SWALLOWED_EXIT_CODE)) {
    const before = source.slice(0, match.index ?? 0);
    // The nearest preceding `name: async deps =>` is the runner that owns this body.
    const runner = [...before.matchAll(/^\s{2}([a-z0-9-]+|"[^"]+"):\s*async/gm)].pop();
    found.push(runner?.[1]?.replace(/"/g, "") ?? "<unknown>");
  }
  return found;
}

describe("#2697 dispatch runners preserve handler exit codes", () => {
  test("the guard pattern matches the pre-fix shape (red-first)", () => {
    // The exact bodies the fix removed. If this fails, the pattern below is vacuous
    // and cannot protect anything.
    const preFix = [
      "  provider: async deps => {",
      '    const { handleProviderCommand } = await import("./provider");',
      "    await handleProviderCommand(deps.args.slice(1));",
      "    return 0;",
      "  },",
    ].join("\n");
    expect(preFix.match(SWALLOWED_EXIT_CODE)).not.toBeNull();
  });

  test("no runner discards a handler exit code outside the allowlist", () => {
    const offenders = swallowingRunners(DISPATCH_SOURCE).filter(name => !CANNOT_FAIL_ALLOWLIST.has(name));
    expect(offenders).toEqual([]);
  });

  test("provider and models return process.exitCode rather than a literal 0", () => {
    for (const runner of ["provider", "models"]) {
      const body = DISPATCH_SOURCE.split(new RegExp(`^  ${runner}: async`, "m"))[1] ?? "";
      const upToNext = body.split(/^  [a-z]/m)[0] ?? "";
      expect(upToNext, `${runner} runner must propagate process.exitCode`)
        .toContain("Number(process.exitCode ?? 0)");
    }
  });
});

describe("#2698 the status mapping and transport cause are actually reachable", () => {
  /**
   * The first review of this phase found both additions were dead code: apiError
   * accepted a status no caller passed, and apiJson recorded a transportError no caller
   * read. A capability that exists only in its own unit test is not a fix, so these
   * assertions are about the CALL SITES rather than the helpers.
   */
  const SOURCES = ["account.ts", "account-extended.ts", "account-main.ts"].map(name =>
    readFileSync(repoPath("src", "cli", name), "utf8"));

  test("every apiError call site forwards the response status", () => {
    const bare: string[] = [];
    for (const source of SOURCES) {
      for (const line of source.split("\n")) {
        if (!line.includes("apiError(")) continue;
        if (line.includes("export function apiError")) continue;
        // Third argument present means the 404 -> 4 / 409 -> 5 mapping can fire.
        if (!/\.status\s*\)\s*;?\s*$/.test(line.trim())) bare.push(line.trim());
      }
    }
    expect(bare).toEqual([]);
  });

  test("proxyUnreachable call sites guarded by status === 0 forward the cause", () => {
    const bare: string[] = [];
    for (const source of SOURCES) {
      for (const line of source.split("\n")) {
        if (!/status === 0.*proxyUnreachable\(/.test(line)) continue;
        if (!line.includes("transportError")) bare.push(line.trim());
      }
    }
    // One site used to be allowed to call proxyUnreachable() bare on a quota-report
    // shape; that path now forwards transportError too.
    expect(bare).toEqual([]);
  });
});

describe("#2696 doctor names the credential collision", () => {
  const ADMIN = `ocx_admin_${"a".repeat(43)}`;

  test("reports OK when no data-plane token is set", () => {
    const check = dataPlaneCredentialCollisionCheck({} as NodeJS.ProcessEnv, null);
    expect(check.level).toBe("OK");
  });

  test("reports OK when the two credentials are distinct", () => {
    const check = dataPlaneCredentialCollisionCheck({ OPENCODEX_API_AUTH_TOKEN: "ocx_data_live" } as NodeJS.ProcessEnv, null);
    expect(check.level).toBe("OK");
  });

  test("fails and names the remedy when the admin token is the data-plane secret", () => {
    const check = dataPlaneCredentialCollisionCheck({ OPENCODEX_API_AUTH_TOKEN: ADMIN } as NodeJS.ProcessEnv, null);
    // FAIL, not WARN: while this holds every /api/* returns 503, so the management
    // surface is unusable rather than degraded.
    expect(check.level).toBe("FAIL");
    expect(check.message).toContain("management (admin) token");
    expect(check.message).toContain("Action:");
    // Never echo the credential itself, even in a diagnostic.
    expect(check.message).not.toContain(ADMIN);
  });

  test("fails when the installed service token file collides and the doctor shell has no env", () => {
    // Production doctor almost never has OPENCODEX_API_AUTH_TOKEN; the service wrapper
    // re-exports the file. Passing null-env + the file token is the already-broken install.
    const check = dataPlaneCredentialCollisionCheck({} as NodeJS.ProcessEnv, ADMIN);
    expect(check.level).toBe("FAIL");
    expect(check.message).toContain("service token file");
    expect(check.message).not.toContain(ADMIN);
  });
});

describe("#2698 management errors carry reason and hint", () => {
  async function messageFor(body: unknown, status: number): Promise<string> {
    try {
      await runtimeRequest("/api/config", {}, {
        baseUrl: "http://127.0.0.1:10100",
        fetchImpl: async () => Response.json(body, { status }),
      });
    } catch (error) {
      if (error instanceof RuntimeApiError) return error.message;
      throw error;
    }
    throw new Error("expected a RuntimeApiError");
  }

  test("a 503 renders the primary message, the reason and the hint", async () => {
    const message = await messageFor(
      {
        error: "management API unavailable",
        reason: "management credential conflicts with a data-plane credential",
        hint: "unset OPENCODEX_API_AUTH_TOKEN and reinstall the service",
      },
      503,
    );
    expect(message).toContain("management API unavailable");
    expect(message).toContain("reason: management credential conflicts with a data-plane credential");
    expect(message).toContain("hint: unset OPENCODEX_API_AUTH_TOKEN and reinstall the service");
  });

  test("a reason-only body does not degrade to the generic message", async () => {
    // Several routes return {ok:false, reason:"…"} with no error key at all.
    const message = await messageFor({ ok: false, reason: "home_mismatch" }, 409);
    expect(message).toContain("home_mismatch");
  });

  test("an opaque body still reports the status", async () => {
    const message = await messageFor({ ok: false }, 500);
    expect(message).toContain("500");
  });

  test("a reason identical to the primary message is not repeated", async () => {
    const message = await messageFor({ error: "catalog_busy", reason: "catalog_busy" }, 503);
    expect(message.match(/catalog_busy/g)).toHaveLength(1);
  });
});

describe("#2698 the account client keeps the transport cause and maps status codes", () => {
  const deps = { fetchImpl: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:10100"); } } as unknown as AccountDeps;

  test("a transport failure reports status 0 and retains the cause", async () => {
    const result = await apiJson(deps, "http://127.0.0.1:10100", "GET", "/api/codex-auth/accounts");
    expect(result.status).toBe(0);
    expect(result.transportError).toContain("ECONNREFUSED");
  });

  test("apiError maps 404 to 4 and 409 to 5, matching the runtime client", () => {
    expect(apiError({ error: "no such account" }, "fallback", 404)).toBe(4);
    expect(apiError({ error: "busy" }, "fallback", 409)).toBe(5);
    expect(apiError({ error: "boom" }, "fallback", 500)).toBe(1);
  });

  test("proxyUnreachable surfaces the transport cause when given one", () => {
    expect(proxyUnreachable("connect ECONNREFUSED")).toBe(1);
    expect(proxyUnreachable()).toBe(1);
  });
});

describe("#2696 a management token is refused as the data-plane secret", () => {
  const ADMIN = `ocx_admin_${"a".repeat(43)}`;

  test("assertNotAdminToken rejects an ocx_admin_ value with an actionable message", () => {
    expect(() => assertNotAdminToken(ADMIN)).toThrow(/management \(admin\) token/);
    expect(() => assertNotAdminToken(ADMIN)).toThrow(/OPENCODEX_API_AUTH_TOKEN/);
  });

  test("assertNotAdminToken accepts a distinct data-plane secret", () => {
    expect(() => assertNotAdminToken("ocx_data_live_secret")).not.toThrow();
    expect(() => assertNotAdminToken("local-secret")).not.toThrow();
  });

  test("assertNotAdminToken rejects a non-prefixed admin token equal to the configured value", () => {
    expect(() => assertNotAdminToken("shared-secret", {
      OPENCODEX_ADMIN_AUTH_TOKEN: "shared-secret",
    } as NodeJS.ProcessEnv)).toThrow(/management \(admin\) token/);
  });

  test("assertServiceAuthEnvironment refuses the collision even on loopback", () => {
    // The loopback short-circuit used to return before any token check, which is how
    // an install could produce a service whose management plane was fenced closed.
    const previous = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.OPENCODEX_API_AUTH_TOKEN = ADMIN;
      expect(() => assertServiceAuthEnvironment()).toThrow(/management \(admin\) token/);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = previous;
    }
  });

  test("handleStart asserts the token it is about to export", () => {
    const source = readFileSync(repoPath("src", "cli", "index.ts"), "utf8");
    expect(source).toContain("assertNotAdminToken(present)");
  });

  test("familyFailure forwards the transport cause", () => {
    const source = readFileSync(repoPath("src", "cli", "account-extended.ts"), "utf8");
    expect(source).toMatch(/networkDown\) return proxyUnreachable\(result\.transportError\)/);
  });
});
