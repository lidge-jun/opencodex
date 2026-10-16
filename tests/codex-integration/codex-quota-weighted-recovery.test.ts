import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { CodexAccountCooldownError, resolveCodexAuthContext } from "../../src/codex/auth-context";
import { clearPoolRotationState, seedPoolRotationAccount } from "../../src/codex/pool-rotation";
import { clearAllCodexPoolRefreshFailures, isCodexPoolRefreshCooling, noteCodexPoolRefreshFailure } from "../../src/codex/pool-refresh-backoff";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import {
  canAcquireCodexQuotaProbeLease, clearCodexUpstreamHealth, clearThreadAccountMap,
  getCodexAccountCooldownUntil, previewCodexAccountForRequest, recordCodexUpstreamOutcome,
  resolveCodexAccountForThreadDetailed, tryAcquireCodexQuotaProbeLease,
} from "../../src/codex/routing";
import { codexQuotaAvoidUntil, getAccountHealth } from "../../src/codex/routing/health-store";
import { accountPoolStrategyForScope } from "../../src/codex/routing/selection";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const minute = 60_000;
const start = 1_791_775_000_000;
const selectionOptions = { isMainAccountTokenLive: () => false };
const authOptions = { ...selectionOptions, primeCodexPoolQuotas: async () => {} };
let now: number;
let home: string;
let config: OcxConfig;
let oldHome: string | undefined;
let oldCodexHome: string | undefined;
let nowSpy: ReturnType<typeof spyOn<typeof Date, "now">>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

function addAccount(id: string, usage: number): void {
  config.codexAccounts!.push({ id, email: `${id}@example.test`, isMain: false });
  saveCodexAccountCredential(id, {
    accessToken: `fixture-${id}`, refreshToken: `fixture-refresh-${id}`,
    expiresAt: start + 3_600_000, chatgptAccountId: `fixture-account-${id}`,
  });
  setAccountQuotaFromParsed(id, { weeklyPercent: usage });
}

function avoidAccount(id = "a"): void {
  recordCodexUpstreamOutcome(config, id, 429, { now, resetAt: start + 120 * minute });
}

function preview(thread: string, options = selectionOptions): string | null {
  return previewCodexAccountForRequest(thread, config, now, undefined, options);
}

function resolve(thread: string, options = selectionOptions) {
  return resolveCodexAccountForThreadDetailed(thread, config, now, undefined, options);
}

beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME; oldCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-weighted-recovery-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  now = start;
  nowSpy = spyOn(Date, "now").mockImplementation(() => now);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("network is disabled in quota-weighted recovery fixtures");
  });
  clearPoolRotationState(); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota();
  clearAllCodexPoolRefreshFailures();
  for (const id of ["a", "b"]) clearAccountNeedsReauth(id);
  config = { providers: {}, accountPoolStrategy: "quota-weighted", activeCodexAccountId: "a",
    autoSwitchThreshold: 80, codexAccounts: [] } as unknown as OcxConfig;
  addAccount("a", 20);
});

afterEach(async () => {
  clearPoolRotationState(); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota();
  clearAllCodexPoolRefreshFailures();
  for (const id of ["a", "b"]) clearAccountNeedsReauth(id);
  await flushConfigDirHardeningForTests();
  nowSpy.mockRestore(); fetchSpy.mockRestore();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
  removeTreeWithRetry(home);
});

describe("quota-weighted last-resort health recovery", () => {
  test("expired hard cooldown leaves soft avoidance recoverable in preview, resolve and auth", async () => {
    avoidAccount(); now += 16 * minute;
    expect(getCodexAccountCooldownUntil("a", now)).toBeNull();
    expect(codexQuotaAvoidUntil("a", undefined, now)).toBeGreaterThan(now);
    expect(preview("recovered")).toBe("a");
    expect(resolve("recovered")).toMatchObject({ status: "selected", accountId: "a" });
    expect(await resolveCodexAuthContext(new Headers(), config, "pool", authOptions))
      .toMatchObject({ kind: "pool", accountId: "a" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("early recovery stays blocked; five-minute probes retain the existing single lease", async () => {
    avoidAccount();
    expect(preview("early")).toBe("a");
    expect(canAcquireCodexQuotaProbeLease("a", now)).toBe(false);
    await expect(resolveCodexAuthContext(new Headers(), config, "pool", authOptions))
      .rejects.toBeInstanceOf(CodexAccountCooldownError);
    now += 5 * minute;
    const before = structuredClone(getAccountHealth("a"));
    for (let i = 0; i < 3; i++) expect(preview(`probe-preview-${i}`)).toBe("a");
    expect(getAccountHealth("a")).toEqual(before);
    expect(canAcquireCodexQuotaProbeLease("a", now)).toBe(true);
    const probe = await resolveCodexAuthContext(new Headers(), config, "pool", authOptions);
    expect(probe.kind).toBe("pool");
    expect("probeLeaseId" in probe && probe.probeLeaseId).toBeString();
    expect(canAcquireCodexQuotaProbeLease("a", now)).toBe(false);
    await expect(resolveCodexAuthContext(new Headers(), config, "pool", authOptions))
      .rejects.toBeInstanceOf(CodexAccountCooldownError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("literal Retry-After is never admitted as a recovery probe", async () => {
    recordCodexUpstreamOutcome(config, "a", 429, { now, retryAfter: "3600" });
    now += 5 * minute;
    expect(preview("retry-after")).toBe("a");
    await expect(resolveCodexAuthContext(new Headers(), config, "pool", authOptions))
      .rejects.toBeInstanceOf(CodexAccountCooldownError);
  });

  test.each([
    { elapsed: 5, priority: false }, { elapsed: 5, priority: true },
    { elapsed: 16, priority: false }, { elapsed: 16, priority: true },
  ])("auth-ready recovery outranks a blocked higher weight/tier: %j", async ({ elapsed, priority }) => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 10 }); addAccount("b", 20);
    recordCodexUpstreamOutcome(config, "a", 429, { now, retryAfter: "3600" });
    avoidAccount("b"); now += elapsed * minute;
    if (priority) config.codexAccountPriorities = { a: 10 };
    const before = structuredClone(getAccountHealth("b"));
    for (let i = 0; i < 3; i++) expect(preview(`ready-${i}`)).toBe("b");
    expect(getAccountHealth("b")).toEqual(before);
    expect(resolve("ready")).toMatchObject({ accountId: "b" });
    const auth = await resolveCodexAuthContext(new Headers(), config, "pool", authOptions);
    expect(auth).toMatchObject({ kind: "pool", accountId: "b" });
    if (elapsed === 5) expect("probeLeaseId" in auth && auth.probeLeaseId).toBeString();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("an existing probe lease cannot mask a sibling's currently available probe", async () => {
    addAccount("b", 40); avoidAccount("a"); avoidAccount("b"); now += 5 * minute;
    expect(tryAcquireCodexQuotaProbeLease("a", now)).toBeString();
    config.codexAccountPriorities = { a: 10 };
    expect(canAcquireCodexQuotaProbeLease("b", now)).toBe(true);
    for (let i = 0; i < 3; i++) expect(preview(`available-probe-${i}`)).toBe("b");
    expect(canAcquireCodexQuotaProbeLease("b", now)).toBe(true);
    expect(await resolveCodexAuthContext(new Headers(), config, "pool", authOptions))
      .toMatchObject({ kind: "pool", accountId: "b" });
    expect(canAcquireCodexQuotaProbeLease("b", now)).toBe(false);
    await expect(resolveCodexAuthContext(new Headers(), config, "pool", authOptions))
      .rejects.toBeInstanceOf(CodexAccountCooldownError);
  });

  test("healthy positive-raw-weight candidates always precede recovering accounts", () => {
    addAccount("b", 70); avoidAccount(); now += 16 * minute;
    config.codexAccountPriorities = { a: 10 };
    expect(preview("healthy-first")).toBe("b");
    expect(resolve("healthy-first")).toMatchObject({ accountId: "b" });
  });

  test.each([80, 100])("health recovery never restores %s%% usage without credit opt-in", usage => {
    setAccountQuotaFromParsed("a", { weeklyPercent: usage });
    if (usage === 100) config.autoSwitchThreshold = 0;
    avoidAccount(); now += 16 * minute;
    expect(preview("drained")).toBeNull();
    expect(resolve("drained").status).toBe("none");
  });

  test("explicit fresh paid-credit opt-in keeps its existing raw-weight semantics", () => {
    avoidAccount(); now += 16 * minute;
    config.autoSwitchThreshold = 0; config.creditCodexAccountIds = ["a"];
    setAccountQuotaFromParsed("a", { weeklyPercent: 100, weeklyResetAt: start + 120 * minute,
      credits: { hasCredits: true, balance: 10, observedAt: now } });
    expect(preview("credit-opt-in")).toBe("a");
    expect(resolve("credit-opt-in")).toMatchObject({ accountId: "a" });
  });

  test("health recovery does not bypass credential-refresh backoff", () => {
    avoidAccount(); now += 16 * minute;
    for (let i = 0; i < 3; i++) noteCodexPoolRefreshFailure("a", "unknown", now);
    expect(isCodexPoolRefreshCooling("a", now)).toBe(true);
    expect(preview("refresh-cooling")).toBeNull();
    expect(resolve("refresh-cooling").status).toBe("none");
  });

  test.each(["paused", "reauth", "plan", "model", "credits-off"] as const)(
    "%s exclusion stays authoritative during recovery", reason => {
      avoidAccount(); now += 16 * minute;
      if (reason === "paused") config.pausedCodexAccountIds = ["a"];
      if (reason === "reauth") markAccountNeedsReauth("a");
      if (reason === "plan") {
        config.codexAccounts![0]!.plan = "free"; config.codexPool = { excludedPlans: ["free"] };
      }
      if (reason === "credits-off") {
        config.autoSwitchThreshold = 0;
        setAccountQuotaFromParsed("a", { weeklyPercent: 100, weeklyResetAt: start + 120 * minute });
      }
      const options = reason === "model"
        ? { ...selectionOptions, modelEligibleAccountIds: new Set<string>() } : selectionOptions;
      expect(preview("excluded", options)).toBeNull();
      expect(resolve("excluded", options).status).toBe("none");
    },
  );

  test("recovery preserves priority, positive-raw manual seeds and preview purity", () => {
    addAccount("b", 60); avoidAccount("a"); avoidAccount("b"); now += 16 * minute;
    config.codexAccountPriorities = { b: 10 };
    expect(preview("priority")).toBe("b");
    delete config.codexAccountPriorities;
    seedPoolRotationAccount("codex", "b");
    for (let i = 0; i < 3; i++) expect(preview("manual")).toBe("b");
    expect(resolve("manual")).toMatchObject({ accountId: "b" });
    expect(resolve("dominant")).toMatchObject({ accountId: "a" });
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("independent quota scopes retain the existing quota strategy fallback", () => {
    avoidAccount(); now += 16 * minute;
    expect(accountPoolStrategyForScope(config, "spark")).toBe("quota");
    expect(previewCodexAccountForRequest("independent", config, now, "spark", selectionOptions)).toBe("a");
  });
});
