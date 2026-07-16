import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  primeCodexPoolQuotas,
  getAccountQuota,
  updateAccountQuota,
  clearAccountQuota,
  clearCodexQuotaPrimeState,
} from "../src/codex/auth-api";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { resolveCodexAccountForThread, clearThreadAccountMap } from "../src/codex/routing";
import type { OcxConfig } from "../src/types";

// Phase 20 (260630_wsl-account-autoswitch): startup/lazy quota priming.

const TEST_DIR = join(import.meta.dir, ".tmp-codex-quota-prime-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  } as OcxConfig;
}

function seedPoolAccount(config: OcxConfig, id: string, plan?: string): void {
  config.codexAccounts = [
    ...(config.codexAccounts ?? []),
    { id, email: `${id}@example.test`, plan, isMain: false },
  ];
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

function whamResponse(weekly: number) {
  return new Response(JSON.stringify({
    rate_limit: {
      secondary_window: { used_percent: weekly, reset_at: 1782000000 },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("primeCodexPoolQuotas", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    // Isolate the main-account source: TEST_CODEX_HOME has no auth.json, so the
    // main account is deterministically absent and priming only touches the pool.
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    clearAccountQuota();
    clearThreadAccountMap();
    clearCodexQuotaPrimeState();
  });

  afterEach(() => {
    clearAccountQuota();
    clearThreadAccountMap();
    clearCodexQuotaPrimeState();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("prime populates stale/unknown pool accounts", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    seedPoolAccount(config, "p2");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) return whamResponse(20);
        return originalFetch(input);
      };
      expect(getAccountQuota("p1")).toBeNull();
      await primeCodexPoolQuotas(config, "test");
      expect(getAccountQuota("p1")).not.toBeNull();
      expect(getAccountQuota("p2")).not.toBeNull();
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 20 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("single-flight coalesces concurrent callers into one pass", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    seedPoolAccount(config, "p2");
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          calls += 1;
          await new Promise(r => setTimeout(r, 5));
          return whamResponse(20);
        }
        return originalFetch(input);
      };
      const a = primeCodexPoolQuotas(config, "test-a");
      const b = primeCodexPoolQuotas(config, "test-b");
      await Promise.all([a, b]);
      expect(calls).toBe(2); // one per pool account, not 2x per account
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fresh cached quota is skipped (TTL guard)", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    updateAccountQuota("p1", 30); // recent updatedAt
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) { calls += 1; return whamResponse(99); }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(0);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 30 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("credential-less pool accounts are skipped and stay unknown", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "nocred", email: "nocred@example.test", isMain: false }],
    });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) { calls += 1; return whamResponse(20); }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(0);
      expect(getAccountQuota("nocred")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("one blocked account does not sink the rest", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "ok");
    seedPoolAccount(config, "blocked");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
          if (auth.includes("blocked")) throw new Error("network blocked");
          return whamResponse(20);
        }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(getAccountQuota("ok")).not.toBeNull();
      expect(getAccountQuota("blocked")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("priming defuses the Phase 10 all-unknown deadlock", async () => {
    const config = makeConfig({ activeCodexAccountId: "p1", autoSwitchThreshold: 80 });
    seedPoolAccount(config, "p1");
    seedPoolAccount(config, "p2");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
          // p1 hot (over threshold), p2 cool -> strict pick should choose p2.
          return auth.includes("p2") ? whamResponse(10) : whamResponse(90);
        }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(resolveCodexAccountForThread("primed-thread", config)).toBe("p2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
