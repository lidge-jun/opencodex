/**
 * Copy missing keys from en.ts into de/ko/zh (English fallback for new keys).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { en } from "../src/i18n/en.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const loc of ["de", "ko", "zh", "ru"]) {
  const path = join(root, "src", "i18n", `${loc}.ts`);
  let text = readFileSync(path, "utf8");
  const missing = Object.entries(en).filter(([key]) => !text.includes(`"${key}":`));
  if (missing.length === 0) {
    console.log(`${loc}: up to date`);
    continue;
  }
  const block = missing
    .map(([key, value]) => `  "${key}": ${JSON.stringify(value)},`)
    .join("\n");

  if (text.includes("} as const;")) {
    text = text.replace(/\n\} as const;/, `\n${block}\n} as const;`);
  } else if (/\n\};\s*\n/.test(text) || /\n\};\s*$/.test(text)) {
    text = text.replace(/\n\};\s*(?=\n|$)/, `\n${block}\n};\n`);
  } else {
    throw new Error(`${path}: missing closing brace for locale object`);
  }

  writeFileSync(path, text);
  console.log(`${loc}: added ${missing.length} keys`);
}
