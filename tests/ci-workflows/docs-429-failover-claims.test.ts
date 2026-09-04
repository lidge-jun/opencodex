/**
 * The published docs must not promise a 429-failover kill switch.
 *
 * Reactive rotation activates on account presence and cannot be disabled. Every locale of the
 * configuration and CLI reference previously said `oauthAccountFailover.enabled: false` turns
 * rotation off, and that `anthropicAccountPool.enabled` gates 429 failover. Both were true when
 * written and both stopped being true when reactive and proactive activation were split.
 *
 * Public docs that contradict the runtime are worse than missing docs: an operator reads them,
 * concludes a rate limit is terminal, and turns on an EXPERIMENTAL pool to buy recovery they
 * already have. This pins the corrected claim in the source locale and asserts the translated
 * locales carry the same shape, since a nine-locale set drifts one file at a time.
 */
import { describe, expect, test } from "bun:test";

const CONFIG_REFERENCE = "docs-site/src/content/docs/reference/configuration/providers.md";
const CLI_REFERENCE = "docs-site/src/content/docs/reference/cli/providers-accounts.md";
const TRANSLATED = ["ko", "ja", "zh-cn", "zh-tw", "fr", "ru", "tr"] as const;

describe("429 failover docs", () => {
  test("the config reference states the failover is not gated and not disableable", async () => {
    const source = await Bun.file(CONFIG_REFERENCE).text();
    const anthropicRow = source
      .split("\n")
      .find(line => line.includes("`anthropicAccountPool.enabled?`"));
    expect(anthropicRow).toBeDefined();
    expect(anthropicRow).toContain("not gated here");
    expect(anthropicRow).toContain("cannot be switched off");

    // The generic knob keeps a real meaning -- the pre-dispatch preference -- so the row must say
    // what it still refuses rather than simply deleting the switch.
    const genericRow = source
      .split("\n")
      .find(line => line.includes("| `oauthAccountFailover.enabled?`"));
    expect(genericRow).toBeDefined();
    expect(genericRow).toContain("pre-dispatch account preference");
    expect(genericRow).toContain("does **not** disable 429 rotation");
  });

  test("the CLI reference no longer says rotation can be turned off", async () => {
    const source = await Bun.file(CLI_REFERENCE).text();
    expect(source).toContain("cannot be turned off");
  });

  test("every translated locale carries the corrected claim", async () => {
    // Shape, not wording: each locale phrases it natively, but none may still present the knob
    // as a rotation kill switch. The English marker strings are the ones a drift would drop.
    for (const locale of TRANSLATED) {
      const config = await Bun.file(
        `docs-site/src/content/docs/${locale}/reference/configuration/providers.md`,
      ).text();
      const row = config
        .split("\n")
        .find(line => line.includes("`anthropicAccountPool.enabled?`"));
      expect(row, `${locale} is missing the anthropicAccountPool row`).toBeDefined();
      // Every translation keeps the literal `429` and marks the sentence bold, so a locale that
      // silently reverted to the old one-line description fails here.
      expect(row, `${locale} lost the 429 carve-out`).toContain("**");
      expect(row, `${locale} lost the 429 carve-out`).toContain("429");
    }
  });

  test("the Claude Code guide does not attribute 429 failover to the pool", async () => {
    // The guide is where an operator decides whether to enable the experimental pool at all, so
    // a stale sentence here is the most expensive one in the docs: it sells the pool on recovery
    // that is now unconditional. Checked in the source locale and the three that translate it.
    //
    // Asserting only that the intro mentions 429 and carries emphasis is too weak: the ORIGINAL
    // stale sentence would satisfy both. So each locale bans the phrase pattern that actually
    // attributed failover to the pool, which is the thing that has to stay gone.
    const bannedByLocale: Record<string, RegExp> = {
      "": /adds sticky[\s\S]{0,80}429/i,
      "zh-tw/": /加入[\s\S]{0,40}429\s*冷卻(故障轉移|容錯移轉)/,
      "tr/": /bağlılığı ve 429[\s\S]{0,60}yük devretmesi ekler/i,
      "fr/": /ajoute l['’]affinité de[\s\S]{0,80}basculement[\s\S]{0,40}429/i,
    };
    for (const [path, banned] of Object.entries(bannedByLocale)) {
      const label = path || "en";
      const source = await Bun.file(`docs-site/src/content/docs/${path}guides/claude-code.md`).text();
      const intro = source.slice(0, source.indexOf("anthropicAccountPool.strategy"));
      expect(intro, `${label} guide`).toContain("429");
      expect(banned.test(intro), `${label} guide re-attributes 429 failover to the pool`).toBe(false);
    }
  });
});
