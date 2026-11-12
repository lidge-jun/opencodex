import { describe, expect, test } from "bun:test";
import { detectWeeklyWindowConflicts } from "../../src/codex/quota-window-conflict";
import type { QuotaHistorySample } from "../../src/codex/quota-history";

const H = 3_600_000;
const D = 24 * H;
const RESET_A = Date.UTC(2026, 10, 11, 18, 55, 40);
const RESET_B = Date.UTC(2026, 10, 17, 18, 34, 49);
const at = (hour: number, minute: number) => Date.UTC(2026, 10, 11, hour, minute);
const sample = (observedAt: number, source: QuotaHistorySample["source"], usedPercent: number, resetAtMs: number, credentialGeneration = 1): QuotaHistorySample => ({
  observedAt, source, credentialGeneration,
  windows: [{ family: "account", window: "short", usedPercent: 5, resetAtMs: observedAt + 2 * H }, { family: "account", window: "weekly", usedPercent, resetAtMs }],
});

// The reported 2026-11-11 sequence for one pool account and credential generation.
const reported = [
  sample(at(14, 58), "response-header", 24, RESET_B), sample(at(15, 0), "response-header", 100, RESET_A),
  sample(at(15, 6), "wham", 100, RESET_A), sample(at(15, 17), "wham", 24, RESET_B),
  sample(at(16, 34), "response-header", 100, RESET_A), sample(at(16, 35), "response-header", 24, RESET_B),
  sample(at(16, 36), "response-header", 100, RESET_A), sample(at(17, 40), "wham", 24, RESET_B),
];

describe("conflicting weekly quota windows (#8574)", () => {
  test("the reported back-and-forth is a conflict naming both windows with source and time", () => {
    expect(detectWeeklyWindowConflicts(reported, 1, at(17, 45))).toEqual([{ family: "account", windows: [
      { resetAtMs: RESET_A, usedPercent: 100, source: "response-header", observedAt: at(16, 36) },
      { resetAtMs: RESET_B, usedPercent: 24, source: "wham", observedAt: at(17, 40) },
    ] }]);
  });

  test("the conflict ends once the earlier window's reset has passed", () => {
    expect(detectWeeklyWindowConflicts(reported, 1, RESET_A + 1)).toEqual([]);
  });

  test("a true rollover is not a conflict", () => {
    const rollover = [sample(at(15, 0), "wham", 100, RESET_A), sample(at(17, 0), "wham", 100, RESET_A),
      sample(RESET_A + 60_000, "wham", 0, RESET_A + 7 * D), sample(RESET_A + H, "response-header", 2, RESET_A + 7 * D)];
    expect(detectWeeklyWindowConflicts(rollover, 1, RESET_A + 2 * H)).toEqual([]);
  });

  test("an early reset that never returns to the old window is not a conflict", () => {
    const early = [sample(at(15, 0), "wham", 100, RESET_A), sample(at(15, 30), "wham", 0, RESET_B), sample(at(16, 0), "response-header", 1, RESET_B)];
    expect(detectWeeklyWindowConflicts(early, 1, at(16, 5))).toEqual([]);
  });

  test("reset times that drift by seconds are one window", () => {
    const jitter = [sample(at(15, 0), "wham", 30, RESET_B), sample(at(15, 5), "response-header", 31, RESET_B + 40_000), sample(at(15, 10), "wham", 32, RESET_B - 20_000)];
    expect(detectWeeklyWindowConflicts(jitter, 1, at(15, 15))).toEqual([]);
  });

  test("only the current credential generation counts", () => {
    const mixed = [sample(at(14, 58), "wham", 24, RESET_B, 1), sample(at(15, 0), "wham", 100, RESET_A, 2)];
    expect(detectWeeklyWindowConflicts(mixed, 2, at(15, 5))).toEqual([]);
    expect(detectWeeklyWindowConflicts(mixed, undefined, at(15, 5))).toEqual([]);
  });

  test("account and spark conflicts are reported separately, and a parse keeps at most two", async () => {
    const both = reported.map(row => ({ ...row, windows: [...row.windows, ...row.windows.map(window => ({ ...window, family: "spark" as const }))] }));
    const conflicts = detectWeeklyWindowConflicts(both, 1, at(17, 45));
    expect(conflicts.map(conflict => conflict.family)).toEqual(["account", "spark"]);
    const { parseWeeklyWindowConflicts } = await import("../../src/codex/quota-window-conflict");
    expect(parseWeeklyWindowConflicts([...conflicts, conflicts[0]])).toHaveLength(2);
  });

  test("a reset time outside JavaScript Date's range never becomes a conflict", async () => {
    const huge = 1e16;
    const flip = [sample(at(15, 0), "wham", 24, huge), sample(at(15, 5), "wham", 100, RESET_A), sample(at(15, 10), "wham", 24, huge), sample(at(15, 15), "wham", 100, RESET_A)];
    expect(detectWeeklyWindowConflicts(flip, 1, at(15, 20))).toEqual([]);
    const { parseWeeklyWindowConflicts } = await import("../../src/codex/quota-window-conflict");
    const window = { resetAtMs: RESET_A, usedPercent: 100, source: "wham", observedAt: at(15, 5) };
    expect(parseWeeklyWindowConflicts([{ family: "account", windows: [window, { ...window, resetAtMs: huge }] }])).toBeUndefined();
    expect(parseWeeklyWindowConflicts([{ family: "account", windows: [window, { ...window, resetAtMs: RESET_B, observedAt: huge }] }])).toBeUndefined();
  });
});

describe("the pool account row names a weekly window conflict (#8574)", () => {
  const { afterEach: after, beforeEach: before } = require("bun:test") as typeof import("bun:test");
  let home = "";
  let previous: string | undefined;
  let isolated: { restore(): void } | null = null;
  const originalFetch = globalThis.fetch;
  before(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { installIsolatedCodexHome } = await import("../helpers/isolated-codex-home");
    previous = process.env.OPENCODEX_HOME;
    isolated = installIsolatedCodexHome("ocx-weekly-conflict-codex-");
    home = mkdtempSync(join(tmpdir(), "ocx-weekly-conflict-"));
    process.env.OPENCODEX_HOME = home;
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  });
  after(async () => {
    const { removeTreeWithRetry } = await import("../helpers/remove-tree");
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    isolated?.restore();
    isolated = null;
    removeTreeWithRetry(home);
  });

  async function rowAfter(observations: Array<[number, QuotaHistorySample["source"], number, number]>) {
    const { saveConfig, loadConfig } = await import("../../src/config");
    const { saveCodexAccountCredential, readCodexAccountRecord, capturePoolQuotaWriter } = await import("../../src/codex/account-store");
    const { setAccountQuotaFromParsed } = await import("../../src/codex/quota");
    const { handleCodexAuthAPI } = await import("../../src/codex/auth-api/routes");
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      codexAccounts: [{ id: "pool-flip", email: "flip@example.test", isMain: false, plan: "prolite" }] } as never);
    saveCodexAccountCredential("pool-flip", { accessToken: "access-flip", refreshToken: "refresh-flip", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "acct-flip" });
    const record = readCodexAccountRecord("pool-flip")!;
    const writer = capturePoolQuotaWriter("pool-flip", { ...record.credential!, generation: record.generation })!;
    for (const [observedAt, source, weeklyPercent, weeklyResetAt] of observations) {
      const raw = { weeklyPercent, weeklyResetAt };
      setAccountQuotaFromParsed("pool-flip", raw, undefined, undefined, raw, { writer, observedAt, source, raw });
    }
    const request = new Request("http://localhost/api/codex-auth/accounts");
    const response = await handleCodexAuthAPI(request, new URL(request.url), loadConfig());
    const body = await response!.json() as { accounts: Array<Record<string, unknown> & { id: string }> };
    return body.accounts.find(account => account.id === "pool-flip")!;
  }

  test("an account flipping between two live seven-day windows carries both, with source and time", async () => {
    const now = Date.now();
    const soon = now + 3 * H;
    const later = now + 6 * D;
    const row = await rowAfter([
      [now - 30 * 60_000, "response-header", 24, later], [now - 25 * 60_000, "response-header", 100, soon],
      [now - 20 * 60_000, "wham", 24, later], [now - 10 * 60_000, "response-header", 100, soon],
    ]);
    expect(row.weeklyQuotaConflicts).toEqual([{ family: "account", windows: [
      { resetAtMs: soon, usedPercent: 100, source: "response-header", observedAt: now - 10 * 60_000 },
      { resetAtMs: later, usedPercent: 24, source: "wham", observedAt: now - 20 * 60_000 },
    ] }]);
  });

  test("a plain rollover leaves the row without a conflict", async () => {
    const now = Date.now();
    const row = await rowAfter([[now - 30 * 60_000, "wham", 40, now + 6 * D], [now - 10 * 60_000, "response-header", 41, now + 6 * D]]);
    expect(row).not.toHaveProperty("weeklyQuotaConflicts");
  });

  test("a row built from the listing's store snapshot adds no credential store reads", async () => {
    const now = Date.now();
    await rowAfter([[now - 30 * 60_000, "wham", 24, now + 6 * D], [now - 20 * 60_000, "wham", 100, now + 3 * H], [now - 10 * 60_000, "wham", 24, now + 6 * D], [now - 5 * 60_000, "wham", 100, now + 3 * H]]);
    const { registerDecisionQuotaSink } = await import("../../src/lib/decision-quota-sink");
    const { loadConfig } = await import("../../src/config");
    const { readCodexAccountRecord } = await import("../../src/codex/account-store");
    const { poolAccountDto } = await import("../../src/codex/auth-api/account-list");
    const config = loadConfig();
    const record = readCodexAccountRecord("pool-flip");
    let storeLoads = 0;
    const counter = new Proxy({}, { get: (_target, name) => name === "codexStoreLoaded" ? () => { storeLoads++; } : () => undefined });
    const detach = registerDecisionQuotaSink(counter as never);
    try {
      const dto = poolAccountDto(config, config.codexAccounts![0]!, { quota: null, needsReauth: false }, true, false, 0, false, undefined, record);
      expect(dto.weeklyQuotaConflicts?.[0]?.family).toBe("account");
    } finally {
      detach();
    }
    // The one remaining read is the health projection's, which predates #8574. The conflict
    // reader and the credits identity take the snapshot record instead of reloading the store.
    expect(storeLoads).toBe(1);
  });

  test("reading conflicts never prunes or clears the stored history", async () => {
    const now = Date.now();
    await rowAfter([[now - 30 * 60_000, "wham", 24, now + 6 * D], [now - 10 * 60_000, "wham", 100, now + 3 * H]]);
    const { readCodexAccountRecord } = await import("../../src/codex/account-store");
    const { getAccountWeeklyQuotaConflicts, getAccountQuotaHistory } = await import("../../src/codex/quota");
    const record = readCodexAccountRecord("pool-flip")!;
    const stranger = { ...record, quotaHistoryIdentity: "00000000-0000-4000-8000-000000000000" };
    expect(getAccountWeeklyQuotaConflicts("pool-flip", stranger, now)).toEqual([]);
    expect(getAccountWeeklyQuotaConflicts("pool-flip", null, now)).toEqual([]);
    expect(getAccountQuotaHistory("pool-flip").observations).toHaveLength(2);
  });
});

describe("the conflict reaches the dashboard and CLI without free text (#8574)", () => {
  const conflict = [{ family: "account", windows: [
    { resetAtMs: RESET_A, usedPercent: 100, source: "response-header", observedAt: at(16, 36) },
    { resetAtMs: RESET_B, usedPercent: 24, source: "wham", observedAt: at(17, 40) },
  ] }];

  test("the dashboard sentence names both windows with their source", async () => {
    const { weeklyWindowConflictText } = await import("../../gui/src/codex-weekly-conflict");
    const { en } = await import("../../gui/src/i18n/en");
    const t = ((key: string, vars: Record<string, string> = {}) => (en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "")) as never;
    const text = weeklyWindowConflictText(conflict, t, "en-US")!;
    expect(text).toContain("100% →");
    expect(text).toContain("24% →");
    expect(text).toContain("response-header");
    expect(text).toContain("wham");
    expect(text).toContain("may not restore the full allowance");
    expect(weeklyWindowConflictText(undefined, t, "en-US")).toBeUndefined();
    expect(weeklyWindowConflictText([{ family: "account", windows: [{ resetAtMs: "soon" }] }], t, "en-US")).toBeUndefined();
    // A nanosecond-style epoch would make Intl.DateTimeFormat throw and blank the Providers page.
    const outOfRange = [{ family: "account", windows: [conflict[0]!.windows[0], { ...conflict[0]!.windows[1], resetAtMs: 1e16 }] }];
    expect(() => weeklyWindowConflictText(outOfRange, t, "en-US")).not.toThrow();
    expect(weeklyWindowConflictText(outOfRange, t, "en-US")).toBeUndefined();
  });

  test("every locale translates the sentence and keeps both placeholders", async () => {
    for (const locale of ["en", "ko", "ja", "zh", "zh-TW", "de", "fr", "pt", "ru", "tr", "vi"]) {
      const catalog = Object.values(await import(`../../gui/src/i18n/${locale}`))[0] as Record<string, string>;
      const sentence = catalog["codexAuth.weeklyConflict"];
      expect(sentence, locale).toContain("{first}");
      expect(sentence, locale).toContain("{second}");
      if (locale !== "en") expect(sentence, locale).not.toBe((Object.values(await import("../../gui/src/i18n/en"))[0] as Record<string, string>)["codexAuth.weeklyConflict"]);
    }
  });

  test("the CLI quota column flags the conflict and drops malformed evidence", async () => {
    const { formatAccountTable } = await import("../../src/cli/account");
    const { parseWeeklyWindowConflicts } = await import("../../src/codex/quota-window-conflict");
    const row = { provider: "openai", type: "codex" as const, id: "pool-flip", label: "prolite", active: false, paused: false, priority: 0,
      quota: { weeklyPercent: 24, shortPercent: 5 }, weeklyQuotaConflicts: parseWeeklyWindowConflicts(conflict) };
    expect(formatAccountTable([row as never], true)).toContain("wk 24% (weekly windows conflict)");
    expect(parseWeeklyWindowConflicts([{ family: "account", windows: [conflict[0]!.windows[0], { ...conflict[0]!.windows[1], source: "made-up" }] }])).toBeUndefined();
    expect(parseWeeklyWindowConflicts("conflict")).toBeUndefined();
  });
});
