/**
 * The fixed-host discovery limits in the provider guides must be read back from the registry.
 *
 * #5198 corrected a preset count that had drifted across sixteen files, and the interesting part
 * was how long it survived: nothing compared any copy to the registry, so CI stayed green the
 * whole time. The per-provider discovery limits are the same shape one layer down -- a byte
 * ceiling and a row ceiling, restated by hand in eight pages, checked by nobody (#5215).
 *
 * Every number here is derived from PROVIDER_REGISTRY, so lowering a ceiling fails in every
 * locale at once instead of leaving seven translations describing the old one.
 *
 * Sections are located by the brand name and the presence of a unit token, not by a translated
 * sentence. A restated anchor phrase is the same hand-copied value this test exists to remove,
 * and the brand names are Latin in all eight published locales. A page where the section is
 * missing or appears twice fails by name and asks to be re-anchored; that is how the Korean
 * guide's absent Featherless section was found.
 */
import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { repoPath } from "../helpers/repo-root";

/** English plus every translated guide that ships, matching docs-site/astro.config.mjs. */
const GUIDES = [
  { locale: "en", path: "docs-site/src/content/docs/guides/providers.md" },
  { locale: "fr", path: "docs-site/src/content/docs/fr/guides/providers.md" },
  { locale: "ja", path: "docs-site/src/content/docs/ja/guides/providers.md" },
  { locale: "ko", path: "docs-site/src/content/docs/ko/guides/providers.md" },
  { locale: "ru", path: "docs-site/src/content/docs/ru/guides/providers.md" },
  { locale: "tr", path: "docs-site/src/content/docs/tr/guides/providers.md" },
  { locale: "zh-cn", path: "docs-site/src/content/docs/zh-cn/guides/providers.md" },
  { locale: "zh-tw", path: "docs-site/src/content/docs/zh-tw/guides/providers.md" },
] as const;

/**
 * One documented section per entry. `ids` holds every registry preset the section speaks for;
 * a grouped section must agree in the registry before one sentence can describe both.
 */
const SECTIONS = [
  { brand: "Chutes", ids: ["chutes"] },
  { brand: "DeepInfra", ids: ["deepinfra"] },
  { brand: "Hyperbolic", ids: ["hyperbolic"] },
  { brand: "Nscale", ids: ["nscale", "vultr"] },
  { brand: "Command Code", ids: ["command-code", "commandcode"] },
  { brand: "SambaNova", ids: ["sambanova"] },
  { brand: "Nebius", ids: ["nebius"] },
  { brand: "Crusoe", ids: ["crusoe"] },
  { brand: "DigitalOcean", ids: ["digitalocean"] },
  { brand: "Scaleway", ids: ["scaleway"] },
  { brand: "Featherless", ids: ["featherless"] },
  { brand: "Novita", ids: ["novita"] },
  { brand: "Baseten", ids: ["baseten"] },
] as const;

const UNIT_TOKEN = /(\d+(?:[.,]\d+)?)\s*(KiB|MiB)/g;

interface Limits { bytes: number; rows: number }

function registryLimits(id: string): Limits {
  const entry = PROVIDER_REGISTRY.find(row => row.id === id);
  expect(entry, `no registry preset with id "${id}"; re-anchor this check`).toBeDefined();
  const discovery = entry!.modelDiscovery;
  expect(discovery, `preset "${id}" declares no modelDiscovery`).toBeDefined();
  const { maxResponseBytes, maxModels } = discovery!;
  expect(typeof maxResponseBytes, `preset "${id}" declares no maxResponseBytes`).toBe("number");
  expect(typeof maxModels, `preset "${id}" declares no maxModels`).toBe("number");
  return { bytes: maxResponseBytes!, rows: maxModels! };
}

/** The documented spelling of a byte ceiling: whole MiB where it divides, otherwise KiB. */
function unitLabel(bytes: number): string {
  const MIB = 1024 * 1024;
  return bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes / 1024} KiB`;
}

/** The paragraph that states this section's limits, located by brand plus a unit token. */
async function limitParagraph(path: string, brand: string): Promise<string> {
  const source = await Bun.file(repoPath(path)).text();
  const paragraphs = source.split(/\n\s*\n/).filter(block => {
    UNIT_TOKEN.lastIndex = 0;
    return block.includes(brand) && UNIT_TOKEN.test(block);
  });
  expect(
    paragraphs.length,
    `${path} should state the ${brand} discovery limits in exactly one paragraph; found ${paragraphs.length}`,
  ).toBe(1);
  return paragraphs[0]!;
}

function unitTokens(paragraph: string): string[] {
  UNIT_TOKEN.lastIndex = 0;
  return [...paragraph.matchAll(UNIT_TOKEN)].map(match => `${match[1]} ${match[2]}`);
}

/** Every standalone integer left once the byte ceilings are removed. */
function rowNumbers(paragraph: string): number[] {
  UNIT_TOKEN.lastIndex = 0;
  const withoutUnits = paragraph.replace(UNIT_TOKEN, " ");
  return [...withoutUnits.matchAll(/(?<![\d.,])(\d+)(?![\d.,])/g)].map(match => Number(match[1]));
}

describe("documented provider discovery limits match the registry", () => {
  test("the registry is the only source of the numbers under test", () => {
    expect(SECTIONS.length).toBeGreaterThan(0);
    for (const section of SECTIONS) {
      const limits = section.ids.map(registryLimits);
      expect(limits[0]!.bytes, `${section.brand} byte ceiling`).toBeGreaterThan(0);
      expect(limits[0]!.rows, `${section.brand} row ceiling`).toBeGreaterThan(0);
      // A grouped section states one pair for several presets. If they ever diverge, the
      // sentence is wrong for one of them and the group has to be split, not re-measured.
      for (const other of limits.slice(1)) {
        expect(other, `${section.ids.join(" and ")} must declare the same discovery limits`)
          .toEqual(limits[0]!);
      }
    }
  });

  for (const guide of GUIDES) {
    for (const section of SECTIONS) {
      const { bytes, rows } = registryLimits(section.ids[0]!);
      test(`${guide.locale} guide states ${unitLabel(bytes)} and ${rows} rows for ${section.brand}`, async () => {
        const paragraph = await limitParagraph(guide.path, section.brand);
        // An exact token set, not a substring: a stale ceiling left beside the current one
        // would otherwise pass while still telling the reader the wrong number.
        expect(unitTokens(paragraph), `${guide.path} ${section.brand} byte ceiling`)
          .toEqual([unitLabel(bytes)]);
        // Read the row ceiling from the prose with the unit tokens removed. Left in, the byte
        // ceiling's own digits satisfy the check: a Hyperbolic paragraph saying "256 KiB and
        // 128 raw rows" would pass an expected 256 rows on the strength of the byte number.
        expect(rowNumbers(paragraph), `${guide.path} ${section.brand} row ceiling`)
          .toContain(rows);
      });
    }
  }
});
