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

/** Template-literal key families in source (`t(\`prefix${x}\`)`). Keep this list honest. */
export const DYNAMIC_PREFIXES = [
  "models.v2Mode_",
  "models.presetMode_",
  "startup.summary.",
  "startup.routing.",
  "startup.status.",
  "logs.detail.reason.",
  "logs.detail.estimateReason.",
  "usage.day",
  "integrations.tab.",
  "integrations.state.",
  "integrations.status.",
  "theme.",
  "uptime.",
  "time.",
  "quota.",
  "pws.",
  "cws.attention.",
  "codexAuth.",
  "accountPool.",
  "api.",
  "sub.",
  "lab.",
  "routing.",
  "dash.mem.",
  "dash.update",
  "errorBoundary.",
  "connection.",
  "claudeDesktop.",
  "storage.",
  "nav.",
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
