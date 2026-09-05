/**
 * The Claude pool toggle must not claim ownership of 429 failover.
 *
 * #3495 made reactive 429 rotation presence-activated and non-disableable, which left this
 * toggle describing behaviour it no longer controls: the off position said "Uses only the
 * active Claude account", so an operator would read a rate limit as terminal and could switch
 * the EXPERIMENTAL pool on to buy failover they already had. That is the opposite of what the
 * experimental warning directly beneath it is for.
 *
 * These assertions are deliberately about meaning rather than exact wording: a locale may
 * rephrase freely, but no locale may reintroduce a failover promise into the enabled strings,
 * and every locale must still say something in the disabled string. Copy drift in one of ten
 * files is exactly how the original inconsistency survived.
 */
import { describe, expect, test } from "bun:test";

const LOCALE_PATHS = [
  "gui/src/i18n/en.ts",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh.ts",
  "gui/src/i18n/zh-TW.ts",
] as const;

function valueOf(source: string, key: string): string {
  // The dictionaries are flat single-line entries, so the value is everything between the
  // first quote after the key and the closing quote of that line.
  const line = source.split("\n").find(candidate => candidate.includes(`"${key}":`));
  expect(line, `${key} is missing`).toBeDefined();
  const start = line!.indexOf(":") + 1;
  return line!.slice(start).trim();
}

describe("Claude account pool toggle copy", () => {
  test("no locale promises 429 failover in the ENABLED descriptions", async () => {
    // "429" is the load-bearing token: every locale writes the status code as digits, including
    // the CJK and Cyrillic ones, so this catches a reintroduced promise without needing to know
    // the surrounding language. The flag buys sticky sessions and proactive selection only.
    for (const path of LOCALE_PATHS) {
      const source = await Bun.file(path).text();
      expect(valueOf(source, "anthropicPool.enabledDesc"), path).not.toContain("429");
      expect(valueOf(source, "anthropicPool.enabledNoProactiveDesc"), path).not.toContain("429");
    }
  });

  test("every locale still states what the OFF position actually means", async () => {
    // The off position must keep describing the one-account-per-session behaviour it does own.
    // An empty or removed string would silently drop the explanation rather than fix it.
    for (const path of LOCALE_PATHS) {
      const source = await Bun.file(path).text();
      const disabled = valueOf(source, "anthropicPool.disabledDesc");
      expect(disabled.length, path).toBeGreaterThan(20);
    }
  });

  test("English names the non-disableable failover explicitly", async () => {
    // The source locale is the one a maintainer reads when deciding what the toggle means, so
    // it carries the full statement: a 429 still moves, and that is not a setting.
    const source = await Bun.file("gui/src/i18n/en.ts").text();
    const disabled = valueOf(source, "anthropicPool.disabledDesc");
    expect(disabled).toContain("429");
    expect(disabled).toContain("cannot be turned off");
  });

  test("the experimental warning is untouched", async () => {
    // What stays experimental is PROACTIVE multi-account routing -- the part Anthropic may
    // restrict, and the part the flag still governs. Softening this warning while relaxing the
    // failover gate would be the wrong trade.
    const source = await Bun.file("gui/src/i18n/en.ts").text();
    const warning = valueOf(source, "anthropicPool.experimentalWarning");
    expect(warning).toContain("Experimental and not battle-tested");
    expect(warning).toContain("automated multi-account rotation");
  });
});
