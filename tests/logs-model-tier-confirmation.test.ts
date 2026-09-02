import { describe, expect, test } from "bun:test";
import { modelTitle, type ModelTitleEntry } from "../gui/src/pages/logs-model-title";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * #2455: a user routing gpt-5.x through the proxy asked for `service_tier: priority`,
 * saw the backend echo something else, and had no way to tell whether Fast was granted.
 *
 * The echo alone cannot answer it. The ChatGPT-internal Codex backend returns
 * `service_tier: "default"` on turns it in fact scheduled as priority, so its echo is
 * marked non-authoritative and the outcome stays `assumed` rather than being read as a
 * downgrade (#2558). That is the honest answer — but it was computed in `tierOutcome`
 * and never shown, so the tooltip printed a bare echoed value that looked like a denial.
 */

/**
 * Stub translator. The tier-outcome labels are marked with a `t:` prefix on purpose: a
 * hardcoded English label would render the same bare word as a translated one, so
 * without the marker these assertions could not tell the two apart. The real catalogs
 * are checked separately, by file, in the locale-coverage test.
 */
const t = ((key: string) => {
  const leaf = key.split(".").pop() ?? key;
  return key.includes("tierOutcome.") ? `t:${leaf}` : leaf;
}) as never;

const CONFIRMATIONS = ["confirmed", "assumed", "downgraded", "unknown"] as const;

function entry(over: Partial<ModelTitleEntry> = {}): ModelTitleEntry {
  return { model: "gpt-5.6-terra", ...over };
}

describe("model tooltip tier confirmation (#2455)", () => {
  test("qualifies the echoed tier with the outcome", () => {
    const title = modelTitle(
      entry({ responseServiceTier: "default", tierOutcome: { confirmation: "assumed" } }),
      t,
    );
    expect(title).toContain("=default (t:assumed)");
  });

  test("names the reason when the tier was actually declined", () => {
    const title = modelTitle(
      entry({
        responseServiceTier: "default",
        tierOutcome: { confirmation: "downgraded", fastDowngradeReason: "response-declined" },
      }),
      t,
    );
    expect(title).toContain("=default (t:downgraded: response-declined)");
  });

  test("a confirmed grant reads as confirmed", () => {
    const title = modelTitle(
      entry({ responseServiceTier: "priority", tierOutcome: { confirmation: "confirmed" } }),
      t,
    );
    expect(title).toContain("=priority (t:confirmed)");
  });

  test("no outcome leaves the existing tooltip unchanged", () => {
    const before = modelTitle(entry({ responseServiceTier: "default" }), t);
    expect(before).toContain("=default");
    expect(before).not.toContain("(");
  });

  test("an outcome without an echoed tier adds nothing", () => {
    // The qualifier explains an echoed value; with nothing echoed there is nothing to
    // qualify, and a lone parenthesis would read as a malformed field.
    const title = modelTitle(entry({ tierOutcome: { confirmation: "assumed" } }), t);
    expect(title).not.toContain("assumed");
    expect(title).toBe("model=gpt-5.6-terra");
  });

  test("a downgrade with no recorded reason omits the colon", () => {
    const title = modelTitle(
      entry({ responseServiceTier: "default", tierOutcome: { confirmation: "downgraded" } }),
      t,
    );
    expect(title).toContain("=default (t:downgraded)");
    expect(title).not.toContain("downgraded:");
  });

  test("every confirmation value is translated in every locale", () => {
    // The label is this proxy's own judgement about the turn, so it is visible text and
    // must not fall back to a raw key in any dashboard language. Read the catalogs as
    // files: importing the barrel pulls in the whole GUI dependency graph.
    // Named explicitly: the directory also holds label modules that are not catalogs,
    // and this list is the same one LOCALES declares in i18n/shared.ts.
    const LOCALE_FILES = [
      "en.ts", "de.ts", "fr.ts", "ko.ts", "zh.ts", "zh-TW.ts", "ru.ts", "ja.ts", "tr.ts",
    ];
    const dir = join(import.meta.dir, "..", "gui", "src", "i18n");
    const present = readdirSync(dir);
    for (const file of LOCALE_FILES) {
      expect(present, `${file} disappeared from i18n/`).toContain(file);
    }

    for (const file of LOCALE_FILES) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const confirmation of CONFIRMATIONS) {
        const key = `"logs.modelTooltip.tierOutcome.${confirmation}":`;
        const line = text.split("\n").find(l => l.includes(key));
        expect(line, `${file} is missing ${key}`).toBeTruthy();
        const value = line!.slice(line!.indexOf(key) + key.length).trim().replace(/^"|",?$/g, "");
        expect(value.length, `${file} ${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  test("the downgrade reason stays a verbatim identifier", () => {
    // `response-declined` maps to fastDowngradeReason in the source; translating it
    // would break the link between what the operator reads and what to grep for.
    const title = modelTitle(
      entry({
        responseServiceTier: "default",
        tierOutcome: { confirmation: "downgraded", fastDowngradeReason: "wire-unavailable" },
      }),
      t,
    );
    expect(title).toContain("wire-unavailable");
  });
});
