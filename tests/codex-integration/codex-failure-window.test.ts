import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
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
