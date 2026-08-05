import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  clearCodexCooldownRecoveryProbeState,
  clearCodexQuotaPrimeState,
} from "../src/codex/auth-api";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../src/codex/quota";
import {
  CODEX_THREAD_AFFINITY_MAX_ENTRIES,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexThreadAffinityEntryCountForTests,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import { resetAppOwnedMemoryForTests } from "../src/lib/app-owned-memory";
import { resetStateStoreSweeperForTests } from "../src/lib/state-store-sweeper";
import { startServer } from "../src/server";
import { resetLifecycleDrainStateForTests, drainAndShutdown } from "../src/server/lifecycle";
import { getActiveMemoryWatchdog } from "../src/server/memory-watchdog";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const originalFetch = globalThis.fetch;
let testDir = "";
let previousOpenCodexHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let canaryServer: ReturnType<typeof startServer> | null = null;

function resetCanaryProcessState(): void {
  getActiveMemoryWatchdog()?.stop();
  resetStateStoreSweeperForTests();
  resetAppOwnedMemoryForTests();
  clearCodexQuotaPrimeState();
  clearCodexCooldownRecoveryProbeState();
  resetLifecycleDrainStateForTests();
}

beforeEach(() => {
  resetCanaryProcessState();
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-pool-canary-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-pool-canary-"));
  process.env.OPENCODEX_HOME = testDir;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
});

afterEach(async () => {
  try {
    if (canaryServer) {
      const server = canaryServer;
      canaryServer = null;
      await drainAndShutdown(server, 5_000);
    }
  } finally {
    resetCanaryProcessState();
    globalThis.fetch = originalFetch;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    rmSync(testDir, { recursive: true, force: true });
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  }
});

function poolConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    autoSwitchThreshold: 80,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
        liveModels: false,
      },
    },
    codexAccounts: [
      { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "pool-a-chatgpt" },
      { id: "pool-b", email: "pool-b@example.test", isMain: false, chatgptAccountId: "pool-b-chatgpt" },
    ],
  } as OcxConfig;
}

function installSyntheticCredential(id: "pool-a" | "pool-b"): void {
  saveCodexAccountCredential(id, {
    accessToken: `${id}-access-token`,
    refreshToken: `${id}-refresh-token`,
    expiresAt: Date.now() + 60 * 60_000,
    chatgptAccountId: `${id}-chatgpt`,
  });
  // Keep the request-path lazy quota primer dormant: it is intentionally
  // fire-and-forget in production and therefore cannot outlive this canary's
  // isolated server lifecycle.
  setAccountQuotaFromParsed(id, { weeklyPercent: 0 });
}

test("isolated Pool canary retries a pre-stream quota rejection without losing HTTP availability", async () => {
  const config = poolConfig();
  installSyntheticCredential("pool-a");
  installSyntheticCredential("pool-b");
  saveConfig(config);

  const attemptedAccounts: Array<"pool-a" | "pool-b"> = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("chatgpt.com/backend-api/codex")) {
      return Response.json({ data: [] });
    }
    const authorization = new Headers(init?.headers).get("authorization");
    const account = authorization === "Bearer pool-a-access-token"
      ? "pool-a"
      : authorization === "Bearer pool-b-access-token"
        ? "pool-b"
        : null;
    if (!account) throw new Error("unexpected synthetic account");
    attemptedAccounts.push(account);
    if (account === "pool-a") {
      return new Response("quota exhausted", { status: 429, headers: { "retry-after": "60" } });
    }
    return Response.json({
      id: "resp_pool_canary",
      object: "response",
      status: "completed",
      model: "gpt-5.6-sol",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;

  canaryServer = startServer(0, { suppressStartupCodexQuotaPrime: true });
  const before = await originalFetch(new URL("/healthz", canaryServer.url));
  expect(before.status).toBe(200);

  const response = await originalFetch(new URL("/v1/responses", canaryServer.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-parent-thread-id": "pool-canary-thread",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "synthetic canary", stream: false }),
  });

  expect(response.status).toBe(200);
  expect(attemptedAccounts).toEqual(["pool-a", "pool-b"]);
  expect(resolveCodexAccountForThread("pool-canary-thread", config)).toBe("pool-b");

  const after = await originalFetch(new URL("/healthz", canaryServer.url));
  expect(after.status).toBe(200);
});

test("isolated Pool canary bounds synthetic thread affinity without exposing identities", () => {
  const config = poolConfig();
  installSyntheticCredential("pool-a");
  installSyntheticCredential("pool-b");

  for (let index = 0; index < CODEX_THREAD_AFFINITY_MAX_ENTRIES + 128; index += 1) {
    expect(resolveCodexAccountForThread(`pool-canary-${index}`, config)).toBe("pool-a");
  }

  expect(getCodexThreadAffinityEntryCountForTests()).toBe(CODEX_THREAD_AFFINITY_MAX_ENTRIES);

  const switchedConfig = { ...config, activeCodexAccountId: "pool-b" };
  expect(resolveCodexAccountForThread(
    `pool-canary-${CODEX_THREAD_AFFINITY_MAX_ENTRIES + 127}`,
    switchedConfig,
  )).toBe("pool-a");
  expect(resolveCodexAccountForThread("pool-canary-0", switchedConfig)).toBe("pool-b");
});
