import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexAccountForThread, clearThreadAccountMap } from "../src/server";
import { updateAccountQuota, clearAccountQuota } from "../src/codex-auth-api";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-session-affinity-test");

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [],
    activeCodexAccountId: undefined,
    autoSwitchThreshold: 80,
    ...overrides,
  } as OcxConfig;
}

describe("resolveCodexAccountForThread", () => {
  beforeEach(() => {
    process.env.OPENCODEX_HOME = TEST_DIR;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    clearThreadAccountMap();
    clearAccountQuota();
  });

  afterEach(() => {
    delete process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    clearAccountQuota();
    clearThreadAccountMap();
  });

  test("returns null when no active account", () => {
    const config = makeConfig();
    expect(resolveCodexAccountForThread(null, config)).toBeNull();
  });

  test("returns active account for new thread", () => {
    const config = makeConfig({ activeCodexAccountId: "work" });
    expect(resolveCodexAccountForThread("t1", config)).toBe("work");
  });

  test("same thread-id returns same account (affinity)", () => {
    const config = makeConfig({ activeCodexAccountId: "work" });
    resolveCodexAccountForThread("t1", config);
    config.activeCodexAccountId = "personal";
    expect(resolveCodexAccountForThread("t1", config)).toBe("work");
  });

  test("different thread gets different account", () => {
    const config = makeConfig({ activeCodexAccountId: "work" });
    resolveCodexAccountForThread("t1", config);
    config.activeCodexAccountId = "personal";
    expect(resolveCodexAccountForThread("t2", config)).toBe("personal");
  });

  test("null thread-id does not cache", () => {
    const config = makeConfig({ activeCodexAccountId: "work" });
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
    updateAccountQuota("a", 85, 10);
    updateAccountQuota("b", 20, 5);
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
    updateAccountQuota("a", 90, 10);
    updateAccountQuota("b", 95, 15);
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
    updateAccountQuota("a", 99, 50);
    updateAccountQuota("b", 10, 5);
    const result = resolveCodexAccountForThread("t1", config);
    expect(result).toBe("a");
  });
});
