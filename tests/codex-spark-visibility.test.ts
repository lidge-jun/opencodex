import { describe, expect, test } from "bun:test";
import { withSparkVisibility } from "../src/codex/auth-api";
import { loadConfig, saveConfig } from "../src/config";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach } from "bun:test";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const SPARK = "GPT-5.3-Codex-Spark Weekly";
const originalHome = process.env.OPENCODEX_HOME;
let home = "";

function baseConfig(showSpark?: boolean): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
    ...(showSpark === undefined ? {} : { showCodexSparkQuota: showSpark }),
  } as unknown as OcxConfig;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-spark-visibility-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

/**
 * Codex Spark is a single-model weekly window. It reads 0% for most operators and, on a
 * multi-account pool, doubles the bar count on every card for information almost nobody acts
 * on — so it is hidden unless the operator asks for it.
 *
 * The filter lives at the projection boundary, never at parse or cache time: custom windows
 * participate in quota-presence checks, snapshot reconciliation and capacity aggregation, so
 * removing Spark upstream of the DTO would change routing state rather than display.
 */
describe("Codex Spark quota visibility", () => {
  test("hidden by default, with the window still present in the stored quota", () => {
    saveConfig(baseConfig());
    const stored = {
      weeklyPercent: 11,
      customWindows: [{ label: SPARK, percent: 33, resetAt: 3 }],
      updatedAt: Date.now(),
    };
    const projected = withSparkVisibility(stored);
    // Absent, not empty: an absent field and an empty array must not be two different ways of
    // saying the same thing on the wire.
    expect(projected.customWindows).toBeUndefined();
    // The source object is untouched — routing and capacity still see the window.
    expect(stored.customWindows).toHaveLength(1);
    expect(projected.weeklyPercent).toBe(11);
  });

  test("an explicit true reveals it unchanged", () => {
    saveConfig(baseConfig(true));
    loadConfig();
    const projected = withSparkVisibility({
      customWindows: [{ label: SPARK, percent: 33, resetAt: 3 }],
      updatedAt: Date.now(),
    });
    expect(projected.customWindows).toEqual([{ label: SPARK, percent: 33, resetAt: 3 }]);
  });

  test("an explicit false hides it", () => {
    saveConfig(baseConfig(false));
    loadConfig();
    const projected = withSparkVisibility({
      customWindows: [{ label: SPARK, percent: 33 }],
      updatedAt: Date.now(),
    });
    expect(projected.customWindows).toBeUndefined();
  });

  test("other providers' custom windows are NEVER filtered", () => {
    // customWindows is the generic carrier: Cursor, Anthropic, Antigravity and Kimi all ride it.
    // A filter written as "drop custom windows" instead of "drop the Spark label" would blank
    // every provider meter in the dashboard.
    saveConfig(baseConfig());
    const projected = withSparkVisibility({
      customWindows: [
        { label: "First-party models", percent: 40 },
        { label: "API usage", percent: 12 },
        { label: SPARK, percent: 33 },
        { label: "Fable", percent: 7 },
        { label: "Total subscription credits", percent: 90 },
      ],
      updatedAt: Date.now(),
    });
    expect(projected.customWindows?.map(window => window.label)).toEqual([
      "First-party models",
      "API usage",
      "Fable",
      "Total subscription credits",
    ]);
  });

  test("a quota with no custom windows is returned untouched", () => {
    saveConfig(baseConfig());
    const stored = { weeklyPercent: 50, updatedAt: 1 };
    expect(withSparkVisibility(stored)).toBe(stored);
  });

  test("null passes through", () => {
    saveConfig(baseConfig());
    expect(withSparkVisibility(null)).toBeNull();
  });
});

