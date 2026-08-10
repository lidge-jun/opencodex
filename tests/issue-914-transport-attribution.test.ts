import { beforeEach, describe, expect, test } from "bun:test";
import {
  classifyCodexUpstreamOutcome,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  getEffectiveActiveCodexAccountId,
  isCodexAccountSoftAvoided,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import {
  clearUpstreamHostHealth,
  getUpstreamHostHealth,
  upstreamHostHealthKey,
} from "../src/codex/upstream-host-health";
import { classifyTransportFailureKind } from "../src/lib/upstream-reachability";
import { fetchWithResetRetry, fetchWithTransientRetry } from "../src/lib/upstream-retry";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { getConfigPath } from "../src/config";
import type { OcxConfig } from "../src/types";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-issue-914-test");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [],
    activeCodexAccountId: undefined,
    autoSwitchThreshold: 80,
    ...overrides,
  } as OcxConfig;
}

function saveTestCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

function makeTwoAccountConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  for (const id of ["a", "b"]) saveTestCredential(id);
  return makeConfig({
    activeCodexAccountId: "a",
    codexAccounts: ["a", "b"].map(id => ({ id, email: `${id}@example.test`, isMain: false })),
    ...overrides,
  });
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_DIR;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearUpstreamHostHealth();
});

function restoreEnv(): void {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("issue #914 — pre-connection failures never touch account health", () => {
  test("three concurrent neutral failures leave streak, affinity, and active account untouched", () => {
    try {
      const config = makeTwoAccountConfig({ upstreamFailoverThreshold: 3 });
      expect(getConfigPath().startsWith(TEST_DIR)).toBe(true);
      // Pin the thread to account A the way a real continue would.
      resolveCodexAccountForThread(config, "thread-914", { now: Date.now() });
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");

      const hostKey = upstreamHostHealthKey("openai", "chatgpt.com");
      for (let i = 0; i < 3; i++) {
        recordCodexUpstreamOutcome(config, "a", "connect_neutral", {
          threadId: "thread-914",
          hostKey,
          lastFailureCode: "ECONNREFUSED",
        });
      }

      // No account evidence at the failover threshold: no streak, no soft-avoid,
      // no affinity loss, no rotation. The host ledger carries the failure instead.
      expect(getCodexUpstreamHealth("a")).toBeNull();
      expect(isCodexAccountSoftAvoided("a")).toBe(false);
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
      expect(getUpstreamHostHealth(hostKey)).toMatchObject({ consecutiveFailures: 3, lastFailureCode: "ECONNREFUSED" });
    } finally {
      restoreEnv();
    }
  });

  test("a relayed 3xx is the neutral class: no account and no host evidence", () => {
    try {
      const config = makeTwoAccountConfig();
      for (const status of [301, 302, 307, 308]) {
        expect(classifyCodexUpstreamOutcome(status)).toBe("neutral");
        recordCodexUpstreamOutcome(config, "a", status);
      }
      expect(getCodexUpstreamHealth("a")).toBeNull();
      expect(isCodexAccountSoftAvoided("a")).toBe(false);
      expect(getUpstreamHostHealth(upstreamHostHealthKey("openai", "chatgpt.com"))).toBeNull();
    } finally {
      restoreEnv();
    }
  });

  test("mixed evidence: 503 then a reachability rejection stays account-attributed", async () => {
    try {
      const config = makeTwoAccountConfig({ upstreamFailoverThreshold: 1 });
      let calls = 0;
      const rejection = coded("refused", "ECONNREFUSED");
      const outcome = classifyTransportFailureKind(await fetchWithTransientRetry(async () => {
        calls++;
        if (calls === 1) return new Response("gw", { status: 503 });
        throw rejection;
      }, { slowAttemptMs: 60_000 }).catch(err => err));
      expect(calls).toBe(2);
      expect(outcome).toBe("connect_error");
      recordCodexUpstreamOutcome(config, "a", outcome, { threadId: "t-mixed" });
      expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 1 });
    } finally {
      restoreEnv();
    }
  });

  test("mixed evidence: a reset then a reachability rejection stays account-attributed", async () => {
    const rejection = coded("refused", "ECONNREFUSED");
    const err = await fetchWithResetRetry(async recovery => {
      if (!recovery) throw coded("reset", "ECONNRESET");
      throw rejection;
    }).catch((e: unknown) => e);
    expect(classifyTransportFailureKind(err)).toBe("connect_error");
  });

  test("a plain reachability rejection classifies neutral end to end", async () => {
    const err = await fetchWithTransientRetry(async () => {
      throw coded("refused", "ECONNREFUSED");
    }).catch((e: unknown) => e);
    expect(classifyTransportFailureKind(err)).toBe("connect_neutral");
  });

  test("real Bun dead-port fetch rejects with a neutral-classifiable shape", async () => {
    // Real socket, not a hand-built error: localhost port 1 is never listening.
    const err = await fetch("http://127.0.0.1:1/", { signal: AbortSignal.timeout(5_000) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(classifyTransportFailureKind(err)).toBe("connect_neutral");
  });
});
