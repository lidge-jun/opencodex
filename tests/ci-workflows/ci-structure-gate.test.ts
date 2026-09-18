import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * `structure/` is the one directory whose entire purpose is a gate, and it was
 * the one directory the gate never saw. `structure:check` reaches CI only
 * through `tests/ci-workflows/structure-ssot.test.ts`, inside the suite the `ci`
 * path filter decides whether to run — and that filter did not list
 * `structure/**`. On #4999, a pure doc split, every expensive leg reported
 * `skipped` and the aggregate `ci` check reported success over nothing (#5001).
 *
 * It hid for so long because `structure/AGENTS.md` makes a `structure/` edit
 * almost always arrive beside a `src/` one, which the `ci` filter does match.
 * Only a pure doc change exposes it, and it took a doc reaching its size budget
 * to produce one.
 */
const source = readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8");
const workflow = Bun.YAML.parse(source) as {
  on?: { push?: { paths?: string[] } };
  jobs?: Record<string, {
    if?: string;
    needs?: string | string[];
    "timeout-minutes"?: number;
    outputs?: Record<string, string>;
    steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }>;
  }>;
};

const changes = workflow.jobs?.changes;
const filterStep = (changes?.steps ?? []).find(step => step.uses?.startsWith("dorny/paths-filter@"));
const filters = Bun.YAML.parse(String(filterStep?.with?.filters ?? "")) as Record<string, string[]>;

test("a change under structure/ selects a job that runs the structure gate", () => {
  // The whole defect was that nothing satisfied this. Read the condition off the
  // job rather than naming the job, so renaming it does not quietly pass.
  expect(filters.structure).toContain("structure/**");
  expect(changes?.outputs?.structure).toBe("${{ steps.filter.outputs.structure }}");

  const selected = Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => job.if?.includes("needs.changes.outputs.structure == 'true'"))
    .filter(([, job]) => (job.steps ?? []).some(step => step.run?.includes("bun run structure:check")));
  expect(selected.map(([name]) => name)).toEqual(["structure-gate"]);
});

test("a prose edit still does not start the cross-platform matrix", () => {
  // This is the tradeoff the narrow job buys, and it is worth pinning: widening
  // the `ci` filter would also close #5001, and would also start nine Windows
  // shards and two macOS shards for a check that takes seconds. A future edit
  // that takes that route fails here and gets read by a human.
  expect(filters.ci).not.toContain("structure/**");
  expect(filters.ci).not.toContain("structure/");
});

test("the push trigger keeps mirroring the ci filter exactly", () => {
  // The gate is pull-request scope, like `docs-site-build`, because the push
  // trigger's `paths:` is pinned to equal the `ci` filter and `structure/**`
  // deliberately is not in that filter. That costs nothing: `dev`, `main` and
  // `preview` are protected to require a pull request, so no `structure/`
  // change reaches an integration line without passing through one.
  expect([...(workflow.on?.push?.paths ?? [])].sort()).toEqual([...(filters.ci ?? [])].sort());
});

test("the aggregate gate expects the job instead of ignoring it", () => {
  // ci.yml's own comment: adding a job without adding it here fails the gate by
  // name rather than passing unnoticed. That only holds if the arm exists, and a
  // job missing from `expected_for` reads as `undeclared`, not as skipped.
  const gate = workflow.jobs?.ci;
  expect(Array.isArray(gate?.needs) ? gate?.needs : []).toContain("structure-gate");
  const script = (gate?.steps ?? []).map(step => step.run ?? "").join("\n");
  expect(script).toContain("structure-gate) echo \"$structure\" ;;");
  expect(script).toContain("GATED_JOBS=\"$GATED_JOBS structure-gate\"");
  expect(script).toContain("CHANGES_STRUCTURE");
});
