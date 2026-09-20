/**
 * Read a test log and report the failures that are not already known.
 *
 * A suite with unexplained failures is a number, not a gate: the next real
 * failure hides among the tolerated ones, and an entry tolerated without a
 * reason absorbs whatever fails next in the same place. Every failure here
 * carries a reason and the commit it was verified against.
 *
 * Usage: bun run test:changed > /tmp/run.txt 2>&1; bun scripts/check-known-failures.ts /tmp/run.txt
 */

const path = Bun.argv[2];
if (!path) {
  console.error("usage: bun scripts/check-known-failures.ts <test-log>");
  process.exit(2);
}

const known = await Bun.file(new URL("../tests/known-failures.json", import.meta.url)).json();
const tolerated = new Set<string>(known.failures.map((f: { test: string }) => f.test));

const log = await Bun.file(path).text();
const failed = [...log.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(m => m[1]!.trim());

const unexpected = failed.filter(name => !tolerated.has(name));
const missing = [...tolerated].filter(name => !failed.includes(name));

for (const name of unexpected) console.log(`  NEW   ${name}`);
for (const name of missing) console.log(`  GONE  ${name} — fixed upstream? drop it from known-failures.json`);

console.log(
  `\n${failed.length} failed, ${failed.length - unexpected.length} known` +
  (known.verifiedAgainst ? ` (baseline ${known.verifiedAgainst.ref} ${known.verifiedAgainst.commit})` : ""),
);
process.exit(unexpected.length ? 1 : 0);
