/**
 * The preset totals in the docs must be recounted from the registry, not restated by hand.
 *
 * Eight pages carry the number and seven of them are translations, so a preset landing in the
 * registry updates the English guide and silently leaves the rest behind. That is exactly what
 * happened: the English guide reached 95 (79 key-based) while ja, ko, fr, ru, tr, zh-CN and
 * zh-TW — and every quickstart including the English one — still said 94 (78 key-based). Nothing
 * failed, because both numbers read as plausible and no check compared them to the registry.
 *
 * AGENTS.md calls this class out directly: prefer deriving a count from the thing it describes
 * over restating it. The counts here are derived from PROVIDER_REGISTRY, so the next preset that
 * lands fails this test in every locale at once instead of drifting.
 *
 * Each page is anchored by a locale-specific fragment rather than a number, so a reworded
 * sentence fails loudly and asks to be re-anchored. That is the intended behavior: a sentence
 * nobody can locate is a sentence nobody is checking.
 */
import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { repoPath } from "../helpers/repo-root";

const TOTAL = PROVIDER_REGISTRY.length;
const KEY_PRESETS = PROVIDER_REGISTRY.filter(entry => entry.authKind === "key").length;

/** Guides state the total and the key-based split on one line. */
const GUIDES = [
  { locale: "en", path: "docs-site/src/content/docs/guides/providers.md", anchor: "opencodex ships" },
  { locale: "ja", path: "docs-site/src/content/docs/ja/guides/providers.md", anchor: "組み込みプリセットが" },
  { locale: "ko", path: "docs-site/src/content/docs/ko/guides/providers.md", anchor: "빌트인 프리셋이" },
  { locale: "fr", path: "docs-site/src/content/docs/fr/guides/providers.md", anchor: "préréglages intégrés" },
  { locale: "ru", path: "docs-site/src/content/docs/ru/guides/providers.md", anchor: "встроенными пресетами" },
  { locale: "tr", path: "docs-site/src/content/docs/tr/guides/providers.md", anchor: "yerleşik önayar ile" },
  { locale: "zh-cn", path: "docs-site/src/content/docs/zh-cn/guides/providers.md", anchor: "个密钥预设" },
  { locale: "zh-tw", path: "docs-site/src/content/docs/zh-tw/guides/providers.md", anchor: "個 key-based" },
] as const;

/** Quickstarts state the total only. */
const QUICKSTARTS = [
  { locale: "en", path: "docs-site/src/content/docs/getting-started/quickstart.md", anchor: "built-in registry presets" },
  { locale: "ja", path: "docs-site/src/content/docs/ja/getting-started/quickstart.md", anchor: "組み込みレジストリプリセット" },
  { locale: "ko", path: "docs-site/src/content/docs/ko/getting-started/quickstart.md", anchor: "내장 레지스트리 프리셋" },
  { locale: "fr", path: "docs-site/src/content/docs/fr/getting-started/quickstart.md", anchor: "préréglages intégrés au registre" },
  { locale: "ru", path: "docs-site/src/content/docs/ru/getting-started/quickstart.md", anchor: "встроенных пресетов реестра" },
  { locale: "tr", path: "docs-site/src/content/docs/tr/getting-started/quickstart.md", anchor: "önayardan birini" },
  { locale: "zh-cn", path: "docs-site/src/content/docs/zh-cn/getting-started/quickstart.md", anchor: "个预设中选择一个" },
  { locale: "zh-tw", path: "docs-site/src/content/docs/zh-tw/getting-started/quickstart.md", anchor: "個預設中選擇一個" },
] as const;

const STRUCTURE = {
  path: "structure/ops/docs-and-release.md",
  anchor: "documented split is",
} as const;

async function anchoredLine(path: string, anchor: string): Promise<string> {
  const source = await Bun.file(repoPath(path)).text();
  const lines = source.split("\n").filter(line => line.includes(anchor));
  expect(lines.length, `${path} has no line containing "${anchor}"; re-anchor this check`).toBe(1);
  return lines[0]!;
}

describe("documented provider preset counts match the registry", () => {
  test("the registry is the only source of the numbers under test", () => {
    // A derived count that collapsed to zero would make every assertion below vacuous.
    expect(TOTAL).toBeGreaterThan(0);
    expect(KEY_PRESETS).toBeGreaterThan(0);
    expect(KEY_PRESETS).toBeLessThanOrEqual(TOTAL);
  });

  for (const guide of GUIDES) {
    test(`${guide.locale} provider guide states ${TOTAL} presets and ${KEY_PRESETS} key-based`, async () => {
      const line = await anchoredLine(guide.path, guide.anchor);
      expect(line, `${guide.path} total`).toContain(String(TOTAL));
      expect(line, `${guide.path} key-based split`).toContain(String(KEY_PRESETS));
    });
  }

  for (const quickstart of QUICKSTARTS) {
    test(`${quickstart.locale} quickstart states ${TOTAL} presets`, async () => {
      const line = await anchoredLine(quickstart.path, quickstart.anchor);
      expect(line, `${quickstart.path} total`).toContain(String(TOTAL));
    });
  }

  test("the structure ops record carries the same split", async () => {
    const line = await anchoredLine(STRUCTURE.path, STRUCTURE.anchor);
    expect(line).toContain(String(TOTAL));
    expect(line).toContain(String(KEY_PRESETS));
  });
});
