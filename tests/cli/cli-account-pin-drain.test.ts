import { describe, expect, test } from "bun:test";
import { cmdAccount } from "../../src/cli/account";
import type { AccountDeps } from "../../src/cli/account-api";

/**
 * #4521: `ocx account use` printed "auto-switch (threshold 80%) may override this pin"
 * whether or not the pin was already spent, so the one case that needed a definite sentence
 * got the same hedge as the healthy case. The route now reports the drain it evaluated.
 */
const BASE_URL = "http://127.0.0.1:10100";

function deps(
  putJson: Record<string, unknown>,
  thresholdJson: Record<string, unknown>,
  accounts = [{ id: putJson.activeCodexAccountId, autoSwitchThresholdOverride: null as number | null }],
): AccountDeps {
  return {
    baseUrl: BASE_URL,
    loadConfigImpl: () => ({ providers: { openai: { adapter: "codex" } } }) as never,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/codex-auth/active" && (init?.method ?? "GET") === "PUT") {
        return new Response(JSON.stringify(putJson), { status: 200 });
      }
      if (path === "/api/codex-auth/active") {
        return new Response(JSON.stringify(thresholdJson), { status: 200 });
      }
      if (path === "/api/codex-auth/accounts") {
        return Response.json({ accounts });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch,
  };
}

async function run(args: string[], accountDeps: AccountDeps): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  try {
    const code = await cmdAccount(args, accountDeps);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("account use pin-drain reporting", () => {
  test("a reported quota drain is stated, not hedged", async () => {
    const result = await run(["use", "openai", "pool_hot"], deps({
      ok: true,
      activeCodexAccountId: "pool_hot",
      appliesImmediately: true,
      pinDrained: true,
      pinDrainReason: "quota_threshold",
    }, { autoSwitchThreshold: 80 }));

    expect(result.code).toBe(0);
    expect(result.err).toContain("is at or above the auto-switch threshold (80%)");
    expect(result.err).toContain("routing releases this pin on its next request");
    expect(result.err).not.toContain("may override this pin");
  });

  test("a non-quota drain names its own reason", async () => {
    const result = await run(["use", "openai", "pool_gone"], deps({
      ok: true,
      activeCodexAccountId: "pool_gone",
      appliesImmediately: true,
      pinDrained: true,
      pinDrainReason: "needs_reauth",
    }, { autoSwitchThreshold: 80 }));

    expect(result.code).toBe(0);
    expect(result.err).toContain("cannot currently be selected (needs_reauth)");
    expect(result.err).not.toContain("auto-switch threshold");
  });

  test("a reported quota drain names the selected account's override", async () => {
    const result = await run(["use", "openai", "pool_hot"], deps({
      ok: true,
      activeCodexAccountId: "pool_hot",
      pinDrained: true,
      pinDrainReason: "quota_threshold",
    }, { autoSwitchThreshold: 80 }, [
      { id: "pool_other", autoSwitchThresholdOverride: 95 },
      { id: "pool_hot", autoSwitchThresholdOverride: 60 },
    ]));

    expect(result.code).toBe(0);
    expect(result.err).toContain("is at or above the auto-switch threshold (60%)");
    expect(result.err).toContain("routing releases this pin on its next request");
    expect(result.err).not.toContain("80%");
    expect(result.err).not.toContain("95%");
    expect(result.err).not.toContain("may override this pin");
  });

  test("no reported drain keeps the generic caveat", async () => {
    const result = await run(["use", "openai", "pool_cool"], deps({
      ok: true,
      activeCodexAccountId: "pool_cool",
      appliesImmediately: true,
    }, { autoSwitchThreshold: 80 }));

    expect(result.code).toBe(0);
    expect(result.err).toContain("auto-switch (threshold 80%) may override this pin");
    expect(result.err).not.toContain("routing releases this pin");
  });

  test("--json carries the two fields through", async () => {
    const result = await run(["use", "openai", "pool_hot", "--json"], deps({
      ok: true,
      activeCodexAccountId: "pool_hot",
      appliesImmediately: true,
      pinDrained: true,
      pinDrainReason: "quota_threshold",
    }, { autoSwitchThreshold: 80 }));

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true,
      provider: "openai",
      type: "codex",
      pinDrained: true,
      pinDrainReason: "quota_threshold",
    });
  });
});
