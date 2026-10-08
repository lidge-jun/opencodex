import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoPath } from "../helpers/repo-root";

// Review-lane contracts for ci.yml and enforce-pr-target.yml. They live beside
// ci-workflows.test.ts because that file sits at its file-size cap.
async function readText(path: string): Promise<string> {
  return readFileSync(repoPath(...path.split("/")), "utf8");
}

describe("CI review lanes", () => {
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

    // The push trigger stays pinned to the release-relevant lines: main and
    // preview MUST stay because release.yml requires a successful push-event
    // run for the exact release SHA and states that a pull-request run does
    // not qualify. dev is deliberately absent: its integration evidence is
    // the pull_request run, with workflow_dispatch for anything else.
    const ci = Bun.YAML.parse(await readText(".github/workflows/ci.yml")) as {
      on?: {
        push?: { branches?: string[]; paths?: string[] };
        pull_request?: { branches?: string[]; paths?: string[] };
      };
      jobs?: Record<string, Record<string, unknown> | undefined>;
    };
    expect([...(ci.on?.push?.branches ?? [])].sort())
      .toEqual(["main", "preview"]);

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
    // decides whether the costly jobs run. Pin the entire list on both paths,
    // including every script and workflow used by repository automation.
    const ciPaths = [
      ".dockerignore",
      ".gitattributes",
      ".github/ISSUE_TEMPLATE/**",
      ".github/scripts/**",
      ".github/workflows/**",
      ".npmignore",
      "Dockerfile",
      "LICENSE",
      "README.md",
      "app/**",
      "assets/**",
      "bin/**",
      "bun.lock",
      "compose.yaml",
      "desktop/**",
      "docker/**",
      "gui/**",
      "package.json",
      "readme/**",
      "scripts/**",
      "skills/**",
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
    expect(scopeStep?.env?.CI_SCOPE).toBe("${{ github.event_name == 'schedule' && 'true' || steps.filter.outputs.ci }}");
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
    // platform-macos is native-gated and pinned to the native condition above,
    // so it must not be read against this ci-only condition.
    for (const jobName of ["test", "storage-policy", "gates", "keyring-smoke", "docker-smoke"]) {
      const job = ci.jobs?.[jobName] as { needs?: string; if?: string } | undefined;
      expect(`${jobName}:${job?.needs}`).toBe(`${jobName}:changes`);
      expect(`${jobName}:${job?.if}`).toBe(`${jobName}:${scopedCondition}`);
    }
    const macosControlIf = ci.jobs?.["macos-control"] as { needs?: string; if?: string } | undefined;
    expect(macosControlIf?.needs).toBe("changes");
    expect(macosControlIf?.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' && (github.event.inputs.lane == '' || github.event.inputs.lane == 'all' || github.event.inputs.lane == 'macos-control')");
  });

  test("manual release-gates keeps ordinary jobs and skips only diagnostic suites", async () => {
    const ci = Bun.YAML.parse(await readText(".github/workflows/ci.yml")) as {
      jobs: Record<string, { if?: string; needs?: string | string[] }>;
    };
    // These job conditions use boolean operators and lowercase string comparisons.
    // Evaluate the checked-in expressions, rather than a second implementation of them.
    const enabled = (job: string, event: string, lane: string, scope = "true", packaging = "true", native = "true", windows = "false") => {
      const condition = ci.jobs[job]!.if ?? "true";
      const evaluate = new Function("github", "needs", `return (${condition});`);
      return evaluate(
        { event_name: event, event: { inputs: { lane } } },
        { changes: { outputs: { ci: scope, packaging, native, windows } } },
      );
    };
    for (const [event, lane, windows, control] of [
      ["push", "", false, false],
      ["pull_request", "", false, false],
      ["push", "release-gates", false, false],
      ["pull_request", "release-gates", false, false],
      ["workflow_dispatch", "", true, true],
      ["workflow_dispatch", "all", true, true],
      ["workflow_dispatch", "macos-control", false, true],
      ["workflow_dispatch", "release-gates", false, false],
      // Diagnostic-only lanes stay off ordinary release-gates; unknown lanes
      // must not opt into a diagnostic suite when more choices are introduced.
      ["workflow_dispatch", "future-lane", false, false],
    ] as const) {
      expect(enabled("select-windows-runner", event, lane)).toBe(true);
      expect(enabled("platform-windows", event, lane)).toBe(windows);
      expect(enabled("macos-control", event, lane)).toBe(control);
      for (const job of ["test", "gates", "storage-policy", "api-usage", "keyring-smoke", "docker-smoke"]) {
        expect(enabled(job, event, lane)).toBe(true);
        expect(enabled(job, event, lane, "false")).toBe(event !== "pull_request");
      }
      for (const job of ["platform-macos", "widget", "desktop-shell"]) {
        for (const scope of ["true", "false"]) {
          for (const native of ["true", "false"]) {
            expect(enabled(job, event, lane, scope, "true", native))
              .toBe(event !== "pull_request" || (scope === "true" && native === "true"));
          }
        }
      }
      expect(enabled("npm-global-smoke", event, lane, "true", "true")).toBe(true);
      expect(enabled("npm-global-smoke", event, lane, "true", "false")).toBe(false);
    }
    for (const windows of ["true", "false", ""]) {
      expect(enabled("platform-windows", "pull_request", "", "true", "true", "true", windows)).toBe(windows === "true");
    }
    expect(enabled("platform-windows", "schedule", "", "false", "false", "false")).toBe(true);
    expect(enabled("macos-control", "schedule", "", "false", "false", "false")).toBe(true);
    expect(ci.jobs["select-windows-runner"]!.if).toBeUndefined();
    expect(ci.jobs["platform-windows"]!.needs).toEqual(["changes", "select-windows-runner"]);
    expect(ci.jobs.ci!.if).toBe("always()");
    expect(ci.jobs.ci!.needs).toEqual(expect.arrayContaining([
      "changes", "select-windows-runner",
      "test", "platform-macos", "gates", "storage-policy", "api-usage",
      "keyring-smoke", "docker-smoke", "npm-global-smoke", "platform-windows", "macos-control",
    ]));
  });

  // The aggregate step runs under bash with jq, as ci-scope-reduction.test.ts guards.
  test.skipIf(process.platform === "win32" || !Bun.which("jq"))("release-gates aggregate accepts diagnostic skips but rejects producer failures", async () => {
    const ci = Bun.YAML.parse(await readText(".github/workflows/ci.yml")) as {
      jobs: Record<string, {
        needs?: string[];
        steps?: { name?: string; shell?: string; env?: Record<string, string>; run?: string }[];
      }>;
    };
    const aggregate = ci.jobs.ci!;
    const step = aggregate.steps?.find(step => step.name === "Assert every job this event requested succeeded");
    expect(step?.shell).toBe("bash");
    expect(step?.env?.RESULTS).toBe("${{ toJSON(needs) }}");
    expect(step?.run).toBeDefined();
    expect(step?.run).not.toContain("${{");
    const results: Record<string, { result: string }> = Object.fromEntries(
      (aggregate.needs ?? []).map(job => [job, { result: "success" }]),
    );
    results["platform-windows"] = { result: "skipped" };
    results["macos-control"] = { result: "skipped" };
    results["docs-site-build"] = { result: "skipped" };
    results["structure-gate"] = { result: "skipped" };
    results["privacy-gate"] = { result: "skipped" };
    results["setup-action"] = { result: "skipped" };
    results["remote-helper"] = { result: "skipped" };
    const run = (value: typeof results, packaging = "true") => spawnSync("bash", ["-c", step!.run!], {
      encoding: "utf8",
      env: {
        ...process.env, RESULTS: JSON.stringify(value),
        EVENT_NAME: "workflow_dispatch", LANE: "release-gates",
        CHANGES_CI: "true", CHANGES_NATIVE: "true", CHANGES_PACKAGING: packaging,
        CHANGES_DOCS: "false", CHANGES_STRUCTURE: "false",
        CHANGES_SETUP_ACTION: "false", CHANGES_REMOTE_HELPER: "false",
      },
      timeout: 5_000,
    });
    for (const packaging of ["success", "skipped"]) {
      const result = run({ ...results, "npm-global-smoke": { result: packaging } }, packaging === "success" ? "true" : "false");
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }
    // Execute the checked-in Bash/jq gate, not a duplicate JS allowlist. The
    // selector must remain visible even though its Windows consumer is skipped.
    for (const producer of Object.keys(results)) {
      for (const status of ["failure", "cancelled"]) {
        const result = run({ ...results, [producer]: { result: status } });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(producer);
        expect(result.stdout).toContain(status);
      }
    }
    // A requested producer cannot disappear behind the intentional diagnostic skips.
    for (const producer of Object.keys(results).filter(job => results[job]!.result === "success")) {
      const result = run({ ...results, [producer]: { result: "skipped" } });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(producer);
    }
    for (const status of ["timed_out", "unexpected-status"]) {
      const result = run({ ...results, "select-windows-runner": { result: status } });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("select-windows-runner");
      expect(result.stdout).toContain(status);
    }
  }, 30_000);
});

describe("Windows and nightly CI contracts", () => {
  test("publishes validated Windows selection and one nightly checkout ref", async () => {
    const ci = Bun.YAML.parse(await readText(".github/workflows/ci.yml")) as {
      on: { schedule: { cron: string }[] };
      jobs: Record<string, { outputs?: Record<string, string>; steps?: Array<{
        id?: string; uses?: string; shell?: string; run?: string;
        env?: Record<string, string>; with?: Record<string, unknown>;
      }> }>;
    };
    expect(ci.on.schedule).toEqual([{ cron: "17 18 * * *" }]);
    const changes = ci.jobs.changes!;
    expect(changes.outputs?.windows).toBe("${{ steps.windows.outputs.windows }}");
    expect(changes.outputs?.checkout_ref).toBe("${{ steps.nightly.outputs.checkout_ref }}");
    const checkout = changes.steps?.find(step => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(2);
    const filter = changes.steps?.find(step => step.id === "filter");
    const filters = Bun.YAML.parse(String(filter?.with?.filters ?? "")) as Record<string, string[]>;
    expect(filters.windows).toEqual([
      "src/lib/windows-*", "src/lib/*acl*", "src/service/**", "src/update/**",
      "src/claude/intercept/**", "src/codex/shim*", "src/codex/app-server-processes.ts",
      "src/codex/desktop-app/**", "src/config/process-state.ts", "src/cli/update-restart*",
      "src/server/local-management-read-client.ts", "src/server/startup-health-cache.ts",
      "src/tray/**", "scripts/test.ts", "scripts/test-*.ts", "scripts/ci/**",
      "tests/preload.ts", "tests/helpers/**", ".github/workflows/ci.yml", "package.json", "bun.lock",
    ]);
    const windows = changes.steps?.find(step => step.id === "windows");
    expect(windows?.shell).toBe("bash");
    expect(windows?.env).toEqual({ EVENT_NAME: "${{ github.event_name }}", PATH_SELECTED: "${{ steps.filter.outputs.windows }}" });
    expect(windows?.run).toBe("bash scripts/ci/windows-sensitive-diff.sh");
    expect(windows?.run).not.toContain("${{");
    let checkouts = 0;
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (name === "changes") continue;
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        expect(step.with?.ref, `${name} checkout`).toBe("${{ needs.changes.outputs.checkout_ref }}");
        checkouts += 1;
      }
    }
    expect(checkouts).toBe(17);
  });

  test.skipIf(process.platform === "win32" || !Bun.which("jq"))("aggregate requests Windows only for selected PRs and requests both diagnostic jobs nightly", async () => {
    const ci = Bun.YAML.parse(await readText(".github/workflows/ci.yml")) as {
      jobs: Record<string, { needs?: string[]; steps?: Array<{ name?: string; shell?: string; env?: Record<string, string>; run?: string }> }>;
    };
    const aggregate = ci.jobs.ci!;
    const step = aggregate.steps?.find(candidate => candidate.name === "Assert every job this event requested succeeded");
    expect(step?.shell).toBe("bash");
    expect(step?.env?.CHANGES_WINDOWS).toBe("${{ needs.changes.outputs.windows }}");
    // Execute only the expectation block (as ci-scope-reduction.test.ts does): the
    // leg count after it calls the Actions API, which a test must not reach.
    const script = step!.run!;
    const start = script.indexOf("scoped=requested");
    const first = script.indexOf("RESULTS_EOF");
    const last = script.indexOf("RESULTS_EOF", first + "RESULTS_EOF".length);
    expect(start).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    const slice = script.slice(start, last + "RESULTS_EOF".length);
    for (const [event, lane, windows, expectWindows, expectControl] of [
      ["schedule", "", undefined, "requested", "requested"],
      ["pull_request", "", "true", "requested", "not-requested"],
      ["pull_request", "", "false", "not-requested", "not-requested"],
      ["pull_request", "", undefined, "not-requested", "not-requested"],
      ["push", "", "true", "not-requested", "not-requested"],
      ["workflow_dispatch", "all", "false", "requested", "requested"],
      ["workflow_dispatch", "release-gates", "true", "not-requested", "not-requested"],
    ] as const) {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin", EVENT_NAME: event, LANE: lane, RESULTS: "{}",
        CHANGES_CI: "true", CHANGES_NATIVE: "true", CHANGES_PACKAGING: "true",
        CHANGES_DESKTOP: "false", CHANGES_DOCS: "false", CHANGES_STRUCTURE: "false",
        CHANGES_SETUP_ACTION: "false", CHANGES_REMOTE_HELPER: "false",
        ...(windows === undefined ? {} : { CHANGES_WINDOWS: windows }),
      };
      const result = spawnSync("bash", ["-c", `set -u\n${slice}\necho "WIN=$(expected_for platform-windows)"\necho "CTL=$(expected_for macos-control)"`], {
        encoding: "utf8", timeout: 5_000, env,
      });
      expect(result.error).toBeUndefined();
      expect(`${event}/${lane}/${windows}:${result.stdout.match(/^WIN=(.*)$/m)?.[1]}`).toBe(`${event}/${lane}/${windows}:${expectWindows}`);
      expect(`${event}/${lane}/${windows}:${result.stdout.match(/^CTL=(.*)$/m)?.[1]}`).toBe(`${event}/${lane}/${windows}:${expectControl}`);
    }
  });

  test.skipIf(process.platform === "win32" || !Bun.which("git"))("Windows diff scan considers only added src/tests markers and fails closed without a parent", () => {
    const scenarios = [
      { path: "src/example.ts", before: "plain\n", after: "WIN32\n", expected: "true" },
      { path: "tests/example.ts", before: "plain\n", after: "ordinary\n", expected: "false" },
      { path: "src/example.ts", before: "powershell\nplain\n", after: "plain\n", expected: "false" },
      { path: "docs/example.md", before: "plain\n", after: "pwsh\n", expected: "false" },
      { path: "src/example.ts", before: "plain\n", after: "plain\n", selected: "true", expected: "true" },
      { path: "src/example.ts", before: "plain\n", after: "plain\n", selected: "invalid", status: 1 },
      { path: "src/example.ts", before: "plain\n", after: "win32\n", event: "push", expected: "false" },
      { path: "src/example.ts", before: "plain\n", after: "plain\n", event: "schedule", selected: "true", expected: "true" },
      { path: "src/example.ts", before: "plain\n", orphan: true, expected: "true" },
    ];
    for (const scenario of scenarios) {
      const directory = mkdtempSync(join(tmpdir(), "ocx-windows-diff-"));
      try {
        const git = (...args: string[]) => {
          const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", timeout: 5_000,
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
        };
        git("init", "--quiet");
        const path = join(directory, scenario.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, scenario.before);
        const commit = () => {
          git("add", ".");
          git("-c", "user.name=CI Fixture", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "-m", "fixture");
        };
        commit();
        if (!scenario.orphan) { writeFileSync(path, scenario.after ?? scenario.before); commit(); }
        const output = join(directory, "output");
        const result = spawnSync("bash", [repoPath("scripts", "ci", "windows-sensitive-diff.sh")], {
          cwd: directory, encoding: "utf8", timeout: 5_000,
          env: { ...process.env, EVENT_NAME: scenario.event ?? "pull_request", PATH_SELECTED: scenario.selected ?? "false", GITHUB_OUTPUT: output },
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(scenario.status ?? 0);
        if (scenario.expected) expect(readFileSync(output, "utf8")).toBe(`windows=${scenario.expected}\n`);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }, 30_000);

  test("startup ACL reads avoid module-autoloaded Get-Acl and Set-Acl across src", () => {
    const violations: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(repoPath(...directory.split("/")), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) { walk(path); continue; }
        if (!entry.isFile() || !/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) continue;
        readFileSync(repoPath(...path.split("/")), "utf8").split("\n").forEach((line, index) => {
          if (/^(\/\/|\*|\/\*)/.test(line.trimStart())) return;
          if (/\b(Get|Set)-Acl\b/i.test(line)) violations.push(`${path}:${index + 1}`);
        });
      }
    };
    walk("src");
    expect(violations, `${violations.join("\n")}\nRead ACLs through .NET as in src/lib/windows-owner-acl.ts; module autoload rebuilds the analysis cache for 20-27 s on a fresh profile.`).toEqual([]);
  });
});
