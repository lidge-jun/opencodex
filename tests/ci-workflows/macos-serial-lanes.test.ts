import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const run = workflow.jobs["platform-macos"]?.steps.find(step => step.name === "Test")?.run;
  if (!run) throw new Error("platform-macos must contain the executable Test step");
  // Render the existing Actions expression too, so the old workflow reaches
  // the ownership assertions instead of failing with Bash's 'bad substitution'.
  return run.replace(/\$\{\{\s*matrix\.shard\s*\}\}/g, String(shard));
}

// Only the Bun CLI is replaced. Bash, arrays, find, pipes, PIPESTATUS, and
// filesystem validation all execute unchanged from the actual YAML run block.
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
const matches = args => config.target === "main" ? args.includes("tests")
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

function runShell(directory: string, shard: number): Promise<{ status: number | null; output: string }> {
  // Use the runner's native /bin/bash (Bash 3 on macOS), never a shell mock.
  const command = macosTestBlock(shard);
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command], {
        cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: `${join(directory, "bin")}:/usr/bin:/bin`, HOME: directory,
          TMPDIR: join(directory, "tmp"), RUNNER_TEMP: join(directory, "tmp"), CI: "true",
          MACOS_TEST_SHARD: String(shard),
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
  return testPaths(call).includes(target === "main" ? "tests" : `tests/${target}`);
}

function optionValues(argv: string[], option: string): string[] {
  return argv.flatMap((arg, index) => arg === option ? [argv[index + 1] ?? ""]
    : arg.startsWith(`${option}=`) ? [arg.slice(option.length + 1)] : []);
}

function expectGeneralCall(call: Invocation, shard: number): void {
  const ignores = optionValues(call.argv, "--path-ignore-patterns");
  expect(ignores.toSorted()).toEqual(SERIAL_FILES.map(file => `**/${basename(file)}`).toSorted());
  expect(optionValues(call.argv, "--shard")).toEqual([`${shard}/2`]);
  expect(optionValues(call.argv, "--timeout")).toEqual(["60000"]);
  expect(call.argv).toContain("--isolate");
  expect(testPaths(call)).toEqual(["tests"]);
  // Account for every CLI argument: a name filter or extra exclusion could
  // silently drop ordinary files even while the serial ownership oracle passes.
  expect(call.argv.toSorted()).toEqual([
    "test", "--isolate", "--timeout", "60000", "tests", `--shard=${shard}/2`,
    ...SERIAL_FILES.flatMap(file => ["--path-ignore-patterns", `**/${basename(file)}`]),
  ].toSorted());
  // Exact exclusions above plus the unrestricted tests root leave these files
  // in the main pool. Similar basenames must not become accidental exclusions.
  for (const file of GENERAL_FILES) expect(ignores).not.toContain(`**/${basename(file)}`);
}

// These are explicitly Unix Bash integration tests; Windows still runs the
// existing cross-platform workflow source/layout contracts unchanged.
describe.skipIf(process.platform === "win32")("macOS serial lane shell ownership", () => {
  test("both shards own each canonical file exactly once in a fresh isolated process", async () => {
    const runs = [await runShard(1), await runShard(2)];
    for (const [index, run] of runs.entries()) {
      expect(run.status, run.output).toBe(0);
      const calls = testCalls(run);
      const serial = calls.filter(call => !call.argv.includes("tests"));
      const owned = SERIAL_FILES.filter((_, fileIndex) => fileIndex % 2 === index);
      // First oracle deliberately fails old CI for missing isolated ownership.
      expect(serial.length, "missing isolated ownership of canonical serial files").toBe(owned.length);
      expect(calls.filter(call => call.argv.includes("tests"))).toHaveLength(1);
      expectGeneralCall(calls[0]!, index + 1);
      expect(serial.map(testPaths)).toEqual(owned.map(file => [`tests/${file}`]));
      for (const call of serial) {
        expect(call.argv).toContain("--parallel=1");
        expect(call.argv).toContain("--isolate");
        expect(optionValues(call.argv, "--timeout")).toEqual(["60000"]);
        expect(optionValues(call.argv, "--shard")).toEqual([]);
        expect(optionValues(call.argv, "--path-ignore-patterns")).toEqual([]);
      }
      const manifests = run.invocations.filter(call => call.kind === "manifest");
      expect(manifests).toHaveLength(1);
      expect(manifests[0]!.argv[1]).toContain("SERIAL_FULL_SUITE_FILES");
    }
    const calls = runs.flatMap(testCalls);
    expect(new Set(calls.map(call => call.pid)).size).toBe(calls.length);
  }, SPAWN_BUDGET_MS);

  for (const target of ["main", SERIAL_FILES[0]!] as const) {
    test(`${target}: assertion failure propagates without retry or later files`, async () => {
      const run = await runShard(1, { target, outcomes: ["assert"] });
      expect(run.status, run.output).toBe(ASSERTION_STATUS);
      const calls = testCalls(run);
      expect(calls).toHaveLength(target === "main" ? 1 : 2);
      expect(targets(calls.at(-1)!, target)).toBe(true);
    }, SPAWN_BUDGET_MS);

    for (const [caseIndex, signature] of CRASH_SIGNATURES.entries()) {
      test(`${target}: retries one runtime crash (case ${caseIndex + 1}), then finishes`, async () => {
        const run = await runShard(1, { target, outcomes: ["crash"], crashSignature: signature });
        expect(run.status, run.output).toBe(0);
        const calls = testCalls(run);
        const attempts = calls.filter(call => targets(call, target));
        expect(attempts).toHaveLength(2);
        expect(attempts[0]!.argv).toEqual(attempts[1]!.argv);
        expect(new Set(calls.map(call => call.pid)).size).toBe(calls.length);
        expect(calls).toHaveLength(4); // Main plus two owned serial files plus one retry.
        expect(targets(calls.at(-1)!, SERIAL_FILES[2]!)).toBe(true);
      }, SPAWN_BUDGET_MS);
    }

    test(`${target}: a repeated crash fails after exactly one retry`, async () => {
      const run = await runShard(1, { target, outcomes: ["crash", "crash"] });
      expect(run.status, run.output).toBe(CRASH_STATUS);
      const calls = testCalls(run);
      expect(calls).toHaveLength(target === "main" ? 2 : 3);
      const attempts = calls.filter(call => targets(call, target));
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.argv).toEqual(attempts[1]!.argv);
    }, SPAWN_BUDGET_MS);

    test(`${target}: assertion on the crash retry retains its own exit status`, async () => {
      const run = await runShard(1, { target, outcomes: ["crash", "assert"] });
      expect(run.status, run.output).toBe(ASSERTION_STATUS);
      const calls = testCalls(run);
      expect(calls).toHaveLength(target === "main" ? 2 : 3);
      expect(calls.filter(call => targets(call, target))).toHaveLength(2);
      expect(run.output).toContain("assertion failures are not retried");
      expect(run.output).not.toContain("crash repeated");
    }, SPAWN_BUDGET_MS);
  }

  const invalidManifests: Array<[string, FixtureOptions]> = [
    ["producer failure despite valid output", { manifestStatus: 19 }],
    ["empty manifest", { manifest: [] }],
    ["duplicate entry", { manifest: [...SERIAL_FILES, SERIAL_FILES[0]!] }],
    ["missing file", { missing: SERIAL_FILES[3] }],
    ["basename collision", { collision: true }],
    ["basename without its full relative path", { manifest: [basename(SERIAL_FILES[0]!)] }],
    ["absolute path", { manifest: [`/${SERIAL_FILES[0]}`] }],
    ["parent traversal", { manifest: ["serial/../serial/falcon.test.ts"] }],
  ];
  test.each(invalidManifests)("rejects %s before any tests start", async (_name, options) => {
    for (const shard of [1, 2]) {
      const run = await runShard(shard, options);
      expect(run.status, run.output).not.toBe(0);
      expect(testCalls(run), run.output).toEqual([]);
      expect(run.invocations.filter(call => call.kind === "manifest")).toHaveLength(1);
    }
  }, SPAWN_BUDGET_MS);
});
