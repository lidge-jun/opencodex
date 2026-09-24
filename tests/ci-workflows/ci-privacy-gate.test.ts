import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * `privacy:scan` is the gate that makes a public `devlog/` safe rather than
 * merely visible. The scan runs as a step of `gates`, and `gates` is gated on
 * the `ci` path filter, so a pull request whose paths miss that filter skipped
 * `gates` and ran no scan while the aggregate `ci` check still concluded
 * success. #5469 closed that gap only for the paths its `privacy` filter
 * enumerated (`devlog/**` and `ci.yml`); a docs-only or no-filter pull request
 * still scanned nothing.
 *
 * The dedicated `privacy-gate` job is now the exact complement of `gates` on
 * pull requests: it runs wherever the `ci` filter declines, so the scan's
 * coverage no longer depends on an enumerated path list and no filter selects
 * it. The cases below execute the checked-in conditions and shell rather than
 * matching their text, so an edit that keeps the words and changes the
 * behaviour still fails here.
 */
type Step = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; steps?: Step[] };

const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8")) as {
  on?: { push?: { paths?: string[] } };
  jobs: Record<string, Job>;
};
const jobs = workflow.jobs;
const filterStep = (jobs.changes?.steps ?? []).find(step => step.uses?.startsWith("dorny/paths-filter@"));
const filters = Bun.YAML.parse(String(filterStep?.with?.filters ?? "")) as Record<string, string[]>;
const aggregate = jobs.ci;
const aggregateStep = (aggregate?.steps ?? []).find(step => step.name === "Assert every job this event requested succeeded");
const aggregateNeeds = aggregate?.needs;
const producers: string[] = Array.isArray(aggregateNeeds) ? aggregateNeeds : [];

// The changes step and the aggregate run under bash on ubuntu-latest; the Windows
// runner has no /bin/bash, so executing them there would test the host.
const cannotRunShell = process.platform === "win32";
const cannotRunAggregate = cannotRunShell || !Bun.which("jq");

const scanners = Object.entries(jobs)
  .filter(([, job]) => (job.steps ?? []).some(step => step.run?.includes("bun run privacy:scan")))
  .map(([name]) => name)
  .sort();

/** Evaluate a job's checked-in if: condition; these use only ==, !=, && and ||. */
function selected(job: string, event: string, ci: string): boolean {
  const condition = jobs[job]?.if;
  if (!condition) throw new Error(`${job} has no if: condition`);
  const evaluate = new Function("github", "needs", `return (${condition});`);
  return Boolean(evaluate(
    { event_name: event, event: { inputs: { lane: "" } } },
    { changes: { outputs: { ci } } },
  ));
}

describe("the privacy scan selection", () => {
  test("the push trigger keeps mirroring the ci filter exactly", () => {
    // Pull-request scope, like docs-site-build and structure-gate: dev, main and
    // preview require a pull request, so no devlog change reaches an integration
    // line without passing through one.
    expect([...(workflow.on?.push?.paths ?? [])].sort()).toEqual([...(filters.ci ?? [])].sort());
  });

  test("no job or step still reads a privacy filter output", () => {
    // The privacy filter selected nothing once privacy-gate became the exact
    // complement of gates, so it was removed with its plumbing. A job or step
    // that still reads it would evaluate a permanently-empty output.
    expect(filters.privacy).toBeUndefined();
    const serialized = JSON.stringify(jobs);
    for (const reference of ["outputs.privacy", "PRIVACY_SCOPE", "CHANGES_PRIVACY"]) {
      expect(serialized).not.toContain(reference);
    }
  });

  test("runs exactly one scanner for every event and ci scope", () => {
    // gates keeps its own scan step, so the dedicated job must stand down
    // wherever gates runs: a push or a dispatch always runs gates, and a pull
    // request runs gates exactly when the ci filter selects the suite. Where
    // gates is skipped the complement selects privacy-gate instead, so every
    // pull request scans once and no event scans twice.
    expect(scanners).toEqual(["gates", "privacy-gate"]);
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      for (const ci of ["true", "false"]) {
        const label = `${event} ci=${ci}`;
        const running = scanners.filter(job => selected(job, event, ci));
        const expected = event !== "pull_request" || ci === "true" ? ["gates"] : ["privacy-gate"];
        expect(`${label}: ${running.join(",")}`).toBe(`${label}: ${expected.join(",")}`);
      }
    }
  });
});

describe.skipIf(cannotRunAggregate)("the aggregate ci gate, executed", () => {
  const runAggregate = (scope: Record<string, string>, results: Record<string, string>) => spawnSync("bash", ["-c", aggregateStep!.run!], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      EVENT_NAME: "pull_request",
      LANE: "",
      CHANGES_CI: "false",
      CHANGES_NATIVE: "false",
      CHANGES_DESKTOP: "false",
      CHANGES_PACKAGING: "false",
      CHANGES_DOCS: "false",
      CHANGES_STRUCTURE: "false",
      CHANGES_SETUP_ACTION: "false",
      CHANGES_REMOTE_HELPER: "false",
      ...scope,
      // needs serializes as an object per job; the gate reads .value.result.
      RESULTS: JSON.stringify(Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result }]))),
    },
    timeout: 5_000,
  });
  const resultsWith = (succeeded: string[]): Record<string, string> =>
    Object.fromEntries(producers.map(job => [job, succeeded.includes(job) ? "success" : "skipped"]));

  test("is green on a pull request that matches no filter only when the privacy gate ran", () => {
    expect(producers).toContain("privacy-gate");
    // The two unconditional producers plus the privacy gate, and nothing else.
    const ran = runAggregate({}, resultsWith(["changes", "select-windows-runner", "privacy-gate"]));
    expect(`status:${ran.status}`, ran.stdout + ran.stderr).toBe("status:0");

    for (const result of ["skipped", "failure", "cancelled"]) {
      const run = runAggregate({}, {
        ...resultsWith(["changes", "select-windows-runner"]),
        "privacy-gate": result,
      });
      expect(`${result} status:${run.status}`).toBe(`${result} status:1`);
      expect(run.stdout).toContain(`privacy-gate was requested by pull_request but reported '${result}'`);
    }
  });

  test("requires the privacy gate alongside a narrow job on a docs-only pull request", () => {
    // docs-site-build is pull-request scope like privacy-gate: the complement
    // must still request the scan, and a gate that did not succeed fails by name.
    const docsOnly = { CHANGES_DOCS: "true" };
    const ran = runAggregate(docsOnly, resultsWith(["changes", "select-windows-runner", "docs-site-build", "privacy-gate"]));
    expect(`status:${ran.status}`, ran.stdout + ran.stderr).toBe("status:0");

    for (const result of ["skipped", "failure", "cancelled"]) {
      const run = runAggregate(docsOnly, {
        ...resultsWith(["changes", "select-windows-runner", "docs-site-build"]),
        "privacy-gate": result,
      });
      expect(`${result} status:${run.status}`).toBe(`${result} status:1`);
      expect(run.stdout).toContain(`privacy-gate was requested by pull_request but reported '${result}'`);
    }
  });

  test("rejects a second scan on a pull request that gates already scans", () => {
    // Where ci is true, gates scans; a privacy gate that also ran means its
    // condition and this table have drifted apart.
    const both = { CHANGES_CI: "true" };
    const doubled = runAggregate(both, { ...resultsWith([]), "privacy-gate": "success" });
    expect(doubled.status).toBe(1);
    expect(doubled.stdout).toContain("privacy-gate was not requested by pull_request but reported 'success'");
    const single = runAggregate(both, resultsWith([]));
    // The step prints RESULTS first, so look for the verdict line, not the job name.
    expect(single.stdout).not.toContain("privacy-gate was");
  });
});
