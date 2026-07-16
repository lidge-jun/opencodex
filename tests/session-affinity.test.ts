import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexAccountForThread, clearThreadAccountMap, formatCodexProviderForLog } from "../src/codex/routing";
import { CODEX_ACCOUNT_LOG_LABEL_RE, fallbackCodexAccountLogLabel } from "../src/codex/account-label";
import { updateAccountQuota, clearAccountQuota } from "../src/codex/auth-api";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-session-affinity-test");
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

function makeActivePoolConfig(active: string, ids: string[] = [active]): OcxConfig {
  for (const id of ids) saveTestCredential(id);
  return makeConfig({
    activeCodexAccountId: active,
    codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, isMain: false })),
  });
}

describe("resolveCodexAccountForThread", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    // Isolate the main-account credential source: TEST_DIR has no auth.json, so the
    // main account is deterministically absent and cannot become a rotation target.
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearAccountQuota();
  });

  afterEach(() => {
    clearAccountQuota();
    clearThreadAccountMap();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("returns null when no active account", () => {
    const config = makeConfig();
    expect(resolveCodexAccountForThread(null, config)).toBeNull();
  });

  test("returns active account for new thread", () => {
    const config = makeActivePoolConfig("work");
    expect(resolveCodexAccountForThread("t1", config)).toBe("work");
  });

  test("same thread-id returns same account (affinity)", () => {
    const config = makeActivePoolConfig("work", ["work", "personal"]);
    // Known low quota keeps "work" the deterministic active (this case tests
    // thread affinity, not the all-unknown quota rotation added in Phase 10).
    updateAccountQuota("work", 10);
    updateAccountQuota("personal", 10);
    resolveCodexAccountForThread("t1", config);
    config.activeCodexAccountId = "personal";
    expect(resolveCodexAccountForThread("t1", config)).toBe("work");
  });

  test("different thread gets different account", () => {
    const config = makeActivePoolConfig("work", ["work", "personal"]);
    updateAccountQuota("work", 10);
    updateAccountQuota("personal", 10);
    resolveCodexAccountForThread("t1", config);
    config.activeCodexAccountId = "personal";
    expect(resolveCodexAccountForThread("t2", config)).toBe("personal");
  });

  test("null thread-id does not cache", () => {
    const config = makeActivePoolConfig("work", ["work", "personal"]);
    updateAccountQuota("work", 10);
    updateAccountQuota("personal", 10);
    resolveCodexAccountForThread(null, config);
    config.activeCodexAccountId = "personal";
    expect(resolveCodexAccountForThread(null, config)).toBe("personal");
  });

  test("auto-switch triggers when active exceeds threshold", () => {
    const config = makeConfig({
      activeCodexAccountId: "a",
      autoSwitchThreshold: 80,
      codexAccounts: [
        { id: "a", email: "a@test", isMain: false },
        { id: "b", email: "b@test", isMain: false },
      ],
    });
    saveTestCredential("a");
    saveTestCredential("b");
    updateAccountQuota("a", 85);
    updateAccountQuota("b", 20);
    const result = resolveCodexAccountForThread("new-thread", config);
    expect(result).toBe("b");
  });

  test("auto-switch keeps current when all at threshold", () => {
    const config = makeConfig({
      activeCodexAccountId: "a",
      autoSwitchThreshold: 80,
      codexAccounts: [
        { id: "a", email: "a@test", isMain: false },
        { id: "b", email: "b@test", isMain: false },
      ],
    });
    saveTestCredential("a");
    saveTestCredential("b");
    updateAccountQuota("a", 90);
    updateAccountQuota("b", 95);
    const result = resolveCodexAccountForThread("new-thread", config);
    expect(result).toBe("a");
  });

  test("auto-switch disabled when threshold is 0", () => {
    const config = makeConfig({
      activeCodexAccountId: "a",
      autoSwitchThreshold: 0,
      codexAccounts: [
        { id: "a", email: "a@test", isMain: false },
        { id: "b", email: "b@test", isMain: false },
      ],
    });
    saveTestCredential("a");
    saveTestCredential("b");
    updateAccountQuota("a", 99);
    updateAccountQuota("b", 10);
    const result = resolveCodexAccountForThread("t1", config);
    expect(result).toBe("a");
  });
});

describe("formatCodexProviderForLog", () => {
  test("keeps base provider for main passthrough", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "pool-a", email: "pool-a@example.test", isMain: false },
      ],
    });
    expect(formatCodexProviderForLog("chatgpt", null, config)).toBe("chatgpt");
  });

  test("labels pool accounts by stable non-PII labels", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool-a@example.test", isMain: false, logLabel: "pabc123" },
        { id: "pool-b", email: "pool-b@example.test", isMain: false, logLabel: "pdef456" },
      ],
    });
    expect(formatCodexProviderForLog("chatgpt", "pool-a", config)).toBe("chatgpt-pabc123");
    expect(formatCodexProviderForLog("chatgpt", "pool-b", config)).toBe("chatgpt-pdef456");
  });

  test("stable pool log labels do not change when accounts are reordered", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "pool-a", email: "pool-a@example.test", isMain: false, logLabel: "pabc123" },
        { id: "pool-b", email: "pool-b@example.test", isMain: false, logLabel: "pdef456" },
      ],
    });
    const reordered = makeConfig({
      codexAccounts: [...(config.codexAccounts ?? [])].reverse(),
    });

    expect(formatCodexProviderForLog("chatgpt", "pool-a", config)).toBe("chatgpt-pabc123");
    expect(formatCodexProviderForLog("chatgpt", "pool-a", reordered)).toBe("chatgpt-pabc123");
  });

  test("accounts without stored log labels use stable pseudonymous fallback labels", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "raw-local-account-id", email: "raw@example.test", isMain: false },
      ],
    });
    const label = formatCodexProviderForLog("chatgpt", "raw-local-account-id", config);

    expect(label).toBe(`chatgpt-${fallbackCodexAccountLogLabel("raw-local-account-id")}`);
    expect(label.replace("chatgpt-", "")).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
    expect(label).not.toContain("raw-local-account-id");
  });

  test("keeps base provider for unknown account ids", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "pool-a", email: "pool-a@example.test", isMain: false },
      ],
    });
    expect(formatCodexProviderForLog("chatgpt", "missing", config)).toBe("chatgpt");
  });
});
