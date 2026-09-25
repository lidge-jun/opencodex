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
import { readFileSync } from "node:fs";
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
    expect(narrow?.env?.SETUP_ACTION).toBe("${{ steps.filter.outputs.setup_action }}");
    expect(narrow?.env?.REMOTE_HELPER).toBe("${{ steps.filter.outputs.remote_helper }}");
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
