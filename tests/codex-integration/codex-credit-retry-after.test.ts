import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import {
  CodexAccountCooldownError, CodexPoolAccountCreditsOffError, cooldownErrorResponse,
  resolveCodexAuthContext, materializeCodexUpstreamAuth, createCodexAuthDispatchGuard,
  applyCodexAuthContextToProvider, assertCodexAuthContextNotCooled,
} from "../../src/codex/auth-context";
import { createOpenAiSidecarCreditGuard } from "../../src/providers/openai-sidecar-credit";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota, getAccountQuota, parseUsageQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";

const ID = "retry-credit-fixture";
const NOW = 1_800_000_000_000;
const RESET = NOW + 6 * 86_400_000;
let home = "";
let previousHome: string | undefined, previousCodexHome: string | undefined;
let clock: ReturnType<typeof spyOn>;
let originalFetch: typeof fetch;
let networkCalls = 0;
const cfg = (): OcxConfig => ({
  port: 10100, defaultProvider: "openai", providers: {}, codexMainAccountHardLock: false,
  codexAccounts: [{ id: ID, email: "fixture@example.test", plan: "plus", isMain: false }],
  codexAccountNamespaces: { subAlias: ID }, creditCodexAccountIds: [ID],
  activeCodexAccountId: ID, autoSwitchThreshold: 0, upstreamFailoverThreshold: 3,
});
function observe(credits: NonNullable<Parameters<typeof setAccountQuotaFromParsed>[1]>["credits"], resetAt = RESET) {
  setAccountQuotaFromParsed(ID, { weeklyPercent: 100, weeklyResetAt: resetAt, ...(credits === undefined ? {} : { credits }) });
}
const positive = (age = 360_000) => ({ hasCredits: true, balance: 5, allowed: true, observedAt: NOW - age });
const resolve = (config = cfg()) => resolveCodexAuthContext(new Headers(), config, "direct", { accountId: ID, modelId: "gpt-5.5" });
async function refusal(config = cfg()): Promise<CodexPoolAccountCreditsOffError> {
  const error = await resolve(config).catch(e => e);
  expect(error).toBeInstanceOf(CodexPoolAccountCreditsOffError);
  expect(error.resetAt).toBe(RESET);
  expect(isAccountNeedsReauth(ID)).toBe(false);
  return error;
}
function expectRetry(error: CodexAccountCooldownError, seconds: number) {
  const response = cooldownErrorResponse(error, Date.now());
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe(String(seconds));
}
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME; previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-credit-retry-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  clock = spyOn(Date, "now").mockReturnValue(NOW);
  const ok = { success: true, exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  setIcaclsRunnerForTests(() => ok); setAsyncIcaclsRunnerForTests(async () => ok);
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); clearAccountNeedsReauth(ID);
  saveCodexAccountCredential(ID, { accessToken: "fixture-credit-access", refreshToken: "fixture-credit-refresh",
    expiresAt: NOW + 3_600_000, chatgptAccountId: "fixture-credit-workspace" });
  originalFetch = globalThis.fetch; networkCalls = 0;
  globalThis.fetch = Object.assign((): never => { networkCalls++; throw new Error("Unexpected network request"); },
    { preconnect: originalFetch.preconnect });
});
afterEach(async () => {
  try {
    expect(networkCalls).toBe(0);
    clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); clearAccountNeedsReauth(ID);
    await flushConfigDirHardeningForTests();
  } finally {
    globalThis.fetch = originalFetch; clock.mockRestore();
    setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(home);
  }
});
for (const kind of ["stale", "missing", "partial", "future", "invalid-time"] as const) test(`opted-in exact Direct account gets a metadata retry for ${kind} evidence`, async () => {
  observe(kind === "stale" ? positive() : kind === "future" ? positive(-1)
    : kind === "invalid-time" ? { ...positive(), observedAt: NaN }
    : kind === "partial" ? { observedAt: NOW } : undefined);
  const before = structuredClone(getAccountQuota(ID));
  const error = await refusal(); expectRetry(error, 300);
  expect(getAccountQuota(ID)).toEqual(before);
  await expect(resolve()).rejects.toBeInstanceOf(CodexPoolAccountCreditsOffError);
});
test("opt-out retains the actual six-day reset despite stale evidence", async () => {
  observe(positive()); const config = cfg(); config.creditCodexAccountIds = [];
  expectRetry(await refusal(config), 518_400);
});
for (const age of [0, 360_000]) for (const [reason, veto] of [
  ["empty", { balance: 0 }], ["spend control", { allowed: false }],
  ["overage", { overageLimitReached: true }], ["no credits", { hasCredits: false }],
] as const) test(`known ${reason} retains reset at credit age ${age}`, async () => {
  observe({ ...positive(age), ...veto }); expectRetry(await refusal(), 518_400);
});
test("explicit retraction retains the included reset", async () => {
  observe(null); expectRetry(await refusal(), 518_400);
});
test("spend-control-only revocation remains a reset-bound refusal", async () => {
  observe(positive(0)); setAccountQuotaFromParsed(ID, parseUsageQuota({ spend_control: { reached: true } }));
  expect(getAccountQuota(ID)?.credits).toBeNull(); expectRetry(await refusal(), 518_400);
});
test("the included reset earlier than metadata cadence remains the hint", async () => {
  observe(positive(), NOW + 30_000);
  const error = await resolve().catch(e => e);
  expect(error).toBeInstanceOf(CodexPoolAccountCreditsOffError);
  expect(error.resetAt).toBe(NOW + 30_000); expectRetry(error, 30);
});
test("TTL boundary admits at five minutes and refuses just beyond it", async () => {
  observe(positive(300_000)); const context = await resolve(); expect(context.kind).toBe("pool");
  clock.mockReturnValue(NOW + 1);
  expect(() => materializeCodexUpstreamAuth(new Headers(), context)).toThrow(CodexPoolAccountCreditsOffError);
});
for (const boundary of ["materialize", "dispatch", "sidecar", "provider", "cooldown"] as const) test(`late ${boundary} refusal retains live consent and metadata hint`, async () => {
  observe(positive(0)); const config = cfg(); const context = await resolve(config);
  observe(positive());
  const run = () => boundary === "materialize" ? materializeCodexUpstreamAuth(new Headers(), context)
    : boundary === "dispatch" ? createCodexAuthDispatchGuard(context, config, "gpt-5.5")!(new Headers())
    : boundary === "provider" ? applyCodexAuthContextToProvider({ adapter: "openai-responses", baseUrl: "https://example.test", authMode: "forward" }, context, "pool")
    : boundary === "cooldown" ? assertCodexAuthContextNotCooled(context)
    : createOpenAiSidecarCreditGuard(context, config)!();
  let error: unknown; try { run(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(CodexPoolAccountCreditsOffError); expectRetry(error as CodexAccountCooldownError, 300);
  config.creditCodexAccountIds = [];
  try { run(); } catch (e) { error = e; }
  expectRetry(error as CodexAccountCooldownError, 518_400);
});
test("authoritative upstream 429 Retry-After is not capped", () => {
  const error = new CodexAccountCooldownError(ID, NOW + 3_600_000, "retry-after");
  expectRetry(error, 3_600);
});
test("a stored upstream 429 cooldown still dominates a metadata-only retry hint", async () => {
  observe(positive());
  recordCodexUpstreamOutcome(cfg(), ID, 429, { retryAfter: "3600", now: NOW });
  expectRetry(await refusal(), 3_600);
});

test("materialization override wins over bound credit consent in both directions", async () => {
  observe(positive(0)); const config = cfg(); const context = await resolve(config); observe(positive());
  const attempt = (allowed: boolean) => {
    try { materializeCodexUpstreamAuth(new Headers(), context, { config: { creditCodexAccountIds: allowed ? [ID] : [] } }); }
    catch (error) { expect(error).toBeInstanceOf(CodexPoolAccountCreditsOffError); return error as CodexPoolAccountCreditsOffError; }
    throw new Error("expected credit admission refusal");
  };
  expectRetry(attempt(false), 518_400);
  config.creditCodexAccountIds = [];
  const error = attempt(true); expect(error.resetAt).toBe(RESET); expectRetry(error, 300);
});

test("unlimited zero balance admits while fresh and requests metadata after expiry", async () => {
  observe({ ...positive(300_000), unlimited: true, balance: 0 });
  expect((await resolve()).kind).toBe("pool");
  clock.mockReturnValue(NOW + 1);
  expectRetry(await refusal(), 300);
});
for (const veto of [{ allowed: false }, { hasCredits: false }, { overageLimitReached: true }]) {
  test(`unlimited zero balance preserves explicit veto ${JSON.stringify(veto)}`, async () => {
    observe({ ...positive(), unlimited: true, balance: 0, ...veto });
    expectRetry(await refusal(), 518_400);
  });
}
const unavailablePayloads: Parameters<typeof parseUsageQuota>[0][] = [
  { credits: {} }, { credits: null }, { credits: { balance: "invalid" } },
  { rate_limit: { allowed: false } },
  { credits: "invalid" } as unknown as Parameters<typeof parseUsageQuota>[0],
];
for (const payload of unavailablePayloads) test(`parser uncertainty stays refused with a short retry: ${JSON.stringify(payload)}`, async () => {
  observe(positive(0));
  setAccountQuotaFromParsed(ID, parseUsageQuota(payload));
  expect(getAccountQuota(ID)?.credits).toBeNull();
  expectRetry(await refusal(), 300);
  updateAccountQuota(ID, 100, RESET);
  setAccountQuotaFromParsed(ID, { weeklyPercent: 100, weeklyResetAt: RESET });
  expectRetry(await refusal(), 300);
  const config = cfg(); config.creditCodexAccountIds = [];
  expectRetry(await refusal(config), 518_400);
});
for (const payload of unavailablePayloads) for (const spend_control of [{ reached: true }, {}]) {
  test(`spending veto dominates unavailable evidence: ${JSON.stringify({ ...payload, spend_control })}`, async () => {
    observe(positive(0));
    setAccountQuotaFromParsed(ID, parseUsageQuota({ ...payload, spend_control }));
    expectRetry(await refusal(), 518_400);
  });
}
test("replacement clears uncertainty provenance, without reviving credit authority", async () => {
  observe(positive(0));
  const context = await resolve();
  const unknown = () => setAccountQuotaFromParsed(ID, parseUsageQuota({ credits: {} }));
  unknown(); expectRetry(await refusal(), 300);
  expect(() => materializeCodexUpstreamAuth(new Headers(), context)).toThrow(CodexPoolAccountCreditsOffError);
  observe(null); expectRetry(await refusal(), 518_400);
  unknown(); observe({ ...positive(), allowed: false }); expectRetry(await refusal(), 518_400);
  unknown(); observe(positive(0)); expect((await resolve()).kind).toBe("pool");
  expect(getAccountQuota(ID)?.creditObservationUnavailable).toBeUndefined();
  unknown(); observe(positive()); expectRetry(await refusal(), 300);
  expect(getAccountQuota(ID)?.creditObservationUnavailable).toBeUndefined();
  unknown(); setAccountQuotaFromParsed(ID, parseUsageQuota({ spend_control: { reached: true } }));
  expectRetry(await refusal(), 518_400);
  unknown(); expectRetry(await refusal(), 300);
});
test("unavailable versus legacy null survives persistence and a fresh reader process", async () => {
  observe(positive());
  setAccountQuotaFromParsed(ID, parseUsageQuota({ credits: {} }));
  setAccountQuotaFromParsed("legacy-null", { credits: null });
  const path = join(home, "codex-quota-cache.json");
  for (let tries = 0; !existsSync(path) && tries < 100; tries++) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { getAccountQuota } from './src/codex/quota';
    import { poolCreditRecoveryNeeded } from './src/codex/pool-credit-policy';
    Date.now = () => ${NOW};
    const policy = {creditCodexAccountIds: ['${ID}', 'legacy-null']};
    console.log(JSON.stringify(['${ID}', 'legacy-null'].map(id => ({
      credits: getAccountQuota(id)?.credits, recovery: poolCreditRecoveryNeeded(policy, id)
    }))));
  `], { cwd: repoRoot(), env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual([
    { credits: null, recovery: true }, { credits: null, recovery: false },
  ]);
});
