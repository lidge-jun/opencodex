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
 * family and hide true orphans. Where the interpolated set is a closed literal union in
 * source, list the concrete keys instead of the prefix (`models.newPolicy_` builds only
 * `off` and `on`; `inherit` is a genuine orphan). Regenerate the evidence with:
 *   rg -o --no-filename '\`[a-zA-Z][a-zA-Z0-9_.]*\.[a-zA-Z0-9_.]*\$\{' src -g '!i18n/**' | sort -u
 * `src/i18n/lab-translations.ts` mirrors the `lab.*` namespace in a typed Record, but a
 * translation is not a consumer: Lab keys the UI renders appear literally in
 * CompatibilityMatrix.tsx, so `lab.` is not exempted.
 */
export const DYNAMIC_PREFIXES = [
  "claude.authSource.",
  "cws.err.",
  "cws.quota.",
  "debug.",
  "logs.detail.source.",
  "logs.filter.surface.",
  "logs.tokens.",
  "models.newPolicy_off",
  "models.newPolicy_on",
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
