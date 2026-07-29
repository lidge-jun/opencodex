import { describe, expect, test } from "bun:test";
import { accountNeedsReauth } from "../src/oauth-health-display";
import { buildActiveAccountNeedsReauthMap } from "../src/hooks/useProviderAccountPools";

/**
 * Aggregate-path regressions: health-only `reauth_required` must demote Providers
 * overview / rail attention the same way row CTAs already do. Fixtures intentionally
 * omit emails/tokens — never assert raw account identifiers into attention state.
 */

describe("Codex callback aggregate path", () => {
  test("activePoolNeedsReauth (health-aware) is what the callback propagates", async () => {
    const pool = await Bun.file(new URL("../src/components/CodexAccountPool.tsx", import.meta.url)).text();
    expect(pool).toContain("accountNeedsReauth(activePoolAccount)");
    expect(pool).toContain("onActiveNeedsReauthChange?.(activePoolNeedsReauth)");
    expect(pool).toContain("[activePoolNeedsReauth, onActiveNeedsReauthChange]");
    // Legacy-only controller flag must not be the callback dependency.
    expect(pool).not.toContain("onActiveNeedsReauthChange?.(activeNeedsReauth)");
    expect(pool).not.toMatch(/\[activeNeedsReauth,\s*onActiveNeedsReauthChange\]/);
  });

  test("shared Codex controller derives activeNeedsReauth from health as well", async () => {
    const hook = await Bun.file(new URL("../src/hooks/useCodexAccountPool.ts", import.meta.url)).text();
    expect(hook).toContain("const activeAccount = activePoolAccount ?? mainAccount");
    expect(hook).toContain("!activeAccount?.paused && accountNeedsReauth(activeAccount)");
    expect(hook).not.toMatch(/activePoolAccount\s*\?\s*Boolean\(activePoolAccount\.needsReauth\)/);
  });

  test("health-only reauth_required marks the active Codex account", () => {
    // Mirrors CodexAccountPool's activePoolNeedsReauth / controller activeNeedsReauth.
    expect(accountNeedsReauth({
      needsReauth: undefined,
      health: { status: "reauth_required", reason: "refresh_failed" },
    })).toBe(true);
    expect(accountNeedsReauth({
      needsReauth: undefined,
      health: { status: "healthy" },
    })).toBe(false);
  });
});

describe("generic provider map aggregate path", () => {
  test("health-only reauth_required on the active account demotes the provider", () => {
    const map = buildActiveAccountNeedsReauthMap({
      anthropic: {
        activeAccountId: "acct_active",
        accounts: [
          {
            id: "acct_active",
            active: true,
            health: { status: "reauth_required", reason: "refresh_failed" },
          },
          {
            id: "acct_other",
            active: false,
            needsReauth: true,
          },
        ],
      },
      xai: {
        activeAccountId: "xai_ok",
        accounts: [
          {
            id: "xai_ok",
            active: true,
            health: { status: "healthy" },
          },
        ],
      },
    });
    expect(map).toEqual({ anthropic: true });
  });

  test("inactive-only reauth does not demote the provider", () => {
    const map = buildActiveAccountNeedsReauthMap({
      anthropic: {
        activeAccountId: "acct_active",
        accounts: [
          { id: "acct_active", active: true, health: { status: "healthy" } },
          { id: "acct_stale", active: false, health: { status: "reauth_required" } },
        ],
      },
    });
    expect(map).toEqual({});
  });

  test("legacy needsReauth and Codex overlay still mark providers", () => {
    const map = buildActiveAccountNeedsReauthMap(
      {
        kimi: {
          activeAccountId: "kimi_1",
          accounts: [{ id: "kimi_1", active: true, needsReauth: true }],
        },
      },
      true,
    );
    expect(map).toEqual({ kimi: true, openai: true });
  });
});
