import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

/**
 * `privacy:scan` is the gate that makes a public `devlog/` safe rather than
 * merely visible, and it was inert for exactly the diffs that fill that
 * directory. The scan runs as a step of `gates`, `gates` is gated on the `ci`
 * path filter, and that filter does not list `devlog/**` -- so a devlog-only
 * pull request skipped `gates` and the aggregate `ci` check still concluded
 * success (#5468).
 *
 * The fix mirrors `docs` and `structure`: its own filter and its own job,
 * rather than widening `ci` and starting the cross-platform matrix for a scan
 * that takes seconds. The cases below execute the checked-in conditions and
 * shell rather than matching their text, so an edit that keeps the words and
 * changes the behaviour still fails here.
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
const changes = jobs.changes;
const filterStep = (changes?.steps ?? []).find(step => step.uses?.startsWith("dorny/paths-filter@"));
const filters = Bun.YAML.parse(String(filterStep?.with?.filters ?? "")) as Record<string, string[]>;
const scopeStep = (changes?.steps ?? []).find(step => step.id === "scope");
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
function selected(job: string, event: string, ci: string, privacy: string): boolean {
  const condition = jobs[job]?.if;
  if (!condition) throw new Error(`${job} has no if: condition`);
  const evaluate = new Function("github", "needs", `return (${condition});`);
  return Boolean(evaluate(
    { event_name: event, event: { inputs: { lane: "" } } },
    { changes: { outputs: { ci, privacy } } },
  ));
}

describe("the privacy filter", () => {
  test("selects devlog changes without widening the ci filter", () => {
    expect(filters.privacy).toContain("devlog/**");
    // Widening ci would also close #5468 and would also start nine Windows
    // shards and two macOS shards for a scan that takes seconds.
    expect((filters.ci ?? []).some(path => path.startsWith("devlog"))).toBe(false);
  });

  test("the push trigger keeps mirroring the ci filter exactly", () => {
    // Pull-request scope, like docs-site-build and structure-gate: dev, main and
    // preview require a pull request, so no devlog change reaches an integration
    // line without passing through one.
    expect([...(workflow.on?.push?.paths ?? [])].sort()).toEqual([...(filters.ci ?? [])].sort());
  });

  test.skipIf(cannotRunShell)("a missing or malformed privacy output fails the changes job", () => {
    // Consumed raw, an empty output reads as "no devlog change": the gate skips and
    // the aggregate expects the skip, so the scan silently stops running.
    expect(changes?.outputs?.privacy).toBe("${{ steps.scope.outputs.privacy }}");
    expect(scopeStep?.env?.PRIVACY_SCOPE).toBe("${{ steps.filter.outputs.privacy }}");
    const runScope = (privacyScope: string) => {
      const directory = mkdtempSync(join(tmpdir(), "ocx-privacy-scope-"));
      try {
        const output = join(directory, "github-output");
        writeFileSync(output, "");
        const result = spawnSync("bash", ["-c", scopeStep!.run!], {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CI_SCOPE: "false", PRIVACY_SCOPE: privacyScope, GITHUB_OUTPUT: output },
          timeout: 5_000,
        });
        return { status: result.status, stdout: result.stdout, written: readFileSync(output, "utf8") };
      } finally {
        removeTreeWithRetry(directory);
      }
    };
    const valid = runScope("true");
    expect(`status:${valid.status}`, valid.stdout).toBe("status:0");
    expect(valid.written).toContain("privacy=true\n");
    for (const malformed of ["", "maybe"]) {
      const run = runScope(malformed);
      const label = JSON.stringify(malformed);
      expect(`${label} status:${run.status}`).toBe(`${label} status:1`);
      expect(run.stdout).toContain("changes.outputs.privacy");
      expect(run.written).not.toContain("privacy=");
    }
  });
});

describe("the privacy scan", () => {
  test("runs at most once for every event and scope, and exactly once for a devlog change", () => {
    // gates keeps its own scan step, so the new job must stand down wherever gates
    // runs: a ci.yml edit sets both filters, and a push or a dispatch always runs
    // gates. Where gates is skipped, a devlog change must still select the
    // dedicated job.
    expect(scanners).toEqual(["gates", "privacy-gate"]);
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      for (const ci of ["true", "false"]) {
        for (const privacy of ["true", "false"]) {
          const label = `${event} ci=${ci} privacy=${privacy}`;
          const running = scanners.filter(job => selected(job, event, ci, privacy));
          const expected = event !== "pull_request" || ci === "true"
            ? ["gates"]
            : privacy === "true" ? ["privacy-gate"] : [];
          expect(`${label}: ${running.join(",")}`).toBe(`${label}: ${expected.join(",")}`);
        }
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
      CHANGES_PACKAGING: "false",
      CHANGES_DOCS: "false",
      CHANGES_STRUCTURE: "false",
      CHANGES_PRIVACY: "false",
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

  test("is green on a devlog-only pull request only when the privacy gate ran", () => {
    expect(producers).toContain("privacy-gate");
    const devlogOnly = { CHANGES_PRIVACY: "true" };
    // The two unconditional producers plus the privacy gate, and nothing else.
    const ran = runAggregate(devlogOnly, resultsWith(["changes", "select-windows-runner", "privacy-gate"]));
    expect(`status:${ran.status}`, ran.stdout + ran.stderr).toBe("status:0");

    for (const result of ["skipped", "failure", "cancelled"]) {
      const run = runAggregate(devlogOnly, {
        ...resultsWith(["changes", "select-windows-runner"]),
        "privacy-gate": result,
      });
      expect(`${result} status:${run.status}`).toBe(`${result} status:1`);
      expect(run.stdout).toContain(`privacy-gate was requested by pull_request but reported '${result}'`);
    }
  });

  test("rejects a second scan on a pull request that gates already scans", () => {
    // Where ci is true, gates scans; a privacy gate that also ran means its
    // condition and this table have drifted apart.
    const both = { CHANGES_CI: "true", CHANGES_PRIVACY: "true" };
    const doubled = runAggregate(both, { ...resultsWith([]), "privacy-gate": "success" });
    expect(doubled.status).toBe(1);
    expect(doubled.stdout).toContain("privacy-gate was not requested by pull_request but reported 'success'");
    const single = runAggregate(both, resultsWith([]));
    // The step prints RESULTS first, so look for the verdict line, not the job name.
    expect(single.stdout).not.toContain("privacy-gate was");
  });
});
