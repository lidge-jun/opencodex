import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

// Deliberately independent of the real six-file policy: expansion, quoting, and
// index-based ownership must work for canonical paths relative to tests/.
const SERIAL_FILES = [
  "serial/falcon.test.ts",
  "nested/lane/ibis.test.ts",
  "serial/lynx.test.ts",
  "other/tern.test.ts",
];
const GENERAL_FILES = ["general/ordinary.test.ts", "general/falcon-extra.test.ts"];
const ASSERTION_STATUS = 23;
const CRASH_STATUS = 139;
// A status the classifier cannot recognise on its own, so a crash carrying it is only detected
// through the panic banner. 139 is a fatal signal and matches on the code alone.
const SIGNATURE_ONLY_CRASH_STATUS = 3;
const CRASH_SIGNATURES = [
  "oh no: Bun has crashed",
  "Internal assertion failure",
  "Segmentation fault at address 0x1234",
  "Illegal instruction",
  "Bus error",
  "Aborted (core dumped)",
];

type Invocation = { kind: "manifest" | "test"; argv: string[]; pid: number };
type FixtureOptions = {
  manifest?: string[];
  manifestStatus?: number;
  missing?: string;
  collision?: boolean;
  target?: "main" | string;
  outcomes?: Array<"assert" | "crash">;
  crashSignature?: string;
  crashStatus?: number;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fixtureDiagnostics(value: string): string {
  return CRASH_SIGNATURES.reduce((text, signature) => text.replaceAll(signature, "[simulated crash]"), value);
}

function macosTestBlock(shard: number): string {
  const workflow = Bun.YAML.parse(readFileSync(repoPath(".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const run = workflow.jobs["platform-macos"]?.steps.find(step => step.name === "Test in fresh-process batches")?.run;
  if (!run) throw new Error("platform-macos must contain its executable batch step");
  // Render the existing Actions expression too, so the old workflow reaches
  // the ownership assertions instead of failing with Bash's 'bad substitution'.
  return run.replace(/\$\{\{\s*matrix\.shard\s*\}\}/g, String(shard));
}

// Bun and the outer timeout executable are fixture shims. The actual workflow
// command, batch runner, Bash selection, pipes and filesystem validation execute unchanged.
const FAKE_BUN = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.env.MACOS_FIXTURE_CONFIG, "utf8"));
const log = process.env.MACOS_FIXTURE_LOG;
const argv = process.argv.slice(2);
const record = kind => appendFileSync(log, JSON.stringify({ kind, argv, pid: process.pid }) + "\n");
if (argv[0] === "-e") {
  record("manifest");
  process.stdout.write(config.manifest.join("\n") + (config.manifest.length ? "\n" : ""));
  process.exit(config.manifestStatus);
}
if (argv[0] !== "test") {
  console.error("unexpected fake Bun invocation", JSON.stringify(argv));
  process.exit(97);
}
record("test");
const matches = args => config.target === "main" ? args.some(arg => arg.includes("tests/general/"))
  : args.some(arg => arg.replace(/^\.\//, "") === "tests/" + config.target);
if (!matches(argv)) process.exit(0);
const attempts = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
  .filter(entry => entry.kind === "test" && matches(entry.argv)).length;
const outcome = config.outcomes[attempts - 1];
if (outcome === "assert") {
  console.error("(fail) fixture assertion: expected true, received false");
  process.exit(config.assertionStatus);
}
if (outcome === "crash") {
  // Deliberately not the final output line: the shell must capture the stream.
  console.error(config.crashSignature);
  console.error("fixture runtime diagnostic tail");
  process.exit(config.crashStatus);
}
process.exit(0);
`;

function createFixture(directory: string, options: FixtureOptions): void {
  mkdirSync(join(directory, "bin"));
  mkdirSync(join(directory, "tmp"));
  // The lane sources its crash classifier from the working directory, so the sandbox gets the
  // REAL file rather than a stand-in. That is deliberate: the harness executes the actual run
  // block, so a copy here would let the block and the classifier drift apart unnoticed, which is
  // the exact failure mode that collapsing four inline signature lists into one file removed.
  mkdirSync(join(directory, "scripts", "ci"), { recursive: true });
  copyFileSync(repoPath("scripts", "ci", "sample-macos-stall.sh"),
    join(directory, "scripts", "ci", "sample-macos-stall.sh"));
  copyFileSync(repoPath("scripts", "ci", "bun-crash-signatures.sh"),
    join(directory, "scripts", "ci", "bun-crash-signatures.sh"));
  copyFileSync(repoPath("scripts", "ci", "run-bun-test-batches.sh"),
    join(directory, "scripts", "ci", "run-bun-test-batches.sh"));
  writeFileSync(join(directory, "bin/timeout"), '#!/bin/sh\nwhile [ "${1#--}" != "$1" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  for (const file of [...SERIAL_FILES, ...GENERAL_FILES]) {
    if (file === options.missing) continue;
    mkdirSync(dirname(join(directory, "tests", file)), { recursive: true });
    writeFileSync(join(directory, "tests", file), "");
  }
  if (options.collision) {
    mkdirSync(join(directory, "tests/collision"));
    writeFileSync(join(directory, "tests/collision", basename(SERIAL_FILES[0]!)), "");
  }
  writeFileSync(join(directory, "fake-bun.mjs"), FAKE_BUN);
  writeFileSync(join(directory, "bin/bun"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(directory, "fake-bun.mjs"))} "$@"\n`,
    { mode: 0o755 });
  writeFileSync(join(directory, "config.json"), JSON.stringify({
    manifest: SERIAL_FILES, manifestStatus: 0, target: "main", outcomes: [],
    assertionStatus: ASSERTION_STATUS, crashStatus: CRASH_STATUS,
    crashSignature: CRASH_SIGNATURES[0], ...options,
  }));
}

function spawnErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "SPAWN_ERROR";
}

function runShell(directory: string, shard: number, scriptOverride?: string): Promise<{ status: number | null; output: string }> {
  // Use the runner's native /bin/bash (Bash 3 on macOS), never a shell mock.
  const command = scriptOverride ?? macosTestBlock(shard);
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command], {
        cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: `${join(directory, "bin")}:/usr/bin:/bin`, HOME: directory,
          TMPDIR: join(directory, "tmp"), RUNNER_TEMP: join(directory, "tmp"), CI: "true",
          TEST_SHARD: `${shard}/2`, BUN_TEST_FILE_SCOPE: "all", BUN_TEST_BATCH_SIZE: "12",
          BUN_TEST_PARALLEL: "1", BUN_TEST_BATCH_TIMEOUT_SECONDS: "300", OCX_TEST_NO_QUEUE: "1",
          MACOS_FIXTURE_CONFIG: join(directory, "config.json"),
          MACOS_FIXTURE_LOG: join(directory, "invocations.jsonl"),
        },
      });
    } catch (error) {
      reject(new Error(`macOS shell harness failed: ${spawnErrorCode(error)}`));
      return;
    }

    const chunks: Buffer[] = [];
    const outputLimit = 256 * 1024;
    let outputBytes = 0;
    let failure: string | undefined;
    let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => interrupt("ETIMEDOUT"), INTERNAL_DEADLINE_MS);

    function finish(status: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (failure) reject(new Error(`macOS shell harness failed: ${failure}`));
      else resolve({ status, output: fixtureDiagnostics(Buffer.concat(chunks).toString("utf8")) });
    }

    function interrupt(code: string): void {
      if (settled || failure) return;
      failure = code;
      clearTimeout(deadline);
      // Only an interrupted run is signalled. Normal close (including an
      // assertion's nonzero status) never kills a completed/reusable PID.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        const killCode = spawnErrorCode(error);
        if (killCode !== "ESRCH") failure = `${code}; CLEANUP_${killCode}`;
      }
      // Await close after group termination, but inherited pipes cannot keep
      // the harness or fixture cleanup pending forever. This is cleanup grace,
      // not another test attempt or an extension of the execution deadline.
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        failure = `${failure}; CLEANUP_TIMEOUT`;
        finish(null);
      }, 1_000);
    }

    function capture(chunk: Buffer): void {
      if (settled || failure) return;
      const remaining = outputLimit - outputBytes;
      const kept = chunk.subarray(0, remaining);
      if (kept.length) chunks.push(Buffer.from(kept));
      outputBytes += kept.length;
      if (chunk.length > remaining) interrupt("OUTPUT_LIMIT");
    }

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdout.on("error", error => interrupt(spawnErrorCode(error)));
    child.stderr.on("error", error => interrupt(spawnErrorCode(error)));
    child.on("error", error => interrupt(spawnErrorCode(error)));
    child.once("exit", (_status, signal) => {
      if (signal) interrupt(signal);
    });
    child.once("close", (status, signal) => {
      if (signal) interrupt(signal);
      finish(status);
    });
  });
}

async function runShard(shard: number, options: FixtureOptions = {}) {
  // Spaces and a quote in cwd exercise the executable/config/log path quoting
  // without inventing manifest characters forbidden by the source path policy.
  const directory = mkdtempSync(join(tmpdir(), "ocx macos' lanes-"));
  try {
    createFixture(directory, options);
    const log = join(directory, "invocations.jsonl");
    const result = await runShell(directory, shard);
    const invocations: Invocation[] = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      : [];
    return { ...result, invocations };
  } finally {
    // runShell settles only after close or its finite termination grace.
    removeTreeWithRetry(directory);
  }
}

function testCalls(result: Awaited<ReturnType<typeof runShard>>): Invocation[] {
  return result.invocations.filter(call => call.kind === "test");
}

function testPaths(call: Invocation): string[] {
  return call.argv.map(arg => arg.replace(/^\.\//, ""))
    .filter(arg => arg === "tests" || arg.startsWith("tests/"));
}

function targets(call: Invocation, target: string): boolean {
  return target === "main" ? testPaths(call).some(path => path.startsWith("tests/general/")) : testPaths(call).includes(`tests/${target}`);
}

function optionValues(argv: string[], option: string): string[] {
  return argv.flatMap((arg, index) => arg === option ? [argv[index + 1] ?? ""]
    : arg.startsWith(`${option}=`) ? [arg.slice(option.length + 1)] : []);
}

function selectedFiles(shard: number, collision = false): string[] {
  return [...SERIAL_FILES, ...GENERAL_FILES, ...(collision ? [`collision/${basename(SERIAL_FILES[0]!)}`] : [])]
    .map(file => `tests/${file}`).sort().filter((_, index) => index % 2 === shard - 1);
}

function expectBatchArguments(call: Invocation): void {
  expect(optionValues(call.argv, "--parallel")).toEqual(["1"]);
  expect(optionValues(call.argv, "--timeout")).toEqual(["60000"]);
  expect(call.argv).toContain("--isolate");
  expect(optionValues(call.argv, "--shard")).toEqual([]);
  expect(optionValues(call.argv, "--path-ignore-patterns")).toEqual([]);
  expect(testPaths(call).length).toBeLessThanOrEqual(12);
}

describe.skipIf(process.platform === "win32")("macOS bounded shard shell ownership", () => {
  test("stall observer samples only an identified silent suite without signaling it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx macos' observer-"));
    try {
      createFixture(directory, {});
      const fixture = repoPath("tests", "fixtures", "macos-stall-observer.sh");
      const result = await runShell(directory, 1,
        `bash ${shellQuote(fixture)} "$PWD/probe" "$PWD/scripts/ci/sample-macos-stall.sh"`);
      expect(result.status, result.output).toBe(0);
      for (const scenario of ["silent", "absent", "ambiguous", "progress", "stop"]) {
        expect(result.output).toContain(`PASS ${scenario}`);
      }
    } finally { removeTreeWithRetry(directory); }
  }, SPAWN_BUDGET_MS);

  test("both actual workflow shards own every file exactly once", async () => {
    const runs = [await runShard(1), await runShard(2)];
    for (const [index, run] of runs.entries()) {
      expect(run.status, run.output).toBe(0);
      const calls = testCalls(run);
      expect(calls.flatMap(testPaths)).toEqual(selectedFiles(index + 1));
      for (const call of calls) {
        expectBatchArguments(call);
        if (testPaths(call).some(path => SERIAL_FILES.some(file => path === `tests/${file}`))) expect(testPaths(call)).toHaveLength(1);
      }
      expect(run.invocations.filter(call => call.kind === "manifest")).toHaveLength(1);
      expect(new Set(calls.map(call => call.pid)).size).toBe(calls.length);
    }
    const all = runs.flatMap(testCalls).flatMap(testPaths);
    expect(all.toSorted()).toEqual([...SERIAL_FILES, ...GENERAL_FILES].map(file => `tests/${file}`).sort());
    expect(new Set(all).size).toBe(all.length);
  }, SPAWN_BUDGET_MS);

  test("same basenames at distinct exact paths are not silently excluded", async () => {
    const runs = [await runShard(1, { collision: true }), await runShard(2, { collision: true })];
    for (const [index, run] of runs.entries()) {
      expect(run.status, run.output).toBe(0);
      expect(testCalls(run).flatMap(testPaths)).toEqual(selectedFiles(index + 1, true));
    }
  }, SPAWN_BUDGET_MS);

  for (const target of ["main", SERIAL_FILES[1]!] as const) {
    const targetPath = target === "main" ? selectedFiles(1)[0]! : `tests/${target}`;
    const primaryCount = selectedFiles(1).indexOf(targetPath) + 1;
    test(`${target}: assertion failure stops all later primary files`, async () => {
      const run = await runShard(1, { target, outcomes: ["assert"] });
      expect(run.status, run.output).toBe(ASSERTION_STATUS);
      const calls = testCalls(run);
      expect(calls).toHaveLength(primaryCount);
      expect(targets(calls.at(-1)!, target)).toBe(true);
      expect(run.output).toContain("not retrying assertion/test failures");
      expect(run.output).not.toContain("Attribution:");
    }, SPAWN_BUDGET_MS);

    for (const [caseIndex, signature] of CRASH_SIGNATURES.entries()) {
      test(`${target}: signature crash stays red after clean diagnostic attribution (${caseIndex})`, async () => {
        const run = await runShard(1, { target, outcomes: ["crash"], crashSignature: signature, crashStatus: SIGNATURE_ONLY_CRASH_STATUS });
        expect(run.status, run.output).toBe(SIGNATURE_ONLY_CRASH_STATUS);
        const calls = testCalls(run);
        expect(calls).toHaveLength(primaryCount + 1);
        expect(calls.filter(call => targets(call, target))).toHaveLength(2);
        expect(calls.slice(primaryCount).flatMap(testPaths)).toEqual([targetPath]);
        expect(run.output).toContain("has already failed this shard");
      }, SPAWN_BUDGET_MS);
    }

    test(`${target}: status-only crash cannot recover after repeated failure`, async () => {
      const run = await runShard(1, { target, outcomes: ["crash", "crash"] });
      expect(run.status, run.output).toBe(CRASH_STATUS);
      expect(testCalls(run)).toHaveLength(primaryCount + 1);
      expect(run.output).toContain("reproduces alone");
    }, SPAWN_BUDGET_MS);
  }

  const invalidManifests: Array<[string, FixtureOptions]> = [
    ["producer failure despite valid output", { manifestStatus: 19 }],
    ["empty manifest", { manifest: [] }],
    ["duplicate entry", { manifest: [...SERIAL_FILES, SERIAL_FILES[0]!] }],
    ["missing file", { missing: SERIAL_FILES[3] }],
    ["basename without its full relative path", { manifest: [basename(SERIAL_FILES[0]!)] }],
    ["absolute path", { manifest: [`/${SERIAL_FILES[0]}`] }],
    ["parent traversal", { manifest: ["serial/../serial/falcon.test.ts"] }],
  ];
  test.each(invalidManifests)("rejects %s before any test starts", async (_name, options) => {
    for (const shard of [1, 2]) {
      const run = await runShard(shard, options);
      expect(run.status, run.output).not.toBe(0);
      expect(testCalls(run)).toEqual([]);
      expect(run.invocations.filter(call => call.kind === "manifest")).toHaveLength(1);
    }
  }, SPAWN_BUDGET_MS);
});
