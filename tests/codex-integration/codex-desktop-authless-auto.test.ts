import { beforeEach, describe, expect, test } from "bun:test";
import {
  resetDesktopAuthlessAutoForTests,
  runDesktopAuthlessAuto,
  type DesktopAuthlessAutoDeps,
} from "../../src/codex/desktop-authless-auto";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import type { StoredAccountQuota } from "../../src/codex/quota";
import type { OcxConfig } from "../../src/types";

const NOW = 1_800_000_000_000;

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    codexDesktopAuthlessAuto: true,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    ...overrides,
  };
}

function quota(overrides: Partial<StoredAccountQuota> = {}): StoredAccountQuota {
  return { updatedAt: NOW, shortPercent: 100, weeklyPercent: 20, ...overrides };
}

interface SpyDeps extends Required<Pick<DesktopAuthlessAutoDeps,
  "persistSetting" | "applyInjection" | "restartClients" | "refreshQuota">> {
  calls: string[];
}

function spies(current: { quota: StoredAccountQuota | null }): SpyDeps & DesktopAuthlessAutoDeps {
  const calls: string[] = [];
  return {
    calls,
    getQuota: (accountId: string) => {
      expect(accountId).toBe(MAIN_CODEX_ACCOUNT_ID);
      return current.quota;
    },
    refreshQuota: async () => { calls.push("refresh"); },
    persistSetting: (cfg, enabled) => {
      calls.push(`persist:${enabled}`);
      if (enabled) cfg.codexDesktopAuthless = true;
      else delete cfg.codexDesktopAuthless;
      return true;
    },
    applyInjection: async () => { calls.push("apply"); return { applied: true }; },
    restartClients: async () => { calls.push("restart"); },
  };
}

beforeEach(() => { resetDesktopAuthlessAutoForTests(); });

describe("desktop authless auto failover", () => {
  test("does nothing when the auto setting is off", async () => {
    const cfg = config({ codexDesktopAuthlessAuto: undefined });
    const deps = spies({ quota: quota() });
    const result = await runDesktopAuthlessAuto(cfg, deps);
    expect(result.acted).toBe(false);
    expect(deps.calls).toEqual([]);
    expect(cfg.codexDesktopAuthless).toBeUndefined();
  });

  test("engages authless routing when the main quota is exhausted", async () => {
    const cfg = config();
    const deps = spies({ quota: quota() });
    const result = await runDesktopAuthlessAuto(cfg, deps);
    expect(result).toEqual({ acted: true, exhausted: true, authless: true });
    expect(deps.calls).toEqual(["persist:true", "apply", "restart"]);
    expect(cfg.codexDesktopAuthless).toBe(true);
  });

  test("stays engaged without acting while exhaustion persists", async () => {
    const cfg = config({ codexDesktopAuthless: true });
    const deps = spies({ quota: quota() });
    const result = await runDesktopAuthlessAuto(cfg, deps);
    expect(result).toEqual({ acted: false, exhausted: true, authless: true });
    expect(deps.calls).toEqual([]);
  });

  test("releases authless routing once a forced refresh confirms recovery", async () => {
    const cfg = config({ codexDesktopAuthless: true });
    const current = { quota: quota({ shortPercent: 12 }) as StoredAccountQuota | null };
    const deps = spies(current);
    deps.refreshQuota = async () => {
      deps.calls.push("refresh");
      current.quota = quota({ shortPercent: 12, weeklyPercent: 20 });
    };
    const result = await runDesktopAuthlessAuto(cfg, deps);
    expect(result).toEqual({ acted: true, exhausted: false, authless: false });
    expect(deps.calls).toEqual(["refresh", "persist:false", "apply", "restart"]);
    expect(cfg.codexDesktopAuthless).toBeUndefined();
  });

  test("stays engaged when the confirmation refresh still reports exhaustion", async () => {
    const cfg = config({ codexDesktopAuthless: true });
    // Cached snapshot looks recovered, but the forced upstream read disagrees.
    const current = { quota: quota({ shortPercent: 12 }) as StoredAccountQuota | null };
    const deps = spies(current);
    deps.refreshQuota = async () => {
      deps.calls.push("refresh");
      current.quota = quota();
    };
    const result = await runDesktopAuthlessAuto(cfg, deps);
    expect(result.acted).toBe(false);
    expect(deps.calls).toEqual(["refresh"]);
    expect(cfg.codexDesktopAuthless).toBe(true);
  });

  test("skips non-pool account modes and client-role processes", async () => {
    const direct = config();
    direct.providers.openai = { ...direct.providers.openai, codexAccountMode: "direct" };
    const directDeps = spies({ quota: quota() });
    expect((await runDesktopAuthlessAuto(direct, directDeps)).acted).toBe(false);
    expect(directDeps.calls).toEqual([]);

    const client = config({ runtimeRole: "client" });
    const clientDeps = spies({ quota: quota() });
    expect((await runDesktopAuthlessAuto(client, clientDeps)).acted).toBe(false);
    expect(clientDeps.calls).toEqual([]);
  });

  test("a failed apply or restart still reports the persisted transition", async () => {
    const cfg = config();
    const deps = spies({ quota: quota() });
    deps.applyInjection = async () => { deps.calls.push("apply"); throw new Error("injector busy"); };
    deps.restartClients = async () => { deps.calls.push("restart"); throw new Error("no clients"); };
    const result = await runDesktopAuthlessAuto(cfg, deps);
    expect(result.acted).toBe(true);
    expect(cfg.codexDesktopAuthless).toBe(true);
  });
});
