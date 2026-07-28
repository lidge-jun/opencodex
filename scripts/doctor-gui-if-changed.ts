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
 * DOCTOR_CMD overrides the spawned command (offline-degradation testing).
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

/** True when any changed path is the gui directory or inside it (slash-guarded). */
export function guiPathsChanged(files: string[]): boolean {
  return files.some(f => f === "gui" || f.startsWith("gui/"));
}

/** True when stderr/stdout looks like a registry/network failure rather than findings. */
export function looksLikeDoctorInfraFailure(output: string): boolean {
  return /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|getaddrinfo|network|registry|npm ERR|fetch failed|ERR_INVALID_URL|certificate|SSL|TLS|offline|could not resolve|unable to resolve|socket hang up|connect ECONN|connect ENOTFOUND/i
    .test(output);
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dirname, "..");
  const guiDir = join(repoRoot, "gui");

  const hasRef = (ref: string): boolean => {
    try {
      execFileSync("git", ["rev-parse", "--verify", ref], { cwd: repoRoot, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  const diffNames = (range: string): string[] => {
    try {
      return execFileSync("git", ["diff", "--name-only", range], { cwd: repoRoot, encoding: "utf8" })
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
  try {
    // Pipe stdout/stderr so we can distinguish findings from offline/registry
    // failures, then replay them so the developer still sees the doctor output.
    const out = execFileSync(cmd!, args, {
      cwd: guiDir,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, npm_config_yes: "true" },
    });
    if (out) process.stdout.write(out);
  } catch (err) {
    const status = typeof err === "object" && err !== null && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
    const stdout = typeof err === "object" && err !== null && "stdout" in err
      ? String((err as { stdout?: unknown }).stdout ?? "")
      : "";
    const stderr = typeof err === "object" && err !== null && "stderr" in err
      ? String((err as { stderr?: unknown }).stderr ?? "")
      : "";
    const combined = `${stdout}\n${stderr}`;
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    // Spawn failed (missing binary) — do not brick the push on infra.
    if (typeof status !== "number") {
      console.warn("doctor:gui: react-doctor unavailable (offline?) — skipping scan");
      process.exit(0);
    }

    // Doctor started but npx/registry failed — same soft-skip contract.
    if (looksLikeDoctorInfraFailure(combined)) {
      console.warn("doctor:gui: react-doctor unavailable (offline?) — skipping scan");
      process.exit(0);
    }

    // Real findings (or other doctor/engine errors) gate the push.
    process.exit(status === 0 ? 1 : status);
  }
}
