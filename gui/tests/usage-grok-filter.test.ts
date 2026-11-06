import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "fr", "ja", "ko", "ru", "zh", "zh-TW"] as const;

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

test("Grok is an available source choice", async () => {
  const source = await read("../src/components/v2-usage/usage-source.ts");
  expect(source).toContain('"grok"');
});

test("every locale carries the grok surface label", async () => {
  const missing: string[] = [];
  for (const locale of LOCALES) {
    const dict = await read(`../src/i18n/${locale}.ts`);
    if (!dict.includes('"logs.filter.surface.grok"')) missing.push(locale);
  }
  expect(missing).toEqual([]);
});
