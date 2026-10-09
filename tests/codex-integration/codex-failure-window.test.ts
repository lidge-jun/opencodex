import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../../src/codex/routing";
import {
  forgetCodexFailureWindows,
  isCodexFailureWindowDegraded,
  noteCodexFailureWindowSample,
} from "../../src/codex/routing/failure-window";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const NOW = 1_700_000_000_000;
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "a", email: "a@test", isMain: false },
      { id: "b", email: "b@test", isMain: false },
    ],
    activeCodexAccountId: "a",
    upstreamFailoverThreshold: 0,
    ...overrides,
  } as OcxConfig;
}

function fill(accountId: string, failures: number, successes: number, now = NOW): void {
  const cfg = config();
  for (let index = 0; index < failures; index += 1) {
    recordCodexUpstreamOutcome(cfg, accountId, 500, { now });
  }
  for (let index = 0; index < successes; index += 1) {
    recordCodexUpstreamOutcome(cfg, accountId, 200, { now });
  }
}

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-window-"));
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  process.env.OPENCODEX_HOME = home;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  forgetCodexFailureWindows();
  for (const id of ["a", "b"]) {
    clearAccountNeedsReauth(id);
    saveCodexAccountCredential(id, {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60_000,
      chatgptAccountId: `acct-${id}`,
    });
    updateAccountQuota(id, 10);
  }
});

afterEach(async () => {
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  forgetCodexFailureWindows();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  await removeTreeWithRetry(home);
});

test("fewer than 20 samples do not degrade an account", () => {
  fill("a", 19, 0);
  expect(isCodexFailureWindowDegraded("a", NOW)).toBe(false);
});

test("a 25 percent ratio over 20 samples degrades independent of order", () => {
  const samples = Array.from({ length: 20 }, (_, index) => index % 4 === 0);
  const forward = config();
  const reverse = config();
  for (const failed of samples) noteCodexFailureWindowSample(forward, "forward", failed, NOW);
  for (const failed of [...samples].reverse()) noteCodexFailureWindowSample(reverse, "reverse", failed, NOW);
  expect(isCodexFailureWindowDegraded("forward", NOW)).toBe(true);
  expect(isCodexFailureWindowDegraded("reverse", NOW)).toBe(true);
  expect(isCodexFailureWindowDegraded("forward", NOW)).toBe(isCodexFailureWindowDegraded("reverse", NOW));
});

test("concurrent completions use the same ratio", async () => {
  const cfg = config();
  const samples = Array.from({ length: 20 }, (_, index) => index % 4 === 0);
  await Promise.all(samples.map((failed, index) => Promise.resolve().then(() => {
    noteCodexFailureWindowSample(cfg, "concurrent", failed, NOW + index);
  })));
  expect(isCodexFailureWindowDegraded("concurrent", NOW + 20)).toBe(true);
});

test("recovery waits for a 10 percent ratio sustained 30 seconds", () => {
  fill("a", 5, 15);
  expect(isCodexFailureWindowDegraded("a", NOW)).toBe(true);
  const recoveredAt = NOW + 61_000;
  fill("a", 0, 20, recoveredAt);
  expect(isCodexFailureWindowDegraded("a", recoveredAt)).toBe(true);
  expect(isCodexFailureWindowDegraded("a", recoveredAt + 30_000)).toBe(false);
});

test("disabling the window records nothing", () => {
  const cfg = config({ codexFailureWindow: false });
  for (let index = 0; index < 20; index += 1) noteCodexFailureWindowSample(cfg, "a", true, NOW);
  expect(isCodexFailureWindowDegraded("a", NOW)).toBe(false);
});

test("quota responses are not window samples", () => {
  const cfg = config();
  for (let index = 0; index < 20; index += 1) {
    recordCodexUpstreamOutcome(cfg, "a", 429, { now: NOW, retryAfter: "60" });
  }
  expect(isCodexFailureWindowDegraded("a", NOW)).toBe(false);
});

test("an unpinned degraded account steers only new threads", () => {
  const cfg = config();
  expect(resolveCodexAccountForThread("bound-thread", cfg, NOW)).toBe("a");
  fill("a", 5, 15);
  expect(resolveCodexAccountForThread("bound-thread", cfg, NOW)).toBe("a");
  expect(resolveCodexAccountForThread("new-thread", cfg, NOW)).toBe("b");
});

test("a pinned account is held unless new threads are opted out", () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = ((line: string) => { warnings.push(line); }) as typeof console.warn;
  try {
    const held = config({ activeCodexAccountPinned: "a" });
    const detour = config({
      activeCodexAccountPinned: "a",
      codexPinnedTransientPolicy: "detour-new-threads",
    });
    expect(resolveCodexAccountForThread("pinned-bound", detour, NOW)).toBe("a");
    fill("a", 5, 15);
    expect(resolveCodexAccountForThread("pinned-new", held, NOW)).toBe("a");
    expect(warnings.some(line => line.includes("pinned Codex account is degraded"))).toBe(true);
    expect(resolveCodexAccountForThread("pinned-bound", detour, NOW)).toBe("a");
    expect(resolveCodexAccountForThread("pinned-fresh", detour, NOW)).toBe("b");
  } finally {
    console.warn = warn;
  }
});
