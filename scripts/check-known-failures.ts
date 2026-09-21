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

// A LOG WITH NO SUMMARY IS NOT A CLEAN RUN. An empty or truncated log has no
// `(fail)` records, so every tolerated name reads as GONE and the exit is 0 --
// which is to say the checker calls a crashed run a pass. That is not
// hypothetical: a full-suite run on the author's machine wedged at 627 of 1435
// files with the runner dead and the parent waiting, and the log simply ended.
// Bun's final summary is the one line that says a run finished; require at
// least one, and require the summaries to agree with the records, so a partial
// log fails loudly instead of quietly classifying itself as green. A log from
// the CI batch runner holds one summary PER BATCH, so they are summed: reading
// only the first would compare batch 1's count against the whole log's records.
const summaries = [...log.matchAll(/^ *(\d+) fail$/gm)].map(m => Number(m[1]));
if (summaries.length === 0) {
  console.error("no final Bun test summary in the log — the run did not complete, so nothing here is attributed");
  process.exit(2);
}
const summarised = summaries.reduce((a, b) => a + b, 0);
if (summarised !== failed.length) {
  console.error(
    `${summaries.length === 1 ? "summary says" : `${summaries.length} batch summaries say`} ${summarised} failed but ${failed.length} (fail) records were parsed — the log is inconsistent`,
  );
  process.exit(2);
}

const unexpected = failed.filter(name => !tolerated.has(name));
const missing = [...tolerated].filter(name => !failed.includes(name));

for (const name of unexpected) console.log(`  NEW   ${name}`);
for (const name of missing) console.log(`  GONE  ${name} — fixed upstream? drop it from known-failures.json`);

console.log(
  `\n${failed.length} failed, ${failed.length - unexpected.length} known` +
  (known.verifiedAgainst ? ` (baseline ${known.verifiedAgainst.ref} ${known.verifiedAgainst.commit})` : ""),
);
process.exit(unexpected.length ? 1 : 0);
