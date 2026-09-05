import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'win32');
assert.equal(Bun.version, JSON.parse(readFileSync('package.json', 'utf8')).dependencies.bun);
console.log('WINDOWS_RUNTIME', Bun.version, process.execPath);
const fixture = 'tests/responses/responses-state.test.ts';
const state = 'src/responses/state.ts';
const acl = 'src/lib/windows-secret-acl.ts';
const baseline = 'ed7ecc5780ea0bd936468aff3828e60c7d9d0d34';
const originals = new Map([fixture, state, acl].map(path => [path, readFileSync(path, 'utf8')]));
mkdirSync('.tmp/a-fixture-proof', { recursive: true });
function run(name, args, expected = 'green', needle) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const output = ((result.stdout ?? '') + (result.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '');
  writeFileSync(`.tmp/a-fixture-proof/${name}.log`, output);
  console.log(`\nPROBE ${name} EXIT ${result.status}\n${output}`);
  assert.ifError(result.error);
  assert.notEqual(result.status, null);
  if (expected === 'green') assert.equal(result.status, 0, name);
  if (expected === 'red') {
    assert.notEqual(result.status, 0, name);
    const failures = output.split(/\r?\n/).filter(line => line.startsWith('(fail) '));
    assert.equal(failures.length, 1, 'exactly the selected assertion must fail');
    assert.match(output, /(?:^|\n)\s*0 pass(?:\r?\n)/);
    assert.match(output, /(?:^|\n)\s*1 fail(?:\r?\n)/);
    assert.doesNotMatch(output, /timed out|TimeoutError|unhandled[^\n]*(?:error|rejection)|Cannot find module|SyntaxError|ReferenceError|ENOTFOUND/i);
    if (needle) assert.match(failures[0], needle);
    if (name === 'stable-tail-oracle-red') {
      assert.match(output, /expect\(drained\)\.toBe\(false\)/);
      assert.match(output, /Expected:\s*false/);
      assert.match(output, /Received:\s*true/);
    } else if (name === 'per-command-budget-oracle-red') {
      assert.match(output, /expect\(timeoutMs\)\.toBe\(previous - 20\)/);
      const expected = /Expected:\s*(\d+)/.exec(output);
      const received = /Received:\s*(\d+)/.exec(output);
      assert(expected && received, 'numeric deadline assertion required');
      assert.equal(Number(received[1]) - Number(expected[1]), 20, 'reset deadline must miss the 20 ms decrement');
    } else {
      assert.fail('unregistered negative-control oracle');
    }
  }
  return { name, expected, status: result.status };
}
function testArgs(pattern) {
  return ['test', '--isolate', '--timeout', '60000', fixture, ...(pattern ? ['--test-name-pattern', pattern] : [])];
}
function restore() { for (const [path, text] of originals) writeFileSync(path, text); }
function rewrite(path, old, replacement) {
  const text = readFileSync(path, 'utf8');
  assert.equal(text.split(old).length, 2, `unique anchor: ${path}`);
  writeFileSync(path, text.replace(old, replacement));
}
function replaceCase(name, nextName, replacement) {
  const text = originals.get(fixture);
  const start = text.indexOf(`  test("${name}"`);
  const end = text.indexOf(`  test("${nextName}"`, start);
  assert(start >= 0 && end > start);
  writeFileSync(fixture, text.slice(0, start) + replacement + '\n\n' + text.slice(end));
}
const results = [];
try {
  results.push(run('candidate-file', testArgs()));
  const fetched = spawnSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseline], { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(fetched.error); assert.equal(fetched.status, 0, fetched.stderr);
  const old = spawnSync('git', ['show', `${baseline}:${fixture}`], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(old.error); assert.equal(old.status, 0);
  writeFileSync(fixture, old.stdout);
  results.push(run('unmodified-baseline-observation', testArgs('shutdown drain reaches a stable tail|shutdown fallback spends only its reserved ACL budget'), 'observe'));
  restore();

  // Model the observed missing-mock route without executing native ACL commands.
  replaceCase('shutdown drain reaches a stable tail after a publication is appended mid-drain',
    'shutdown drain cap expiry enters the synchronous spill fallback', `
  test("controlled synchronous fallback exposes the missing ACL mock route", async () => {
    forceWindowsAclLane();
    setResponseSpillShutdownBudgetForTests({ totalMs: 1000, fallbackReserveMs: 500 });
    setNowForTests(() => 0); setResponseSpillNowForTests(() => 0);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    setAsyncIcaclsRunnerForTests(async args => {
      if (!isSpillAclTarget(args)) return ICACLS_OK;
      entered(); await gate; return ICACLS_OK;
    });
    let syncCalls = 0;
    setIcaclsRunnerForTests(args => {
      if (!isSpillAclTarget(args)) return ICACLS_OK;
      syncCalls++; return { success: false, exitCode: 1, timedOut: false, stdout: "" };
    });
    setResponseStateByteCapForTests(1024);
    let clock: ReturnType<typeof spyOn> | undefined;
    try {
      rememberLarge("probe_fallback", "x".repeat(8000)); await started;
      clock = spyOn(Date, "now").mockReturnValue(Date.now());
      let failure: unknown;
      try { await flushResponseState(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.some((error: any) => error.code === "EICACLS")).toBe(true);
      expect(syncCalls).toBeGreaterThan(0);
      console.log("CONTROL fallback entered; EICACLS observed; native ACL runner never used", syncCalls);
    } finally {
      release();
      try { await awaitResponseSpillPublicationTailForTests(); await flushPendingResponseSpillsForTests(); }
      finally { clock?.mockRestore(); }
    }
  });`);
  rewrite(state, 'function awaitResponseSpillTailUntil(observed: Promise<void>, deadline: number): Promise<boolean> {',
    'function awaitResponseSpillTailUntil(observed: Promise<void>, deadline: number): Promise<boolean> { return Promise.resolve(false);');
  results.push(run('controlled-fallback-admission', testArgs('controlled synchronous fallback exposes')));
  restore();

  // Isolate the missing spill clock: the same write event shifts wall time or logical time.
  replaceCase('shutdown fallback spends only its reserved ACL budget',
    'late async spill completion cannot overwrite the shutdown fallback', `
  for (const mode of ["wall", "logical", "exhausted"] as const) test("controlled spill-clock divergence " + mode, async () => {
    forceWindowsAclLane();
    setResponseSpillShutdownBudgetForTests({ totalMs: 500, fallbackReserveMs: 300 });
    let logical = 0; let wall = 0;
    setNowForTests(() => logical);
    setResponseSpillNowForTests(() => mode === "wall" ? wall : logical);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    setAsyncIcaclsRunnerForTests(async args => {
      if (!isSpillAclTarget(args)) return ICACLS_OK;
      entered(); await gate; return ICACLS_OK;
    });
    let syncCalls = 0;
    setIcaclsRunnerForTests(args => {
      if (isSpillAclTarget(args)) { syncCalls++; logical += 20; }
      return ICACLS_OK;
    });
    setResponseStateByteCapForTests(1024);
    let clock: ReturnType<typeof spyOn> | undefined;
    let jumped = false;
    try {
      rememberLarge("probe_clock_" + mode, "x".repeat(8000)); await started;
      const epoch = Date.now(); clock = spyOn(Date, "now").mockImplementation(() => epoch + logical);
      setSpillIoForTest({ record: event => {
        if (event !== "write" || jumped) return;
        jumped = true; if (mode === "exhausted") logical += 301; else wall += 301;
      }});
      let failure: unknown;
      try { await flushResponseState(); } catch (error) { failure = error; }
      expect(jumped).toBe(true);
      if (mode === "logical") {
        expect(failure).toBeUndefined(); expect(syncCalls).toBeGreaterThanOrEqual(6);
        expect(logical).toBeLessThanOrEqual(300);
      } else {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors.some((error: any) => error.code === "ETIMEDOUT")).toBe(true);
      }
      console.log("CONTROL spill clock", mode, { logical, wall, syncCalls });
    } finally {
      release();
      try { await awaitResponseSpillPublicationTailForTests(); await flushPendingResponseSpillsForTests(); }
      finally { clock?.mockRestore(); }
    }
  });`);
  results.push(run('controlled-spill-clock', testArgs('controlled spill-clock divergence')));
  restore();

  rewrite(state, '    if (observed === responseSpillPublicationTail) return;', '    return; // Probe: incorrectly stop after the first observed tail.');
  results.push(run('stable-tail-oracle-red', testArgs('shutdown drain reaches a stable tail'), 'red', /shutdown drain reaches a stable tail/));
  restore();
  const aclText = originals.get(acl);
  const from = aclText.indexOf('function runIcacls(targetPath: string, directory: boolean, deadline: number): void {');
  const to = aclText.indexOf('/** Async counterpart of runIcacls', from);
  assert(from >= 0 && to > from);
  let block = aclText.slice(from, to);
  block = block.replace('  const principal = currentWindowsPrincipal(deadline);', '  const principal = currentWindowsPrincipal(deadline);\n  const probeInitialRemaining = deadline - nowFn();');
  assert.equal(block.split('    const remaining = deadline - nowFn();').length, 2);
  block = block.replace('    const remaining = deadline - nowFn();', '    const remaining = probeInitialRemaining;');
  writeFileSync(acl, aclText.slice(0, from) + block + aclText.slice(to));
  results.push(run('per-command-budget-oracle-red', testArgs('shutdown fallback spends only its reserved ACL budget'), 'red', /shutdown fallback spends only its reserved ACL budget/));
  restore();
  results.push(run('retained-deadline-watchdog-controls', testArgs('shutdown drain cap expiry|shutdown fallback budget exhaustion is contained by a child watchdog')));
  console.log('VERIFIED_PROBES', JSON.stringify(results));
} finally { restore(); }
