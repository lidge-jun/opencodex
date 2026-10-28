import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import * as accountStore from "../../src/codex/account-store";
import { headersForCodexAuthContext, type CodexAuthContext } from "../../src/codex/auth-context";
import { deleteCodexAccount, reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { captureMainQuotaWriter, clearMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { codexForwardTerminalOutcomeRecorder, sidecarOutcomeRecorder } from "../../src/server/responses/core-codex-account";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../../src/codex/routing";
import {
  forgetCodexFailureWindows,
  failureWindowSteersNewThreads,
  isCodexFailureWindowDegraded,
  noteCodexFailureWindowSample,
} from "../../src/codex/routing/failure-window";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
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
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-window-"));
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
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
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await removeTreeWithRetry(home);
});

const forwardProvider = { adapter: "openai-responses", authMode: "forward" } as OcxProviderConfig;

function terminal(config: OcxConfig, context: CodexAuthContext) {
  headersForCodexAuthContext(new Headers(), context, config);
  return codexForwardTerminalOutcomeRecorder(config, context, forwardProvider)!;
}

function mainTerminal(config: OcxConfig, identity: string, accessToken = `access-${identity}`) {
  writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: accessToken, account_id: identity } }));
  reconcileMainCodexAccountRuntimeState();
  return terminal(config, {
    kind: "main-pool", accountId: MAIN_CODEX_ACCOUNT_ID, writerGeneration: captureConfigGeneration(),
    mainQuotaWriter: captureMainQuotaWriter(identity), accessToken, chatgptAccountId: identity, fixedAccount: true,
  });
}

function poolTerminal(config: OcxConfig) {
  const record = readCodexAccountRecord("a")!;
  return terminal(config, {
    kind: "pool", accountId: "a", writerGeneration: captureConfigGeneration(), generation: record.generation,
    accessToken: record.credential!.accessToken, chatgptAccountId: record.credential!.chatgptAccountId, fixedAccount: true,
  });
}

test("late terminal outcomes cannot refill a replacement main failure window", () => {
  const cfg = config({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
  const old = mainTerminal(cfg, "physical-a");
  const replacement = mainTerminal(cfg, "physical-b");
  for (let index = 0; index < 20; index++) old("failed", 500);
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  for (let index = 0; index < 19; index++) replacement("failed", 500);
  old("completed");
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  replacement("failed", 500);
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
});

test("a returned main identity does not revive the first login's terminal writer", () => {
  const cfg = config({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
  const first = mainTerminal(cfg, "physical-a");
  mainTerminal(cfg, "physical-b");
  const returned = mainTerminal(cfg, "physical-a");
  for (let index = 0; index < 20; index++) first("failed", 500);
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  for (let index = 0; index < 20; index++) returned("failed", 500);
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
});

test("late successful terminals cannot count toward the replacement main window", () => {
  const cfg = config({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
  const old = mainTerminal(cfg, "physical-a");
  const current = mainTerminal(cfg, "physical-b");
  for (let index = 0; index < 19; index++) current("failed", 500);
  old("completed");
  old("incomplete");
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  current("completed");
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
});

test("sidecar recorder retains the old main dispatch even if its context is reused", () => {
  const cfg = config({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
  mainTerminal(cfg, "physical-a");
  const context: CodexAuthContext = { kind: "main-pool", accountId: MAIN_CODEX_ACCOUNT_ID,
    writerGeneration: captureConfigGeneration(), mainQuotaWriter: captureMainQuotaWriter("physical-a"),
    accessToken: "access-physical-a", chatgptAccountId: "physical-a" };
  headersForCodexAuthContext(new Headers(), context, cfg);
  const old = sidecarOutcomeRecorder(cfg, context)!;
  const current = mainTerminal(cfg, "physical-b");
  context.mainQuotaWriter = captureMainQuotaWriter("physical-b");
  context.accessToken = "access-physical-b";
  context.chatgptAccountId = "physical-b";
  headersForCodexAuthContext(new Headers(), context, cfg);
  for (let index = 0; index < 20; index++) old(500);
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  for (let index = 0; index < 20; index++) current("failed", 500);
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
});

test("a replaced main credential retires its terminal samples without an identity change", () => {
  const cfg = config({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
  const old = mainTerminal(cfg, "physical-a", "old-access");
  const current = mainTerminal(cfg, "physical-a", "new-access");
  for (let index = 0; index < 20; index++) old("failed", 500);
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  for (let index = 0; index < 19; index++) current("failed", 500);
  current("incomplete");
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
});

test("same-id pool recreation rejects the deleted credential's late terminal samples", () => {
  const cfg = config();
  const old = poolTerminal(cfg);
  deleteCodexAccount(cfg, "a");
  saveCodexAccountCredential("a", { accessToken: "replacement-access", refreshToken: "replacement-refresh", chatgptAccountId: "replacement-account", expiresAt: Date.now() + 60_000 });
  cfg.codexAccounts!.push({ id: "a", email: "replacement@test", isMain: false });
  const current = poolTerminal(cfg);
  for (let index = 0; index < 20; index++) old("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(false);
  for (let index = 0; index < 19; index++) current("failed", 500);
  old("completed");
  expect(isCodexFailureWindowDegraded("a")).toBe(false);
  current("completed");
  expect(isCodexFailureWindowDegraded("a")).toBe(true);
});

test("terminal pool samples keep the dispatched generation if the context is reused", () => {
  const cfg = config();
  const record = readCodexAccountRecord("a")!;
  const context: CodexAuthContext = { kind: "pool", accountId: "a", writerGeneration: captureConfigGeneration(),
    generation: record.generation, accessToken: record.credential!.accessToken,
    chatgptAccountId: record.credential!.chatgptAccountId, fixedAccount: true };
  const old = terminal(cfg, context);
  context.generation = saveCodexAccountCredential("a", { ...record.credential!, accessToken: "new-access" });
  for (let index = 0; index < 20; index++) old("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(false);
  const current = poolTerminal(cfg);
  for (let index = 0; index < 20; index++) current("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(true);
});

test("a main terminal without an owned dispatch proof cannot seed the window", () => {
  const cfg = config({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
  mainTerminal(cfg, "physical-a");
  const record = codexForwardTerminalOutcomeRecorder(cfg, {
    kind: "main-pool", accountId: MAIN_CODEX_ACCOUNT_ID, writerGeneration: captureConfigGeneration(),
    accessToken: "unobserved-access", chatgptAccountId: "physical-a",
  }, forwardProvider)!;
  for (let index = 0; index < 20; index++) record("failed", 500);
  expect(isCodexFailureWindowDegraded(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
});

test("a cross-process replacement after the unlocked live check cannot donate a terminal sample", () => {
  const cfg = config();
  const old = poolTerminal(cfg);
  const original = accountStore.isCodexAccountGenerationLive;
  let swapped = false;
  const liveCheck = spyOn(accountStore, "isCodexAccountGenerationLive").mockImplementation((id, generation) => {
    const live = original(id, generation);
    if (id === "a" && live && !swapped) {
      swapped = true;
      const credential = readCodexAccountRecord(id)!.credential!;
      saveCodexAccountCredential(id, { ...credential, accessToken: "replacement-after-read" });
    }
    return live;
  });
  try {
    old("completed");
    expect(swapped).toBe(true);
  } finally {
    liveCheck.mockRestore();
  }
  const current = poolTerminal(cfg);
  for (let index = 0; index < 19; index++) current("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(false);
  current("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(true);
});

test("a replacement does not inherit degraded state or the prior pinned warning", () => {
  const cfg = config({ activeCodexAccountPinned: "a" });
  const old = poolTerminal(cfg);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (let index = 0; index < 20; index++) old("failed", 500);
    expect(isCodexFailureWindowDegraded("a")).toBe(true);
    failureWindowSteersNewThreads(cfg, "a", Date.now());
    expect(warn).toHaveBeenCalledTimes(1);
    const credential = readCodexAccountRecord("a")!.credential!;
    saveCodexAccountCredential("a", { ...credential, accessToken: "replacement-access" });
    expect(isCodexFailureWindowDegraded("a")).toBe(false);
    const current = poolTerminal(cfg);
    for (let index = 0; index < 19; index++) current("failed", 500);
    old("completed");
    expect(isCodexFailureWindowDegraded("a")).toBe(false);
    current("failed", 500);
    expect(isCodexFailureWindowDegraded("a")).toBe(true);
    failureWindowSteersNewThreads(cfg, "a", Date.now());
    expect(warn).toHaveBeenCalledTimes(2);
    // Rejecting a stale writer must not erase the replacement's healthy or degraded window.
    old("failed", 500);
    expect(isCodexFailureWindowDegraded("a")).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("a replacement after the insertion snapshot is filtered at window read time", () => {
  const cfg = config();
  const old = poolTerminal(cfg);
  const original = accountStore.beginCodexAccountGenerationLiveCheck;
  let swapped = false;
  const snapshot = spyOn(accountStore, "beginCodexAccountGenerationLiveCheck").mockImplementation(() => {
    const live = original();
    if (!swapped) {
      swapped = true;
      const credential = readCodexAccountRecord("a")!.credential!;
      saveCodexAccountCredential("a", { ...credential, accessToken: "replacement-after-snapshot" });
    }
    return live;
  });
  try {
    old("completed");
    expect(swapped).toBe(true);
  } finally {
    snapshot.mockRestore();
  }
  const current = poolTerminal(cfg);
  for (let index = 0; index < 19; index++) current("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(false);
  current("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(true);
});

test("a full tagged window loads one current credential snapshot per read", () => {
  const cfg = config();
  const generation = readCodexAccountRecord("a")!.generation;
  for (let index = 0; index < 512; index++) {
    recordCodexUpstreamOutcome(cfg, "a", 200, { failureWindowCredentialGeneration: generation, now: NOW });
  }
  const original = accountStore.beginCodexAccountGenerationLiveCheck;
  const snapshot = spyOn(accountStore, "beginCodexAccountGenerationLiveCheck").mockImplementation(original);
  try {
    expect(isCodexFailureWindowDegraded("a", NOW)).toBe(false);
    expect(snapshot).toHaveBeenCalledTimes(1);
    const credential = readCodexAccountRecord("a")!.credential!;
    saveCodexAccountCredential("a", { ...credential, accessToken: "next-full-window" });
    expect(isCodexFailureWindowDegraded("a", NOW)).toBe(false);
    expect(snapshot).toHaveBeenCalledTimes(2);
  } finally {
    snapshot.mockRestore();
  }
});

function withFailedStoreSnapshot(kind: "read" | "parse", run: () => void): void {
  const path = join(home, "codex-accounts.json");
  const bytes = readFileSync(path);
  const original = fs.readFileSync;
  const read = kind === "read" ? spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof original>) => {
    if (String(args[0]) === path) throw Object.assign(new Error("fixture read unavailable"), { code: "EACCES" });
    return original(...args);
  }) : undefined;
  if (kind === "parse") writeFileSync(path, "{incomplete-json");
  try {
    run();
  } finally {
    read?.mockRestore();
    writeFileSync(path, bytes);
  }
}

test.each(["read", "parse"] as const)("a temporary %s snapshot failure preserves degraded samples and the pinned warning", kind => {
  const cfg = config({ activeCodexAccountPinned: "a" });
  const record = poolTerminal(cfg);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (let index = 0; index < 20; index++) record("failed", 500);
    expect(isCodexFailureWindowDegraded("a")).toBe(true);
    failureWindowSteersNewThreads(cfg, "a", Date.now());
    expect(warn).toHaveBeenCalledTimes(1);
    withFailedStoreSnapshot(kind, () => {
      expect(accountStore.beginCodexAccountGenerationLiveCheck().snapshotStatus).toBe("failed");
      expect(isCodexFailureWindowDegraded("a")).toBe(true);
      failureWindowSteersNewThreads(cfg, "a", Date.now());
      expect(warn).toHaveBeenCalledTimes(1);
    });
    expect(isCodexFailureWindowDegraded("a")).toBe(true);
    failureWindowSteersNewThreads(cfg, "a", Date.now());
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test.each(["read", "parse"] as const)("a temporary %s failure does not erase or append to nineteen retained samples", kind => {
  const cfg = config();
  const record = poolTerminal(cfg);
  for (let index = 0; index < 19; index++) record("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(false);
  withFailedStoreSnapshot(kind, () => {
    noteCodexFailureWindowSample(cfg, "a", true, Date.now());
    expect(isCodexFailureWindowDegraded("a")).toBe(false);
  });
  expect(isCodexFailureWindowDegraded("a")).toBe(false);
  record("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(true);
});

test.each(["read", "parse"] as const)("a temporary %s snapshot failure preserves the recovery timer and retained generation", kind => {
  const cfg = config();
  const generation = readCodexAccountRecord("a")!.generation;
  const record = (failed: boolean, now: number) => recordCodexUpstreamOutcome(cfg, "a", failed ? 500 : 200,
    { failureWindowCredentialGeneration: generation, now });
  for (let index = 0; index < 20; index++) record(true, NOW);
  for (let index = 0; index < 20; index++) record(false, NOW + 61_000);
  expect(isCodexFailureWindowDegraded("a", NOW + 61_000)).toBe(true);
  withFailedStoreSnapshot(kind, () => expect(isCodexFailureWindowDegraded("a", NOW + 75_000)).toBe(true));
  expect(isCodexFailureWindowDegraded("a", NOW + 90_999)).toBe(true);
  expect(isCodexFailureWindowDegraded("a", NOW + 91_000)).toBe(false);
  const credential = readCodexAccountRecord("a")!.credential!;
  saveCodexAccountCredential("a", { ...credential, accessToken: "replacement-after-failure" });
  const current = readCodexAccountRecord("a")!.generation;
  for (let index = 0; index < 19; index++) recordCodexUpstreamOutcome(cfg, "a", 500,
    { failureWindowCredentialGeneration: current, now: NOW + 92_000 });
  expect(isCodexFailureWindowDegraded("a", NOW + 92_000)).toBe(false);
});

test.each(["absent", "empty"] as const)("a valid %s snapshot still retires the previous generation", kind => {
  const cfg = config();
  const old = poolTerminal(cfg);
  for (let index = 0; index < 20; index++) old("failed", 500);
  expect(isCodexFailureWindowDegraded("a")).toBe(true);
  const path = join(home, "codex-accounts.json");
  if (kind === "absent") unlinkSync(path);
  else writeFileSync(path, "{}");
  expect(accountStore.beginCodexAccountGenerationLiveCheck().snapshotStatus).toBe("ok");
  expect(isCodexFailureWindowDegraded("a")).toBe(false);
});

test.each(["[]", "false", "0", "null", "\"\"", "\"text\""])("a wrong-shaped top-level snapshot %s preserves the failure window", contents => {
  const cfg = config({ activeCodexAccountPinned: "a" });
  const record = poolTerminal(cfg);
  const path = join(home, "codex-accounts.json");
  const bytes = readFileSync(path);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (let index = 0; index < 20; index++) record("failed", 500);
    expect(isCodexFailureWindowDegraded("a")).toBe(true);
    failureWindowSteersNewThreads(cfg, "a", Date.now());
    expect(warn).toHaveBeenCalledTimes(1);
    writeFileSync(path, contents);
    expect(isCodexFailureWindowDegraded("a")).toBe(true);
    expect(accountStore.beginCodexAccountGenerationLiveCheck().snapshotStatus).toBe("failed");
    failureWindowSteersNewThreads(cfg, "a", Date.now());
    expect(warn).toHaveBeenCalledTimes(1);
    writeFileSync(path, bytes);
    expect(isCodexFailureWindowDegraded("a")).toBe(true);
    failureWindowSteersNewThreads(cfg, "a", Date.now());
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
    writeFileSync(path, bytes);
  }
});

test("a replacement does not inherit the previous generation's recovery timer", () => {
  const cfg = config();
  const firstGeneration = readCodexAccountRecord("a")!.generation;
  const record = (outcome: number, generation: number, now: number) => recordCodexUpstreamOutcome(cfg, "a", outcome,
    { failureWindowCredentialGeneration: generation, now });
  const fillGeneration = (generation: number, failed: boolean, now: number) => {
    for (let index = 0; index < 20; index++) record(failed ? 500 : 200, generation, now);
  };
  fillGeneration(firstGeneration, true, NOW);
  fillGeneration(firstGeneration, false, NOW + 61_000);
  expect(isCodexFailureWindowDegraded("a", NOW + 61_000)).toBe(true);
  const credential = readCodexAccountRecord("a")!.credential!;
  const nextGeneration = saveCodexAccountCredential("a", { ...credential, accessToken: "next-access" });
  fillGeneration(nextGeneration, false, NOW + 62_000);
  expect(isCodexFailureWindowDegraded("a", NOW + 62_000)).toBe(false);
  fillGeneration(nextGeneration, true, NOW + 63_000);
  expect(isCodexFailureWindowDegraded("a", NOW + 63_000)).toBe(true);
  // Only G2 successes remain in-window; its own 30-second recovery starts here.
  fillGeneration(nextGeneration, false, NOW + 124_000);
  expect(isCodexFailureWindowDegraded("a", NOW + 153_999)).toBe(true);
  expect(isCodexFailureWindowDegraded("a", NOW + 154_000)).toBe(false);
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
