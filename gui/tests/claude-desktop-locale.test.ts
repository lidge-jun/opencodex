import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "fr", "ja", "ko", "ru", "zh", "zh-TW"] as const;

async function readDict(locale: string): Promise<Map<string, string>> {
  const src = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/gm)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

// `de.ts` is typed `Record<TKey, string>`, so a MISSING key already fails `tsc`. These
// cases cover what the type cannot see: a key that exists but renders nothing, which
// would ship a blank tab label or an empty lane heading. The Claude Desktop keys arrived
// through a hand-resolved merge conflict, so they get an explicit guard.
test("every locale defines a non-empty value for each Claude Desktop key", async () => {
  const en = await readDict("en");
  const desktopKeys = [...en.keys()].filter(k => k.startsWith("claudeDesktop.") || k.startsWith("claude.tab"));
  expect(desktopKeys.length).toBeGreaterThan(50);

  const blank: string[] = [];
  for (const locale of LOCALES) {
    const dict = await readDict(locale);
    for (const key of desktopKeys) {
      if (!(dict.get(key) ?? "").trim()) blank.push(`${locale}:${key}`);
    }
  }
  expect(blank).toEqual([]);
});

test("locale key sets stay identical to the English source", async () => {
  const en = [...(await readDict("en")).keys()].sort();
  for (const locale of LOCALES.filter(l => l !== "en")) {
    const other = [...(await readDict(locale)).keys()].sort();
    expect(`${locale}:${other.length}`).toBe(`${locale}:${en.length}`);
    expect(other).toEqual(en);
  }
});
