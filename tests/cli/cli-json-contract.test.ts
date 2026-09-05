import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

/**
 * The `--json` contract, enforced rather than conventional.
 *
 * Today's inconsistency exists because nothing ever checked. Two commands parsed the flag
 * positionally and both were wrong for scripting: `status` honoured `--json` only as the
 * LONE argument, so `ocx status --json --anything` printed human output to a caller that
 * asked for JSON; and `restore` matched `args[1]`, so `ocx restore back --json` ignored the
 * flag entirely because position 1 held `back`.
 *
 * These assertions read source rather than spawning the CLI for every command: spawning 50
 * subprocesses is slow and, worse, several of these commands mutate real config. Source
 * assertions pin the parsing SHAPE, which is what regressed.
 */
const repoRoot = resolveRepoRoot();
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("--json is order-independent", () => {
  test("status does not require --json to be the lone argument", () => {
    const src = read("src/cli/index.ts");
    // The exact defective form, kept as a string so a revert is caught rather than merely
    // discouraged by a comment.
    expect(src).not.toContain('statusArgs.length === 1 && statusArgs[0] === "--json"');
    expect(src).toContain('takeFlag(statusArgs, "--json")');
  });

  test("restore does not match --json positionally", () => {
    const src = read("src/cli/dispatch.ts");
    expect(src).not.toContain('const restoreJson = deps.args[1] === "--json"');
    expect(src).not.toContain('deps.args.slice(1).includes("--json")');
    expect(src).toContain('takeFlag(restoreArgs, "--json")');
    expect(src).toContain("restoreArgs[0] === \"back\"");
    expect(src).toContain("skippedRestoreEnvelope(success, message)");
  });

  test("no runner reads --json at a fixed argv index", () => {
    // Generalises the two known defects: any `args[<number>] === "--json"` is the same bug
    // waiting to happen in another command.
    const offenders: string[] = [];
    for (const rel of ["src/cli/dispatch.ts", "src/cli/index.ts", "src/cli/root.ts"]) {
      const lines = read(rel).split("\n");
      lines.forEach((line, i) => {
        if (/args\[\d+\]\s*===\s*"--json"/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("capability JSON declarations match reality", () => {
  test("every capability declaring JSON lists a --json flag", () => {
    // The capability table is what an agent reads to decide whether it can ask for JSON.
    // A capability claiming a json mode while advertising no --json flag would mislead it.
    const wrong = CAPABILITIES
      .filter(cap => cap.json !== "none" && !cap.flags.some(f => f.name === "--json"))
      .map(cap => cap.command.join(" "));
    expect(wrong).toEqual([]);
  });

  test("no capability advertises --json while declaring json: none", () => {
    const wrong = CAPABILITIES
      .filter(cap => cap.json === "none" && cap.flags.some(f => f.name === "--json"))
      .map(cap => cap.command.join(" "));
    expect(wrong).toEqual([]);
  });
});

describe("doctor can gate a script", () => {
  test("the doctor runner no longer hard-returns 0", () => {
    // A diagnostic that always succeeds cannot gate anything, which defeats running it
    // from a script at all. BREAKING for pipelines that ignored the result.
    const src = read("src/cli/dispatch.ts");
    const runner = src.slice(src.indexOf("  doctor: async deps => {"));
    const body = runner.slice(0, runner.indexOf("\n  },"));
    expect(body).toContain("doctorFailed()");
    expect(body).not.toMatch(/\n    return 0;\s*$/);
  });

  test("doctorFailed is exported and resets per run", async () => {
    // Reset matters: the suite drives runDoctor several times in one process, and a sticky
    // flag would fail the second call because the first saw a problem.
    const mod = await import("../../src/cli/doctor");
    expect(typeof mod.doctorFailed).toBe("function");
    const src = read("src/cli/doctor.ts");
    expect(src).toContain("doctorSawFailure = false;");
  });

  test("only FAIL-level checks fail the command, not WARN", () => {
    // WARN describes a degraded-but-working install. Failing on it would break pipelines
    // that are legitimately green, which is how a useful gate gets disabled by its users.
    const src = read("src/cli/doctor.ts");
    expect(src).toContain('if (check.level === "FAIL") recordDoctorFailure();');
  });
});
