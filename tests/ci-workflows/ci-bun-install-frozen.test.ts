import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The script targets the Linux CI runners and needs GNU timeout.
describe.skipIf(process.platform === "win32")("bun-install-frozen.sh retry policy", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  /** A fake bun whose Nth invocation behaves as listed: "hang", "ok" or an exit code. */
  function run(plan: string[], options: { dirs?: number; env?: Record<string, string> } = {}) {
    const root = mkdtempSync(join(tmpdir(), "ocx-bun-install-"));
    roots.push(root);
    const count = join(root, "count"), fake = join(root, "fake-bun");
    writeFileSync(join(root, "plan"), plan.join("\n") + "\n");
    writeFileSync(fake, [
      "#!/usr/bin/env bash",
      `n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${count}"`,
      `step=$(sed -n "${"$"}{n}p" "${join(root, "plan")}")`,
      'echo "fake bun $* in $PWD"',
      'case "$step" in hang) exec sleep 30 ;; ok) exit 0 ;; *) exit "$step" ;; esac',
    ].join("\n"));
    chmodSync(fake, 0o755);
    const dirs = Array.from({ length: options.dirs ?? 1 }, () => root);
    const started = Date.now();
    const result = spawnSync("bash", [script, ...dirs], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, BUN_INSTALL_BIN: fake, BUN_INSTALL_ATTEMPT_SECONDS: "1", BUN_INSTALL_KILL_GRACE_SECONDS: "1",
        BUN_INSTALL_MIN_ATTEMPT_SECONDS: "1", ...options.env },
    });
    return { status: result.status, out: result.stdout + result.stderr, elapsedMs: Date.now() - started,
      calls: existsSync(count) ? Number(readFileSync(count, "utf8")) : 0 };
  }

  test("an attempt killed by its deadline is retried and the next success passes", () => {
    const result = run(["hang", "ok"]);
    expect(result.status, result.out).toBe(0);
    expect(result.calls).toBe(2);
    expect(result.out).toContain("::warning::bun install --frozen-lockfile");
  });

  test("an ordinary install failure such as a lockfile mismatch is not retried", () => {
    const result = run(["1", "ok"]);
    expect(result.status, result.out).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.out).toContain("not retrying");
  });

  test("three deadline kills fail with an error annotation", () => {
    const result = run(["hang", "hang", "hang", "ok"]);
    expect(result.status, result.out).toBe(124);
    expect(result.calls).toBe(3);
    expect(result.out).toContain("::error::bun install --frozen-lockfile in");
  });

  test("every attempt runs the frozen-lockfile install", () => {
    const result = run(["ok"]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("fake bun install --frozen-lockfile");
  });

  test("root and GUI stalls share one total budget instead of three attempts each", () => {
    // Per-directory retries alone would allow 6 attempts of 2 s plus grace; the 4 s total ends after 2.
    const result = run(Array(8).fill("hang"), { dirs: 2, env: { BUN_INSTALL_ATTEMPT_SECONDS: "2", BUN_INSTALL_TOTAL_SECONDS: "4" } });
    expect(result.status, result.out).toBe(124);
    expect(result.calls).toBe(2);
    expect(result.elapsedMs).toBeLessThan(7_000);
    expect(result.out).toContain("budget");
  });
});
