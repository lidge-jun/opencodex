import { expect, test } from "bun:test";

export function registerReviewLaneTests(readText: (path: string) => Promise<string>): void {
  test("manual release-gates keeps ordinary jobs and skips only diagnostic suites", async () => {
    const ci = Bun.YAML.parse(await readText(".github/workflows/ci.yml")) as {
      jobs: Record<string, { if?: string; needs?: string | string[] }>;
    };
    // These job conditions use boolean operators and lowercase string comparisons.
    // Evaluate the checked-in expressions, rather than a second implementation of them.
    const enabled = (job: string, event: string, lane: string, scope = "true", packaging = "true") => {
      const condition = ci.jobs[job]!.if ?? "true";
      const evaluate = new Function("github", "needs", `return (${condition});`);
      return evaluate(
        { event_name: event, event: { inputs: { lane } } },
        { changes: { outputs: { ci: scope, packaging } } },
      );
    };
    for (const [event, lane, windows, control] of [
      ["push", "", false, false],
      ["pull_request", "", false, false],
      ["workflow_dispatch", "", true, true],
      ["workflow_dispatch", "all", true, true],
      ["workflow_dispatch", "macos-control", false, true],
      ["workflow_dispatch", "release-gates", false, false],
    ] as const) {
      expect(enabled("platform-windows", event, lane)).toBe(windows);
      expect(enabled("macos-control", event, lane)).toBe(control);
      for (const job of ["test", "platform-macos", "gates", "storage-policy", "api-usage", "keyring-smoke", "docker-smoke"]) {
        expect(enabled(job, event, lane)).toBe(true);
        expect(enabled(job, event, lane, "false")).toBe(event !== "pull_request");
      }
      expect(enabled("npm-global-smoke", event, lane, "true", "true")).toBe(true);
      expect(enabled("npm-global-smoke", event, lane, "true", "false")).toBe(false);
    }
    expect(ci.jobs.ci!.needs).toEqual(expect.arrayContaining([
      "test", "platform-macos", "gates", "storage-policy", "api-usage",
      "keyring-smoke", "docker-smoke", "npm-global-smoke", "platform-windows", "macos-control",
    ]));
  });

  test("PR checks reach every branch the target gate accepts", async () => {
    // These lists have to move together with enforce-pr-target.yml. A PR that
    // passes the gate but triggers no checks is worse than one that is blocked:
    // it looks reviewable and has nothing behind it (commit 5229717b1).
    //
    // The gate accepts more than `ALLOWED_BASES`. It also exempts a STACKED
    // child — a PR whose base is another open PR's head branch — from the
    // wrong-base failure. That exemption has no fixed branch list, so a
    // `branches:` allow-list on the check workflow can never cover it, and
    // `ci.yml` therefore carries no base filter at all. `service-lifecycle.yml`
    // keeps its list: it gates the release service path, not review.
    const gate = await readText(".github/workflows/enforce-pr-target.yml");
    const allowed = gate.match(/const ALLOWED_BASES = \[([^\]]*)\];/);
    expect(allowed).not.toBeNull();
    const bases = [...(allowed?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(m => m[1]);
    expect(bases).toEqual(["dev"]);

    // The gate itself must stay unfiltered by base, or the stacked exemption it
    // implements would never be evaluated for the branches it exempts.
    expect(gate).not.toMatch(/pull_request_target:[\s\S]{0,200}?branches:/);

    for (const [path, expectedKeys] of [
      // No `branches`: the stacked-base exemption has no enumerable branch list.
      [".github/workflows/ci.yml", []],
      [".github/workflows/service-lifecycle.yml", ["branches", "paths"]],
    ] as const) {
      const workflow = Bun.YAML.parse(await readText(path)) as {
        on?: { pull_request?: Record<string, unknown> };
      };
      const trigger = workflow.on?.pull_request ?? {};
      if (expectedKeys.includes("branches")) {
        const branches = (trigger.branches as string[] | undefined) ?? [];
        expect([...branches].sort()).toEqual(["dev", "main"]);
      }

      // Narrowing a default is a mutation that deletes nothing. Omitting
      // `types` means opened + synchronize + reopened; writing
      // `types: [opened]` keeps the workflow, keeps the branch list, and stops
      // running checks on every commit pushed after the PR was opened — the
      // review then reads a green tick that belongs to an older tree. An
      // absent key is only pinned by asserting the key set, so assert it.
      expect(Object.keys(trigger).sort()).toEqual([...expectedKeys].sort());
      if ("types" in trigger) {
        // If a future change genuinely needs `types`, it must still cover the
        // three events the default covers.
        expect([...(trigger.types as string[])].sort()).toEqual(["opened", "reopened", "synchronize"]);
      }
    }

    // The push trigger stays pinned to the release-relevant lines: release.yml
    // gates on main and preview, so widening this one would pull an unrelated
    // branch into that path.
    const ci = Bun.YAML.parse(await readText(".github/workflows/ci.yml")) as {
      on?: {
        push?: { branches?: string[]; paths?: string[] };
        pull_request?: { branches?: string[]; paths?: string[] };
      };
      jobs?: Record<string, Record<string, unknown> | undefined>;
    };
    expect([...(ci.on?.push?.branches ?? [])].sort())
      .toEqual(["dev", "main", "preview"]);

    // The PR trigger must carry NO base-branch filter, and the two triggers
    // differ on purpose. GitHub matches `branches:` against the BASE ref, so
    // `[main, dev]` silently excluded stacked child PRs — whose base is another
    // open PR's head branch. The #951-#955 stack merged with `enforce-target`,
    // `label`, and `react-doctor` as its only check-runs and no test job at
    // all, for 24 changed files under `src/`; the type annotation above did not
    // even model `branches` on this trigger, so no assertion could have caught
    // it.
    //
    // Re-adding an allowlist is the regression this pins, and it cannot be
    // written correctly: stacked bases carry contributor prefixes (`fix/`,
    // `feat/`, `agent/`) as readily as `codex/`, so any list leaves some stack
    // silently unverified. Pull requests also carry no workflow-level path
    // filter: every head needs an aggregate `ci` check.
    expect(ci.on?.pull_request?.branches).toBeUndefined();
    expect(ci.on?.pull_request?.paths).toBeUndefined();

    // The push trigger and pull-request `changes` job share one expensive-CI
    // allowlist. PRs always create the workflow and aggregate check; this list
    // decides whether the costly jobs run. Pin the entire list on both paths.
    const ciPaths = [
      ".dockerignore",
      ".gitattributes",
      ".github/workflows/ci.yml",
      ".github/workflows/enforce-pr-target.yml",
      ".github/workflows/release.yml",
      ".github/workflows/stale-needs-info.yml",
      ".npmignore",
      "Dockerfile",
      "LICENSE",
      "README.md",
      "assets/**",
      "bin/**",
      "bun.lock",
      "compose.yaml",
      "docker/**",
      "gui/**",
      "package.json",
      "scripts/**",
      "src/**",
      "tests/**",
      "tsconfig.json",
    ];
    expect([...(ci.on?.push?.paths ?? [])].sort()).toEqual(ciPaths);

    const filterStep = (ci.jobs?.changes as {
      steps?: { with?: Record<string, string> }[];
    })?.steps?.find(step => step.with?.filters);
    const areaFilters = Bun.YAML.parse(String(filterStep?.with?.filters ?? "")) as {
      ci?: string[];
    };
    expect([...(areaFilters.ci ?? [])].sort()).toEqual(ciPaths);

    const changesJob = ci.jobs?.changes as {
      outputs?: Record<string, string>;
      steps?: Array<{
        name?: string;
        id?: string;
        shell?: string;
        env?: Record<string, string>;
        run?: string;
        with?: Record<string, string>;
      }>;
    } | undefined;
    const scopeStep = changesJob?.steps?.find(
      step => step.name === "Assert the scope output is usable",
    );
    expect(changesJob?.outputs?.ci).toBe("${{ steps.scope.outputs.ci }}");
    expect(scopeStep?.id).toBe("scope");
    expect(scopeStep?.shell).toBe("bash");
    expect(scopeStep?.env?.CI_SCOPE).toBe("${{ steps.filter.outputs.ci }}");
    expect(scopeStep?.run).not.toContain("${{");
    expect(scopeStep?.run).toContain('case "$CI_SCOPE" in');
    expect(scopeStep?.run).toContain("true|false)");
    expect(scopeStep?.run).toContain(`printf 'ci=%s\\n' "$CI_SCOPE" >> "$GITHUB_OUTPUT"`);
    expect(scopeStep?.run).toContain("exit 1");
    const filterIndex = changesJob?.steps?.findIndex(step => step.id === "filter") ?? -1;
    const scopeIndex = changesJob?.steps?.findIndex(step => step.id === "scope") ?? -1;
    expect(filterIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeGreaterThan(filterIndex);

    const scopedCondition = "github.event_name != 'pull_request' || needs.changes.outputs.ci == 'true'";
    for (const jobName of ["test", "storage-policy", "gates", "platform-macos", "keyring-smoke", "docker-smoke"]) {
      const job = ci.jobs?.[jobName] as { needs?: string; if?: string } | undefined;
      expect(`${jobName}:${job?.needs}`).toBe(`${jobName}:changes`);
      expect(`${jobName}:${job?.if}`).toBe(`${jobName}:${scopedCondition}`);
    }
    const macosControlIf = ci.jobs?.["macos-control"] as { needs?: string; if?: string } | undefined;
    expect(macosControlIf?.needs).toBe("changes");
    expect(macosControlIf?.if).toBe("github.event_name == 'workflow_dispatch' && (github.event.inputs.lane == '' || github.event.inputs.lane == 'all' || github.event.inputs.lane == 'macos-control')");
  });

}
