/**
 * The Claude pool toggle must not claim ownership of 429 failover.
 *
 * #3495 made reactive 429 rotation presence-activated and non-disableable, which left this
 * toggle describing behaviour it no longer controls: the off position said "Uses only the
 * active Claude account", so an operator would read a rate limit as terminal and could switch
 * the EXPERIMENTAL pool on to buy failover they already had. That is the opposite of what the
 * conditions notice directly beneath it is for.
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
  "gui/src/i18n/pt.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/vi.ts",
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
      expect(valueOf(source, "anthropicPool.enabledFillFirstDesc"), path).not.toContain("429");
      expect(valueOf(source, "anthropicPool.enabledFillFirstNoThresholdDesc"), path).not.toContain("429");
      expect(valueOf(source, "anthropicPool.enabledRoundRobinDesc"), path).not.toContain("429");
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

  test("every locale says the OFF position still fails over on a 429", async () => {
    // The source locale is the one a maintainer reads when deciding what the toggle means, so
    // it carries the full statement: a 429 still moves while the pool is off. Every locale
    // repeats the status code in the off description and in the failover detail line.
    for (const path of LOCALE_PATHS) {
      const source = await Bun.file(path).text();
      expect(valueOf(source, "anthropicPool.disabledDesc"), path).toContain("429");
      expect(valueOf(source, "anthropicPool.detailsFailover"), path).toContain("429");
    }
    const source = await Bun.file("gui/src/i18n/en.ts").text();
    const disabled = valueOf(source, "anthropicPool.disabledDesc");
    expect(disabled).toContain("Proactive account selection is off");
    expect(disabled).toContain("can still switch after a rate-limit response (429)");
  });

  test("the pool notice states its conditions without promising compliance", async () => {
    // The notice replaced an alarm ("not battle-tested ... keep this off") that told operators
    // nothing they could act on. What replaces it must name the conditions the pool is meant
    // for and still say it is experimental and unendorsed -- softer wording, not a softer claim.
    const source = await Bun.file("gui/src/i18n/en.ts").text();
    const warning = valueOf(source, "anthropicPool.experimentalWarning");
    for (const claim of [
      "subscriptions you own or are authorized to use",
      "not endorsed by Anthropic",
      "remains experimental",
      "genuine Claude Code client",
      "a person supervising the session",
      "Anthropic's current terms",
      "may not add capacity",
    ]) expect(warning).toContain(claim);
    for (const banned of ["battle-tested", "Keep this off", "safe", "compliant", "guarantee"]) {
      expect(warning).not.toContain(banned);
    }
    // Every locale names the client and the vendor in the notice it renders.
    for (const path of LOCALE_PATHS) {
      const localized = valueOf(await Bun.file(path).text(), "anthropicPool.experimentalWarning");
      expect(localized, path).toContain("Claude Code");
      expect(localized, path).toContain("Anthropic");
    }
  });
});
