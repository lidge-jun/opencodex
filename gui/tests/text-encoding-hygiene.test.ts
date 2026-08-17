import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUI_DIR = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIR = join(GUI_DIR, "src");
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".jsx", ".ts", ".tsx"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const MOJIBAKE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "replacement character", pattern: /\uFFFD/u },
  { name: "C1 control character", pattern: /[\u0080-\u009F]/u },
  { name: "Latin-1 decoded UTF-8", pattern: /(?:Â[\u0080-\u00BF]|Ã[\u0080-\u00BF])/u },
  { name: "Windows-1252 punctuation decoded UTF-8", pattern: /â(?:€.|[\u0080-\u00BF]{2})/u },
  { name: "emoji decoded UTF-8", pattern: /ðŸ/u },
  { name: "replacement or BOM decoded UTF-8", pattern: /ï(?:¿½|»¿)/u },
  {
    name: "UTF-8 bytes expressed as adjacent JavaScript hex escapes",
    pattern: /\\x(?:c[2-9a-f]|d[0-9a-f]|e[0-9a-f]|f[0-4])(?:\\x[89ab][0-9a-f])+/iu,
  },
];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return TEXT_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

test("GUI source is valid UTF-8 and contains no common mojibake", async () => {
  const files = [...await sourceFiles(SOURCE_DIR), join(GUI_DIR, "index.html")];
  const failures: string[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = UTF8_DECODER.decode(await readFile(file));
    } catch {
      failures.push(`${file}: invalid UTF-8`);
      continue;
    }
    for (const { name, pattern } of MOJIBAKE_PATTERNS) {
      if (pattern.test(source)) failures.push(`${file}: ${name}`);
    }
  }

  expect(failures).toEqual([]);
});

test("GUI document declares UTF-8", async () => {
  const html = UTF8_DECODER.decode(await readFile(join(GUI_DIR, "index.html")));
  expect(html).toMatch(/<meta\s+charset=["']UTF-8["']\s*\/?>/i);
});
