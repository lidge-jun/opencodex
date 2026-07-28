/**
 * Run React Doctor in gui/ when this push includes gui/ changes.
 * Used by `bun run prepush`. Skip with: git push --no-verify
 *
 * Gating by contract (doctor.config.json blocking: "warning"): findings fail
 * the push. An unavailable engine (offline npx fetch, missing binary) still
 * degrades to a warning so infrastructure outages do not brick pushes.
 *
 * Test hooks: DOCTOR_DRY_RUN=1 prints the run/skip decision without spawning;
 * DOCTOR_FILES (newline-separated) overrides git-derived changed files;
 * DOCTOR_CMD overrides the spawned command (offline-degradation testing);
 * OCX_DOCTOR_MAX_BUFFER overrides spawnSync maxBuffer (overflow hard-fail testing).
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

/** True when any changed path is the gui directory or inside it (slash-guarded). */
export function guiPathsChanged(files: string[]): boolean {
  return files.some(f => f === "gui" || f.startsWith("gui/"));
}

/** True when stderr/stdout looks like a registry/network failure rather than findings. */
export function looksLikeDoctorInfraFailure(output: string): boolean {
  // Keep this narrow: bare words like "network"/"offline" also appear in findings text.
  // `npm ERR!` is matched on its own — `!` is non-word, so a shared trailing `\b` never fires after it.
  return /npm ERR!|(?:^|\b)(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|getaddrinfo ENOTFOUND|fetch failed|ERR_INVALID_URL|UNABLE_TO_GET_ISSUER_CERT|certificate has expired|unable to resolve|could not resolve host|socket hang up|connect ECONNREFUSED|connect ENOTFOUND|connect ECONNRESET)(?:\b|$)/im
    .test(output);
}

/** Large enough for verbose doctor scans; overflows must not soft-skip the gate. */
export const DOCTOR_MAX_BUFFER = 20 * 1024 * 1024;

/** True when spawnSync failed because child stdout/stderr exceeded maxBuffer. */
export function isDoctorBufferOverflow(code: string | undefined): boolean {
  return code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function resolveMaxBuffer(): number {
  const raw = process.env.OCX_DOCTOR_MAX_BUFFER;
  if (raw === undefined || raw === "") return DOCTOR_MAX_BUFFER;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DOCTOR_MAX_BUFFER;
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dirname, "..");
  const guiDir = join(repoRoot, "gui");

  const hasRef = (ref: string): boolean => {
    try {
      const probe = spawnSync("git", ["rev-parse", "--verify", ref], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      return probe.status === 0;
    } catch {
      return false;
    }
  };

  const diffNames = (range: string): string[] => {
    try {
      const diff = spawnSync("git", ["diff", "--name-only", range], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (diff.status !== 0) return [];
      return (diff.stdout ?? "")
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  let files: string[];
  let hadBase = true;
  if (process.env.DOCTOR_FILES !== undefined) {
    files = process.env.DOCTOR_FILES.split(/\r?\n/).map(f => f.trim()).filter(Boolean);
  } else {
    let range: string | null = null;
    if (hasRef("@{u}")) range = "@{u}...HEAD";
    else if (hasRef("origin/main")) range = "origin/main...HEAD";
    else if (hasRef("main")) range = "main...HEAD";
    hadBase = range !== null;
    files = range ? diffNames(range) : [];
  }

  // No usable base — run doctor so GUI pushes still get a check.
  const shouldRun = hadBase ? guiPathsChanged(files) : true;

  if (process.env.DOCTOR_DRY_RUN === "1") {
    console.log(shouldRun ? "doctor:run" : "doctor:skip");
    process.exit(0);
  }

  if (!shouldRun) {
    console.log("doctor:gui: skip (no gui/ changes in push range)");
    process.exit(0);
  }

  console.log("doctor:gui: gui/ changed — running React Doctor (scope=changed)");
  const [cmd, ...args] = process.env.DOCTOR_CMD
    ? process.env.DOCTOR_CMD.split(" ")
    : ["bun", "run", "doctor"];

  // spawnSync (not execFileSync): explicit maxBuffer + status/error channels so
  // oversized doctor output cannot be mistaken for an offline soft-skip.
  const result = spawnSync(cmd!, args, {
    cwd: guiDir,
    encoding: "utf8",
    maxBuffer: resolveMaxBuffer(),
    env: { ...process.env, npm_config_yes: "true" },
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const overflowCode = result.error && "code" in result.error
    ? String((result.error as NodeJS.ErrnoException).code ?? "")
    : "";
  if (isDoctorBufferOverflow(overflowCode)) {
    console.error("doctor:gui: react-doctor output exceeded buffer — failing push");
    process.exit(1);
  }

  // Spawn failed (missing binary) — do not brick the push on infra.
  if (result.error && typeof result.status !== "number") {
    console.warn("doctor:gui: react-doctor unavailable (offline?) — skipping scan");
    process.exit(0);
  }

  if (result.status === 0) process.exit(0);

  const combined = `${stdout}\n${stderr}`;
  // Doctor started but npx/registry failed — same soft-skip contract.
  if (looksLikeDoctorInfraFailure(combined)) {
    console.warn("doctor:gui: react-doctor unavailable (offline?) — skipping scan");
    process.exit(0);
  }

  // Real findings (or other doctor/engine errors) gate the push.
  process.exit(result.status === null || result.status === 0 ? 1 : result.status);
}
