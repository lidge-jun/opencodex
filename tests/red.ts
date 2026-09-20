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


import { GUARDS, VOICE } from "./red-guards";



/**
 * A suite run with a wall-clock limit.
 *
 * A break can make the code loop rather than fail — removing a deadline check
 * does exactly that — and without a timeout the runner waits forever holding
 * the lock, with the guard still removed. That happened in the sibling repo.
 * A timeout counts as a failure, which is the right answer: the guard was
 * noticed, just not by returning.
 */
const SUITE_TIMEOUT_MS = 60_000;

async function runSuite(suite: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bun", "test", suite], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), SUITE_TIMEOUT_MS);
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, output: out + err + (code === null ? "\n(timed out)" : "") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A lock, held while any guard is removed.
 *
 * This tool disables production code for a second at a time, and a
 * `git add -A` during that window commits the disabled guard. Not
 * hypothetical: the sibling repo shipped `if false` in place of an upload
 * length limit that way, because a check was running in the background while
 * the commit was made. A check must not be able to do the damage it looks for.
 */
const LOCK = ".red-running";

function releaseLock(): void {
  try {
    require("node:fs").unlinkSync(LOCK);
  } catch {
    // already gone
  }
}

if (await Bun.file(LOCK).exists()) {
  console.error(`${LOCK} exists — another red run is in flight, or one died mid-break.`);
  console.error("Check `git status` before deleting it: a guard may still be disabled.");
  process.exit(2);
}
await Bun.write(LOCK, `${process.pid}\n`);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    releaseLock();
    process.exit(130);
  });
}

/**
 * The names the suite actually runs.
 *
 * Without this, a guard pointing at a renamed or deleted test reports MISS —
 * the same word as a guard whose break nothing noticed — and the two want
 * opposite fixes: one is a stale entry, the other is a missing test.
 *
 * Read from a junit run, not from the source. The first attempt scanned for
 * `test("...")` declarations and saw 15 of 33, because the table-driven cases
 * are named by template literal and that name exists only at runtime.
 */
async function ranTests(suite: string): Promise<Set<string>> {
  const out = `/tmp/red-listing-${process.pid}.xml`;
  const proc = Bun.spawn(
    ["bun", "test", suite, "--reporter=junit", `--reporter-outfile=${out}`],
    { stdout: "ignore", stderr: "ignore" },
  );
  await proc.exited;
  const xml = await Bun.file(out).text().catch(() => "");
  await Bun.file(out).unlink().catch(() => {});
  // Entity-decoded: junit escapes the apostrophes in names like "the
  // caller's OpenAI model name", and two guards read as missing until this
  // was here.
  const decode = (name: string) =>
    name
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, "&");
  return new Set(
    [...xml.matchAll(/<testcase[^>]*\bname="([^"]*)"/g)].map(m => decode(m[1]!)),
  );
}

const declared = new Map<string, Set<string>>();
for (const suite of new Set(GUARDS.map(g => g.suite))) {
  declared.set(suite, await ranTests(suite));
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
  if (!declared.get(guard.suite)?.has(guard.expect)) {
    misses.push(`${guard.name}: no test named "${guard.expect}" in ${guard.suite}`);
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
releaseLock();
if (!ok) {
  console.log("restore failed — the suite is red with the original source\n" + output);
  process.exit(1);
}
for (const miss of misses) console.log(`  MISS  ${miss}`);
console.log(`\n${GUARDS.length - misses.length}/${GUARDS.length} guards are actually tested`);
process.exit(misses.length ? 1 : 0);
