import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

const script = repoPath("scripts", "ci", "bun-install-frozen.sh");
const UBUNTU_INSTALL_JOBS = ["test", "test-changed", "storage-policy", "api-usage", "gates"];

/** Map each job id in ci.yml to its runs-on value and the run lines it contains. */
function ciJobs(): Map<string, { runsOn: string | null; text: string }> {
  const jobs = new Map<string, { runsOn: string | null; text: string }>();
  let current: { runsOn: string | null; text: string } | null = null;
  for (const line of readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8").split(/\r?\n/)) {
    const job = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (job) { current = { runsOn: null, text: "" }; jobs.set(job[1]!, current); continue; }
    if (!current) continue;
    const runsOn = /^    runs-on:\s*(.+)$/.exec(line);
    if (runsOn) current.runsOn = runsOn[1]!.trim();
    current.text += line + "\n";
  }
  return jobs;
}

describe("CI frozen installs are bounded", () => {
  test("every Ubuntu job that installs the GUI goes through the bounded install script", () => {
    const jobs = ciJobs();
    for (const name of UBUNTU_INSTALL_JOBS) {
      const job = jobs.get(name);
      expect(job?.runsOn, name).toBe("ubuntu-latest");
      expect(job!.text, name).toContain("bash scripts/ci/bun-install-frozen.sh . gui");
    }
    for (const [name, job] of jobs) {
      if (job.runsOn !== "ubuntu-latest") continue;
      // A bare two-step root+gui install, in block or one-line form, is unbounded again.
      expect(/bun install --frozen-lockfile(?:\s*&&\s*|\s*\n\s*)cd gui(?:\s*&&\s*|\s*\n\s*)bun install/.test(job.text), name).toBe(false);
    }
  });
});

// These process-group assertions need POSIX; a Windows skip is not Linux coverage.
describe.skipIf(process.platform === "win32")("bun-install-frozen.sh retry policy", () => {
  const roots: string[] = [];
  const groups = (root: string) => existsSync(join(root, "groups"))
    ? [...new Set(readFileSync(join(root, "groups"), "utf8").trim().split(/\s+/).filter((s) => /^[1-9]\d*$/.test(s)))] : [];
  const drained = (root: string) => spawnSync("bash", ["-c",
    'for group; do if kill -0 -- "-$group" 2>/dev/null; then exit 1; fi; done',
    "_", ...groups(root)], { timeout: 2_000 }).status === 0;
  afterEach(() => {
    for (const root of roots.splice(0)) {
      // Never delete a fixture against a live attempt, or infer drain merely from pipe EOF.
      if (!drained(root)) throw new Error("Attempt group remains; fixture retained: " + root);
      rmSync(root, { recursive: true });
    }
  });

  function fixture(plan: string[], env: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), "ocx-bun-install-case-"));
    roots.push(root);
    mkdirSync(join(root, "tmp"));
    writeFileSync(join(root, "plan"), plan.join("\n") + "\n");
    const fake = join(root, "fake-bun");
    writeFileSync(fake, [
      "#!/usr/bin/env bash",
      'if [[ -r /proc/$$/stat ]]; then',
      '  IFS= read -r stat < /proc/$$/stat; rest="${stat##*) }"; read -r state parent group rest <<< "$rest"',
      'else read -r group <<< "$(ps -o pgid= -p "$$")"; fi',
      'printf "%s\\n" "$group" >> "$TEST_ROOT/groups"',
      'n=$(( $(cat "$TEST_ROOT/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$TEST_ROOT/count"',
      'step=$(sed -n "$' + '{n}p" "$TEST_ROOT/plan")',
      'echo "fake bun $* in $PWD"',
      'case "$step" in',
      "  hang) exec sleep 30 ;;",
      "  hang-ignore) trap '' TERM; exec sleep 30 ;;",
      "  term-marker) trap 'echo TERM > \"$TEST_ROOT/termed\"; exit 0' TERM; sleep 30 ;;",
      "  sigkill) kill -KILL $$ ;;",
      "  spawn-ignore) ( trap '' TERM; exec sleep 30 ) & exec sleep 30 ;;",
      "  spawn-leak) ( exec sleep 30 >/dev/null 2>&1 ) & exit 0 ;;",
      '  forge-fd) for fd in 6 7 8 9; do if ( printf "result 0\\n" >&"$fd" ) 2>/dev/null; then echo "$fd" > "$TEST_ROOT/leaked"; exit 99; fi; done; exit 42 ;;',
      '  metadata) mkdir "$TMPDIR/ocx-bun-install.forged"; mkdir "$TMPDIR/ocx-bun-install.forged/decision"; echo 0 > "$TMPDIR/ocx-bun-install.forged/result"; echo "deadline 0" > "$TMPDIR/ocx-bun-install.forged/witness"; exit 42 ;;',
      '  kill-keeper) kill -KILL "$group"; exec sleep 30 ;;',
      "  ok) exit 0 ;;",
      '  *) exit "$step" ;;',
      "esac",
    ].join("\n"));
    chmodSync(fake, 0o755);
    return {
      root, count: join(root, "count"),
      env: { ...process.env, TEST_ROOT: root, TMPDIR: join(root, "tmp"),
        BUN_INSTALL_BIN: fake, BUN_INSTALL_ATTEMPT_SECONDS: "1",
        BUN_INSTALL_KILL_GRACE_SECONDS: "1", BUN_INSTALL_MIN_ATTEMPT_SECONDS: "1", ...env },
    };
  }

  function run(plan: string[], options: { dirs?: number; env?: Record<string, string> } = {}) {
    const f = fixture(plan, options.env);
    const dirs = Array.from({ length: options.dirs ?? 1 }, (_, n) => {
      const dir = join(f.root, "dir-" + n); mkdirSync(dir); return dir;
    });
    const started = Date.now();
    const child = spawnSync("bash", [script, ...dirs], {
      encoding: "utf8", timeout: 15_000, env: f.env,
    });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(drained(f.root), "owned group remains").toBe(true);
    return { status: child.status, out: child.stdout + child.stderr, root: f.root,
      elapsedMs: Date.now() - started,
      calls: existsSync(f.count) ? Number(readFileSync(f.count, "utf8")) : 0 };
  }

  function timeoutCandidates(f: ReturnType<typeof fixture>, compatibleFallback: boolean) {
    const bin = join(f.root, "timeout-bin");
    mkdirSync(bin);
    for (const name of ["timeout", "gtimeout"]) {
      writeFileSync(join(bin, name), [
        "#!/usr/bin/env bash",
        'if [[ "$1" == --signal=TERM ]]; then exit 0; fi',
        'if [[ "$1" == --foreground ]]; then',
        ...(name === "gtimeout" && compatibleFallback
          ? ['  shift 2', '  exec "$@"']
          : ['  exit 64']),
        "fi",
        "exit 64",
      ].join("\n"));
      chmodSync(join(bin, name), 0o755);
    }
    return { ...f.env, PATH: `${bin}:${f.env.PATH ?? ""}` };
  }

  test("rejects candidates without foreground support before starting an install", () => {
    const f = fixture(["ok"]);
    const dir = join(f.root, "dir"); mkdirSync(dir);
    const child = spawnSync("bash", [script, dir], {
      encoding: "utf8", timeout: 10_000, env: timeoutCandidates(f, false),
    });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(69);
    expect(child.stdout + child.stderr).toContain("GNU timeout is required");
    expect(existsSync(f.count)).toBe(false);
    expect(drained(f.root)).toBe(true);
  });

  test("falls back to gtimeout when timeout lacks foreground support", () => {
    const f = fixture(["ok"]);
    const dir = join(f.root, "dir"); mkdirSync(dir);
    const child = spawnSync("bash", [script, dir], {
      encoding: "utf8", timeout: 10_000, env: timeoutCandidates(f, true),
    });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(existsSync(f.count)).toBe(true);
    expect(readFileSync(f.count, "utf8")).toBe("1\n");
    expect(drained(f.root)).toBe(true);
  });

  test.each(["1", "124", "137", "sigkill"])("ordinary install failure %s never retries", (step) => {
    const r = run([step, "ok"]);
    expect(r.status, r.out).toBe(step === "sigkill" ? 137 : Number(step));
    expect(r.calls).toBe(1);
    expect(r.out).toContain("not retrying");
    expect(r.out).not.toContain("::warning::");
  });

  test.each(["hang", "hang-ignore", "spawn-ignore"])("deadline retries %s after its full grace", (step) => {
    const r = run([step, "ok"], { env: { BUN_INSTALL_KILL_GRACE_SECONDS: "2" } });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(2_800);
    expect(r.elapsedMs).toBeLessThan(12_000);
    expect(r.out).toContain("::warning::");
    expect(r.out).toContain("fake bun install --frozen-lockfile --force");
    expect(r.out.split("fake bun ")[1]).toStartWith("install --frozen-lockfile in ");
  }, 15_000);

  test("TERM remains catchable and its full grace elapses before completion", () => {
    const r = run(["term-marker"], { env: {
      BUN_INSTALL_MAX_ATTEMPTS: "1", BUN_INSTALL_KILL_GRACE_SECONDS: "2",
    } });
    expect(r.status, r.out).toBe(124);
    expect(r.calls).toBe(1);
    const marker = join(r.root, "termed");
    expect(existsSync(marker)).toBe(true);
    expect(Date.now() - statSync(marker).mtimeMs).toBeGreaterThanOrEqual(1_800);
  }, 10_000);

  test("a failure after a witnessed deadline stops further retries", () => {
    const r = run(["hang", "42", "ok"]);
    expect(r.status, r.out).toBe(42);
    expect(r.calls).toBe(2);
    expect(r.out).toContain("not retrying");
  }, 10_000);

  test("normal success drains descendants even when they closed output", () => {
    const r = run(["spawn-leak"]);
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toBe(1);
    expect(r.elapsedMs).toBeLessThan(5_000);
  });

  test("the install inherits no result or lifeline descriptor", () => {
    const r = run(["forge-fd", "ok"]);
    expect(r.status, r.out).toBe(42);
    expect(r.calls).toBe(1);
    expect(existsSync(join(r.root, "leaked"))).toBe(false);
  });

  test("writable decision/result/witness files have no classification authority", () => {
    const r = run(["metadata", "ok"]);
    expect(r.status, r.out).toBe(42);
    expect(r.calls).toBe(1);
    expect(r.out).not.toContain("::warning::");
    expect(readFileSync(join(r.root, "tmp", "ocx-bun-install.forged", "result"), "utf8")).toBe("0\n");
  });

  test("keeper death fails closed and leaves no attempt group", () => {
    const r = run(["kill-keeper", "ok"]);
    expect(r.status, r.out).toBe(70);
    expect(r.calls).toBe(1);
    expect(r.elapsedMs).toBeLessThan(8_000);
    expect(r.out).not.toContain("::warning::");
  }, 10_000);

  test("three witnessed deadlines stop at max attempts", () => {
    const r = run(["hang", "hang", "hang", "ok"]);
    expect(r.status, r.out).toBe(124);
    expect(r.calls).toBe(3);
    expect(r.out).toContain("exceeded its deadline 3 times");
  }, 15_000);

  test("successful root and stalled GUI share the total budget, including cleanup", () => {
    const r = run(["ok", "hang", "hang", "hang"], { dirs: 2, env: {
      BUN_INSTALL_ATTEMPT_SECONDS: "3", BUN_INSTALL_TOTAL_SECONDS: "9",
    } });
    expect(r.status, r.out).toBe(124);
    expect(r.calls).toBeGreaterThanOrEqual(2);
    expect(r.calls).toBeLessThan(4);
    expect(r.elapsedMs).toBeLessThan(10_500);
    expect(r.out).toContain("dir-1");
    expect(r.out).toContain("budget");
  }, 15_000);

  async function interrupt(signal: "SIGTERM" | "SIGINT" | "SIGHUP" | "SIGKILL", duringGrace = false) {
    const f = fixture([duringGrace ? "term-marker" : "hang", "ok"], {
      BUN_INSTALL_ATTEMPT_SECONDS: duringGrace ? "1" : "8", BUN_INSTALL_KILL_GRACE_SECONDS: "3",
    });
    const child = spawn("bash", [script, f.root], { env: f.env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    let closed = false;
    const completion = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, sig) => {
        closed = true;
        resolve(code ?? (sig === "SIGKILL" ? 137 : sig === "SIGTERM" ? 143 : -1));
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const readyBy = Date.now() + 5_000;
      const ready = duringGrace ? join(f.root, "termed") : f.count;
      while (!existsSync(ready) && !closed && Date.now() < readyBy) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(ready), out).toBe(true);
      expect(closed, out).toBe(false);
      const stopped = Date.now();
      child.kill(signal);
      const status = await Promise.race([completion, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("No parent exit/output EOF")), 5_000);
      })]);
      // SIGKILL cannot wait for its descendants, so observe the group separately.
      while (!drained(f.root) && Date.now() - stopped < 4_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status, out).toBe({ SIGTERM: 143, SIGINT: 130, SIGHUP: 129, SIGKILL: 137 }[signal]);
      expect(drained(f.root), out).toBe(true);
      expect(Number(readFileSync(f.count, "utf8"))).toBe(1);
      expect(out).not.toContain("::warning::");
    } finally {
      if (timer) clearTimeout(timer);
      if (!closed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (!closed) await completion;
    }
  }

  test.each(["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"] as const)("parent %s stops its attempt without a retry",
    (signal) => interrupt(signal), 15_000);
  test("parent cancellation outranks an already recorded deadline during its grace",
    () => interrupt("SIGTERM", true), 15_000);

  test("retry completes a trusted postinstall interrupted after package extraction", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-bun-postinstall-"));
    roots.push(root);
    mkdirSync(join(root, "dep"));
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "install-retry-fixture", dependencies: { fixture: "file:./dep" }, trustedDependencies: ["fixture"],
    }));
    writeFileSync(join(root, "dep", "package.json"), JSON.stringify({
      name: "fixture", version: "1.0.0", scripts: { postinstall: "node postinstall.cjs" },
    }));
    // The first postinstall records extraction, then stalls before producing its binary.
    // A plain install retry skips this already-extracted package and exits zero.
    writeFileSync(join(root, "dep", "postinstall.cjs"), [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const marker = path.resolve('../..', 'started');",
      "const retry = fs.existsSync(marker);",
      "fs.appendFileSync(marker, 'started\\n');",
      "if (!retry) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);",
      "fs.writeFileSync('binary-ready', 'ready');",
    ].join("\n"));
    const lock = spawnSync(process.execPath, ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    expect(lock.status, lock.stdout + lock.stderr).toBe(0);
    const lockBefore = readFileSync(join(root, "bun.lock"), "utf8");
    const result = spawnSync("bash", [script, root], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, BUN_INSTALL_BIN: process.execPath, BUN_INSTALL_ATTEMPT_SECONDS: "2",
        BUN_INSTALL_KILL_GRACE_SECONDS: "1", BUN_INSTALL_MIN_ATTEMPT_SECONDS: "1" },
    });
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(0);
    expect(out).toContain("::warning::bun install --frozen-lockfile");
    expect(existsSync(join(root, "node_modules", "fixture", "binary-ready")), out).toBe(true);
    expect(readFileSync(join(root, "started"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(lockBefore);
  }, 30_000);

});
