/**
 * Break each guard this branch added, and require the named test to fail.
 *
 * A green suite proves the tests pass. It does not prove they would notice if
 * the code were wrong — and in this work they four times would not have, every
 * time because the test called a helper or used a fixture tidier than the real
 * thing. The most recent: the redacted-presence test asserted on
 * `redactedFieldPresence` while the bug lived in `safeConfigDTO`, and stayed
 * green with the DTO reverted.
 *
 * The lesson did not transfer by being written down. It transferred to the
 * sibling repo by becoming a command, so here is the command.
 *
 * Run: bun tests/red.ts
 */

import { $ } from "bun";

import { GUARDS, VOICE } from "./red-guards";



async function runSuite(suite: string): Promise<{ ok: boolean; output: string }> {
  const done = await $`bun test ${suite}`.nothrow().quiet();
  return { ok: done.exitCode === 0, output: done.stdout.toString() + done.stderr.toString() };
}

const misses: string[] = [];

for (const guard of GUARDS) {
  const path = Bun.file(guard.file);
  const original = await path.text();
  const occurrences = original.split(guard.from).length - 1;
  if (occurrences !== 1) {
    misses.push(`${guard.name}: its source appears ${occurrences} times in ${guard.file}`);
    continue;
  }
  await Bun.write(guard.file, original.replace(guard.from, guard.to));
  try {
    const { ok, output } = await runSuite(guard.suite);
    if (ok) misses.push(`${guard.name}: nothing failed — "${guard.expect}" did not notice`);
    else if (!output.includes(guard.expect)) {
      misses.push(`${guard.name}: something failed, but not "${guard.expect}"`);
    } else console.log(`  red   ${guard.name}`);
  } finally {
    await Bun.write(guard.file, original);
  }
}

const { ok, output } = await runSuite(VOICE);
if (!ok) {
  console.log("restore failed — the suite is red with the original source\n" + output);
  process.exit(1);
}
for (const miss of misses) console.log(`  MISS  ${miss}`);
console.log(`\n${GUARDS.length - misses.length}/${GUARDS.length} guards are actually tested`);
process.exit(misses.length ? 1 : 0);
