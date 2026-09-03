#!/usr/bin/env bun
/**
 * Find i18n keys defined in src/i18n/en.ts that no source file consumes.
 *
 * A key is "consumed" when its exact string appears outside src/i18n/, or when a
 * dynamic prefix that source builds with a template literal covers it. The dynamic
 * prefixes are listed explicitly: a scanner that guessed them would hide true orphans.
 *
 * Usage: bun scripts/find-orphan-keys.mjs            # prints orphans, exit 1 if any
 *        bun scripts/find-orphan-keys.mjs --json     # JSON array
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const srcDir = join(root, "src");
const i18nDir = join(srcDir, "i18n");

/**
 * Template-literal key families in source (`t(\`prefix${x}\`)`). Every entry must be
 * backed by a real dynamic construction; a namespace-wide entry would exempt the whole
 * family and hide true orphans. Regenerate the evidence with:
 *   rg -o --no-filename '\`[a-zA-Z][a-zA-Z0-9_.]*\.[a-zA-Z0-9_.]*\$\{' src -g '!i18n/**' | sort -u
 * `lab.` is the one non-template entry: `src/i18n/lab-translations.ts` owns those keys through
 * a `Record<LabCatalogKey, string>` typed off en.ts, so the consumer lives inside the excluded
 * i18n directory.
 */
export const DYNAMIC_PREFIXES = [
  "claude.authSource.",
  "cws.err.",
  "cws.quota.",
  "debug.",
  "lab.",
  "logs.detail.source.",
  "logs.filter.surface.",
  "logs.tokens.",
  "models.newPolicy_",
  "models.presetMode_",
  "models.reasoningEffort.",
  "models.v2Mode_",
  "routing.compatibility.layer.",
  "routing.unknownEvidence.",
  "usage.range.",
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (p !== i18nDir) walk(p, out); }
    else if (/\.(tsx?|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

export function findOrphanKeys() {
  const en = readFileSync(join(i18nDir, "en.ts"), "utf8");
  const keys = [...en.matchAll(/^\s*"([^"]+)":\s*"/gm)].map(m => m[1]);
  const sources = walk(srcDir).map(p => readFileSync(p, "utf8")).join("\n");
  return keys.filter(key =>
    !sources.includes(`"${key}"`)
    && !sources.includes(`'${key}'`)
    && !DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix)),
  );
}

if (import.meta.main) {
  const orphans = findOrphanKeys();
  if (process.argv.includes("--json")) console.log(JSON.stringify(orphans));
  else for (const key of orphans) console.log(key);
  process.exit(orphans.length ? 1 : 0);
}
