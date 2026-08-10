import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, validateConfigCandidate } from "../src/config";

let temporaryHome: string | null = null;
let previousHome: string | undefined;

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true });
  temporaryHome = null;
  previousHome = undefined;
});

describe("economicAllowances validation", () => {
  test("malformed top-level economicAllowances is rejected without throwing", () => {
    const base = getDefaultConfig();
    expect(() => validateConfigCandidate({ ...base, economicAllowances: "not-an-object" })).not.toThrow();
    expect(validateConfigCandidate({ ...base, economicAllowances: "not-an-object" }).ok).toBe(false);

    expect(validateConfigCandidate({ ...base, economicAllowances: [] }).ok).toBe(false);
    expect(validateConfigCandidate({ ...base, economicAllowances: 123 }).ok).toBe(false);
    expect(validateConfigCandidate({ ...base, economicAllowances: null }).ok).toBe(false);
  });

  test("malformed allowance entries produce actionable errors", () => {
    const base = getDefaultConfig();
    const cases: Array<{ allowance: unknown; contains: string }> = [
      { allowance: { unit: "credits", capacity: "bad", window: { kind: "balance" } }, contains: "capacity" },
      { allowance: { unit: "bad-unit", capacity: 10, window: { kind: "balance" } }, contains: "unit" },
      { allowance: { unit: "credits", capacity: 10 }, contains: "window" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "rolling" } }, contains: "durationMs" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "rolling", durationMs: 0 } }, contains: "durationMs" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "calendar", interval: "month", timezone: "Not/AZone" } }, contains: "timezone" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "expiresAt", expiresAt: -1 } }, contains: "expiresAt" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "balance" }, reserveFraction: 2 }, contains: "reserveFraction" },
      { allowance: { unit: "credits", capacity: 5, window: { kind: "balance" }, reserveAmount: 10 }, contains: "reserveAmount" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "balance" }, source: "unknown" }, contains: "source" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "balance" }, staleAfterMs: -1 }, contains: "staleAfterMs" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "balance" }, rates: "bad" }, contains: "rates" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "balance" }, rates: { inputPerMillion: Number.NaN } }, contains: "inputPerMillion" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "balance" }, rates: { inputPerMillion: Number.POSITIVE_INFINITY } }, contains: "inputPerMillion" },
      { allowance: { unit: "credits", capacity: 10, window: { kind: "balance" }, rates: { inputPerMillion: -1 } }, contains: "inputPerMillion" },
    ];
    for (const { allowance, contains } of cases) {
      const result = validateConfigCandidate({ ...base, economicAllowances: { bad: allowance as never } });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.error.toLowerCase()).toContain(contains.toLowerCase());
    }
  });

  test("old configs without economicAllowances still validate", () => {
    const base = getDefaultConfig();
    const { economicAllowances: _omit, ...rest } = base as Record<string, unknown>;
    expect(validateConfigCandidate(rest).ok).toBe(true);
    expect(validateConfigCandidate({ ...rest, economicAllowances: undefined }).ok).toBe(true);
    expect(validateConfigCandidate({ ...rest, economicAllowances: {} }).ok).toBe(true);
  });

  test("unsafe allowance ids are rejected while stable ids remain valid", () => {
    const base = getDefaultConfig();
    const allowance = { unit: "credits", capacity: 10, window: { kind: "balance" } };
    for (const id of ["__proto__", "prototype", "constructor", "bad id", ".leading", "x".repeat(65)]) {
      const allowances = JSON.parse(`{${JSON.stringify(id)}:${JSON.stringify(allowance)}}`) as Record<string, unknown>;
      const result = validateConfigCandidate({ ...base, economicAllowances: allowances });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("allowance id");
    }
    expect(validateConfigCandidate({ ...base, economicAllowances: { "provider-five_hour.v1": allowance } }).ok).toBe(true);
  });

  test("loadConfig drops malformed optional allowances without discarding providers", () => {
    previousHome = process.env.OPENCODEX_HOME;
    temporaryHome = mkdtempSync(join(tmpdir(), "ocx-economic-load-"));
    process.env.OPENCODEX_HOME = temporaryHome;
    const base = getDefaultConfig();
    const configPath = getConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      ...base,
      defaultProvider: "preserved",
      providers: {
        ...base.providers,
        preserved: { adapter: "openai-chat", baseUrl: "https://preserved.example/v1", apiKey: "keep-me" },
      },
      economicAllowances: {
        valid: { unit: "credits", capacity: 10, window: { kind: "balance" } },
        broken: { unit: "credits", capacity: "bad", window: { kind: "balance" } },
      },
    }));

    const loaded = loadConfig();
    expect(loaded.defaultProvider).toBe("preserved");
    expect(loaded.providers.preserved?.baseUrl).toBe("https://preserved.example/v1");
    expect(loaded.economicAllowances?.valid?.capacity).toBe(10);
    expect(Object.hasOwn(loaded.economicAllowances ?? {}, "broken")).toBe(false);
  });
});
