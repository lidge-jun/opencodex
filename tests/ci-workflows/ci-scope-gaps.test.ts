/**
 * Paths the ci filter leaves out still reach a job that exercises them.
 *
 * The `ci` path filter omits `.github/actions/**` and `native/**`, so a pull request that changed
 * only the composite Bun setup action, or only the Rust remote-workspace helper, ran nothing that
 * used what it changed while the aggregate check reported success over skips. Each now has a
 * narrow filter and a small job, in the shape `structure-gate` set: pull-request scope, no full
 * suite, and an arm in the aggregate gate.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

type Step = { id?: string; name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; steps?: Step[]; strategy?: { matrix?: { os?: string[] } } };
const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8")) as {
  jobs: Record<string, Job | undefined>;
};
const jobs = workflow.jobs;
const changes = jobs.changes;
const filterStep = (changes?.steps ?? []).find(step => step.uses?.startsWith("dorny/paths-filter@"));
const filters = Bun.YAML.parse(String(filterStep?.with?.filters ?? "")) as Record<string, string[]>;

const matches = (patterns: readonly string[] | undefined, path: string): boolean =>
  (patterns ?? []).some(pattern => new Bun.Glob(pattern).match(path));
const filtersMatching = (path: string): string[] =>
  Object.entries(filters).filter(([, patterns]) => matches(patterns, path)).map(([name]) => name);
/** Jobs whose condition reads one of the named changes outputs. */
const jobsSelectedBy = (outputs: string[]): Array<[string, Job]> =>
  Object.entries(jobs).filter((entry): entry is [string, Job] =>
    entry[1] !== undefined && outputs.some(output => (entry[1]!.if ?? "").includes(`needs.changes.outputs.${output} == 'true'`)));
const scriptOf = (job: Job): string => (job.steps ?? []).map(step => step.run ?? "").join("\n");

const ACTION_PATH = ".github/actions/setup-project-bun/action.yml";
const HELPER_PATH = "native/remote-workspace-helper/src/main.rs";

describe("an edit to the setup action alone", () => {
  test("selects a job that runs the action and checks what it installed", () => {
    const selected = jobsSelectedBy(filtersMatching(ACTION_PATH))
      .filter(([, job]) => (job.steps ?? []).some(step => step.uses === "./.github/actions/setup-project-bun"));
    expect(selected.map(([name]) => name)).toEqual(["setup-action"]);
    const [, job] = selected[0]!;
    expect(scriptOf(job)).toContain("bun --version");
    expect(job.strategy?.matrix?.os).toEqual(["ubuntu-latest", "windows-latest", "macos-latest"]);
  });

  test("checks resolved and installed versions for both roles", () => {
    const steps = jobs["setup-action"]?.steps ?? [];
    const setups = steps.filter(step => step.uses === "./.github/actions/setup-project-bun");
    expect(setups.map(step => step.with?.role ?? "runtime")).toEqual(["runtime", "test-runner"]);
    for (const [index, key] of ["dependencies.bun", "testRunnerBun"].entries()) {
      const setup = setups[index]!;
      const check = steps[steps.indexOf(setup) + 1]!;
      expect(check.env?.RESOLVED).toBe(`\${{ steps.${setup.id}.outputs.version }}`);
      expect(check.run).toContain(`require('./package.json').${key}`);
      expect(check.run).toContain('installed="$(bun --version)"');
      expect(check.run).toContain('[ "$RESOLVED" != "$declared" ] || [ "$installed" != "$declared" ]');
      expect(check.run).toContain("exit 1");
    }
  });
});

// #6713: user runtimes and compiled artifacts need 1.4.2; isolate runners need 1.4.0.
// Check the active setup at each test command, so a later role switch cannot evade the guard.
const runsBunTests = (step: Step): boolean =>
  /\bbun\s+test\b|\bbun\s+run\s+test(?::changed)?(?:\s|$)|\bbun\s+(?:run\s+)?scripts\/test\.ts\b|scripts\/ci\/run-bun-test-batches\.sh/.test(
    (step.run ?? "").split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n"),
  );
const workflowJobs = new Map(readdirSync(repoPath(".github", "workflows"))
  .filter(file => file.endsWith(".yml"))
  .sort()
  .map(file => [file, (Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", file), "utf8")) as {
    jobs: Record<string, Job>;
  }).jobs]));

describe("CI Bun roles", () => {
  test("recognizes direct tests, both suite wrappers, and keeps Swift tests on runtime", () => {
    for (const run of ["bun test --isolate tests", "bun run test", "bun run test:changed",
      "bun scripts/test.ts", "bun run scripts/test.ts", "bash scripts/ci/run-bun-test-batches.sh 1/4"]) {
      expect(runsBunTests({ run })).toBeTrue();
    }
    expect(runsBunTests({ run: "bun run test:macos" })).toBeFalse();
    expect(runsBunTests({ run: "# bun run test" })).toBeFalse();
  });

  test("covers every known Bun test job including single-file version validation", () => {
    const testing = [...workflowJobs].flatMap(([file, fileJobs]) => Object.entries(fileJobs)
      .filter(([, job]) => job.steps?.some(runsBunTests)).map(([name]) => `${file}/${name}`));
    expect(testing).toEqual(expect.arrayContaining([
      "ci.yml/api-usage", "ci.yml/gates", "ci.yml/macos-control", "ci.yml/platform-macos",
      "ci.yml/platform-windows", "ci.yml/storage-policy", "ci.yml/test",
      "dev-version-bump.yml/open-bump-pr",
    ]));
  });

  for (const [file, fileJobs] of workflowJobs) {
    test(`${file}: test commands use test-runner; other jobs keep runtime`, () => {
      for (const [name, job] of Object.entries(fileJobs)) {
        if (file === "ci.yml" && name === "setup-action") continue; // Both roles are verified above.
        const steps = job.steps ?? [];
        const testing = steps.some(runsBunTests);
        let activeSetup: Step | undefined;
        for (const step of steps) {
          if (step.uses === "./.github/actions/setup-project-bun") {
            activeSetup = step;
            expect(`${name}:${step.with?.role ?? "runtime"}`).toBe(`${name}:${testing ? "test-runner" : "runtime"}`);
          } else if (step.uses?.startsWith("oven-sh/setup-bun@")) {
            activeSetup = undefined;
          }
          if (runsBunTests(step)) {
            expect(`${name}:${activeSetup?.with?.role}`).toBe(`${name}:test-runner`);
          }
        }
      }
    });
  }

  test("release, packaged runtime and sidecar jobs use the default runtime action", () => {
    const runtimeJobs: Record<string, string[]> = {
      "ci.yml": ["desktop-shell", "widget", "docker-smoke", "keyring-smoke"],
      "release.yml": ["preflight", "package-standalone", "package-desktop", "verify-release", "publish", "attach-release"],
      "service-lifecycle.yml": ["linux-systemd", "macos-launchd", "windows-schtasks"],
      "desktop-installed-gate.yml": ["macos", "windows", "linux"],
    };
    for (const [file, names] of Object.entries(runtimeJobs)) {
      for (const name of names) {
        const setups = workflowJobs.get(file)?.[name]?.steps?.filter(step => step.uses === "./.github/actions/setup-project-bun") ?? [];
        expect(`${file}/${name}:${setups.length}`).toBe(`${file}/${name}:1`);
        expect(setups[0]?.with?.role).toBeUndefined();
      }
    }
  });
});

type BunAction = {
  inputs: { role: { default: string } };
  outputs: { version: { value: string } };
  runs: { steps: Step[] };
};
const bunAction = Bun.YAML.parse(readFileSync(repoPath(...ACTION_PATH.split("/")), "utf8")) as BunAction;
const resolveStep = bunAction.runs.steps.find(step => step.id === "resolve")!;
const resolver = resolveStep.run?.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];

function resolveBunPin(pkg: unknown, role = bunAction.inputs.role.default) {
  if (!resolver) throw new Error("setup-project-bun's Node resolver is missing");
  const scratch = repoPath(".tmp");
  mkdirSync(scratch, { recursive: true });
  const fixture = mkdtempSync(join(scratch, "bun-role-"));
  const output = join(fixture, "output");
  try {
    writeFileSync(join(fixture, "package.json"), JSON.stringify(pkg));
    writeFileSync(output, "");
    const result = Bun.spawnSync(["node", "-e", resolver], {
      cwd: fixture, env: { ...process.env, BUN_ROLE: role, GITHUB_OUTPUT: output },
    });
    return { status: result.exitCode, stderr: result.stderr.toString(), output: readFileSync(output, "utf8") };
  } finally {
    removeTreeWithRetry(fixture);
  }
}

describe("setup-project-bun pin resolution", () => {
  const pkg = { dependencies: { bun: "1.4.2" }, testRunnerBun: "1.4.0" };
  test("defaults to runtime and routes the requested role without changing the output contract", () => {
    expect(bunAction.inputs.role.default).toBe("runtime");
    expect(resolveStep.env?.BUN_ROLE).toBe("${{ inputs.role }}");
    expect(bunAction.outputs.version.value).toBe("${{ steps.resolve.outputs.version }}");
    const setup = bunAction.runs.steps.find(step => step.uses?.startsWith("oven-sh/setup-bun@"));
    expect(setup?.with?.["bun-version"]).toBe("${{ steps.resolve.outputs.version }}");
    expect(resolveBunPin(pkg)).toMatchObject({ status: 0, output: "version=1.4.2\n" });
    expect(resolveBunPin(pkg, "test-runner")).toMatchObject({ status: 0, output: "version=1.4.0\n" });
  });

  test("unknown and empty roles fail without emitting a version", () => {
    for (const role of ["", "testing", "runtime; echo injected"]) {
      const result = resolveBunPin(pkg, role);
      expect(result).toMatchObject({ status: 1, output: "" });
      expect(result.stderr).toContain("Unknown Bun role");
    }
  });

  test("each role fails closed on missing, empty, non-string and unpinned values", () => {
    for (const value of [undefined, null, "", "undefined", 140, "^1.4.0", "1.4.0\n", "1.4.0\nversion=1.4.2"]) {
      for (const role of ["runtime", "test-runner"]) {
        const broken = role === "runtime" ? { ...pkg, dependencies: { bun: value } } : { ...pkg, testRunnerBun: value };
        const result = resolveBunPin(broken, role);
        expect(result).toMatchObject({ status: 1, output: "" });
        expect(result.stderr).toContain("Missing or invalid package.json");
      }
    }
    expect(resolveBunPin({}, "runtime")).toMatchObject({ status: 1, output: "" });
  });
});

describe("an edit to the remote-workspace helper alone", () => {
  test("selects a job that lints and tests the crate", () => {
    const selected = jobsSelectedBy(filtersMatching(HELPER_PATH))
      .filter(([, job]) => scriptOf(job).includes("native/remote-workspace-helper/Cargo.toml"));
    expect(selected.map(([name]) => name)).toEqual(["remote-helper"]);
    const script = scriptOf(selected[0]![1]);
    expect(script).toContain("cargo clippy --locked");
    expect(script).toContain("cargo test --locked");
    expect(script).toContain("cargo fmt");
  });
});

describe("the narrow checks stay narrow", () => {
  test("neither path starts the full suite or the native macOS jobs", () => {
    for (const path of [ACTION_PATH, HELPER_PATH]) {
      expect(`${path}:ci=${matches(filters.ci, path)}`).toBe(`${path}:ci=false`);
      expect(`${path}:native=${matches(filters.native, path)}`).toBe(`${path}:native=false`);
    }
  });

  test("an ordinary source change selects neither job", () => {
    for (const path of ["src/router.ts", "tests/lab/core-lab-boundary.test.ts", "package.json"]) {
      expect(`${path}:${filtersMatching(path).filter(name => name === "setup_action" || name === "remote_helper")}`).toBe(`${path}:`);
    }
  });

  test("each filter output is validated before a job reads it", () => {
    const narrow = (changes?.steps ?? []).find(step => step.id === "narrow");
    expect(changes?.outputs?.setup_action).toBe("${{ steps.narrow.outputs.setup_action }}");
    expect(changes?.outputs?.remote_helper).toBe("${{ steps.narrow.outputs.remote_helper }}");
    expect(narrow?.env?.SETUP_ACTION).toBe("${{ github.event_name == 'schedule' && 'true' || steps.filter.outputs.setup_action }}");
    expect(narrow?.env?.REMOTE_HELPER).toBe("${{ github.event_name == 'schedule' && 'true' || steps.filter.outputs.remote_helper }}");
    expect(narrow?.run).toContain("exit 1");
  });
});

function gateExpectation(job: string, env: Record<string, string>): string {
  const gate = (jobs.ci?.steps ?? []).map(step => step.run ?? "").join("\n");
  const start = gate.indexOf("scoped=requested");
  const end = gate.indexOf("bad=\"\"");
  if (start < 0 || end < 0) throw new Error("cannot locate the aggregate expectation block in ci.yml");
  const result = Bun.spawnSync(["bash", "-c", `${gate.slice(start, end)}\nexpected_for "$1"\necho "GATED=$GATED_JOBS"`, "gate", job], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EVENT_NAME: "pull_request", CHANGES_CI: "false", ...env },
  });
  return result.stdout.toString().trim();
}

describe.skipIf(process.platform === "win32")("the aggregate gate", () => {
  test("requires each narrow job exactly when its filter selected it", () => {
    const needs = Array.isArray(jobs.ci?.needs) ? jobs.ci!.needs : [];
    for (const [job, variable] of [["setup-action", "CHANGES_SETUP_ACTION"], ["remote-helper", "CHANGES_REMOTE_HELPER"]] as const) {
      expect(needs).toContain(job);
      expect(gateExpectation(job, { [variable]: "true" })).toStartWith("requested\n");
      expect(gateExpectation(job, { [variable]: "false" })).toStartWith("not-requested\n");
      expect(gateExpectation(job, {})).toContain(` ${job}`);
    }
    const step = (jobs.ci?.steps ?? []).find(candidate => (candidate.run ?? "").includes("scoped=requested"));
    expect(step?.env?.CHANGES_SETUP_ACTION).toBe("${{ needs.changes.outputs.setup_action }}");
    expect(step?.env?.CHANGES_REMOTE_HELPER).toBe("${{ needs.changes.outputs.remote_helper }}");
  });
});
