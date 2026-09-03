import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  SCRIPT_BINDINGS,
  callsTo,
  methodsOf,
  runEnforcePrTarget,
  type HarnessResult,
} from "./helpers/enforce-pr-target-harness";

/** Final consolidated gate comment body (the single bot message). */
function lastGateCommentBody(result: HarnessResult): string {
  const marker = "<!-- opencodex-pr-gate -->";
  const updates = (callsTo(result, "issues.updateComment") as Array<{ body: string }>)
    .filter(call => call.body.includes(marker));
  if (updates.length > 0) return updates[updates.length - 1]!.body;
  const creates = callsTo(result, "issues.createComment") as Array<{ body: string }>;
  const gateCreates = creates.filter(call => call.body.includes(marker));
  if (gateCreates.length === 0) {
    throw new Error("scenario recorded no gate comment");
  }
  return gateCreates[gateCreates.length - 1]!.body;
}

/** The single consolidated comment body; alias kept for scenario readability. */
const lastReadinessCommentBody = lastGateCommentBody;
/** Alias kept for scenarios that named the pre-consolidation enforcer comment. */
const lastEnforcerCommentBody = lastGateCommentBody;

const root = new URL("../", import.meta.url);
const doctorGuiIfChangedScript = fileURLToPath(new URL("../scripts/doctor-gui-if-changed.ts", import.meta.url));
const lintGuiIfChangedScript = fileURLToPath(new URL("../scripts/lint-gui-if-changed.ts", import.meta.url));

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function count(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

/** Match an executable shell line, not a fragment that could appear in echo or a comment. */
function hasExactShellCommand(run: string | undefined, expected: string): boolean {
  return (run ?? "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .includes(expected);
}

/**
 * Same intent as {@link hasExactShellCommand}, but for a command that is the HEAD of a
 * pipeline. The retry loops capture the suite with `… 2>&1 | tee "$suite_log"`, so an exact
 * whole-line match would reject the very shape the retry requires. Anchoring at the start of
 * the line still rejects an `echo` of the command or a commented-out copy, which is what the
 * exact match was protecting against.
 */
function hasShellCommandHead(run: string | undefined, expected: string): boolean {
  return (run ?? "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .some(line => line === expected || line.startsWith(`${expected} `));
}

function expectSecureLinuxKeyringBootstrap(workflow: string): void {
  const smokeStep = workflow
    .split("- name: OS keyring create/read/delete smoke")[1]
    ?.split(/\n(?: {6}- name:| {2}[A-Za-z0-9_-]+:)/)[0];

  expect(smokeStep).toBeDefined();
  expect(smokeStep).toContain('keyring_home="$(mktemp -d)"');
  expect(smokeStep).toContain('runtime_dir="$(mktemp -d)"');
  expect(smokeStep).toContain('cleanup() { rm -rf -- "$keyring_home" "$runtime_dir"; }');
  expect(smokeStep).toContain("trap cleanup EXIT");
  expect(smokeStep).toContain('chmod 700 "$keyring_home" "$runtime_dir"');
  expect(smokeStep).toContain(
    'HOME="$keyring_home" XDG_RUNTIME_DIR="$runtime_dir" dbus-run-session',
  );
  expect(smokeStep).toMatch(
    /od -An -N32 -tx1 \/dev\/urandom \|\s+tr -d "\[:space:\]" \|\s+gnome-keyring-daemon --unlock --components=secrets >\/dev\/null/,
  );
  expect(smokeStep).not.toContain("eval ");
  expect(smokeStep).not.toContain("gnome-keyring-daemon --start");
}

describe("GitHub Actions hardening", () => {
  test("cross-platform CI keeps bounded jobs and immutable action references", async () => {
    const workflow = await readText(".github/workflows/ci.yml");
    const ci = Bun.YAML.parse(workflow) as {
      permissions?: Record<string, string>;
      jobs?: Record<string, { "timeout-minutes"?: number } | undefined>;
    };

    // Job-scoped: a global count still passes if values are swapped between jobs.
    // Pin ownership explicitly. The Windows leg is sharded like the Linux ones
    // since 8034cd7c0 — a single leg reached 30m on a green suite and was killed
    // in cleanup, so each shard now holds the same 15m a Linux shard holds. A
    // shard that needs longer is wedged, not slow.
    expect(ci.jobs?.["select-windows-runner"]?.["timeout-minutes"]).toBe(2);
    expect(ci.jobs?.test?.["timeout-minutes"]).toBe(15);
    expect(ci.jobs?.gates?.["timeout-minutes"]).toBe(15);
    expect(ci.jobs?.["platform-macos"]?.["timeout-minutes"]).toBe(30);
    // Higher than the Linux shards on purpose: at 15 the Windows leg cancelled a
    // shard mid-suite, which reports as neither pass nor fail (#2152).
    expect(ci.jobs?.["platform-windows"]?.["timeout-minutes"]).toBe(25);
    expect(ci.jobs?.["keyring-smoke"]?.["timeout-minutes"]).toBe(8);
    expect(ci.jobs?.["npm-global-smoke"]?.["timeout-minutes"]).toBe(8);
    expect(ci.jobs?.ci?.["timeout-minutes"]).toBe(5);
    expect(ci.permissions).toEqual({ contents: "read" });

    const keyringJob = ci.jobs?.["keyring-smoke"] as {
      "runs-on"?: string;
      strategy?: {
        matrix?: {
          include?: Array<{ name: string; runner: string }>;
        };
      };
    } | undefined;
    expect(keyringJob?.["runs-on"]).toBe("${{ matrix.runner }}");
    expect(keyringJob?.strategy?.matrix?.include).toEqual([
      { name: "ubuntu", runner: "ubuntu-latest" },
      { name: "windows", runner: "windows-latest" },
      { name: "macos", runner: "macos-latest" },
    ]);
    expectSecureLinuxKeyringBootstrap(workflow);
    // Every job must stay bounded — an unbounded job can hang a queue for hours.
    // Asserted structurally rather than by counting the string: a count passes if
    // a job is added while another loses its bound in the same edit. Iterating the
    // parsed jobs proves what the sentence above always claimed, and names the
    // offending job when it fails.
    for (const [name, job] of Object.entries(ci.jobs ?? {})) {
      expect(`${name}:${typeof job?.["timeout-minutes"]}`).toBe(`${name}:number`);
    }
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    // Bun setup moved into .github/actions/setup-project-bun so the runtime
    // version has a single source (package.json). The SHA pin still has to
    // exist — it just lives in the composite action now, and this workflow
    // must reference that local action rather than a third-party one.
    expect(workflow).toContain("./.github/actions/setup-project-bun");
    expect(await readText(".github/actions/setup-project-bun/action.yml"))
      .toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(workflow).toContain("bun test --isolate tests");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);

    // Sharding is only safe while the shards tile the suite exactly. If the
    // matrix and the divisor drift apart, some files stop running and CI stays
    // green — the worst failure available here. Pin them to each other.
    const linuxShards = (ci.jobs?.test as { strategy?: { matrix?: { shard?: number[] } } })
      ?.strategy?.matrix?.shard ?? [];
    expect(linuxShards).toEqual([1, 2, 3, 4]);
    expect(workflow).toContain(`--shard=\${{ matrix.shard }}/${linuxShards.length}`);

    // Every job that runs tests/ must fetch tags, because one of those tests reads
    // them. tests/release-version-line.test.ts compares package.json against the
    // newest release tag, and actions/checkout brings no tags by default: git is
    // present, `git tag --list` exits 0, and stdout is empty. The check then has an
    // empty set, cannot fail, and a version regression rides through green. That is
    // how the first cut of that test shipped, so pin the flag rather than trusting a
    // comment. Asserted per job so a future edit cannot drop it from one leg while
    // the other still carries it.
    for (const jobName of ["test", "platform-macos", "platform-windows"]) {
      const steps = (ci.jobs?.[jobName] as { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> })?.steps ?? [];
      const checkout = steps.find(step => typeof step.uses === "string" && step.uses.includes("actions/checkout"));
      expect(`${jobName}:${String(checkout?.with?.["fetch-tags"])}`).toBe(`${jobName}:true`);
    }

    // Windows uses the same shard matrix after the single-leg isolate budget was
    // replaced. Keep the two matrices equal so a future edit cannot reintroduce
    // a partial Windows suite while Linux stays fully tiled.
    const windowsShards = (ci.jobs?.["platform-windows"] as {
      strategy?: { matrix?: { shard?: number[] } };
    })?.strategy?.matrix?.shard ?? [];
    expect(windowsShards).toEqual(linuxShards);

    // The aggregate gate is the check a human trusts. Three ways to break it
    // silently: drop `if: always()` so it skips (and a skipped job reports
    // success), shrink `needs:` so it stops covering a job, or add a job and
    // forget to gate it. Deriving the expected list from the workflow's own job
    // keys closes all three — a hardcoded list rots on the next job added.
    const gate = ci.jobs?.ci as { if?: unknown; needs?: string[] } | undefined;
    expect(gate?.if).toBe("always()");
    const ungated = new Set(["ci"]);
    expect([...(gate?.needs ?? [])].sort())
      .toEqual(Object.keys(ci.jobs ?? {}).filter(name => !ungated.has(name)).sort());

    // The focused doctor contract config is ADDITIVE evidence. It must never
    // replace the repository-wide strict typecheck: doing so made the aggregate
    // CI check green while most of src/ was no longer typechecked by Actions.
    const gatesSteps = (ci.jobs?.gates as { steps?: { name?: string; run?: string }[] })?.steps ?? [];
    const gatesTypecheck = gatesSteps.find(step => step.name === "Typecheck")?.run ?? "";
    const rootTypecheck = "bun x tsc --noEmit";
    const doctorContractTypecheck =
      "bun x tsc --noEmit -p tests/tsconfig.doctor-service-memory-contract.json";
    expect(hasExactShellCommand(gatesTypecheck, rootTypecheck)).toBe(true);
    expect(hasExactShellCommand(gatesTypecheck, doctorContractTypecheck)).toBe(true);
    expect(gatesTypecheck.indexOf(rootTypecheck)).toBeLessThan(
      gatesTypecheck.indexOf(doctorContractTypecheck),
    );

    // GUI tests mutate process globals (fetch, DOM, timers and React work).
    // Hosted runners exposed order-dependent cross-file leaks when the 138
    // files shared one realm. Pin isolation to the GATES job specifically — a
    // broad workflow search would pass because macOS already uses --isolate.
    const gatesGuiRun = gatesSteps.find(step => step.name === "GUI tests")?.run ?? "";
    expect(hasExactShellCommand(gatesGuiRun, "cd gui && bun test --isolate tests")).toBe(true);
    expect(hasExactShellCommand(gatesGuiRun, "cd gui && bun test tests")).toBe(false);

    // macOS is the unsharded control for every CI-relevant change. It may skip
    // only when the shared path filter says the entire expensive suite is out of
    // scope (for example a docs-site-only PR).
    const macosSteps = (ci.jobs?.["platform-macos"] as { steps?: { run?: string }[] })?.steps ?? [];
    // The 60s per-test ceiling is part of the pinned shape: dropping it silently
    // restores the timing-flake class this lane kept surfacing.
    expect(macosSteps.some(step => step.run?.includes("bun test --isolate --timeout 60000 tests"))).toBe(true);
    expect(macosSteps.some(step => step.run?.includes("--shard"))).toBe(false);

    // The macOS leg retries ONLY a Bun runtime crash, and only once. Bun 1.3.14
    // segfaults reclaiming a Worker at an `--isolate` file boundary with
    // balanced worker counts, which is a runtime defect rather than a test
    // result; the Linux shards already absorb that class in
    // `scripts/ci/run-bun-test-batches.sh`. Two ways to break this silently:
    // drop the crash-signature guard so an assertion failure gets retried into
    // green, or let the retry loop swallow a repeated crash. Pin both.
    const macosTestRun = macosSteps.find(step => step.run?.includes("bun test --isolate --timeout 60000 tests"))?.run ?? "";
    // Actions invokes multiline `run:` blocks with `bash -e`. The retry loop
    // must disable errexit before the crash-prone command or exit 133 aborts
    // the step before PIPESTATUS can be inspected and the retry can run.
    expect(hasExactShellCommand(macosTestRun, "set +e")).toBe(true);
    expect(macosTestRun).toContain("Segmentation fault at address");
    expect(macosTestRun).toContain("oh no: Bun has crashed");
    expect(macosTestRun).toContain("assertion failures are not retried");
    expect(macosTestRun).toContain("failing after one retry");
    // `for attempt in 1 2` — one retry, never an unbounded loop.
    expect(macosTestRun).toContain("for attempt in 1 2");
    expect(macosTestRun).not.toContain("while true");
    expect((ci.jobs?.["platform-macos"] as { needs?: string; if?: string })?.needs).toBe("changes");
    expect((ci.jobs?.["platform-macos"] as { if?: string })?.if)
      .toBe("github.event_name != 'pull_request' || needs.changes.outputs.ci == 'true'");

    // Windows is dispatch-only: it gates nothing, not even the shipping
    // boundary. The sharded promotion run surfaced ~207 Windows-only failures
    // that pre-date every released version, so the leg became a measurement
    // tool a maintainer runs by hand, not a gate. Assert the positive
    // condition and the absence of every automatic trigger — a stray
    // `|| github.ref == ...` would restore a red leg to the release path.
    const windowsIf = String((ci.jobs?.["platform-windows"] as { if?: string })?.if ?? "");
    expect(windowsIf).toContain("github.event_name == 'workflow_dispatch'");
    expect(windowsIf).not.toContain("refs/heads/main");
    expect(windowsIf).not.toContain("refs/heads/preview");
    expect(windowsIf).not.toContain("refs/heads/dev");
    expect(windowsIf).not.toContain("pull_request");

    // Windows runs the same suite, sharded like the Linux legs, and keeps the
    // self-hosted workspace wipe. Without the wipe a deleted file survives on
    // the runner's disk and the suite passes against a tree that no longer
    // exists in git.
    const winSteps = (ci.jobs?.["platform-windows"] as { steps?: { if?: string; run?: string }[] })?.steps ?? [];
    // --timeout is part of the contract, not incidental: this leg ran on Bun's 5s default
    // while Linux and macOS both pass 60000, and it is the slowest hardware on the board.
    // Three composed-acceptance failures were that default firing on tests still working
    // at 41s. Pin the flag so the leg cannot silently drift back to the default.
    const windowsTestCommand = `bun test --isolate --timeout 60000 tests --shard=\${{ matrix.shard }}/${windowsShards.length}`;
    expect(hasShellCommandHead(`echo ${windowsTestCommand}`, windowsTestCommand)).toBe(false);
    // Binding the assertion to an executable line is only half the guarantee: a
    // step carrying the exact command still runs nothing under `if: false`, and
    // the suite would stay green against a Windows leg that never tests. Require
    // the matching step to be unconditional.
    const windowsTestSteps = winSteps.filter(step => hasShellCommandHead(step.run, windowsTestCommand));
    expect(windowsTestSteps.length).toBeGreaterThan(0);
    expect(windowsTestSteps.every(step => step.if === undefined)).toBe(true);
    expect(winSteps.some(step => step.if === "runner.environment == 'self-hosted'"
      && step.run?.includes("git clean -xffd"))).toBe(true);

    // The three crash-signature lists must stay identical, and they must not key on
    // `panic(thread`.
    //
    // Bun emits BOTH `panic(thread 2852)` and `panic(main thread)` for the same class of
    // failure, so a grep anchored on the numbered form silently misses half of them and the
    // shard fails on a crash it was supposed to retry. This repository already learned that
    // once — `devlog/_fin/260731_pr_issue_triage_round/050_windows_ci_flake_rca.md` names
    // `Internal assertion failure` as the stable fingerprint — and #2152 reintroduced it.
    // Three copies of one list is the real hazard, so pin the sync rather than the text.
    const crashSignatures = [
      "oh no: Bun has crashed",
      "Internal assertion failure",
      "Segmentation fault at address",
      "Illegal instruction",
      "Bus error",
    ];
    const windowsTestRun = windowsTestSteps[0]?.run ?? "";
    const batchScript = await readText("scripts/ci/run-bun-test-batches.sh");
    for (const signature of crashSignatures) {
      expect(`macos:${signature}:${macosTestRun.includes(signature)}`).toBe(`macos:${signature}:true`);
      expect(`windows:${signature}:${windowsTestRun.includes(signature)}`).toBe(`windows:${signature}:true`);
      expect(`script:${signature}:${batchScript.includes(signature)}`).toBe(`script:${signature}:true`);
    }
    // The thread-numbered form must not be the anchor anywhere.
    expect(macosTestRun).not.toContain("panic\\(thread");
    expect(windowsTestRun).not.toContain("panic\\(thread");
    expect(batchScript).not.toContain("panic\\(thread");

    // Windows carries the same bounded retry as macOS: one attempt, crash-only.
    expect(hasExactShellCommand(windowsTestRun, "set +e")).toBe(true);
    expect(windowsTestRun).toContain("for attempt in 1 2");
    expect(windowsTestRun).not.toContain("while true");
    expect(windowsTestRun).toContain("assertion failures are not retried");
    expect(windowsTestRun).toContain("failing after one retry");

    // Every job that runs the root suite must build the GUI first, unconditionally.
    // Tests that fetch the served dashboard read their session bootstrap out of
    // `gui/dist/index.html`; with no build the server has no index to serve and the
    // assertions read an empty string. The old three-platform job satisfied this by
    // accident, because the same job also ran the GUI build — splitting the suite
    // away from the gates removed that coincidence, and the shards went red on a
    // pull request before this pin existed.
    for (const jobName of ["test", "platform-macos", "platform-windows"]) {
      const steps = (ci.jobs?.[jobName] as { steps?: { if?: string; run?: string }[] })?.steps ?? [];
      const build = steps.find(step => step.run?.includes("bun run build"));
      expect(`${jobName}:${build === undefined}`).toBe(`${jobName}:false`);
      expect(`${jobName}:${build?.if ?? "unconditional"}`).toBe(`${jobName}:unconditional`);
    }

    // No job in this workflow pushes, and the self-hosted runner keeps its
    // checkout between jobs, so a persisted token is avoidable residue. The
    // other workflows in this repository already set this; ci.yml was the gap.
    const checkouts = Object.values(ci.jobs ?? {})
      .flatMap(job => (job as { steps?: { uses?: string; with?: Record<string, unknown> }[] })?.steps ?? [])
      .filter(step => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const [index, step] of checkouts.entries()) {
      expect(`checkout[${index}]:${step.with?.["persist-credentials"]}`).toBe(`checkout[${index}]:false`);
    }

    // The self-hosted workspace wipe must not swallow its own failure. A clean
    // that fails on permissions leaves deleted files on disk, and the checkout
    // after it then validates a tree that no longer exists in git.
    const wipe = ((ci.jobs?.["platform-windows"] as { steps?: { if?: string; run?: string }[] })?.steps ?? [])
      .find(step => step.run?.includes("git clean -xffd"));
    expect(wipe?.run).not.toContain("|| true");
    expect(wipe?.run).toContain("git rev-parse --is-inside-work-tree");
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
      ".gitattributes",
      ".github/workflows/ci.yml",
      ".github/workflows/enforce-pr-target.yml",
      ".github/workflows/release.yml",
      ".github/workflows/stale-needs-info.yml",
      ".npmignore",
      "LICENSE",
      "README.md",
      "assets/**",
      "bin/**",
      "bun.lock",
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
    for (const jobName of ["test", "storage-policy", "gates", "platform-macos", "keyring-smoke"]) {
      const job = ci.jobs?.[jobName] as { needs?: string; if?: string } | undefined;
      expect(`${jobName}:${job?.needs}`).toBe(`${jobName}:changes`);
      expect(`${jobName}:${job?.if}`).toBe(`${jobName}:${scopedCondition}`);
    }
  });

  test("cross-platform CI keeps the GUI lint and build gates", async () => {
    // Review finding (PR #97): the GUI build gate was silently dropped once; assert the
    // enhanced gate (PR #99) stays wired so broken GUI builds cannot merge unnoticed.
    const workflow = await readText(".github/workflows/ci.yml");

    expect(workflow).toContain("- name: GUI lint");
    expect(workflow).toContain("bun run lint");
    expect(workflow).toContain("- name: GUI build");
    expect(workflow).toContain("bun run build");

    // Presence is no longer enough. After area scoping, a step conditioned on a
    // filter that never fires is a dropped gate wearing the step's name — the
    // same outcome #97 hit, reached a different way. Pin the condition to the
    // filter output, and pin the filter to patterns that can actually match.
    const ci = Bun.YAML.parse(workflow) as {
      jobs?: Record<string, Record<string, unknown> | undefined>;
    };
    const gateSteps = (ci.jobs?.gates as {
      steps?: { name?: string; if?: string }[];
    })?.steps ?? [];
    for (const stepName of ["GUI lint", "GUI build"]) {
      const step = gateSteps.find(candidate => candidate.name === stepName);
      expect(`${stepName}:${step === undefined}`).toBe(`${stepName}:false`);
      expect(step?.if).toBe("needs.changes.outputs.gui == 'true'");
    }

    const filterStep = (ci.jobs?.changes as {
      steps?: { with?: Record<string, string> }[];
    })?.steps?.find(step => step.with?.filters);

    // `base` is not cosmetic. Unset, paths-filter diffs a `dev` push against the
    // repository default branch (`main`), so everything changed since the last
    // promotion still reads as changed and the scoped jobs run anyway — the
    // filter would look correct, stay green, and save nothing.
    expect(filterStep?.with?.base).toBe("${{ github.ref }}");

    // paths-filter cannot read a PR's file list without this, and a filter that
    // errors produces empty outputs — which every `== 'true'` condition reads as
    // "skip". The scoped jobs would silently stop running.
    expect((ci.jobs?.changes as { permissions?: Record<string, string> })?.permissions)
      .toEqual({ contents: "read", "pull-requests": "read" });

    // Whole-list comparison, not samples. Every entry is an input to the
    // published tarball; dropping one silently stops packaging verification for
    // that surface. `src/**` is the load-bearing one: it keeps a source-only PR
    // running the Windows smoke jobs (keyring, npm-global) now that the full
    // Windows suite runs only on manual dispatch.
    const filters = String(filterStep?.with?.filters ?? "");
    const packagingBlock = filters.split(/\n\s*packaging:\s*\n/)[1] ?? "";
    const packaging = [...packagingBlock.matchAll(/-\s*'([^']+)'/g)].map(match => match[1]).sort();
    expect(packaging).toEqual([
      ".npmignore",
      ".gitattributes",
      "LICENSE",
      "README.md",
      "assets/**",
      "bin/**",
      "bun.lock",
      "gui/**",
      "package.json",
      "scripts/prepare-package.ts",
      "src/**",
    ].sort());

    // Every packaging pattern that names a real path must also appear in the
    // shared expensive-CI filter. Otherwise the workflow records a cheap green
    // aggregate while silently skipping the packaging verification.
    const ciPatterns = (Bun.YAML.parse(filters) as { ci?: string[] }).ci ?? [];
    for (const pattern of packaging) {
      if (pattern === "scripts/prepare-package.ts") continue; // covered by scripts/**
      expect(`${pattern}:${ciPatterns.includes(pattern)}`).toBe(`${pattern}:true`);
    }
  });

  test("stale needs-info workflow is schedule-only and least-privilege", async () => {
    const text = await readText(".github/workflows/stale-needs-info.yml");
    const workflow = Bun.YAML.parse(text) as {
      on?: Record<string, unknown>;
      permissions?: Record<string, string>;
      jobs?: Record<string, {
        steps?: Array<{
          name?: string;
          uses?: string;
          with?: Record<string, unknown>;
        }>;
      }>;
    };

    // Branch-selected workflow_dispatch would run an unreviewed YAML with write tokens.
    expect(workflow.on).toBeDefined();
    expect(Object.keys(workflow.on ?? {})).toEqual(["schedule"]);
    expect(workflow.permissions).toEqual({
      issues: "write",
      "pull-requests": "write",
    });
    expect(workflow.permissions).not.toHaveProperty("contents");

    const steps = workflow.jobs?.stale?.steps ?? [];
    expect(steps).toHaveLength(2);

    const ensureLabel = steps[0]!;
    expect(ensureLabel.name).toBe("Ensure stale label exists");
    expect(ensureLabel.uses).toBe(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    const ensureScript = String(ensureLabel.with?.script ?? "");
    expect(ensureScript).toContain("createLabel");
    expect(ensureScript).toContain('const name = "stale"');
    expect(ensureScript).toContain("core.setFailed");
    expect(ensureScript).toContain("getLabel");

    const stale = steps[1]!;
    expect(stale.name).toBe("Mark and close inactive needs-info issues");
    expect(stale.uses).toBe("actions/stale@1e223db275d687790206a7acac4d1a11bd6fe629");
    expect(stale.with?.["only-issue-labels"]).toBe("needs-info");
    expect(stale.with?.["days-before-pr-stale"]).toBe(-1);
    expect(stale.with?.["days-before-pr-close"]).toBe(-1);
    expect(stale.with?.["remove-pr-stale-when-updated"]).toBe(false);
    expect(stale.with?.["days-before-issue-stale"]).toBe(14);
    expect(stale.with?.["days-before-issue-close"]).toBe(7);
    expect(stale.with?.["stale-issue-label"]).toBe("stale");
    expect(stale.with?.["exempt-issue-labels"]).toBeUndefined();
    expect(stale.with?.["remove-stale-when-updated"]).toBe(true);
    expect(text).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("service lifecycle is least-privilege, bounded, and cannot swallow health failures", async () => {
    const workflow = await readText(".github/workflows/service-lifecycle.yml");

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("group: service-lifecycle-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(count(workflow, "timeout-minutes: 10")).toBe(3);
    expect(count(workflow, "if: ${{ !cancelled() }}")).toBe(3);
    expect(workflow).not.toContain("always()");
    expect(workflow).not.toContain('healthz || echo "healthz not ready yet"');
    expect(workflow).not.toContain("sleep 8");
    expect(workflow).toContain("systemd service has no positive MainPID before crash test");
    expect(workflow).toContain("Get-ScheduledTask -TaskName opencodex-proxy -ErrorAction SilentlyContinue");
    expect(workflow).toContain("launchd artifact or proxy survived uninstall");
    expect(workflow).toContain("scheduled task or proxy survived uninstall");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("release workflow gates the exact SHA, channel, and service surface without injection", async () => {
    const workflow = await readText(".github/workflows/release.yml");
    const release = Bun.YAML.parse(workflow) as {
      permissions?: Record<string, string>;
      jobs?: {
        "validate-dispatch"?: {
          "runs-on"?: string;
          permissions?: Record<string, string>;
        };
        publish?: {
          "runs-on"?: string;
          needs?: string;
          permissions?: Record<string, string>;
        };
      };
    };
    
    // Keep the workflow unprivileged by default. Dispatch validation gets only
    // read access; write + OIDC permissions exist only on the gated publish job.
    expect(release.permissions).toEqual({});
    
    expect(release.jobs?.["validate-dispatch"]?.["runs-on"]).toBe("ubuntu-latest");
    expect(release.jobs?.["validate-dispatch"]?.permissions).toEqual({
      contents: "read",
    });
    
    expect(release.jobs?.publish?.needs).toBe("validate-dispatch");
    expect(release.jobs?.publish?.["runs-on"]).toBe("ubuntu-latest");
    expect(release.jobs?.publish?.permissions).toEqual({
      contents: "write",
      actions: "read",
      "pull-requests": "read",
      "id-token": "write",
    });
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 15");

    // The exact-SHA CI gate already includes the three hosted keyring legs. The
    // release workflow must not duplicate the Linux bootstrap and drift from CI.
    expect(workflow).not.toContain("- name: OS keyring create/read/delete smoke");
    expect(workflow).not.toContain("gnome-keyring-daemon");

    // Root and GUI dependency trees share one audit definition across local and
    // workflow release paths.
    const packageJson = JSON.parse(await readText("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["audit:high"]).toBe(
      "bun audit --audit-level=high && cd gui && bun audit --audit-level=high",
    );
    expect(workflow).toContain("run: bun run audit:high");
    expect(workflow).not.toContain("run: bun audit --audit-level=high");

    // gh embeds a jq expression but does not expose jq's --arg flag. Keep the
    // branch and event filters on gh's native, documented flag surface.
    const ciLookup = workflow.split('ci_url="$(')[1]?.split('\n          )"')[0];
    expect(ciLookup).toBeDefined();
    expect(ciLookup).toContain("--workflow ci.yml");
    expect(ciLookup).toContain('--branch "${GITHUB_REF#refs/heads/}"');
    expect(ciLookup).toContain('--commit "$GITHUB_SHA"');
    expect(ciLookup).toContain("--event push");
    expect(ciLookup).not.toContain("--status success");
    expect(ciLookup).toContain("--json conclusion,url");
    expect(ciLookup).toContain("select(.conclusion == \"success\")");
    expect(ciLookup).toContain("[0].url // \"\"");
    expect(ciLookup).not.toContain("--arg");
    expect(ciLookup).not.toContain("$branch");

    const serviceLookup = workflow
      .split('service_url="$(')[1]?.split('\n            )"')[0];
    expect(serviceLookup).toBeDefined();
    expect(serviceLookup).toContain("--workflow service-lifecycle.yml");
    expect(serviceLookup).toContain('--commit "$GITHUB_SHA"');
    expect(serviceLookup).not.toContain("--status success");
    expect(serviceLookup).toContain("--json conclusion,headSha,url,workflowName");
    expect(serviceLookup).toContain("select(.conclusion == \"success\")");
    expect(serviceLookup).toContain("[0].url // \"\"");
    expect(serviceLookup).not.toContain("--arg");

    // Dry-run first by default; tokenless trusted publishing only.
    expect(workflow).toMatch(/dry-run:[\s\S]*?default: true/);
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN:");

    // Immutable action references.
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    // Same move as the CI workflow: the pinned setup-bun reference now lives in
    // the shared composite action.
    expect(workflow).toContain("./.github/actions/setup-project-bun");
    expect(await readText(".github/actions/setup-project-bun/action.yml"))
      .toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);

    // Workflow-dispatch inputs must reach shell code via env, never by direct
    // interpolation into run: source (script-injection hardening).
    const runBlocks = workflow.split(/\n {6,}- name: /).filter(block => block.includes("run: |"));
    for (const block of runBlocks) {
      const runSource = block.slice(block.indexOf("run: |"));
      expect(runSource).not.toContain("${{ inputs.");
    }

    // The service gate must cover the post-restructure service surface and stay
    // in sync with every service-lifecycle.yml push trigger path.
    const gateMatch = workflow.match(/grep -Eq '(\^\([^']+\)\$)'/);
    expect(gateMatch).not.toBeNull();
    const gate = new RegExp(gateMatch![1]!);
    const lifecycle = await readText(".github/workflows/service-lifecycle.yml");
    const pushPaths = lifecycle
      .split("push:")[1]!
      .split("workflow_dispatch:")[0]!
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith('- "'))
      .map(line => line.slice(3, -1));
    expect(pushPaths.length).toBeGreaterThanOrEqual(6);
    for (const path of pushPaths) {
      expect(gate.test(path)).toBe(true);
    }
    expect(gate.test("src/cli/index.ts")).toBe(true);
    expect(gate.test("src/lib/bun-runtime.ts")).toBe(true);
    expect(gate.test("src/cli.ts")).toBe(true);

    // PR and push triggers must stay path-set identical, and both must cover the
    // pre-restructure compat stub src/cli.ts that the release gate regex checks
    // (devlog 260716_passthrough_followups/020 — a release whose only service change
    // is src/cli.ts must auto-trigger service-lifecycle instead of dead-ending the gate).
    const prPaths = lifecycle
      .split("pull_request:")[1]!
      .split("push:")[0]!
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith('- "'))
      .map(line => line.slice(3, -1));
    expect([...prPaths].sort()).toEqual([...pushPaths].sort());
    expect(prPaths).toContain("src/cli.ts");
    expect(pushPaths).toContain("src/cli.ts");
    expect(gate.test("src/router.ts")).toBe(false);
    expect(gate.test("docs-site/src/pages/index.astro")).toBe(false);

    // Channel guards stay branch-exact.
    expect(workflow).toContain("Release must run from main or preview");
    expect(workflow).toContain("main releases must use a stable semver version");
    expect(workflow).toContain("preview releases must use a preview prerelease version");

    // Release notes are built and coverage-validated before npm publish. The
    // builder owns Git-history/PR coverage; the workflow only wires the validated
    // artifact into the release. Stable/preview range semantics are unit-tested in
    // build-release-changelog.test.ts rather than duplicated as YAML string pins.
    const notesBuildIndex = workflow.indexOf("- name: Build and validate release changelog");
    const publishIndex = workflow.indexOf("- name: Publish (or dry-run)");
    expect(notesBuildIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(notesBuildIndex);
    expect(workflow).toContain("bun scripts/build-release-changelog.ts");
    expect(workflow).toContain('--version "$RELEASE_VERSION"');
    expect(workflow).toContain('--dist-tag "$NPM_DIST_TAG"');
    expect(workflow).toContain('--repository "$GITHUB_REPOSITORY"');
    expect(workflow).toContain('--target "$GITHUB_SHA"');
    expect(workflow).toContain('--out "$notes_file"');
    expect(workflow).toContain('test -s "$notes_file"');
    expect(workflow).not.toContain("bun scripts/release-notes.ts matching-preview-tags");
    expect(workflow).not.toContain("newest_carried_preview_tag");
    expect(workflow).not.toContain("carried_file");
    expect(workflow).not.toContain("delta_file");
    expect(workflow).not.toContain("notes_range_start");

    const releaseNotesBuilder = await readText("scripts/build-release-changelog.ts");
    expect(releaseNotesBuilder).toContain("releases/generate-notes");
    expect(releaseNotesBuilder).toContain('"git",');
    expect(releaseNotesBuilder).toContain('"log",');
    expect(releaseNotesBuilder).toContain("selectReleaseBaseline");
    expect(releaseNotesBuilder).toContain("skip-changelog");
    expect(releaseNotesBuilder).toContain("release changelog failed coverage validation");

    expect(workflow).toMatch(/gh release create[\s\S]*?--notes-file "\$notes_file"/);
    expect(workflow).not.toContain("gh release edit");
    expect(workflow).not.toContain("--generate-notes");

    const createStep = workflow
      .split("- name: Create GitHub release")[1]!
      .split(/\n {6}- name:/)[0]!;
    expect(createStep).toContain('notes_file="$GITHUB_WORKSPACE/.release-notes.md"');
    expect(createStep).toContain('test -s "$notes_file"');
    expect(createStep).not.toContain("generate-notes");
    expect(createStep).not.toContain("gh api");
    expect(createStep.indexOf('test -s "$notes_file"')).toBeLessThan(
      createStep.indexOf('git tag "$release_tag"'),
    );

    // The merged-only restriction remains on the service gate, whose
    // changed-files comparison is deliberately lineage-relative.
    const ciGateStep = workflow
      .split("- name: Require successful Cross-platform CI for this commit")[1]!
      .split(/\n {6}- name:/)[0]!;
    expect(ciGateStep).toContain("--merged HEAD");
  });

  /**
   * `enforce-pr-target.yml` had no test at all, and it is the one workflow that
   * mutates a contributor's pull request — it rewrites the title and converts the
   * PR to a draft. It also runs on `pull_request_target`, so it holds the base
   * repository's write token while doing it.
   *
   * These assertions pin the CURRENT behaviour rather than a desired one. The
   * gate is being redesigned (devlog/_plan/260727_governance_intake/040), and a
   * redesign without a characterisation test is how the four review rounds on
   * that plan happened in the first place.
   *
   * They parse the workflow rather than grepping it. Two rounds of adversarial
   * mutation testing broke the string-matching version: `- run : echo pwn` and
   * `- 'uses': owner/action@feature` are valid YAML that no reasonable regex
   * catches, and `// await convertToDraft();` satisfies a substring check while
   * removing the behaviour. A parser sees keys, not spellings.
   */
  type WorkflowStep = Record<string, unknown> & {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  };
  type WorkflowJob = Record<string, unknown> & { "runs-on"?: unknown; steps?: WorkflowStep[] };
  type WorkflowShape = Record<string, unknown> & {
    on?: {
      pull_request_target?: { types?: string[] };
      issue_comment?: { types?: string[] };
      workflow_run?: { workflows?: string[]; types?: string[] };
      pull_request_review?: { types?: string[] };
      pull_request_review_comment?: { types?: string[] };
      status?: unknown;
    };
    permissions?: Record<string, string> | string;
    concurrency?: Record<string, unknown> & { group?: string };
    jobs?: Record<string, WorkflowJob>;
  };

  async function readEnforcePrTarget(): Promise<{
    workflow: WorkflowShape;
    jobs: [string, WorkflowJob][];
    steps: WorkflowStep[];
    allSteps: WorkflowStep[];
    script: string;
  }> {
    const text = await readText(".github/workflows/enforce-pr-target.yml");
    const workflow = Bun.YAML.parse(text) as WorkflowShape;
    const jobs = Object.entries(workflow.jobs ?? {});
    const steps = workflow.jobs?.["enforce-target"]?.steps;
    expect(Array.isArray(steps)).toBe(true);
    // Every step of every job, so a second job cannot smuggle in an unchecked
    // one. `enforce-target` is not privileged here; it is just the one whose
    // script body the behavioural tests read.
    const allSteps = jobs.flatMap(([, job]) => job?.steps ?? []);
    const scriptStep = steps!.find(step => typeof step.with?.script === "string");
    expect(scriptStep).toBeDefined();
    const script = stripComments(String(scriptStep!.with!.script));
    return { workflow, jobs, steps: steps!, allSteps, script };
  }

  const SCRIPT_LOAD = [
    "require",
    "require",
    "require",
    "require",
    "require",
    "require",
    "require",
    // pr-referenced-authors.cjs, for the carry-attribution assessor.
    "require",
  ] as const;

  /** Reads every allowed-base PR performs before any enforcement writes. */
  function readsAllowedBase(tail: string[] = []): string[] {
    return [
      ...SCRIPT_LOAD,
      "pulls.get",
      "issues.listComments",
      "repos.getCollaboratorPermissionLevel",
      "repos.compareCommitsWithBasehead",
      "repos.compareCommitsWithBasehead",
      "pulls.get",
      "pulls.listFiles",
      "pulls.get",
      // The carry-attribution assessor reads the branch's commit messages: a
      // Co-authored-by trailer can live in a commit rather than the body.
      "pulls.listCommits",
      ...tail,
    ];
  }

  /** Reads for a PR whose base is outside the allow-list (no ancestry compares). */
  function readsWrongBase(tail: string[] = []): string[] {
    return [
      ...SCRIPT_LOAD,
      "pulls.get",
      "issues.listComments",
      "repos.getCollaboratorPermissionLevel",
      "pulls.list",
      "pulls.get",
      "pulls.listFiles",
      "pulls.get",
      "pulls.listCommits",
      ...tail,
    ];
  }

  /** Like readsAllowedBase but with a second listComments page from paginate. */
  function readsAllowedBasePaged(tail: string[] = []): string[] {
    return [
      ...SCRIPT_LOAD,
      "pulls.get",
      "issues.listComments",
      "issues.listComments",
      "repos.getCollaboratorPermissionLevel",
      "repos.compareCommitsWithBasehead",
      "repos.compareCommitsWithBasehead",
      // The harness walks every paginate call across the same page count, so
      // listFiles appears once per comment page even when the file list is empty.
      "pulls.get",
      "pulls.listFiles",
      "pulls.listFiles",
      "pulls.get",
      "pulls.listCommits",
      "pulls.listCommits",
      ...tail,
    ];
  }

  /**
   * Drop JavaScript comments so a commented-out call cannot satisfy a "calls X"
   * assertion. Both forms matter: an audit round removed the draft conversion
   * with `// await convertToDraft();` and then again with the block form
   * `/* await convertToDraft(); *\/`, and a line-only stripper caught just the
   * first.
   *
   * Quoting has to be tracked rather than pattern-matched. The script builds a
   * message containing `https://…`, so a naive `line.replace(/\/\/.*$/, "")`
   * truncates that string literal and quietly weakens everything after it.
   * Newlines are preserved so failure output still points at the right line.
   */
  function stripComments(source: string): string {
    let out = "";
    let quote: string | null = null;
    let block = false;

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i]!;
      const next = source[i + 1];

      if (block) {
        if (char === "*" && next === "/") { block = false; i += 1; continue; }
        if (char === "\n") out += char;
        continue;
      }

      if (quote) {
        out += char;
        if (char === "\\") { if (next !== undefined) { out += next; i += 1; } continue; }
        if (char === quote) quote = null;
        continue;
      }

      if (char === '"' || char === "'" || char === "`") { quote = char; out += char; continue; }
      if (char === "/" && next === "*") { block = true; i += 1; continue; }
      if (char === "/" && next === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
        out += "\n";
        continue;
      }
      out += char;
    }

    return out;
  }

  /**
   * Enumerate what the workflow IS, not what it must not be.
   *
   * Three audit rounds killed the deny-list approach. Each round the author
   * closed the named holes and each round the next auditor found more, because
   * "assert this key is absent" only ever covers keys someone thought of. Round
   * three alone landed fourteen: `if: false` on the job, `if: false` on the
   * step, `runs-on: self-hosted`, `container: node:22`, a `strategy.matrix`,
   * `outputs.leaked: ${{ github.token }}`, a `<<:` merge key that smuggles in
   * `if: false`, `github-token: ${{ secrets.SOME_PAT }}` beside `script`,
   * `result-encoding`, a job-level `env:` carrying the PR title, and
   * `cancel-in-progress`.
   *
   * Every one of those is a KEY THAT WAS NOT THERE BEFORE. So pin the key sets
   * exactly. A new key — any new key, including one invented after this test
   * was written — fails here and gets read by a human. That is the property a
   * characterisation test on a privileged workflow actually needs.
   */
  test("PR target enforcement's structure is an exact allowlist, not a deny-list", async () => {
    const { workflow, jobs, steps } = await readEnforcePrTarget();

    // Top level: concurrency lives on the write job after read-only PR resolution.
    expect(Object.keys(workflow).sort()).toEqual([
      "jobs",
      "name",
      "on",
      "permissions",
    ]);

    // pull_request_target runs with the base repo's token. Checking out or
    // executing the PR's code under it is the classic escalation. Review
    // events are deliberately NOT added: they load the workflow from the PR
    // head branch (like `pull_request`), which would run head-controlled
    // workflow YAML under a write token against base-pinned scripts — a
    // mismatch that crashes the gate and breaks the trusted-base model.
    //
    // `status` is the only extra trigger. CodeRabbit publishes a legacy
    // commit status; this privileged workflow is loaded from the default branch
    // and re-reads live review evidence before any mutation.
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      "pull_request_target",
      "status",
    ]);

    // And the trigger is exactly a `types:` list — nothing else.
    //
    // Every other level here is pinned by exact key-set equality; this one was
    // not, and a review round walked straight through the hole. `branches: [main]`
    // narrows the gate to PRs against `main`, so one opened against `preview`
    // sails past unenforced. `paths:` is worse: the gate then fires only when
    // particular files change, which on a docs-only PR means never. Both are
    // additive, both look like ordinary scoping in a diff, and neither failed a
    // single assertion.
    expect(Object.keys(workflow.on?.pull_request_target ?? {})).toEqual(["types"]);
    expect(Object.prototype.hasOwnProperty.call(workflow.on ?? {}, "status")).toBe(true);

    // Exactly the scopes this gate needs. `pull-requests: write` covers title and
    // comment updates. `contents: write` is required for the draft GraphQL
    // mutations with GITHUB_TOKEN (#626: "Resource not accessible by integration"
    // when contents was unset). Asserting the whole object pins both presence
    // and the absence of anything broader (write-all, contents alone, …).
    expect(workflow.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });

    expect(workflow.concurrency).toBeUndefined();

    const resolver = workflow.jobs?.["resolve-pr"] as WorkflowJob | undefined;
    expect(resolver).toBeDefined();
    expect(Object.keys(resolver ?? {}).sort()).toEqual([
      "if",
      "outputs",
      "permissions",
      "runs-on",
      "steps",
    ]);
    expect(resolver?.["runs-on"]).toBe("ubuntu-latest");
    expect(resolver?.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.context == 'CodeRabbit'");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.state == 'success'");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.sender.login == 'coderabbitai[bot]'");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.sender.id == 136622811");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.label.name == 'gui-screenshot-waived'");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.label.name == 'intake: hygiene-blocked'");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.label.name == 'maintainer-sponsored'");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.label.name == 'test-exception-approved'");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.label.name == 'suppression-approved'");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.label.name == 'generated-change-approved'");
    expect(String(resolver?.["if"] ?? "")).toContain("github.event.label.name == 'dependency-change-approved'");

    const hygieneWorkflow = Bun.YAML.parse(
      await readText(".github/workflows/pr-hygiene.yml"),
    ) as { concurrency?: { group?: string; "cancel-in-progress"?: boolean } };
    expect(hygieneWorkflow.concurrency?.group).toBe(
      "pr-gate-comment-${{ github.event.pull_request.number }}",
    );
    expect(hygieneWorkflow.concurrency?.["cancel-in-progress"]).toBe(false);

    expect(jobs.map(([name]) => name)).toEqual(["resolve-pr", "enforce-target"]);

    const job = workflow.jobs?.["enforce-target"] as WorkflowJob | undefined;
    expect(job).toBeDefined();
    expect(Object.keys(job ?? {}).sort()).toEqual([
      "concurrency",
      "if",
      "needs",
      "permissions",
      "runs-on",
      "steps",
    ]);
    expect(job?.["runs-on"]).toBe("ubuntu-latest");
    expect(job?.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(job?.needs).toBe("resolve-pr");
    expect(job?.["if"]).toBe("needs.resolve-pr.outputs.pull-number != ''");
    expect(job?.concurrency).toEqual({
      group: "pr-gate-comment-${{ needs.resolve-pr.outputs.pull-number }}",
      "cancel-in-progress": false,
    });

    // Checkout trusted scripts, then run the gate. Anything more is an extra
    // privileged action nobody reviewed.
    expect(steps).toHaveLength(2);
    const [checkout, scriptStep] = steps as [WorkflowStep, WorkflowStep];
    expect(Object.keys(checkout).sort()).toEqual(["name", "uses", "with"]);
    expect(checkout.uses).toBe(
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    );
    expect(Object.keys(checkout.with ?? {}).sort()).toEqual([
      "persist-credentials",
      "ref",
      "sparse-checkout",
    ]);
    expect(checkout.with).toEqual({
      // The trusted ref comes from a fixed set of integration branches, never
      // from the pull request: a stacked child's base is another open PR's
      // head, so an unpromoted commit must not select the code that runs with
      // this workflow's write-capable token. A `status` event has no
      // pull_request payload and loads scripts from the default-branch trust
      // boundary that owns the event; a `main`-targeting PR loads from `main`
      // so the scripts match the workflow definition `pull_request_target`
      // itself loaded; everything else resolves to `dev`.
      ref:
        "${{ github.event_name == 'status' && github.event.repository.default_branch || (github.event.pull_request.base.ref == 'main' && 'main' || 'dev') }}",
      "persist-credentials": false,
      // MAINTAINERS.md rides along so the completion ping reads the canonical
      // maintainer list from the same trusted base revision as the scripts.
      "sparse-checkout": ".github/scripts\nMAINTAINERS.md\n",
    });

    expect(Object.keys(scriptStep).sort()).toEqual(["env", "name", "uses", "with"]);
    expect(scriptStep.env).toEqual({
      RESOLVED_PULL_NUMBER: "${{ needs.resolve-pr.outputs.pull-number }}",
    });

    // `github-script` is the action, pinned to a 40-hex commit SHA: this
    // workflow hands a write token to whatever the ref resolves to, so a tag or
    // branch is a mutable dependency.
    expect(scriptStep.uses).toMatch(/^actions\/github-script@[0-9a-f]{40}$/);

    // `script` is the only input. `github-token:` swaps the restricted
    // `GITHUB_TOKEN` for an arbitrary PAT, and every other input changes how the
    // action behaves with that token in hand.
    expect(Object.keys(scriptStep.with ?? {})).toEqual(["script"]);
  });

  /**
   * `${{ }}` is interpolated by Actions into the script text BEFORE node sees
   * it, so a PR title containing a backtick or a quote is code, not data. This
   * is the canonical `pull_request_target` script-injection sink, and the round
   * three audit walked straight through it with
   * `const injected = "${{ github.event.pull_request.title }}";`.
   *
   * The script body must contain no expression syntax at all. It already reads
   * everything it needs from the `context` object at runtime.
   */
  test("PR target enforcement's script interpolates nothing from the event", async () => {
    const { steps } = await readEnforcePrTarget();
    const scriptStep = steps.find(step => typeof step.with?.script === "string");
    const rawScript = String(scriptStep?.with?.script ?? "");
    expect(rawScript).not.toContain("${{");
  });

  test("PR target enforcement reacts to the events that can change the verdict", async () => {
    const { workflow, script } = await readEnforcePrTarget();

    // `edited` is what catches a retarget; `ready_for_review` is what re-applies
    // the draft when someone undoes it by hand. Dropping either silently makes
    // the gate one-shot.
    const types = workflow.on?.pull_request_target?.types ?? [];
    expect([...types].sort()).toEqual([
      "edited",
      "labeled",
      "opened",
      "ready_for_review",
      "reopened",
      "synchronize",
      "unlabeled",
    ]);

    // GUI-waiver labels re-run immediately through pull_request_target.
    // CodeRabbit reviews re-run through the default-branch status event instead
    // of using bot status-comment edits as workflow synchronisation.
    expect(Object.prototype.hasOwnProperty.call(workflow.on ?? {}, "status")).toBe(true);

    // Review events must NOT be added: they load the workflow from the PR
    // head branch, breaking the base-pinned checkout (`pull_request_review`
    // runs head YAML + base scripts → `parseGateState is not a function`).
    expect(workflow.on?.pull_request_review).toBeUndefined();
    expect(workflow.on?.pull_request_review_comment).toBeUndefined();

    // The verdict is a live PR read plus ancestry/description checks.
    expect(script).toContain("github.rest.pulls.get");
    expect(script).toContain("collectPrQualityFailures");
    expect(script).toContain("collectDeterministicHygieneFailures");
    expect(script).toContain("github.rest.pulls.listFiles");
    // The GUI screenshot gate reads changed file paths under gui/.
    expect(script).toContain("changedFilePaths");
    expect(script).toContain("filesTruncated");
    expect(script).toContain("isChangedFileListTruncated");
    expect(script).toContain("PR head moved while listing changed files");
    expect(script).toContain("github.rest.repos.getCollaboratorPermissionLevel");
    expect(script).toContain("github.rest.repos.compareCommitsWithBasehead");
    // The allow-list is the gate's whole policy, so it is pinned by value and
    // not just by shape: a widened list is the one edit that opens every base
    // at once while every behavioural scenario below still passes.
    expect(script).toMatch(/const ALLOWED_BASES = \["dev"\];/);
    expect(script).toMatch(/const DEFAULT_BASE = "dev";/);

    // The read-only resolver is the single authority for PR identity. The
    // write job consumes exactly that output, so its mutation target and
    // concurrency key cannot diverge or perform a second SHA-to-PR lookup.
    expect(script).toContain("process.env.RESOLVED_PULL_NUMBER");
    expect(script).not.toContain("listPullRequestsAssociatedWithCommit");

    // Nothing may write back into the fetched PR. The audit round preserved the
    // required comparison line verbatim and defeated it one line earlier with
    // `pr.base.ref = EXPECTED_BASE;` — the literal was still there, the verdict
    // was still always false. `pr` is read-only evidence, so no assignment to
    // any of its fields may exist.
    expect(script).not.toMatch(/\bpr\.[A-Za-z_$][\w$.]*\s*=(?!=)/);
  });

  /**
   * Every write this workflow performs, and exactly which fields it may carry.
   *
   * The audit found two argument-level bypasses that nothing above catches,
   * because both leave the call site's shape intact:
   *
   *   - `issue_number: 1` on the comment call, retargeting the bot's comment at
   *     an unrelated issue;
   *   - `base: "main"` added to the title update, so the gate that exists to
   *     stop wrong-branch PRs quietly retargets them itself.
   *
   * The second is the worse one: `pulls.update` accepts `base`, `state`, and
   * `body`, so an unconstrained argument list on a write token means the bot can
   * retarget or close any PR it is invoked on. Pin the argument names.
   */
  test("PR target enforcement's writes carry only the fields they need", async () => {
    const { script } = await readEnforcePrTarget();

    // Parse each `await github.rest.X.Y({ ... })` call and collect its top-level
    // argument names by brace-depth, so nested objects do not leak in.
    function callArgs(callee: string): string[][] {
      const found: string[][] = [];
      const pattern = new RegExp(`${callee.replaceAll(".", "\\.")}\\(\\s*\\{`, "g");
      for (const match of script.matchAll(pattern)) {
        let depth = 1;
        let i = match.index! + match[0].length;
        const start = i;
        for (; i < script.length && depth > 0; i += 1) {
          const char = script[i]!;
          if (char === "{" || char === "(" || char === "[") depth += 1;
          else if (char === "}" || char === ")" || char === "]") depth -= 1;
        }
        const body = script.slice(start, i - 1);
        const names: string[] = [];
        let nest = 0;
        for (const line of body.split("\n")) {
          const trimmed = line.trim();
          const key = /^([A-Za-z_$][\w$]*)\s*(?::|,|$)/.exec(trimmed);
          if (nest === 0 && key) names.push(key[1]!);
          for (const char of line) {
            if (char === "{" || char === "[" || char === "(") nest += 1;
            else if (char === "}" || char === "]" || char === ")") nest -= 1;
          }
        }
        found.push(names.sort());
      }
      return found;
    }

    // Seven `pulls.update` sites: the maintainer checklist retirement, the
    // checklist injection, the head-drift reset, the claim-check uncheck
    // (body only), the wrong-base prefix add, and the two stale-prefix strips
    // (draft path and ready path). `base` and `state` are accepted by this
    // endpoint and none of them belong anywhere here.
    expect(callArgs("github.rest.pulls.update")).toEqual([
      ["body", "owner", "pull_number", "repo"],
      ["body", "owner", "pull_number", "repo"],
      ["body", "owner", "pull_number", "repo"],
      ["body", "owner", "pull_number", "repo"],
      ["owner", "pull_number", "repo", "title"],
      ["owner", "pull_number", "repo", "title"],
      ["owner", "pull_number", "repo", "title"],
    ]);

    // The single consolidated comment addresses the PR being enforced, by its
    // own number.
    expect(callArgs("github.rest.issues.createComment")).toEqual([
      ["body", "issue_number", "owner", "repo"],
    ]);
    expect(callArgs("github.rest.issues.updateComment")).toEqual([
      ["body", "comment_id", "owner", "repo"],
    ]);

    // …and the number is `pull_number`, not a literal. `issue_number: 1` has the
    // same shape as `issue_number: pull_number` and points somewhere else.
    expect(script).toMatch(/issue_number:\s*pull_number\b/);
    expect(script).not.toMatch(/issue_number:\s*\d/);

    // These are the only mutating REST calls. A new one is a write nobody
    // reviewed. `pulls.list` and `pulls.listReviews` are reads, not writes.
    const restWrites = [...script.matchAll(/github\.rest\.[\w.]+/g)]
      .map(match => match[0])
      .filter(
        name =>
          !name.endsWith(".get") &&
          !name.endsWith(".list") &&
          !name.endsWith(".listComments") &&
          name !== "github.rest.pulls.listReviews" &&
          name !== "github.rest.repos.getCollaboratorPermissionLevel" &&
          name !== "github.rest.repos.compareCommitsWithBasehead" &&
          name !== "github.rest.repos.listPullRequestsAssociatedWithCommit" &&
          name !== "github.rest.issues.listEvents" &&
          // Hygiene reassessment reads the changed-file list; not a write.
          name !== "github.rest.pulls.listFiles" &&
          // Carry attribution reads the branch's commit messages; not a write.
          name !== "github.rest.pulls.listCommits",
      );
    expect([...new Set(restWrites)].sort()).toEqual([
      "github.rest.issues.addLabels",
      "github.rest.issues.createComment",
      "github.rest.issues.deleteComment",
      "github.rest.issues.removeLabel",
      "github.rest.issues.updateComment",
      "github.rest.pulls.update",
    ]);
  });

  /**
   * Run the script instead of reading it.
   *
   * Four audit rounds established that pinning JavaScript by text does not
   * work. Every one of these defeated a regex while leaving the strings it
   * matched on intact:
   *
   *     const upd = github.rest.pulls.update; await upd({ base: "main" })
   *     github.rest["pulls"]["update"]({ base: "main" })
   *     github.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", …)
   *     await github.rest.pulls.update({ ...{ base: "main" }, owner, … })
   *     Object.assign(pr.base, { ref: EXPECTED_BASE })
   *     if (false) { …the entire body… }
   *     try { …the entire body… } catch {}
   *
   * A recording client does not care how the call was spelled. It records what
   * came out. `if (false)` and a swallowed exception show up as an empty call
   * list, and a smuggled `base: "main"` shows up in the arguments.
   */
  describe("PR target enforcement, executed", () => {
    async function run(options: Parameters<typeof runEnforcePrTarget>[1]) {
      const { script } = await readEnforcePrTarget();
      return runEnforcePrTarget(script, options);
    }

    /**
     * Run the read-only `resolve-pr` job's SHA-to-PR resolver in the same
     * harness scope the write gate gets. The resolver is a separate inline
     * script from `enforce-target`; compiling it on its own lets a test pin
     * what `pull-number` it publishes for a given associated-PR / open-PR
     * state. This is the exact surface where the stale-commit-index bug
     * (PR #1441) lived, so the head-SHA fallback is asserted here.
     */
    async function runResolver(options: Parameters<typeof runEnforcePrTarget>[1]) {
      const text = await readText(".github/workflows/enforce-pr-target.yml");
      const workflow = Bun.YAML.parse(text) as {
        jobs?: Record<string, { steps?: Array<{ name?: string; with?: { script?: string } }> }>;
      };
      const step = workflow.jobs?.["resolve-pr"]?.steps?.find(
        s => s.name === "Resolve trusted gate event to PR",
      );
      const resolverScript = step?.with?.script;
      if (typeof resolverScript !== "string") {
        throw new Error("resolve-pr step has no inline script");
      }
      return runEnforcePrTarget(stripComments(resolverScript), options);
    }

    /**
     * Run an arbitrary body in the same scope the workflow script gets, and
     * hand back what it returned.
     *
     * This is how a test asks "what would a mutation see from in there?"
     * without guessing. Round eight's three findings were all probes for a
     * binding that answers differently on the runner than in the harness, so
     * the check that closes them has to be able to look from the same place.
     */
    async function runProbe(body: string): Promise<Record<string, unknown>> {
      const result = await runEnforcePrTarget(body, { pr: { base: { ref: "dev" } } });
      return result.returnValue as Record<string, unknown>;
    }

    const BOT = "github-actions[bot]";
    const MARKER = "<!-- pr-quality-enforcer -->";
    const LEGACY_MARKER = "<!-- wrong-branch-enforcer -->";
    const GATE_MARKER = "<!-- opencodex-pr-gate -->";
    const READINESS_MARKER = "<!-- pr-quality-readiness -->";
    const CHECKLIST_START = "<!-- pr-quality-readiness-checklist:start -->";
    const CHECKLIST_END = "<!-- pr-quality-readiness-checklist:end -->";
    const CHECKLIST_ITEMS = [
      "All CI tests are green on my local testing.",
      "I pushed my PR to the latest dev commit.",
      "I resolved all correct Codex and CodeRabbit findings.",
      "My PR is ready for review.",
    ];
    const CONTRIBUTOR_BODY = [
      "## Summary",
      "",
      "This change adds enough substantive detail for reviewers to understand the motivation and approach taken.",
      "",
      "## Test plan",
      "",
      "- Run `bun test tests/ci-workflows.test.ts`",
    ].join("\n");
    /**
     * Fixture for the trusted `MAINTAINERS.md`: the current-maintainers table
     * plus a change-log mention, so the section scoping of the ping is proven
     * and the scenario does not depend on the live repository file.
     */
    const MAINTAINERS_FIXTURE = [
      "## Current maintainers",
      "",
      "| GitHub account | Project role | Responsibilities |",
      "| --- | --- | --- |",
      "| [@lidge-jun](https://github.com/lidge-jun) | Project owner | x |",
      "| [@Ingwannu](https://github.com/Ingwannu) | Maintainer | x |",
      "| [@Wibias](https://github.com/Wibias) | Maintainer | x |",
      "",
      "## Change log",
      "",
      "- [@Wibias](https://github.com/Wibias) was added as a maintainer.",
    ].join("\n");

    const GUI_CHANGED_FILES = [
      { filename: "gui/src/App.tsx" },
      { filename: "tests/smoke.test.ts" },
    ];

    /** A PR body whose readiness checklist has exactly `checked` boxes ticked. */
    function readinessChecklistBody(checked: number, base = CONTRIBUTOR_BODY): string {
      const boxes = CHECKLIST_ITEMS.map((item, index) =>
        (index === CHECKLIST_ITEMS.length - 1 ? "\n" : "") +
        `- [${index < checked ? "x" : " "}] ${item}`,
      );
      return [
        base,
        CHECKLIST_START,
        "## Review readiness checklist",
        "",
        ...boxes,
        CHECKLIST_END,
      ].join("\n");
    }

    function readinessComment(state: Record<string, unknown>): Comment {
      return {
        id: 8,
        user: { login: BOT },
        body: [
          READINESS_MARKER,
          `<!-- pr-quality-readiness-state:${JSON.stringify(state)} -->`,
          "about readiness",
        ].join("\n"),
      };
    }

    /**
     * The writes a fresh contributor PR triggers on `dev` with no quality
     * failures: inject the checklist, then the ownership checkpoint comment
     * (claiming `autoDraftedByBot` before the mutation), then the draft
     * conversion.
     */
    const CONTRIBUTOR_CLEAN_TAIL = [
      "pulls.update",
      "issues.createComment",
      "graphql",
    ];

    /**
     * The writes a fresh wrong-base contributor PR triggers: inject the
     * checklist, then the title prefix, then the ownership checkpoint comment
     * (claiming `autoDraftedByBot` before the mutation), then the draft
     * conversion.
     */
    const CONTRIBUTOR_WRONG_BASE_TAIL = [
      "pulls.update",
      "pulls.update",
      "issues.createComment",
      "graphql",
    ];

    function botComment(state: Record<string, unknown>, title = "Add a thing") {
      return {
        id: 7,
        user: { login: BOT },
        body: [
          LEGACY_MARKER,
          `<!-- wrong-branch-enforcer-state:${JSON.stringify(state)} -->`,
          `about ${title}`,
        ].join("\n"),
      };
    }

    test("a PR targeting dev is left completely alone", async () => {
      const result = await run({
        pr: { base: { ref: "dev" } },
        authorPermission: "write",
      });

      // Reads only. If a rewrite adds a write here, it appears in this list.
      expect(methodsOf(result)).toEqual(readsAllowedBase());
      expect(result.logs.join(" ")).toContain("All PR quality gates passed");
    });

    test("a contributor PR targeting dev is drafted with a readiness checklist", async () => {
      const result = await run({ pr: { base: { ref: "dev" } } });

      // The gate keeps the PR in draft until the four-box checklist in the
      // description is complete — even though every quality gate passes. The
      // check itself stays green: no setFailed for a pending checklist.
      expect(methodsOf(result)).toEqual(readsAllowedBase(CONTRIBUTOR_CLEAN_TAIL));
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);

      const [injected] = callsTo(result, "pulls.update") as [{ body: string }];
      expect(injected.body).toContain(CHECKLIST_START);
      expect(injected.body).toContain(CHECKLIST_END);
      expect(injected.body).toContain("- [ ] All CI tests are green on my local testing.");
      expect(injected.body).toContain("- [ ] My PR is ready for review.");

      const [draft] = callsTo(result, "graphql") as [{ query: string }];
      expect(draft.query).toContain("convertPullRequestToDraft");

      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain("**0/4** boxes ticked");
      expect(readinessBody).toContain(GATE_MARKER);
      expect(readinessBody).toContain('"maintainersPinged":false');
    });

    test("a failed checklist draft conversion fails the check closed", async () => {
      // The enforcer path soft-fails a failed draft conversion with a red
      // check. The readiness path must fail closed the same way: a contributor
      // PR that stays ready with an open checklist is exactly the state the
      // gate exists to prevent.
      const { script } = await readEnforcePrTarget();
      const result = await runEnforcePrTarget(script, {
        pr: { base: { ref: "dev" }, draft: false },
        failGraphqlOn: ["convertPullRequestToDraft"],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "issues.createComment",
        "graphql",
        "issues.updateComment",
      ]));
      // Only a successful conversion records autoDraftedByBot; a failed one
      // clears it so a later permission recovery cannot leave the bot-created
      // draft in place forever.
      expect(lastReadinessCommentBody(result)).toContain('"autoDraftedByBot":false');
      expect(lastReadinessCommentBody(result)).toContain(
        "Automatic draft conversion failed",
      );
      expect(
        result.warnings.some(w =>
          w.includes("could not convert the pull request to draft while the review readiness checklist is open"),
        ),
      ).toBe(true);
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(true);
    });

    test("ticking every checklist box marks the contributor PR ready and pings maintainers", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
      });

      // No prior enforcer history: the checklist completion alone lifts the
      // draft and notifies the maintainers from MAINTAINERS.md.
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
      ]));
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(2);
      expect(drafts[0]!.query).toContain("reviewThreads");
      expect(drafts[1]!.query).toContain("markPullRequestReadyForReview");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain("**4/4** boxes ticked");
      expect(readinessBody).toContain("Maintainers notified: @lidge-jun @Ingwannu @Wibias");
      expect(readinessBody).toContain('"maintainersPinged":true');
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("unsponsored restricted surfaces keep Ready and review-ready blocked", async () => {
      // Regression for #1324: hygiene failed on auth-api while the quality gate
      // still posted READY and applied review-ready. The gate must re-assess
      // deterministic hygiene itself and treat those failures like any other
      // quality block.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        files: [
          { filename: "src/codex/auth-api.ts", patch: "+change" },
          { filename: "tests/codex-auth-api.test.ts", patch: "+test" },
        ],
      });

      expect(
        result.warnings.some(
          w => w.startsWith("setFailed:") && w.includes("unsponsored_surface"),
        ),
      ).toBe(true);
      expect(methodsOf(result)).toContain("pulls.listFiles");
      expect(methodsOf(result)).not.toContain("issues.addLabels");
      expect(methodsOf(result)).not.toContain("markPullRequestReadyForReview");
      const graphqlCalls = callsTo(result, "graphql") as Array<{ query: string }>;
      expect(
        graphqlCalls.some(call => call.query.includes("markPullRequestReadyForReview")),
      ).toBe(false);
      expect(
        graphqlCalls.some(call => call.query.includes("convertPullRequestToDraft")),
      ).toBe(true);
      const gateBody = lastReadinessCommentBody(result);
      expect(gateBody).toContain("## ⏳ DRAFT");
      expect(gateBody).toContain("unsponsored_surface");
      expect(gateBody).toContain("maintainer-sponsored");
      expect(gateBody).not.toContain("## ✅ READY");
    });

    test("maintainer-sponsored clears the restricted-surface Ready block", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        labels: ["maintainer-sponsored"],
        files: [
          { filename: "src/codex/auth-api.ts", patch: "+change" },
          { filename: "tests/codex-auth-api.test.ts", patch: "+test" },
        ],
      });

      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
      expect(methodsOf(result)).toContain("issues.addLabels");
      const graphqlCalls = callsTo(result, "graphql") as Array<{ query: string }>;
      expect(
        graphqlCalls.some(call => call.query.includes("markPullRequestReadyForReview")),
      ).toBe(true);
      expect(lastReadinessCommentBody(result)).toContain("## ✅ READY");
    });

    test("completing the checklist records the head it was completed on", async () => {
      // A pre-binding v1 state has no recorded SHA. Completion on the current
      // head binds forward instead of resetting, so a checklist that was
      // completed before this feature exists does not draft every already-ready
      // PR on the first run after the upgrade.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        comments: [readinessComment({
          version: 1,
          autoDraftedByBot: true,
          maintainersPinged: true,
        })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      const readinessBody = lastReadinessCommentBody(result);
      // The completion is bound to the exact head that was reviewed.
      expect(readinessBody).toContain(
        '"completedAtHeadSha":"3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b"',
      );
      // A migrated v1 state is rewritten at the current version.
      expect(readinessBody).toContain('"version":1');
      expect(readinessBody).toContain("**4/4** boxes ticked");
      // Already pinged before the upgrade: no second notification.
      expect(readinessBody).toContain('"maintainersPinged":true');
      expect(readinessBody).not.toContain("Maintainers notified");
    });

    test("new commits after checklist completion re-draft, reset the checklist, and clear the notification state", async () => {
      // The reviewer's gap: a completed checklist is an attestation about a
      // specific head. When new commits land, the attestation no longer covers
      // the code under review, so the gate resets the boxes and the maintainer
      // ping, converts the PR back to a draft, and tells the author to
      // re-test and re-tick on the latest code.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        comments: [readinessComment({
          version: 2,
          autoDraftedByBot: false,
          maintainersPinged: true,
          completedAtHeadSha: "1111111111111111111111111111111111111111",
        })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.get",
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
        "graphql",
      ]));
      const [resetBody] = callsTo(result, "pulls.update") as [{ body: string }];
      expect(resetBody.body).toContain(CHECKLIST_START);
      expect(resetBody.body).toContain("- [ ] All CI tests are green on my local testing.");
      expect(resetBody.body).toContain("- [ ] My PR is ready for review.");
      expect(resetBody.body).not.toContain("- [x]");

      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.query).toContain("convertPullRequestToDraft");
      expect(drafts[0]!.query).not.toContain("markPullRequestReadyForReview");

      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain("**0/4** boxes ticked");
      expect(readinessBody).toContain('"completedAtHeadSha":null');
      expect(readinessBody).toContain('"maintainersPinged":false');
      expect(readinessBody).toContain(
        "New commits were pushed after the checklist was completed on `1111111`",
      );
      expect(readinessBody).toContain(
        "The checklist has been reset: re-test against the latest code and tick all four boxes again.",
      );
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("a checklist completed on the current head is not reset on a rerun", async () => {
      // Same head, same boxes, already notified: the rerun is a no-op apart
      // from refreshing the readiness message. No re-draft, no body rewrite,
      // no second maintainer ping.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        comments: [readinessComment({
          version: 2,
          autoDraftedByBot: false,
          maintainersPinged: true,
          completedAtHeadSha: "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b",
        })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([]);
      // The only GraphQL call is the review-threads read; the completion is
      // already bound and green, so no mutation fires.
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.query).toContain("reviewThreads");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain("**4/4** boxes ticked");
      expect(readinessBody).toContain(
        '"completedAtHeadSha":"3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b"',
      );
      expect(readinessBody).toContain('"maintainersPinged":true');
      expect(readinessBody).not.toContain("Maintainers notified");
    });

    test("new commits after completion still enforce quality failures", async () => {
      // The head-drift reset folds into the existing failure path instead of
      // short-circuiting it: a PR that drifted onto a wrong base is drafted,
      // the checklist resets, AND the wrong-base gate still fails closed with
      // its title prefix and explanation.
      const result = await run({
        pr: {
          base: { ref: "main" },
          draft: false,
          title: "Add a thing",
          body: readinessChecklistBody(4),
        },
        comments: [readinessComment({
          version: 2,
          autoDraftedByBot: false,
          maintainersPinged: true,
          completedAtHeadSha: "1111111111111111111111111111111111111111",
        })],
      });

      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.get",
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
        "graphql",
      ]));
      expect(lastEnforcerCommentBody(result)).toContain("wrong target branch");
      expect(lastEnforcerCommentBody(result)).toContain("[WRONG BRANCH]");
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(true);

      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain("**0/4** boxes ticked");
      expect(readinessBody).toContain('"maintainersPinged":false');
      expect(readinessBody).toContain('"completedAtHeadSha":null');
      expect(readinessBody).toContain(
        "New commits were pushed after the checklist was completed",
      );
    });

    test("a completion whose ticks predate the live head is rejected and reset", async () => {
      // A push raced the `edited` job: the event saw the older head the boxes
      // were ticked against, but the live head is newer. Binding the
      // completion to the live head would attest code the author never ticked
      // against, so the gate rejects the completion, resets the boxes, and
      // re-drafts instead of sliding the attestation forward.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        eventPayload: {
          head: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        },
        maintainersFile: MAINTAINERS_FIXTURE,
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.get",
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.query).toContain("convertPullRequestToDraft");
      expect(drafts[0]!.query).not.toContain("markPullRequestReadyForReview");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain(
        "The checklist was ticked before the current head `3f1c0de` was pushed.",
      );
      expect(readinessBody).toContain("**0/4** boxes ticked");
      expect(readinessBody).toContain('"completedAtHeadSha":null');
      expect(readinessBody).toContain('"maintainersPinged":false');
      expect(readinessBody).not.toContain("Maintainers notified");
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("a synchronize event does not inherit an unrecorded complete checklist", async () => {
      // The boxes were ticked on head A, but the edited job has not yet
      // persisted completedAtHeadSha. A synchronize for head B must not
      // mark B ready with A's attestation; it must reset and re-draft.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        eventAction: "synchronize",
        maintainersFile: MAINTAINERS_FIXTURE,
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.get",
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.query).toContain("convertPullRequestToDraft");
      expect(drafts[0]!.query).not.toContain("markPullRequestReadyForReview");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain(
        "A complete checklist was found on a synchronize event with no recorded completion head",
      );
      expect(readinessBody).toContain("**0/4** boxes ticked");
      expect(readinessBody).toContain('"completedAtHeadSha":null');
      expect(readinessBody).toContain('"maintainersPinged":false');
      expect(readinessBody).not.toContain("Maintainers notified");
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("red GitHub CI does not untick the local-CI attestation", async () => {
      // Fork contributors attest local green; repository CI is
      // maintainer-started. A red or missing GitHub `ci` check must not
      // disprove the local box or block ready-for-review.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        checkRuns: [{ name: "ci", status: "completed", conclusion: "failure" }],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
      ]));
      expect(callsTo(result, "checks.listForRef")).toEqual([]);
      expect(callsTo(result, "pulls.update")).toEqual([]);
      const drafts = callsTo(result, "graphql") as [{ query: string }, { query: string }];
      expect(drafts[0]!.query).toContain("reviewThreads");
      expect(drafts[1]!.query).toContain("markPullRequestReadyForReview");
      expect(lastReadinessCommentBody(result)).toContain("**4/4** boxes ticked");
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("a revalidation reset preserves bot ownership of the title prefix", async () => {
      // A wrong-base PR that the bot prefixed and later had retargeted to dev
      // with a complete checklist hits a revalidation failure (stale vs `dev`
      // unchecks a box). The reset must preserve `titlePrefixedByBot` long
      // enough for the mustDraft strip to fire — otherwise the stale
      // `[WRONG BRANCH] ` prefix stays on the title forever because ownership
      // was forgotten.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Add a thing",
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        compareByBasehead: {
          "dev...3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b": { ahead_by: 0, behind_by: 11 },
        },
        comments: [botComment({
          version: 1,
          active: true,
          autoDraftedByBot: true,
          titlePrefixedByBot: true,
        })],
      });

      const titleUpdates = callsTo(result, "pulls.update") as Array<{ title?: string; body?: string }>;
      // The stale prefix is stripped (the ownership survived the reset long
      // enough for the strip to run), and the state records ownership cleared.
      expect(titleUpdates.some(u => u.title === "Add a thing")).toBe(true);
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain('"titlePrefixedByBot":false');
      expect(readinessBody).toContain('"autoDraftedByBot":true');
      expect(readinessBody).toContain("more than 10 commits behind `dev`");
    });

    test("a complete checklist more than 10 commits behind dev unchecks the latest-dev box and re-drafts", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        compareByBasehead: {
          "dev...3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b": { ahead_by: 0, behind_by: 11 },
        },
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "pulls.get",
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      const [bodyUpdate] = callsTo(result, "pulls.update") as [{ body: string }];
      // Only the latest-dev box is unticked; local CI stays checked.
      expect(bodyUpdate.body).toContain("- [x] All CI tests are green on my local testing.");
      expect(bodyUpdate.body).toContain("- [ ] I pushed my PR to the latest dev commit.");
      expect(bodyUpdate.body).toContain("- [x] My PR is ready for review.");
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(2);
      expect(drafts[0]!.query).toContain("reviewThreads");
      expect(drafts[1]!.query).toContain("convertPullRequestToDraft");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain(
        "The PR is more than 10 commits behind `dev`; the **latest dev** box has been unticked.",
      );
      expect(readinessBody).toContain("**3/4** boxes ticked");
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("a head exactly 10 commits behind dev keeps the latest-dev box", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        compareByBasehead: {
          "dev...3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b": { ahead_by: 0, behind_by: 10 },
        },
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([]);
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(2);
      expect(drafts[0]!.query).toContain("reviewThreads");
      expect(drafts[1]!.query).toContain("markPullRequestReadyForReview");
    });

    test("missing or pending GitHub CI does not block a complete local attestation", async () => {
      for (const checkRuns of [
        [],
        [{ name: "ci", status: "in_progress", conclusion: null }],
        [{
          name: "ci",
          status: "completed",
          conclusion: "success",
          app: { id: 999999 },
        }],
      ]) {
        const result = await run({
          pr: {
            base: { ref: "dev" },
            draft: true,
            body: readinessChecklistBody(4),
          },
          maintainersFile: MAINTAINERS_FIXTURE,
          checkRuns,
        });

        expect(callsTo(result, "checks.listForRef")).toEqual([]);
        expect(callsTo(result, "pulls.update")).toEqual([]);
        const drafts = callsTo(result, "graphql") as [{ query: string }, { query: string }];
        expect(drafts[1]!.query).toContain("markPullRequestReadyForReview");
        expect(lastReadinessCommentBody(result)).toContain("**4/4** boxes ticked");
      }
    });

    test("an unresolved Codex thread unchecks the findings box and re-drafts", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        reviewThreads: [
          { isResolved: false, author: { login: "chatgpt-codex-connector[bot]" } },
        ],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "pulls.get",
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      const [bodyUpdate] = callsTo(result, "pulls.update") as [{ body: string }];
      // Only the findings box is unticked; CI and latest-dev stay checked.
      expect(bodyUpdate.body).toContain("- [x] All CI tests are green on my local testing.");
      expect(bodyUpdate.body).toContain("- [x] I pushed my PR to the latest dev commit.");
      expect(bodyUpdate.body).toContain("- [ ] I resolved all correct Codex and CodeRabbit findings.");
      expect(bodyUpdate.body).toContain("- [x] My PR is ready for review.");
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(2);
      expect(drafts[0]!.query).toContain("reviewThreads");
      expect(drafts[1]!.query).toContain("convertPullRequestToDraft");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain(
        "Codex has 1 unresolved finding; the **Codex/CodeRabbit findings** box has been unticked.",
      );
      expect(readinessBody).toContain("**3/4** boxes ticked");
      expect(readinessBody).toContain('"completedAtHeadSha":null');
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("an unresolved CodeRabbit thread unchecks the findings box and re-drafts", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        reviewThreads: [
          { isResolved: false, author: { login: "coderabbitai[bot]" } },
        ],
      });

      const [bodyUpdate] = callsTo(result, "pulls.update") as [{ body: string }];
      expect(bodyUpdate.body).toContain("- [ ] I resolved all correct Codex and CodeRabbit findings.");
      expect(bodyUpdate.body).toContain("- [x] My PR is ready for review.");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain(
        "CodeRabbit has 1 unresolved finding; the **Codex/CodeRabbit findings** box has been unticked.",
      );
    });

    test("all bot threads resolved keeps the findings box and marks ready", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        reviewThreads: [
          { isResolved: true, author: { login: "chatgpt-codex-connector[bot]" } },
          { isResolved: true, author: { login: "coderabbitai[bot]" } },
        ],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([]);
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(2);
      expect(drafts[0]!.query).toContain("reviewThreads");
      expect(drafts[1]!.query).toContain("markPullRequestReadyForReview");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain("**4/4** boxes ticked");
    });

    test("CodeRabbit outside-diff findings do not untick the box once threads are clean", async () => {
      // CodeRabbit posts some findings only in its review body ("outside the
      // diff range"), which never become review threads. A review body is
      // immutable, so the count can never fall to zero on its own once posted;
      // the supplement therefore only counts while an unresolved bot thread
      // exists. Clean threads + a live-head review body with a positive count
      // must stay green — otherwise the author could never clear the box
      // without pushing an empty commit.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        reviews: [
          {
            body: "**Actionable comments posted: 2**\n\nWalkthrough.",
            commit_id: "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b",
            submitted_at: "2026-08-04T06:24:02Z",
            user: { login: "coderabbitai[bot]" },
          },
        ],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([]);
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain("**4/4** boxes ticked");
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("CodeRabbit outside-diff findings add to an unresolved thread count", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        reviewThreads: [
          { isResolved: false, author: { login: "coderabbitai[bot]" } },
        ],
        reviews: [
          {
            body: "**Actionable comments posted: 2**\n\nWalkthrough.",
            commit_id: "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b",
            submitted_at: "2026-08-04T06:24:02Z",
            user: { login: "coderabbitai[bot]" },
          },
        ],
      });

      const [bodyUpdate] = callsTo(result, "pulls.update") as [{ body: string }];
      expect(bodyUpdate.body).toContain("- [ ] I resolved all correct Codex and CodeRabbit findings.");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain(
        "CodeRabbit has 3 unresolved findings; the **Codex/CodeRabbit findings** box has been unticked.",
      );
      expect(readinessBody).toContain("**3/4** boxes ticked");
    });

    test("a CodeRabbit outside-diff review of a stale head does not untick the box", async () => {
      // The supplement is head-bound: a review of a superseded commit cannot
      // flag the current head. Clean threads + a stale review stay green.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        reviews: [
          {
            body: "**Actionable comments posted: 2**",
            commit_id: "1111111111111111111111111111111111111111",
            submitted_at: "2026-08-04T06:24:02Z",
            user: { login: "coderabbitai[bot]" },
          },
        ],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([]);
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(2);
      expect(drafts[0]!.query).toContain("reviewThreads");
      expect(drafts[1]!.query).toContain("markPullRequestReadyForReview");
      expect(lastReadinessCommentBody(result)).toContain("**4/4** boxes ticked");
    });

    test("an unresolved human review thread does not untick the findings box", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        reviewThreads: [
          { isResolved: false, author: { login: "wibias" } },
        ],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([]);
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(2);
      expect(drafts[1]!.query).toContain("markPullRequestReadyForReview");
      expect(lastReadinessCommentBody(result)).toContain("**4/4** boxes ticked");
    });

    test("a human review quoting the actionable-comments line does not untick the box", async () => {
      // The outside-diff supplement filters by author: a maintainer quoting
      // CodeRabbit's summary in their own review must not count as CodeRabbit
      // findings, or the box would be unticked by a human's quote.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        reviewThreads: [
          { isResolved: false, author: { login: "coderabbitai[bot]" } },
        ],
        reviews: [
          {
            body: "CodeRabbit said **Actionable comments posted: 2** — let's discuss.",
            commit_id: "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b",
            submitted_at: "2026-08-04T06:24:02Z",
            user: { login: "wibias" },
          },
        ],
      });

      // Only the unresolved thread counts (1), not the human's quoted line.
      const [bodyUpdate] = callsTo(result, "pulls.update") as [{ body: string }];
      expect(bodyUpdate.body).toContain("- [ ] I resolved all correct Codex and CodeRabbit findings.");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain(
        "CodeRabbit has 1 unresolved finding; the **Codex/CodeRabbit findings** box has been unticked.",
      );
    });

    test("a review-threads lookup failure fails closed for the findings claim", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        // Only the review-threads read fails; the draft conversion must stay
        // green so the assert below is about the findings claim, not a
        // mutation failure.
        failGraphqlOn: ["reviewThreads"],
      });

      // The threads read fails closed: the findings box is unticked even
      // though no thread data was readable, and the PR stays a draft.
      const [bodyUpdate] = callsTo(result, "pulls.update") as [{ body: string }];
      expect(bodyUpdate.body).toContain("- [ ] I resolved all correct Codex and CodeRabbit findings.");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain(
        "The Codex/CodeRabbit findings claim could not be verified",
      );
      expect(result.warnings.some(w => w.includes("Could not list review threads for the readiness claim check"))).toBe(true);
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("a completion recorded while quality gates fail still binds the head", async () => {
      // The mustDraft failure path returns before the completion block, so
      // without an explicit record the checklist would stay unbound while a
      // quality gate is red — the author could push un-attested code and have
      // the newest head bound to the old attestation once the gate clears.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          title: "GUI: fix provider list spacing",
          body: readinessChecklistBody(4),
        },
        files: GUI_CHANGED_FILES,
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "issues.createComment",
        "graphql",
      ]));
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(true);
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain(
        '"completedAtHeadSha":"3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b"',
      );
      expect(readinessBody).toContain('"version":1');
      expect(readinessBody).toContain("**4/4** boxes ticked");
      expect(readinessBody).toContain(
        "This pull request is being kept as a draft automatically",
      );
    });

    test("a stale recorded head with an already-open checklist still recovers the reset state", async () => {
      // Partial-reset window: the body update succeeded but the readiness
      // comment failed, leaving unticked boxes with the old completion head
      // and ping flag. The stale-record detection must not depend on the
      // boxes being ticked, or the next completion would be reset one extra
      // cycle and the ping would silently survive.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: false,
          body: readinessChecklistBody(0),
        },
        comments: [readinessComment({
          version: 2,
          autoDraftedByBot: false,
          maintainersPinged: true,
          completedAtHeadSha: "1111111111111111111111111111111111111111",
        })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.get",
        "issues.createComment",
        "issues.deleteComment",
        "graphql",
      ]));
      // No body rewrite: the boxes are already unticked from the failed reset.
      expect(callsTo(result, "pulls.update")).toEqual([]);
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.query).toContain("convertPullRequestToDraft");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain('"completedAtHeadSha":null');
      expect(readinessBody).toContain('"maintainersPinged":false');
      expect(readinessBody).toContain(
        "New commits were pushed after the checklist was completed on `1111111`",
      );
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("a stale event on a never-completed checklist does not wipe bot state or post a reset notice", async () => {
      // `ticksPredateLiveHead` must only fire for an actual completion. A
      // stale event on an open checklist has nothing to reset: posting the
      // notice would be noise, and replacing the stored state would drop the
      // bot's draft-ownership record (`autoDraftedByBot`).
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(1),
        },
        eventPayload: {
          head: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        },
        comments: [readinessComment({
          version: 2,
          autoDraftedByBot: true,
          maintainersPinged: false,
        })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "issues.createComment",
        "issues.deleteComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(callsTo(result, "graphql")).toEqual([]);
      const readinessBody = lastReadinessCommentBody(result);
      // Ownership is preserved and no reset was performed or announced.
      expect(readinessBody).toContain('"autoDraftedByBot":true');
      expect(readinessBody).toContain('"completedAtHeadSha":null');
      expect(readinessBody).not.toContain("ticked before the current head");
      expect(readinessBody).not.toContain("has been reset");
    });

    test("an empty PR cannot be laundered into ready by ticking the injected boxes", async () => {
      // The unit tests pin `assessPrDescription` against the injected section.
      // This pins the sequence that would exploit it end to end, because the
      // exploit needs two runs and a body the bot itself wrote in between:
      // open with no description (run one injects), tick the four boxes the
      // bot just added (run two), and the PR is ready for review with the
      // author having written nothing at all.
      const { script } = await readEnforcePrTarget();
      const injectRun = await runEnforcePrTarget(script, {
        pr: { base: { ref: "dev" }, draft: false, body: "" },
        authorPermission: "read",
      });
      expect(
        injectRun.warnings.some(
          w => w.startsWith("setFailed:") && w.includes("bad description"),
        ),
      ).toBe(true);

      // Take the body the bot actually wrote, not a hand-built fixture: the
      // exploit is only real if the injected text is what gets ticked.
      const injectedBody = (
        callsTo(injectRun, "pulls.update") as Array<{ body?: string }>
      ).find(call => typeof call.body === "string")?.body;
      expect(injectedBody).toContain(CHECKLIST_START);

      const tickedRun = await runEnforcePrTarget(script, {
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: injectedBody!.replace(/- \[ \]/g, "- [x]"),
        },
        authorPermission: "read",
        maintainersFile: MAINTAINERS_FIXTURE,
      });
      expect(
        tickedRun.warnings.some(
          w => w.startsWith("setFailed:") && w.includes("bad description"),
        ),
      ).toBe(true);
      // `markPullRequestReadyForReview` goes out over `graphql`. Four ticked
      // boxes must not summon it while the description gate is still failing.
      expect(methodsOf(tickedRun)).not.toContain("graphql");
    });

    test("the injected checklist does not satisfy the gui screenshot gate", async () => {
      // Same laundering shape on the screenshot axis: the injected section adds
      // renderable structure but no image, so a gui-cued contributor PR with a
      // complete checklist and no screenshot must still fail and stay drafted.
      const guiBody = [
        "## Summary",
        "",
        "Reworks the gui settings panel so the provider list keeps its scroll",
        "position when a preset is applied from the sidebar.",
        "",
        "## Test plan",
        "",
        "`bun run build:gui` — pass; verified by hand in the dashboard.",
      ].join("\n");
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4, guiBody),
        },
        authorPermission: "read",
        maintainersFile: MAINTAINERS_FIXTURE,
        files: GUI_CHANGED_FILES,
      });
      expect(
        result.warnings.some(
          w => w.startsWith("setFailed:") && w.includes("screenshot"),
        ),
      ).toBe(true);
      expect(methodsOf(result)).not.toContain("graphql");
    });

    test("a maintainer PR drafted during a permission-lookup failure is restored once the lookup recovers", async () => {
      // The permission lookup fails closed: a clean maintainer PR is treated
      // as a contributor PR, gets the checklist and a draft. When the lookup
      // recovers, the early return must not leave that PR drafted forever —
      // the readiness state records the bot's draft, and the recovery path
      // undoes it.
      const { script } = await readEnforcePrTarget();
      const duringFailure = await runEnforcePrTarget(script, {
        pr: { base: { ref: "dev" }, draft: false },
        failPermissionLookup: true,
      });
      expect(methodsOf(duringFailure)).toEqual(readsAllowedBase([
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      expect(lastReadinessCommentBody(duringFailure)).toContain('"autoDraftedByBot":true');

      const recovered = await runEnforcePrTarget(script, {
        pr: { base: { ref: "dev" }, draft: true, body: readinessChecklistBody(0) },
        authorPermission: "write",
        maintainersFile: MAINTAINERS_FIXTURE,
        comments: [readinessComment({
          version: 1,
          autoDraftedByBot: true,
          maintainersPinged: false,
        })],
      });
      expect(methodsOf(recovered)).toEqual(readsAllowedBase([
        "pulls.update",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      // The injected checklist is retired from the maintainer's body.
      const [stripped] = callsTo(recovered, "pulls.update") as [{ body: string }];
      expect(stripped.body).not.toContain(CHECKLIST_START);
      const drafts = callsTo(recovered, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.query).toContain("markPullRequestReadyForReview");
      const readinessBody = lastReadinessCommentBody(recovered);
      expect(readinessBody).toContain("## ✅ READY");
      expect(readinessBody).toContain("this PR is ready for review");
      expect(readinessBody).not.toContain("## Review readiness checklist");
      expect(readinessBody).not.toContain("⬜");
      expect(readinessBody).toContain('"autoDraftedByBot":false');
      expect(recovered.warnings.some(w => w.startsWith("setFailed:"))).toBe(false);
    });

    test("permission recovery keeps draft ownership when ready conversion fails", async () => {
      // If markReadyForReview fails transiently during recovery, the readiness
      // state must keep autoDraftedByBot so a later run retries — otherwise
      // the maintainer's PR stays a draft forever with a comment claiming it
      // is ready.
      const { script } = await readEnforcePrTarget();
      const result = await runEnforcePrTarget(script, {
        pr: { base: { ref: "dev" }, draft: true, body: readinessChecklistBody(0) },
        authorPermission: "write",
        maintainersFile: MAINTAINERS_FIXTURE,
        comments: [readinessComment({
          version: 1,
          autoDraftedByBot: true,
          maintainersPinged: false,
        })],
        failOn: ["graphql"],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      expect(result.warnings.some(w =>
        w.includes("Could not mark pull request ready for review"),
      )).toBe(true);
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain('"autoDraftedByBot":true');
      expect(readinessBody).toContain("will retry on the next run");
      expect(readinessBody).not.toContain("✅ This PR is ready for review.");
    });

    test("a contributor completing the checklist with a corrupted enforcer comment still completes", async () => {
      // `parseState` returns null for malformed state, but the bot comment
      // still exists — the restore path must not dereference `storedState`
      // unguarded (CodeRabbit critical + Codex review P2).
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        comments: [{
          id: 7,
          user: { login: BOT },
          body: `${MARKER}\n<!-- wrong-branch-enforcer-state:{not json} -->`,
        }],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(2);
      expect(drafts[0]!.query).toContain("reviewThreads");
      expect(drafts[1]!.query).toContain("markPullRequestReadyForReview");
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain('"active":false');
      expect(readinessBody).toContain("all PR quality gates passed");
      expect(result.warnings.join(" ")).toContain("Could not parse stored workflow state");
    });

    test("a complete checklist does not lift the draft while the base is wrong", async () => {
      const result = await run({
        pr: {
          base: { ref: "main" },
          draft: true,
          title: "Add a thing",
          body: readinessChecklistBody(4),
        },
      });

      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "issues.createComment",
      ]));
      expect(callsTo(result, "graphql")).toEqual([]);
      expect(lastEnforcerCommentBody(result)).toContain("wrong target branch");
      expect(lastReadinessCommentBody(result)).toContain("**4/4** boxes ticked");
      expect(result.warnings.some(w => w.startsWith("setFailed:"))).toBe(true);
    });

    test("a maintainer PR on the wrong base gets no readiness checklist", async () => {
      const result = await run({
        pr: { base: { ref: "main" }, title: "Add a thing", draft: false },
        authorPermission: "write",
      });

      // The maintainer contract is unchanged: draft on failure, explain, and
      // nothing else — no checklist injection, no readiness message.
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] Add a thing" },
      ]);
      expect(
        (callsTo(result, "issues.createComment") as [{ body: string }])
          .every(call => !call.body.includes(READINESS_MARKER)),
      ).toBe(true);
    });

    const HEAD_SHA = "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b";
    const ANCESTRY_FAIL_COMPARES = {
      [`main...${HEAD_SHA}`]: { ahead_by: 1, behind_by: 0 },
      [`dev...${HEAD_SHA}`]: { ahead_by: 0, behind_by: 44 },
    } as const;

    test("wrong ancestry on dev fails without title prefix (#644)", async () => {
      const result = await run({
        pr: { base: { ref: "dev" } },
        authorPermission: "read",
        compareByBasehead: ANCESTRY_FAIL_COMPARES,
      });

      // No wrong base, so no title write — the checklist injection is the only
      // `pulls.update`, and the contributor flow writes the ownership
      // checkpoint comment before the draft conversion.
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      const commentBody = lastEnforcerCommentBody(result);
      expect(commentBody).toContain("wrong branch ancestry");
      expect(commentBody).not.toContain("wrong target branch");
      expect(commentBody).toContain("## Review readiness checklist");
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("wrong ancestry"))).toBe(true);
    });

    test("maintainers skip ancestry enforcement with the same compares", async () => {
      const result = await run({
        pr: { base: { ref: "dev" } },
        authorPermission: "write",
        compareByBasehead: ANCESTRY_FAIL_COMPARES,
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase());
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
    });

    test("empty PR description fails and drafts", async () => {
      const result = await run({ pr: { base: { ref: "dev" }, body: "" } });

      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("PR description needs work");
      expect(lastEnforcerCommentBody(result)).toContain("(empty)");
      // The bot also injects the checklist, so the draft conversion is the only
      // GraphQL mutation.
      expect(callsTo(result, "graphql")).toHaveLength(1);
      const [draft] = callsTo(result, "graphql") as [{ query: string }];
      expect(draft.query).toContain("convertPullRequestToDraft");
      const [injected] = callsTo(result, "pulls.update") as [{ body: string }];
      expect(injected.body).toContain(CHECKLIST_START);
    });

    test("gui/ changes without a screenshot fail and draft", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, title: "Fix dashboard spacing" },
        files: GUI_CHANGED_FILES,
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot required");
      expect(lastEnforcerCommentBody(result)).toContain(
        "screenshot of the UI change",
      );
      expect(callsTo(result, "graphql")).toHaveLength(1);
    });

    test("gui in the title alone does not demand a screenshot", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, title: "GUI: fix provider list spacing" },
        authorPermission: "write",
        files: [{ filename: "scripts/foo.ts" }],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase());
      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(false);
    });

    test("no gui changes text without gui/ file changes does not demand a screenshot", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "Fix proxy routing",
          body: [
            "## Summary",
            "",
            "This change adjusts proxy routing only; there are no gui changes in this PR.",
            "The handler in scripts/foo.ts keeps the same public surface while fixing retry semantics.",
            "",
            "## Test plan",
            "",
            "- Ran \`bun test tests/ci-workflows.test.ts\`",
          ].join("\n"),
        },
        authorPermission: "write",
        files: [{ filename: "scripts/foo.ts" }],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase());
      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(false);
    });

    test("malformed changed_files metadata fails closed on the screenshot gate", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          changed_files: 2.5,
        },
        files: [{ filename: "scripts/foo.ts" }],
        authorPermission: "write",
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot required");
    });

    test("gui in the body without a screenshot fails when gui/ changed", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "Fix dashboard spacing",
          body: [
            "## Summary",
            "This change adjusts gui/ spacing tokens used by the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        files: GUI_CHANGED_FILES,
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot required");
    });

    test("an OWNER comment waiving gui skips the screenshot gate", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "Fix dashboard spacing",
          body: [
            "## Summary",
            "This change adjusts gui/ spacing tokens used by the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        comments: [
          { id: 1, user: { login: "lidge-jun" }, author_association: "OWNER", body: "Not touching gui here." },
        ],
        files: GUI_CHANGED_FILES,
      });

      // The screenshot failure is gone: no setFailed for it, and the comment
      // does not demand a screenshot. The contributor checklist still applies.
      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(false);
      expect(lastEnforcerCommentBody(result)).not.toContain("UI screenshot required");
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot waived by a maintainer comment");
    });

    test("a COLLABORATOR comment saying no gui changes also waives it", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        comments: [
          { id: 1, user: { login: "wibias" }, author_association: "COLLABORATOR", body: "no gui changes needed" },
        ],
        files: GUI_CHANGED_FILES,
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(false);
      expect(lastEnforcerCommentBody(result)).not.toContain("UI screenshot required");
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot waived by a maintainer comment");
    });

    test("the gui-screenshot-waived label clears the sole screenshot failure and reports the waiver", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        labels: ["gui-screenshot-waived"],
        maintainersFile: MAINTAINERS_FIXTURE,
        eventName: "pull_request_target",
        eventAction: "synchronize",
        senderLogin: "contributor",
        issueEvents: [{
          id: 101,
          event: "labeled",
          created_at: "2026-08-08T06:00:00Z",
          actor: { login: "lidge-jun" },
          label: { name: "gui-screenshot-waived" },
        }],
        files: GUI_CHANGED_FILES,
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(false);
      expect(lastEnforcerCommentBody(result)).not.toContain("UI screenshot required");
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot waived by the `gui-screenshot-waived` label");
    });


    test("the gui-screenshot-waived label is reported after it clears the sole failure on the ready path", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "GUI: fix provider list spacing",
          body: readinessChecklistBody(4),
        },
        labels: ["gui-screenshot-waived"],
        maintainersFile: MAINTAINERS_FIXTURE,
        eventName: "pull_request_target",
        eventAction: "edited",
        senderLogin: "contributor",
        issueEvents: [{
          id: 101,
          event: "labeled",
          created_at: "2026-08-08T06:00:00Z",
          actor: { login: "lidge-jun" },
          label: { name: "gui-screenshot-waived" },
        }],
        files: GUI_CHANGED_FILES,
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(false);
      expect(lastEnforcerCommentBody(result)).toContain("## ✅ READY");
      expect(lastEnforcerCommentBody(result)).not.toContain("UI screenshot required");
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot waived by the `gui-screenshot-waived` label");
    });

    test("the gui-screenshot-waived label from an unauthorized sender does not waive the screenshot requirement", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        labels: ["gui-screenshot-waived"],
        maintainersFile: MAINTAINERS_FIXTURE,
        eventName: "pull_request_target",
        eventAction: "synchronize",
        senderLogin: "lidge-jun",
        issueEvents: [{
          id: 102,
          event: "labeled",
          created_at: "2026-08-08T06:00:00Z",
          actor: { login: "unauthorized-contributor" },
          label: { name: "gui-screenshot-waived" },
        }],
        files: GUI_CHANGED_FILES,
      });

      // The screenshot failure must remain because the label was applied by
      // an unauthorized user (not in MAINTAINERS.md).
      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot required");
      expect(lastEnforcerCommentBody(result)).not.toContain("UI screenshot waived");
      expect(result.logs.join(" ")).toContain("unauthorized-contributor");
      expect(result.logs.join(" ")).toContain("not in MAINTAINERS.md");
    });

    test("a missing resolved PR number fails closed before PR lookup", async () => {
      const result = await run({
        pr: { base: { ref: "dev" } },
        resolvedPullNumber: "",
      });

      expect(result.logs.join(" ")).toContain("No pull request could be resolved for this gate event; skipping");
      expect(callsTo(result, "pulls.get")).toEqual([]);
      expect(callsTo(result, "issues.createComment")).toEqual([]);
      expect(callsTo(result, "issues.updateComment")).toEqual([]);
      expect(callsTo(result, "graphql")).toEqual([]);
    });

    test("the write gate consumes the resolved PR number without re-resolving status SHA", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, number: 4242 },
        eventName: "status",
        resolvedPullNumber: 4242,
      });

      expect(callsTo(result, "pulls.get")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 4242 },
        { owner: "lidge-jun", repo: "opencodex", pull_number: 4242 },
        { owner: "lidge-jun", repo: "opencodex", pull_number: 4242 },
      ]);
      expect(callsTo(result, "repos.listPullRequestsAssociatedWithCommit")).toEqual([]);
      expect(methodsOf(result)).toContain("issues.listComments");
    });

    test("the resolver falls back to the head SHA when the commit-PR index is empty", async () => {
      const headSha = "6c42d17f213a632fc2def56053f0cd574b13d459";
      const result = await runResolver({
        pr: { base: { ref: "dev" }, number: 4242, head: { sha: headSha } },
        eventName: "status",
        statusSha: headSha,
        // GitHub's commit-to-PR index can lag a fresh push (seen on #1441):
        // the association endpoint returns no PR for a genuine current head.
        associatedPullRequests: [],
        openPulls: [
          { number: 4242, state: "open", head: { sha: headSha } },
          { number: 9999, state: "open", head: { sha: "other" } },
          { number: 100, state: "closed", head: { sha: headSha } },
        ],
      });

      expect(result.outputs).toEqual([{ name: "pull-number", value: "4242" }]);
      // The fallback must consult the live open-PR list exactly once.
      expect(callsTo(result, "repos.listPullRequestsAssociatedWithCommit")).toHaveLength(1);
      expect(callsTo(result, "pulls.list")).toHaveLength(1);
      expect(result.logs.join(" ")).toContain("Associated-index fallback");
      // A closed PR with the same head must not count as a candidate.
      expect(result.logs.join(" ")).toContain("1 open PR(s) match head");
    });

    test("the resolver skips when the fallback finds no unique open head match", async () => {
      const headSha = "6c42d17f213a632fc2def56053f0cd574b13d459";
      const result = await runResolver({
        pr: { base: { ref: "dev" }, number: 4242, head: { sha: headSha } },
        eventName: "status",
        statusSha: headSha,
        associatedPullRequests: [],
        // No open PR carries this head; the stale index is not a match.
        openPulls: [
          { number: 9999, state: "open", head: { sha: "other" } },
        ],
      });

      expect(result.outputs).toEqual([]);
      // The fallback must actually have run: the resolver consults the live
      // open-PR list exactly once. Without this assertion the test would still
      // pass if the fallback were removed (the empty association index by
      // itself already skips), silently losing coverage of the head-SHA
      // reconciliation path.
      expect(callsTo(result, "pulls.list")).toHaveLength(1);
      expect(callsTo(result, "pulls.list")[0]).toMatchObject({
        owner: "lidge-jun",
        repo: "opencodex",
        state: "open",
      });
      expect(result.logs.join(" ")).toContain("skipping ambiguous/stale revalidation");
    });

    test("the resolver fails closed when two open PRs share the head SHA", async () => {
      const headSha = "6c42d17f213a632fc2def56053f0cd574b13d459";
      const result = await runResolver({
        pr: { base: { ref: "dev" }, number: 4242, head: { sha: headSha } },
        eventName: "status",
        statusSha: headSha,
        associatedPullRequests: [],
        // Two open PRs on the same head: the live lookup is ambiguous, so the
        // resolver must fail closed rather than guess which PR to revalidate.
        openPulls: [
          { number: 4242, state: "open", head: { sha: headSha } },
          { number: 7777, state: "open", head: { sha: headSha } },
        ],
      });

      expect(result.outputs).toEqual([]);
      // The live fallback must actually have run before the ambiguity is
      // detected: the resolver consults the open-PR list exactly once and
      // weighs both same-head candidates before failing closed. Without this
      // assertion the test would still pass if the fallback were removed (the
      // empty association index by itself already skips), silently losing
      // coverage of the head-SHA reconciliation path.
      expect(callsTo(result, "pulls.list")).toHaveLength(1);
      expect(callsTo(result, "pulls.list")[0]).toMatchObject({
        owner: "lidge-jun",
        repo: "opencodex",
        state: "open",
      });
      expect(result.logs.join(" ")).toContain("skipping ambiguous/stale revalidation");
    });

    test("the resolver resolves via the association index when it is already fresh", async () => {
      const headSha = "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b";
      const result = await runResolver({
        pr: { base: { ref: "dev" }, number: 42, head: { sha: headSha } },
        eventName: "status",
        statusSha: headSha,
        associatedPullRequests: [
          { number: 42, state: "open", head: { sha: headSha } },
        ],
      });

      expect(result.outputs).toEqual([{ name: "pull-number", value: "42" }]);
      // A unique index hit must not need the open-PR fallback.
      expect(callsTo(result, "pulls.list")).toEqual([]);
    });

    test("the resolver fails closed when both resolution paths error", async () => {
      const headSha = "6c42d17f213a632fc2def56053f0cd574b13d459";
      const result = await runResolver({
        pr: { base: { ref: "dev" }, number: 4242, head: { sha: headSha } },
        eventName: "status",
        statusSha: headSha,
        associatedPullRequests: [],
        failOn: [
          "repos.listPullRequestsAssociatedWithCommit",
          "pulls.list",
        ],
      });

      expect(result.outputs).toEqual([]);
      expect(result.logs.join(" ")).toContain("skipping ambiguous/stale revalidation");
      expect(result.warnings.join(" ")).toContain(
        "Could not list PRs associated with commit",
      );
      expect(result.warnings.join(" ")).toContain("Could not list open PRs");
    });

    test("a non-maintainer issue_comment does not re-run the gate", async () => {
      // The `issue_comment` trigger must only re-run for maintainer comments
      // (OWNER / COLLABORATOR / MEMBER). A random comment from a contributor
      // must not start the write-capable gate or re-draft the PR.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        eventName: "issue_comment",
        eventAction: "created",
        commentAuthorAssociation: "CONTRIBUTOR",
        comments: [
          { id: 1, user: { login: "someone" }, author_association: "CONTRIBUTOR", body: "looks good to me" },
        ],
      });

      // The gate never runs: no screenshot failure, no waiver notice, no draft
      // mutation, no comment write.
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
      expect(methodsOf(result)).not.toContain("issues.createComment");
      expect(methodsOf(result)).not.toContain("issues.updateComment");
      expect(methodsOf(result)).not.toContain("graphql");
    });

    test("an issue_comment on a plain issue does not re-run the gate", async () => {
      // `issue_comment` fires for comments on ANY issue. A comment on a plain
      // issue (no `issue.pull_request`) is not a PR comment and must not start
      // this PR-only gate.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        eventName: "issue_comment",
        eventAction: "created",
        issueIsPullRequest: false,
        comments: [
          { id: 1, user: { login: "wibias" }, author_association: "COLLABORATOR", body: "not touching gui" },
        ],
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
      expect(methodsOf(result)).not.toContain("issues.createComment");
      expect(methodsOf(result)).not.toContain("issues.updateComment");
      expect(methodsOf(result)).not.toContain("graphql");
    });

    test("a COLLABORATOR who is not in MAINTAINERS.md cannot re-run the gate", async () => {
      // OWNER/COLLABORATOR/MEMBER association is broader than the canonical
      // maintainer list. A collaborator or member who is absent from
      // MAINTAINERS.md must not start the write-capable gate — no PR lookup,
      // no comment/label/title/draft mutations.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        eventName: "issue_comment",
        eventAction: "created",
        commentAuthorAssociation: "COLLABORATOR",
        commentAuthorLogin: "someone-else",
        maintainersFile: MAINTAINERS_FIXTURE,
        comments: [
          { id: 1, user: { login: "someone-else" }, author_association: "COLLABORATOR", body: "not touching gui" },
        ],
      });

      // The in-script guard reads MAINTAINERS.md and skips before pulls.get:
      // no PR lookup, no writes, no GraphQL mutation.
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
      expect(methodsOf(result)).not.toContain("pulls.get");
      expect(methodsOf(result)).not.toContain("issues.createComment");
      expect(methodsOf(result)).not.toContain("issues.updateComment");
      expect(methodsOf(result)).not.toContain("graphql");
    });

    test("the gate comment preserves an existing hygiene section across rebuilds", async () => {
      // The hygiene workflow writes its status into the same consolidated gate
      // comment. When the gate rebuilds that comment, it must carry the
      // hygiene block forward instead of dropping it.
      const HYGIENE_BLOCK_START = "<!-- pr-hygiene-block:start -->";
      const HYGIENE_BLOCK_END = "<!-- pr-hygiene-block:end -->";
      const existingGateBody = [
        GATE_MARKER,
        '<!-- opencodex-pr-gate-state:{"version":1,"active":true,"autoDraftedByBot":false,"titlePrefixedByBot":false} -->',
        "",
        "## ⏳ DRAFT",
        "- PR is kept in draft.",
        "",
        "## Hygiene",
        "",
        HYGIENE_BLOCK_START,
        "<!-- pr-hygiene -->",
        "",
        "✅ **Deterministic PR hygiene checks passed.**",
        "",
        HYGIENE_BLOCK_END,
      ].join("\n");

      const result = await run({
        pr: { base: { ref: "dev" }, draft: false },
        authorPermission: "write",
        comments: [
          { id: 7, user: { login: "github-actions[bot]" }, body: existingGateBody },
        ],
      });

      const updated = callsTo(result, "issues.updateComment") as [{ body: string }];
      expect(updated.length).toBeGreaterThan(0);
      const gateUpdate = updated.find(call => call.body.includes(GATE_MARKER))!;
      expect(gateUpdate.body).toContain(HYGIENE_BLOCK_START);
      expect(gateUpdate.body).toContain(HYGIENE_BLOCK_END);
      expect(gateUpdate.body).toContain("✅ **Deterministic PR hygiene checks passed.**");
    });

    test("the PR author cannot waive their own screenshot requirement", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        comments: [
          { id: 1, user: { login: "contributor" }, author_association: "CONTRIBUTOR", body: "Not touching gui here." },
        ],
        files: GUI_CHANGED_FILES,
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot required");
      expect(lastEnforcerCommentBody(result)).not.toContain("UI screenshot waived");
    });

    test("a maintainer comment naming gui without negating keeps the gate", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        comments: [
          { id: 1, user: { login: "lidge-jun" }, author_association: "OWNER", body: "This is gui related, please add a screenshot." },
        ],
        files: GUI_CHANGED_FILES,
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:") && w.includes("screenshot"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot required");
    });

    test("gui with an embedded screenshot passes", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "![after](https://example.com/after.png)",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        authorPermission: "write",
        files: GUI_CHANGED_FILES,
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase());
      expect(result.logs.join(" ")).toContain("All PR quality gates passed");
    });

    test("gui with a reference-style screenshot passes", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "![after][shot]",
            "",
            "[shot]: https://example.com/after.png",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        authorPermission: "write",
        files: GUI_CHANGED_FILES,
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase());
      expect(result.logs.join(" ")).toContain("All PR quality gates passed");
    });

    test("gui with image syntax only inside a code fence still fails", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          title: "GUI: fix provider list spacing",
          body: [
            "## Summary",
            "This change fixes the provider list spacing in the dashboard.",
            "",
            "```",
            "![after](https://example.com/after.png)",
            "```",
            "",
            "## Test plan",
            "- Ran bun test tests/ci-workflows.test.ts",
          ].join("\n"),
        },
        files: GUI_CHANGED_FILES,
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("UI screenshot required");
    });

    test("guidance in the title does not demand a screenshot", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, title: "Add contributor guidance docs" },
        authorPermission: "write",
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase());
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
    });

    test("literal backslash-n in the body fails the description gate", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          body: "## Summary\\n\\nThis uses escaped newlines instead of real breaks.\\n\\n## Test plan\\n\\nAlso escaped here.",
        },
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("PR description needs work");
    });

    test("clears prior bot state when every gate passes again", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          body: readinessChecklistBody(4),
        },
        maintainersFile: MAINTAINERS_FIXTURE,
        comments: [botComment({
          version: 1,
          active: true,
          autoDraftedByBot: true,
          titlePrefixedByBot: false,
          ancestryFailed: true,
          descriptionFailed: true,
        })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
      const readinessBody = lastReadinessCommentBody(result);
      expect(readinessBody).toContain('"active":false');
      expect(readinessBody).toContain("all PR quality gates passed");

      // Checklist completion also lifts the draft and pings the maintainers.
      expect(readinessBody).toContain("**4/4** boxes ticked");
      expect(readinessBody).toContain("Maintainers notified: @lidge-jun @Ingwannu @Wibias");
      expect(readinessBody).toContain('"maintainersPinged":true');
      // The ping list is read through the recorded fs stub, and the change-log
      // duplicate of @Wibias is not re-added.
      expect(result.fsReads.some(read => read.endsWith("MAINTAINERS.md"))).toBe(true);
    });

    test("every base outside the allow-list is still blocked", async () => {
      // Widening a list is a one-token edit, and the danger is widening it too
      // far. These are the bases a contributor actually reaches for: the
      // release branch, its old name, the prerelease train, the retired Go
      // native-port line, and a topic branch. None of them is an integration
      // line any more — `dev` is the only one.
      for (const ref of ["main", "master", "preview", "dev2-go", "feature/x"]) {
        const result = await run({ pr: { base: { ref }, title: "Add a thing", draft: false } });

        expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
        expect(lastEnforcerCommentBody(result)).toContain(`wrong target branch (${ref})`);
        expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      }
    });

    test("a PR retargeted from main to dev is restored, not left prefixed", async () => {
      // A contributor who follows the bot's own instruction must end up with
      // their original title and ready state back. If the restoration path
      // does not fire, they are left with a permanently renamed, drafted PR
      // and no state to explain it.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Port the runtime entry",
          body: readinessChecklistBody(4),
        },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "pulls.update",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Port the runtime entry" },
      ]);
      const cleared = lastReadinessCommentBody(result);
      expect(cleared).toContain('"active":false');
      // The confirmation names the ready state, read from the live PR.
      expect(cleared).toContain("all PR quality gates passed");
    });

    test("a PR retargeted to dev with an open checklist stays a draft", async () => {
      // Retargeting clears the branch failure, but the readiness checklist is
      // still open, so the PR must NOT be marked ready. The enforcer message is
      // updated to say the branch is now correct and the checklist is pending.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Port the runtime entry",
        },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      expect(callsTo(result, "graphql")).toEqual([]);
      expect(lastEnforcerCommentBody(result)).toContain("review readiness checklist open");
      expect(lastEnforcerCommentBody(result)).toContain("**0/4** boxes ticked");
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
    });

    test("a PR moved from dev back to main is enforced again from a cleared state", async () => {
      // The other half of the round trip. After a restoration the marker is
      // inactive, so a move back out has to build fresh state rather than
      // reuse the cleared one, and must not stack a second prefix.
      const result = await run({
        pr: { base: { ref: "main" }, draft: false, title: "Port the runtime entry" },
        comments: [botComment({ version: 1, active: false, autoDraftedByBot: false, titlePrefixedByBot: false })],
      });

      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
        "graphql",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] Port the runtime entry" },
      ]);
      expect(lastEnforcerCommentBody(result)).toContain('"active":true');
      expect(lastEnforcerCommentBody(result)).toContain('"autoDraftedByBot":true');
      expect(lastEnforcerCommentBody(result)).toContain('"titlePrefixedByBot":true');
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
    });

    test("the wrong-target explanation names the one allowed base", async () => {
      // `dev` is the only integration line, so the instruction has to name it
      // without offering an alternative the gate would then reject.
      const result = await run({
        pr: { base: { ref: "main" }, title: "Add a thing", draft: false },
      });
      const commentBody = lastEnforcerCommentBody(result);

      expect(commentBody).toContain("wrong target branch (main)");
      expect(commentBody).toContain("Retarget this PR to `dev`");
      expect(commentBody).not.toContain("dev2-go");
    });

    test("a PR targeting main is prefixed, drafted, and explained — and nothing else", async () => {
      const result = await run({
        pr: { base: { ref: "main" }, title: "Add a thing", draft: false },
      });

      // Pending ownership first, then title prefix, then claim autoDraftedByBot and
      // checkpoint before convertToDraft so a successful convert followed by a
      // failed comment still restores later.
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));

      // The title update carries the title and nothing else. `base`, `state`
      // and `body` are all accepted by this endpoint; an audit round added
      // `base: "main"` here and no static assertion caught it.
      expect(callsTo(result, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] Add a thing" },
      ]);

      // The single comment create addresses this PR, by its own number.
      const createdComments = callsTo(result, "issues.createComment") as [{ issue_number: number; body: string }];
      const created = createdComments.find(call => call.body.includes(GATE_MARKER))!;
      expect(created.issue_number).toBe(42);
      expect(created.body).toContain(GATE_MARKER);
      const commentBody = lastEnforcerCommentBody(result);
      expect(commentBody).toContain("@contributor");
      expect(commentBody).toContain('"autoDraftedByBot":true');
      expect(commentBody).toContain("## Review readiness checklist");

      // The only GraphQL mutation is the draft conversion — not a retarget.
      const [draft] = callsTo(result, "graphql") as [{ query: string; variables: unknown }];
      expect(draft.query).toContain("convertPullRequestToDraft");
      expect(draft.query).not.toContain("updatePullRequest");
      expect(draft.variables).toEqual({ pullRequestId: "PR_kwDOnode42" });

      // Wrong-base runs must fail the required check even when mutations succeed.
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
    });

    test("a stacked PR targeting another open PR head is not wrong-base", async () => {
      const parentHead = "feature/parent-stack";
      const result = await run({
        pr: {
          number: 42,
          base: {
            ref: parentHead,
            repo: { name: "opencodex", owner: { login: "lidge-jun" } },
          },
          title: "Stacked child",
          draft: false,
        },
        authorPermission: "write",
        openPulls: [
          {
            number: 41,
            head: {
              ref: parentHead,
              repo: { name: "opencodex", owner: { login: "lidge-jun" } },
            },
          },
        ],
      });

      expect(methodsOf(result)).toEqual(readsWrongBase());
      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(callsTo(result, "graphql")).toEqual([]);
      expect(result.logs.join(" ")).toContain("treating as stacked");
      expect(result.logs.join(" ")).toContain("All PR quality gates passed");
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
    });

    test("a stacked parent found on open-PR page two is still exempt", async () => {
      const parentHead = "feature/parent-page-two";
      const filler = Array.from({ length: 100 }, (_, i) => ({
        number: 1000 + i,
        head: {
          ref: `feature/filler-${i}`,
          repo: { name: "opencodex", owner: { login: "lidge-jun" } },
        },
      }));
      const result = await run({
        pr: {
          number: 42,
          base: {
            ref: parentHead,
            repo: { name: "opencodex", owner: { login: "lidge-jun" } },
          },
          title: "Stacked child beyond page one",
          draft: false,
        },
        openPullPages: [
          filler,
          [
            {
              number: 41,
              head: {
                ref: parentHead,
                repo: { name: "opencodex", owner: { login: "lidge-jun" } },
              },
            },
          ],
        ],
        authorPermission: "write",
      });

      const listPages = callsTo(result, "pulls.list").map(
        (args) => Number((args as { page?: number }).page ?? 1),
      );
      expect(listPages).toEqual([1, 2]);
      expect(methodsOf(result).filter((m) => m === "pulls.list")).toHaveLength(2);
      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(result.logs.join(" ")).toContain("treating as stacked");
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
    });

    test("a non-dev base with no open parent PR is still wrong-base", async () => {
      const result = await run({
        pr: { base: { ref: "feature/orphan" }, title: "Orphan stack", draft: false },
        openPulls: [
          {
            number: 99,
            head: {
              ref: "feature/other",
              repo: { name: "opencodex", owner: { login: "lidge-jun" } },
            },
          },
        ],
      });

      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          title: "[WRONG BRANCH] Orphan stack",
        },
      ]);
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
    });

    test("a PR that was already a draft is not un-drafted afterwards", async () => {
      const wrong = await run({
        pr: { base: { ref: "main" }, draft: true },
      });

      // No draft conversion: it is already a draft. Pending ownership first,
      // then title prefix, then final explanation. State records that the bot
      // did not draft — which stops restore from marking it ready.
      expect(methodsOf(wrong)).toEqual(readsWrongBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
      ]));
      expect(lastEnforcerCommentBody(wrong)).toContain('"autoDraftedByBot":false');
      expect(wrong.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);

      // Now retarget it correctly, feeding that state back in.
      const restored = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: false, titlePrefixedByBot: true })],
      });

      // The prefix comes off; the draft stays — the checklist is still open and
      // the bot never drafted this PR. No GraphQL at all.
      expect(methodsOf(restored)).toEqual(readsAllowedBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      expect(callsTo(restored, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
      ]);
    });

    test("a corrected PR gets its title and ready state back", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Add a thing",
          body: readinessChecklistBody(4),
        },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "pulls.update",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
      ]);
      const drafts = callsTo(result, "graphql") as [{ query: string }];
      expect(drafts).toHaveLength(2);
      expect(drafts[0]!.query).toContain("reviewThreads");
      expect(drafts[1]!.query).toContain("markPullRequestReadyForReview");

      // The single consolidated comment is created, and the state is cleared
      // so a later run does not try to restore twice.
      const update = lastReadinessCommentBody(result);
      expect(update).toContain('"active":false');
      expect(update).toContain("all PR quality gates passed");
      expect(update).toContain("review readiness checklist is complete");
    });

    test("only this workflow's own prefix is removed, not a contributor's edits", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, draft: false, title: "[WRONG BRANCH] Add a thing (v2)" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: false, titlePrefixedByBot: true })],
      });

      expect(callsTo(result, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing (v2)" },
      ]);
    });

    test("a rerun on an already-handled PR does not stack prefixes or re-draft", async () => {
      const result = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      // The comment is refreshed (pending + final); title and draft are already right.
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
      ]));
    });

    test("the verdict comes from the fetched PR, not the stale event payload", async () => {
      // The event fired when the PR still targeted dev; by the time the job
      // runs it has been retargeted to main. The workflow refetches for exactly
      // this reason, and an audit round undid that with
      // `Object.assign(pr, context.payload.pull_request)` — invisible in a
      // harness where the two were the same object.
      const wentWrong = await run({
        pr: { base: { ref: "main" }, title: "Add a thing", draft: false },
        eventPayload: { base: { ref: "dev" }, title: "Add a thing", draft: false },
      });
      // Exact equality, not `toContain`. An audit round hung an extra
      // `github.request("POST /repos/attacker/other/issues", …)` off precisely
      // this path because it was the one scenario asserting loosely.
      expect(methodsOf(wentWrong)).toEqual(readsWrongBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      expect(callsTo(wentWrong, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] Add a thing" },
      ]);

      // …and the reverse: the event says main, the live PR says dev. No writes.
      const wasFixed = await run({
        pr: { base: { ref: "dev" } },
        eventPayload: { base: { ref: "main" } },
        authorPermission: "write",
      });
      expect(methodsOf(wasFixed)).toEqual(readsAllowedBase());
    });

    test("what the comment tells the author is the live base, not the event's", async () => {
      // Half of this gate is what it says. Reading `context.payload
      // .pull_request.base.ref` for the message alone keeps every call and
      // every argument identical while the text lies: a PR that actually
      // targets main gets drafted and told it "currently targets dev", so the
      // author sees nothing to fix. The corrected-path sentence has the same
      // hole in reverse.
      const wrongTarget = await run({
        pr: { base: { ref: "main" }, title: "Add a thing", draft: false },
        eventPayload: { base: { ref: "dev" }, title: "Add a thing", draft: false },
      });
      expect(lastEnforcerCommentBody(wrongTarget)).toContain("wrong target branch (main)");
      expect(lastEnforcerCommentBody(wrongTarget)).not.toContain("wrong target branch (dev)");

      // The corrected-path sentence: the event still carries the old wrong
      // base, the live PR is on dev. Naming the event's base here tells the
      // author their retarget did not take.
      const corrected = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        eventPayload: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: false, titlePrefixedByBot: true })],
      });
      const edited = lastReadinessCommentBody(corrected);
      expect(edited).toContain("review readiness checklist open");
      expect(edited).not.toContain("wrong target branch");
    });

    test("the bot finds its own comment even when it has scrolled onto a later page", async () => {
      // A busy PR pushes the bot comment off page one. Without pagination the
      // workflow does not find its state: it posts a SECOND comment and forgets
      // it had prefixed the title, so the prefix is never removed. An audit
      // round swapped `paginate` for a bare `listComments` and nothing noticed.
      const filler = Array.from({ length: 3 }, (_, index) => ({
        id: 100 + index,
        user: { login: "contributor" },
        body: "looks good",
      }));

      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Add a thing",
          body: readinessChecklistBody(4),
        },
        commentPages: [
          filler,
          [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
        ],
      });

      // Found it: the prefix comes off, the PR is marked ready, and the
      // existing enforcer comment is edited rather than duplicated. The one
      // created comment is the readiness checklist message, which did not
      // exist on the busy PR yet.
      expect(methodsOf(result)).toEqual(readsAllowedBasePaged([
        "graphql",
        "pulls.listReviews",
        "pulls.listReviews",
        "issues.addLabels",
        "pulls.update",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      const [created] = callsTo(result, "issues.createComment") as [{ body: string }];
      expect(created.body).toContain(GATE_MARKER);
      expect(created.body).not.toContain(MARKER);
    });

    test("a bot comment with unreadable state is treated as no state, not as a reason to stop", async () => {
      // `parseState` catches a JSON error and returns null. Nothing covered
      // that branch, so an audit round added `if (botComment && !storedState)
      // return;` — a wrong-target PR with one corrupted comment became a
      // permanent no-op, and every scenario still passed.
      const result = await run({
        pr: { base: { ref: "main" }, title: "Add a thing", draft: false },
        comments: [{
          id: 7,
          user: { login: BOT },
          body: `${MARKER}\n<!-- wrong-branch-enforcer-state:{not json} -->`,
        }],
      });

      // Enforcement still happens, and the unreadable comment is repaired in
      // place rather than duplicated.
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
        "graphql",
      ]));
      expect(result.warnings.join(" ")).toContain("Could not parse stored workflow state");
    });

    test("an active state that recorded no changes still enforces and still clears", async () => {
      // `{active: true, titlePrefixedByBot: false, autoDraftedByBot: false}` is
      // reachable — it is what a PR that was already prefixed and already a
      // draft leaves behind. No scenario covered it, so an audit round added
      // `if (storedState?.active && !titlePrefixedByBot && !autoDraftedByBot)
      // return;` to both halves and turned enforcement into a no-op.
      const noRecordedChanges = {
        version: 1,
        active: true,
        autoDraftedByBot: false,
        titlePrefixedByBot: false,
      };

      // Still wrong: refresh the explanation. Nothing to re-apply.
      const stillWrong = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment(noRecordedChanges)],
      });
      expect(methodsOf(stillWrong)).toEqual(readsWrongBase([
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
      ]));

      // Corrected branch, open checklist: nothing to undo, the enforcer state
      // is cleared (the checklist message now owns the draft), and the next
      // wrong-target event cannot resume from a stale record.
      const corrected = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment(noRecordedChanges)],
      });
      expect(methodsOf(corrected)).toEqual(readsAllowedBase([
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      const cleared = lastReadinessCommentBody(corrected);
      expect(cleared).toContain('"active":true');
      expect(cleared).toContain("review readiness checklist open");
    });

    test("a PR undrafted by hand before the retarget still gets its state cleared", async () => {
      // The bot drafted it, the author marked it ready again, then retargeted
      // to dev. `autoDraftedByBot: true` with `pr.draft: false` is reachable and
      // had no scenario, so an audit round added `if (autoDraftedByBot &&
      // !pr.draft) return;` — the state comment stays active forever and the
      // next wrong-target event resumes from a record that no longer matches.
      const result = await run({
        pr: { base: { ref: "dev" }, draft: false, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      // The prefix comes off, the state stays active, and the open checklist
      // re-drafts the PR the author undrafted by hand.
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "issues.deleteComment",
        "graphql",
      ]));
      const cleared = lastReadinessCommentBody(result);
      expect(cleared).toContain('"active":true');
      expect(cleared).toContain("review readiness checklist open");
    });

    test("a title the author already fixed by hand is not sliced a second time", async () => {
      // `titlePrefixedByBot: true` while the live title no longer starts with
      // the prefix — the author removed it themselves. Slicing anyway would eat
      // the first 15 characters of their title.
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "Add a thing",
          body: readinessChecklistBody(4),
        },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
    });

    test("the explanation tells the contributor what to do and where to read", async () => {
      // The comment is the entire user-facing half of this gate: a PR gets
      // renamed and drafted, and this is the only thing that says why. Round
      // ten deleted the @mention target and the contributing link separately;
      // both left every other assertion intact, and both leave a contributor
      // staring at a mangled PR with no notification and no next step.
      const result = await run({
        pr: { base: { ref: "main" }, title: "Add a thing", draft: false, user: { login: "someone-else" } },
      });

      const commentBody = lastEnforcerCommentBody(result);
      // Addressed to the PR author, so GitHub actually notifies them.
      expect(commentBody).toContain("@someone-else");
      // Names the branch involved, so the instruction is actionable.
      expect(commentBody).toContain("wrong target branch (main)");
      expect(commentBody).toContain("Retarget this PR to `dev`");
      // And carries the state the next run needs.
      expect(commentBody).toContain(GATE_MARKER);
      expect(commentBody).toContain('"version":1');
    });

    test("comment listing asks for full pages, so the bot's own comment is found", async () => {
      // `per_page` is a performance knob until it is a correctness one. At
      // per_page: 1 a busy PR needs a hundred round trips to find a comment
      // that page one used to hold, and any rate-limit or transient failure in
      // that sequence means the bot does not find its own state — so it posts a
      // duplicate and forgets what it changed. Round ten dropped it to 1 and
      // nothing failed.
      const result = await run({ pr: { base: { ref: "dev" } } });
      const [listed] = callsTo(result, "issues.listComments") as [{ per_page: number }];
      expect(listed.per_page).toBe(100);
    });

    test("the state marker keeps the version the reader expects", async () => {
      // Both halves of the workflow parse this JSON, and a comment written by
      // an older run is read by a newer one. Bumping `version` on the write
      // side without teaching the read side is how a PR ends up with state
      // nobody honours — the prefix stays on forever. Round ten bumped it to 2
      // and every test passed, because nothing asserted the value.
      const wrong = await run({ pr: { base: { ref: "main" }, draft: false } });
      const postedComments = callsTo(wrong, "issues.createComment") as [{ body: string }];
      const posted = postedComments.find(call => call.body.includes(GATE_MARKER))!;
      expect(posted.body).toContain('"version":1');

      const cleared = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Add a thing",
          body: readinessChecklistBody(4),
        },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });
      const done = lastReadinessCommentBody(cleared);
      expect(done).toContain('"version":1');
    });

    test("state written by an unknown version is still honoured on both paths", async () => {
      // The reader never looks at `version`. That is a deliberate property,
      // not an oversight: a comment written by a future run of this workflow
      // still has to be readable by the run that is executing now, or the
      // prefix it added stays on the PR forever with nothing left to remove
      // it. A version gate reads as defensive hygiene — `if (storedState &&
      // storedState.version !== 1) return;` — and verified reachable: with
      // that line in place, an active v2 marker on a corrected, drafted PR
      // produced only ["pulls.get", "issues.listComments"]. No title
      // restoration, no ready-for-review, permanently stuck.
      for (const version of [2, 99]) {
        const active = { version, active: true, autoDraftedByBot: true, titlePrefixedByBot: true };

        // Corrected target: the unknown-version state is trusted and both
        // changes are undone, and the marker is rewritten at the version this
        // workflow writes.
        const restored = await run({
          pr: {
            base: { ref: "dev" },
            draft: true,
            title: "[WRONG BRANCH] Add a thing",
            body: readinessChecklistBody(4),
          },
          comments: [botComment(active)],
        });
        expect(methodsOf(restored)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "pulls.update",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
        expect(callsTo(restored, "pulls.update")).toEqual([
          { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
        ]);
        const cleared = lastReadinessCommentBody(restored);
        expect(cleared).toContain('"version":1');
        expect(cleared).toContain('"active":false');

        // Still wrong: enforcement proceeds, and the spread carries the
        // unknown version through untouched. Pinning that is what makes a
        // future migration a visible decision rather than a silent rewrite.
        const wrong = await run({
          pr: { base: { ref: "main" }, draft: false, title: "Add a thing" },
          comments: [botComment(active)],
        });
        expect(methodsOf(wrong)).toEqual(readsWrongBase([
          "pulls.update",
          "pulls.update",
          "issues.createComment",
          "issues.deleteComment",
          "graphql",
        ]));
        expect(lastEnforcerCommentBody(wrong)).toContain('"version":1');
        expect(lastEnforcerCommentBody(wrong)).toContain('"active":true');
        expect(wrong.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      }
    });

    test("state fields are read for truthiness, not for their type", async () => {
      // `parseState` hands back whatever JSON.parse produced, and every reader
      // is a plain `if (…)`. So the contract is truthiness, and a type guard —
      // `if (storedState && typeof storedState.active !== "boolean") return;`
      // — looks like schema hygiene while disabling restoration for any state
      // this workflow did not write in its current shape. Verified reachable:
      // with that guard, a marker carrying `"active":"true"` produced only
      // ["pulls.get", "issues.listComments"] where the real script restores
      // the title and marks the PR ready.
      //
      // The comment selector requires github-actions[bot], so this is not
      // contributor-reachable. It is reachable across a migration, which is
      // exactly when the prefix must still come off.
      const loose = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Add a thing",
          body: readinessChecklistBody(4),
        },
        comments: [botComment({ version: 1, active: "true", autoDraftedByBot: 1, titlePrefixedByBot: "yes" })],
      });
      expect(methodsOf(loose)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "pulls.update",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      expect(callsTo(loose, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
      ]);

      // And the falsy side is symmetric: `null` and `0` skip their own
      // restoration without stopping the run or the clearing write.
      const falsy = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Add a thing",
          body: readinessChecklistBody(4),
        },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: null, titlePrefixedByBot: 0 })],
      });
      expect(methodsOf(falsy)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      const cleared = lastReadinessCommentBody(falsy);
      expect(cleared).toContain('"active":false');
    });

    test("ownership comment is checkpointed before mutations and finalized after", async () => {
      // Ownership is written before the draft mutation. autoDraftedByBot is
      // claimed and checkpointed in the consolidated comment BEFORE
      // convertToDraft, so a successful convert followed by a failed comment
      // write still leaves the bot-created draft owned and restorable.
      const result = await run({ pr: { base: { ref: "main" }, draft: false } });
      // The exact call order pins the ownership discipline: the title is
      // prefixed, the ownership comment is written (claiming
      // `autoDraftedByBot`), then convertToDraft runs.
      expect(methodsOf(result)).toEqual(readsWrongBase(CONTRIBUTOR_WRONG_BASE_TAIL));

      const methods = methodsOf(result);
      const ownershipIndex = methods.indexOf("issues.createComment");
      const draftIndex = methods.indexOf("graphql");
      expect(ownershipIndex).toBeLessThan(draftIndex);

      // The single comment records that the bot drafted.
      const commentBody = lastReadinessCommentBody(result);
      expect(commentBody).toContain('"autoDraftedByBot":true');
    });

    test("a title that is exactly the prefix is still enforced", async () => {
      // `pr.title === TITLE_PREFIX` is a reachable, contributor-controllable
      // value, and `startsWith` is true for it — so an early return keyed on
      // that exact equality reads as a harmless guard and silently exempts any
      // PR whose author titles it "[WRONG BRANCH] ". A review round added one
      // and nothing failed.
      const result = await run({
        pr: { base: { ref: "main" }, title: "[WRONG BRANCH] ", draft: false },
      });

      // Already prefixed, so no title write — but pending/draft/final still run.
      expect(callsTo(result, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
      ]);
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      expect(lastEnforcerCommentBody(result)).toContain('"titlePrefixedByBot":false');
      expect(lastEnforcerCommentBody(result)).toContain('"autoDraftedByBot":true');
    });

    test("an empty title is enforced rather than skipped", async () => {
      // GitHub does not allow it, but the script never checks, and
      // `if (!pr.title) return;` is the kind of defensive line that looks
      // reasonable in review. It exempts whatever can produce a falsy title.
      const result = await run({
        pr: { base: { ref: "main" }, title: "", draft: true },
      });

      expect(callsTo(result, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] " },
      ]);
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
      ]));
    });

    test("an already-prefixed title is never prefixed twice", async () => {
      // The workflow re-runs on `edited`, which its own title write triggers.
      // Without the `startsWith` guard each pass would stack another prefix.
      // This states the property directly, so a guard keyed on the doubled
      // prefix — which only ever matches after the bug already happened —
      // cannot be introduced as if it were the fix.
      const result = await run({
        pr: { base: { ref: "main" }, title: "[WRONG BRANCH] Add a thing", draft: true },
      });

      // No second prefix — and the run still does everything else it owes:
      // reads, finds no prior state, and records that it changed nothing.
      // Asserting only the absent write would let an early return keyed on the
      // doubled prefix pass, since that skips the write too.
      expect(callsTo(result, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
      ]);
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "issues.createComment",
      ]));
      expect(lastEnforcerCommentBody(result)).toContain('"titlePrefixedByBot":false');
      expect(lastEnforcerCommentBody(result)).toContain('"active":true');
    });

    test("a title that already carries the prefix twice is still enforced", async () => {
      // The prefix is contributor-writable text, so any guard keyed on a
      // doubled prefix is a guard the contributor can satisfy on purpose.
      // Verified reachable: with such a guard in place, a PR titled
      // "[WRONG BRANCH] [WRONG BRANCH] mine" against main produced only
      // ["pulls.get", "issues.listComments"] — no comment, no draft, complete
      // exemption.
      const result = await run({
        pr: { base: { ref: "main" }, title: "[WRONG BRANCH] [WRONG BRANCH] mine", draft: false },
      });

      expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "issues.createComment",
        "graphql",
      ]));
      // Already prefixed by the `startsWith` test, so no third prefix is added.
      expect(callsTo(result, "pulls.update")).toEqual([
        {
          owner: "lidge-jun",
          repo: "opencodex",
          pull_number: 42,
          body: expect.stringContaining(CHECKLIST_START),
        },
      ]);
      expect(lastEnforcerCommentBody(result)).toContain('"active":true');
      expect(lastEnforcerCommentBody(result)).toContain('"autoDraftedByBot":true');
    });

    test("with two bot comments, the workflow reads and writes the first", async () => {
      // Duplicates happen: a failed run that posted before crashing, or a
      // repository that once ran two copies of this workflow. The two carry
      // conflicting state, so which one is authoritative decides whether the
      // title gets restored. `find` and `findLast` are a one-word edit apart
      // and pick opposite answers; nothing pinned which.
      const first = {
        id: 7,
        user: { login: BOT },
        body: [MARKER, `<!-- wrong-branch-enforcer-state:${JSON.stringify({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })} -->`].join("\n"),
      };
      const second = {
        id: 8,
        user: { login: BOT },
        body: [MARKER, `<!-- wrong-branch-enforcer-state:${JSON.stringify({ version: 1, active: false, autoDraftedByBot: false, titlePrefixedByBot: false })} -->`].join("\n"),
      };
      const result = await run({
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Add a thing",
          body: readinessChecklistBody(4),
        },
        comments: [first, second],
      });

      // The first comment's state is the one honoured: it says the bot
      // prefixed and drafted, so both are undone.
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "pulls.listReviews",
        "issues.addLabels",
        "pulls.update",
        "graphql",
        "issues.createComment",
        "issues.deleteComment",
      ]));
      // The first legacy enforcer comment is migrated (deleted); the second
      // `MARKER` comment is not matched by either legacy lookup. The
      // consolidated gate comment carries the honoured (first) state.
      const deletions = callsTo(result, "issues.deleteComment") as [{ comment_id: number }];
      expect(deletions.map(d => d.comment_id).sort()).toEqual([7]);
      const gateBody = lastReadinessCommentBody(result);
      expect(gateBody).toContain(GATE_MARKER);
    });

    test("a failure reading the PR stops the run", async () => {
      // `pulls.get` is the authoritative read the whole verdict rests on.
      // Turning its failure into a synthetic correct-looking PR converts an
      // enforcement outage into a green check — the gate reports success while
      // every wrong-target PR walks through. Existing coverage failed the
      // GraphQL call and `pulls.update`, never this one.
      for (const status of [404, 403, 500]) {
        await expect(
          run({ pr: { base: { ref: "main" } }, failOn: ["pulls.get"], failStatus: status }),
        ).rejects.toThrow();
      }
    });

    test("the harness offers every binding the pinned action does", async () => {
      // Round eight did not attack the workflow. It attacked the gap between
      // this fake and the real runtime, three times over: `typeof getOctokit
      // === "function"`, `core.setOutput`, and `core.getInput?.("github-token")`
      // are all truthy on the runner and were all absent here, so
      // `if (…) return;` disabled the gate in production and changed nothing in
      // the suite.
      //
      // Patching those three names would invite a fourth. The scope list below
      // is transcribed from the pinned action's `src/main.ts`, which hands
      // `callAsyncFunction` an object whose keys become the script's
      // parameters. If the action is ever re-pinned to a version with a
      // different scope, this fails and says so, instead of quietly reopening
      // the hole.
      expect([...SCRIPT_BINDINGS].sort()).toEqual([
        "__original_require__",
        "context",
        "core",
        "exec",
        "fetch",
        "getOctokit",
        "github",
        "glob",
        "io",
        "octokit",
        "require",
      ]);

      // Same argument one level down: `core` is a module, and a probe for any
      // method it exports is a probe the fake has to answer the same way.
      // Transcribed from `@actions/core`'s exports.
      const result = await run({ pr: { base: { ref: "dev" } } });
      expect(result.coreSurface).toEqual([
        "addPath",
        "debug",
        "endGroup",
        "error",
        "exportVariable",
        "getBooleanInput",
        "getIDToken",
        "getInput",
        "getMultilineInput",
        "getState",
        "group",
        "info",
        "isDebug",
        "markdownSummary",
        "notice",
        "platform",
        "saveState",
        "setCommandEcho",
        "setFailed",
        "setOutput",
        "setSecret",
        "startGroup",
        "summary",
        "toPlatformPath",
        "toPosixPath",
        "toWin32Path",
        "warning",
      ]);
    });

    test("a probe for any of those bindings finds it, so it cannot detect the fake", async () => {
      // The mechanism the three round-eight mutations shared: a truthiness or
      // `typeof` check that answers one way on the runner and the other way
      // here. Assert the answers match production for every injected name.
      const result = await run({
        pr: { base: { ref: "dev" } },
        authorPermission: "write",
      });
      const probe = await runProbe(`
        const seen = {};
        for (const [name, value] of Object.entries({
          github, octokit, getOctokit, context, core, exec, glob, io, fetch, require,
          __original_require__,
        })) {
          seen[name] = typeof value;
        }
        seen["core.getInput"] = typeof core.getInput;
        seen["core.setOutput"] = typeof core.setOutput;
        seen["core.summary.addRaw"] = typeof core.summary.addRaw;
        seen["core.getInput(github-token)"] = core.getInput("github-token") !== "";
        seen["core.isDebug"] = core.isDebug();
        return seen;
      `);

      // Everything the action injects is a function or an object on the runner.
      // Nothing here may be `undefined`.
      expect(Object.values(probe).some(value => value === "undefined")).toBe(false);
      expect(probe["core.getInput"]).toBe("function");
      expect(probe["core.setOutput"]).toBe("function");
      expect(probe["core.summary.addRaw"]).toBe("function");
      // `github-token` carries a `${{ github.token }}` default, so it is
      // non-empty on the runner. A gate that returns early when it is set is a
      // gate that never runs.
      expect(probe["core.getInput(github-token)"]).toBe(true);
      expect(probe["core.isDebug"]).toBe(false);

      // And the normal path is unaffected by the probe scenario.
      expect(methodsOf(result)).toEqual(readsAllowedBase());
    });

    test("the harness runs the Node major the pinned action declares", async () => {
      // Same class of finding as the three above, one level deeper: the
      // runtime version. `actions/github-script@3a2844b7…` declares
      // `runs: using: node24` in its `action.yml`, so the runner executes this
      // script under Node 24. The harness reported v20 for fourteen rounds, so
      // `if (process.versions.node.startsWith("24")) return;` was a no-op in
      // the suite and a dead gate in production.
      //
      // Read the major out of the workflow's own pin rather than hardcoding
      // it: re-pinning the action to a node26 build should fail here and say
      // so, not silently reopen the gap.
      const workflow = await readText(".github/workflows/enforce-pr-target.yml");
      expect(workflow).toContain("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");

      const probe = await runProbe(`
        return {
          major: process.versions.node.split(".")[0],
          version: process.version,
          startsWith24: process.versions.node.startsWith("24"),
          bun: typeof process.versions.bun,
        };
      `);
      expect(probe.major).toBe("24");
      expect(probe.version).toBe(`v${probe.major}.10.0`);
      expect(probe.startsWith24).toBe(true);
      // Still Node, not Bun: the runner has no `process.versions.bun`.
      expect(probe.bun).toBe("undefined");
    });

    test("a draft GraphQL failure is soft-failed with accurate state and a hard check failure", async () => {
      // Observed on PR #626: convertPullRequestToDraft failed with
      // "Resource not accessible by integration", the job crashed before
      // setFailed, and the PR stayed ready. Soft-catch the draft mutation,
      // record autoDraftedByBot:false, explain the fallback, and still fail
      // the required check so merge stays blocked.
      const { script } = await readEnforcePrTarget();

      for (const status of [403, 404, 422, 500]) {
        const result = await runEnforcePrTarget(script, {
          pr: { base: { ref: "main" }, draft: false },
          failOn: ["graphql"],
          failStatus: status,
        });
        expect(methodsOf(result)).toEqual(readsWrongBase([
        "pulls.update",
        "pulls.update",
        "issues.createComment",
        "graphql",
        "issues.updateComment",
      ]));
        const commentBody = lastEnforcerCommentBody(result);
        expect(commentBody).toContain('"autoDraftedByBot":false');
        expect(commentBody).toContain("Automatic draft conversion failed");
        expect(lastReadinessCommentBody(result)).toContain(
          "Automatic draft conversion failed",
        );
        expect(result.warnings.some((w) => w.includes("Could not convert pull request to draft"))).toBe(true);
        expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      }

      // Title update failures still propagate — without the prefix the gate
      // has no durable signal on the PR itself.
      for (const status of [403, 404, 422]) {
        await expect(
          runEnforcePrTarget(script, {
            pr: { base: { ref: "main" }, draft: false },
            failOn: ["pulls.update"],
            failStatus: status,
          }),
        ).rejects.toThrow(/simulated failure: pulls\.update/);
      }
    });

    test("a failed draft conversion does not claim autoDraftedByBot", async () => {
      const { script } = await readEnforcePrTarget();
      const result = await runEnforcePrTarget(script, {
        pr: { base: { ref: "main" }, draft: false },
        failOn: ["graphql"],
      });
      const commentBody = lastEnforcerCommentBody(result);
      expect(commentBody).toContain('"autoDraftedByBot":false');
      expect(commentBody).toContain('"titlePrefixedByBot":true');
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
    });

    test("a failed ready-for-review conversion keeps ownership active for retry", async () => {
      const { script } = await readEnforcePrTarget();
      const result = await runEnforcePrTarget(script, {
        pr: {
          base: { ref: "dev" },
          draft: true,
          title: "[WRONG BRANCH] Add a thing",
          body: readinessChecklistBody(4),
        },
        comments: [
          {
            id: 7,
            user: { login: "github-actions[bot]" },
            body: [
              "<!-- wrong-branch-enforcer -->",
              `<!-- wrong-branch-enforcer-state:${JSON.stringify({
                version: 1,
                active: true,
                autoDraftedByBot: true,
                titlePrefixedByBot: true,
              })} -->`,
            ].join("\n"),
          },
        ],
        failGraphqlOn: ["markPullRequestReadyForReview"],
      });
      const commentBody = lastEnforcerCommentBody(result);
      expect(commentBody).toContain('"active":true');
      expect(commentBody).toContain('"autoDraftedByBot":true');
      expect(commentBody).toContain("Automatic ready-for-review conversion failed");
      expect(result.warnings.some((w) => w.includes("Could not mark pull request ready for review"))).toBe(true);
    });
  });

  test("PR target enforcement records what it changed so it can undo it", async () => {
    const { script } = await readEnforcePrTarget();

    // The bot rewrites the author's title and draft state, so it stores which of
    // those it touched and restores exactly those on a correct retarget. Losing
    // this bookkeeping means a PR that was already a draft gets marked ready, or
    // that the `[WRONG BRANCH] ` prefix is never removed.
    expect(script).toMatch(/state\.autoDraftedByBot\s*=\s*true/);
    expect(script).toMatch(/state\.titlePrefixedByBot\s*=\s*true/);
    expect(script).toMatch(/gateState\.autoDraftedByBot/);
    expect(script).toMatch(/gateState\.titlePrefixedByBot/);
    expect(script).toMatch(/await\s+convertToDraft\(\)/);
    expect(script).toMatch(/await\s+markReadyForReview\(\)/);
    expect(script).toMatch(/core\.setFailed\(/);

    // Tie each helper to its GraphQL body. Asserting that the call and the
    // mutation name both appear somewhere leaves a gap: declaring an empty
    // `async function convertToDraft() {}` later in the script shadows the real
    // one, removes the behaviour, and satisfies both checks. Require exactly one
    // declaration of each, and require it to contain the mutation.
    for (const [helper, mutation] of [
      ["convertToDraft", "convertPullRequestToDraft"],
      ["markReadyForReview", "markPullRequestReadyForReview"],
    ] as const) {
      const declarations = [...script.matchAll(new RegExp(`function\\s+${helper}\\s*\\(`, "g"))];
      expect(declarations).toHaveLength(1);
      const body = script.slice(declarations[0]!.index!);
      const nextDeclaration = body.slice(1).search(/\n\s*(?:async\s+)?function\s/);
      expect(nextDeclaration === -1 ? body : body.slice(0, nextDeclaration + 1)).toContain(mutation);
    }
    expect(script).toMatch(/const TITLE_PREFIX = "\[WRONG BRANCH\] ";/);

    // The two branch conditions, pinned literally. An audit round wrote
    // `if (!storedState?.active || true)` — the restoration path became
    // unreachable, so a corrected PR kept its `[WRONG BRANCH] ` title and stayed
    // a draft forever, and every assertion above still passed because both
    // helpers and both state fields were still textually present. Presence of a
    // call proves nothing about whether it can be reached.
    expect(script).toMatch(/\n\s*if \(!checklistRequired\) \{\n/);
    expect(script).toMatch(/\n\s*if \(failures\.length > 0\) \{\n/);

    // The readiness gate: contributor drafts are owned by the checklist in the
    // PR body, and the maintainer ping is recorded in the checklist message
    // state so it happens once.
    expect(script).toMatch(/const mustDraft =/);
    expect(script).toMatch(/extractReviewReadiness\(pr\.body\)/);
    expect(script).toMatch(/appendReviewReadinessSection\(pr\.body/);
    expect(script).toMatch(/checklistComplete = readiness\.present && readiness\.complete/);
    expect(script).toMatch(/Maintainers notified:/);
    expect(script).toMatch(/maintainersPinged\s*=\s*true/);
    expect(script).toMatch(/readMaintainerLogins\(\)/);
    expect(script).toMatch(/fs\.readFileSync/);

    // The readiness marker and the state serializers live in the shared
    // modules the script loads; the script itself must import and use them.
    const messagesModule = await readText(
      ".github/scripts/pr-quality-messages.cjs",
    );
    expect(messagesModule).toMatch(
      /READINESS_MARKER = "<!-- pr-quality-readiness -->"/,
    );
    expect(script).toMatch(/pr-quality-messages\.cjs/);

    // Ownership is claimed and checkpointed in the consolidated comment BEFORE
    // the draft mutation, so a successful convert followed by a failed comment
    // write still leaves the bot-created draft owned and restorable. Only a
    // failed conversion rewrites the comment with autoDraftedByBot:false.
    const branchStart = script.indexOf("if (failures.length > 0) {");
    expect(branchStart).toBeGreaterThan(-1);
    const branch = script.slice(branchStart);
    const ownershipClaimIndex = branch.indexOf("state.autoDraftedByBot = true;");
    const draftCallIndex = branch.indexOf("await convertToDraft()");
    // The failure path writes the ownership checkpoint through the shared
    // `draftComment` helper, which is defined before the draft mutation runs.
    const gateWriteIndex = branch.indexOf("const draftComment = (notices) =>");
    expect(ownershipClaimIndex).toBeGreaterThan(-1);
    expect(draftCallIndex).toBeGreaterThan(-1);
    expect(ownershipClaimIndex).toBeLessThan(draftCallIndex);
    expect(gateWriteIndex).toBeLessThan(draftCallIndex);
  });

  test("docs deployment is pinned, bounded, and scoped to Pages", async () => {
    const workflow = await readText(".github/workflows/deploy-docs.yml");

    expect(workflow).toContain("permissions:\n  contents: read\n  pages: write\n  id-token: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("withastro/action@e84f40bd8d2caa9e768ec82ad30dd81f0b280853");
    expect(workflow).toContain("actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("issue-quality workflow rejects workflow_dispatch pull request numbers before mutation", async () => {
    const workflow = await readText(".github/workflows/enforce-issue-quality.yml");

    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("Translate non-English issue comments");
    expect(workflow).toContain("shouldTranslateComment");
    expect(workflow).toContain("buildTranslatedCommentBody");
    expect(workflow).toContain("github.rest.issues.updateComment");
    expect(workflow).toContain("group: issue-translation-${{ github.event.issue.number }}");
    expect(workflow).not.toContain("issue-comment-translation-${{ github.event.comment.id }}");
    expect(workflow).toContain("if: github.event_name == 'issue_comment'");
    // translate/validate skip open-area backfill; backfill job is area-only.
    expect(workflow).toContain("backfill_open_areas");
    expect(workflow).toContain("backfill-open-areas:");
    expect(workflow).toMatch(/inputs\.backfill_open_areas != true/);
    expect(workflow).toMatch(/inputs\.backfill_open_areas == true/);
    expect(workflow).toMatch(
      /translate:\s*\n\s*name: Translate non-English issues\s*\n\s*if: >\s*\n\s*github\.event_name == 'issues' \|\|\s*\n\s*\(github\.event_name == 'workflow_dispatch' &&\s*\n\s*inputs\.backfill_open_areas != true &&\s*\n\s*inputs\.issue_number != ''\)/,
    );
    expect(workflow).toMatch(
      /validate:\s*\n\s*# Wait for translate[\s\S]*?\n\s*needs: translate\s*\n\s*if: >\s*\n\s*always\(\) &&\s*\n\s*needs\.translate\.result != 'cancelled' &&\s*\n\s*\(github\.event_name == 'issues' \|\|\s*\n\s*\(github\.event_name == 'workflow_dispatch' &&\s*\n\s*inputs\.backfill_open_areas != true &&\s*\n\s*inputs\.issue_number != ''\)\)/,
    );

    const commentJob = workflow.split(/\n {2}translate-comment:\n/)[1]!.split(/\n {2}[a-zA-Z]/)[0]!;
    expect(commentJob).toContain("parse-issue-translation-response.cjs");
    expect(commentJob).toContain("Apply inline comment translation");
    expect(commentJob).toContain("isPreparedSourceStillCurrent");
    expect(commentJob).toContain("updateComment");
    expect(commentJob).toContain("requires_translation == 'true'");
    expect(commentJob).toContain("group: issue-translation-${{ github.event.issue.number }}");
    expect(commentJob).toContain("# Required to rewrite the triggering issue comment in place.");
    expect(commentJob).toContain("sourceKey:");
    // Same fail-closed parse → apply gate as the issue path.
    const commentParse = commentJob
      .split("- name: Parse AI response")[1]!
      .split("- name: Apply inline comment translation")[0]!;
    expect(commentParse).toContain("parse-issue-translation-response.cjs");
    const commentRun = commentParse.split(/\n\s*run:\s*/)[1];
    expect(commentRun).toBeDefined();
    expect(commentRun!).not.toContain("${{");
    const commentApply = commentJob
      .split("- name: Apply inline comment translation")[1]!
      .split("- name: Persist comment translation control state")[0]!;
    const guardAt = commentApply.indexOf("isPreparedSourceStillCurrent({");
    const updateAt = commentApply.indexOf("updateComment");
    const missingAt = commentApply.indexOf("missingRequiredTranslationFields({");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(missingAt).toBeGreaterThanOrEqual(0);
    expect(missingAt).toBeLessThan(updateAt);
    expect(guardAt).toBeLessThan(updateAt);
    expect(commentApply).toContain("omitted required field(s)");

    // Job-scoped permissions only (no top-level issues:write; no actions:write).
    // The Copilot migration replaced `models: read` with `copilot-requests: write`
    // as the inference credential; the job stays contents-read + issues-write.
    expect(workflow).toMatch(
      // dev resolved the same Copilot-migration drift with an alternation that
      // also accepts the pre-migration `models: read`; take theirs so the gate
      // holds on whichever branch supplies the workflow file.
      /jobs:\s*\n\s*translate:[\s\S]*?permissions:\s*\n(?:\s*#.*\n)*\s*contents: read\s*\n(?:\s*#.*\n)*\s*issues: write\s*\n(?:\s*#.*\n)*\s*(?:copilot-requests: write|models: read)/,
    );
    const translateJob = workflow.split(/\n {2}translate:\n/)[1]!.split(/\n {2}[a-zA-Z]/)[0]!;
    expect(translateJob).not.toMatch(/actions:\s*write/);
    expect(workflow).toMatch(
      /jobs:\s*\n\s*translate:[\s\S]*?validate:[\s\S]*?permissions:\s*\n\s*contents: read\s*\n\s*#.*\n\s*issues: write/,
    );
    const beforeJobs = workflow.split(/jobs:\s*\n/)[0]!;
    expect(beforeJobs).not.toMatch(/^\s*permissions:/m);

    // Non-cancelling per-issue concurrency at workflow and translate-job scope.
    expect(workflow).toContain(
      "group: issue-quality-${{ github.event.issue.number || inputs.issue_number || (inputs.backfill_open_areas && 'backfill-open-areas') || 'manual' }}",
    );
    expect(workflow).toContain("group: issue-translation-${{ github.event.issue.number || inputs.issue_number }}");
    const workflowConcurrency = workflow.split(/jobs:\s*\n/)[0]!;
    expect(workflowConcurrency).toMatch(
      /concurrency:\s*\n\s*group: issue-quality-[^\n]*\n\s*cancel-in-progress:\s*false/,
    );
    expect(translateJob).toMatch(
      /concurrency:\s*\n\s*group: issue-translation-[^\n]*\n\s*cancel-in-progress:\s*false/,
    );
    expect(translateJob).toContain("translation-state-degraded");
    expect(translateJob).toContain("core.summary");

    // Trusted scripts always come from the repository default branch.
    const checkoutStep = workflow
      .split("- name: Checkout trusted workflow code")[1]!
      .split(/\n {6}- name:/)[0]!;
    expect(checkoutStep).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(checkoutStep).toContain("persist-credentials: false");
    expect(checkoutStep).toContain("sparse-checkout: .github/scripts");

    const script = workflow
      .split("- name: Validate issue quality")[1]!
      .split("script: |")[1]!
      .split(/\n {6}- name:/)[0]!;

    // Invalid issue numbers fail before any issues API call.
    const invalidNumberIdx = script.indexOf("Invalid workflow_dispatch issue_number:");
    const firstIssuesGetIdx = script.indexOf("github.rest.issues.get({");
    expect(invalidNumberIdx).toBeGreaterThan(-1);
    expect(firstIssuesGetIdx).toBeGreaterThan(-1);
    expect(invalidNumberIdx).toBeLessThan(firstIssuesGetIdx);

    // Non-default-branch dispatches fail before any issues API mutation.
    const branchGuardIdx = script.indexOf("const nonDefaultBranchFailure = rejectsWorkflowDispatchNonDefaultBranch(");
    const firstMutationIdx = script.indexOf("github.rest.issues.update({");
    expect(branchGuardIdx).toBeGreaterThan(-1);
    expect(firstMutationIdx).toBeGreaterThan(-1);
    expect(branchGuardIdx).toBeLessThan(firstMutationIdx);
    expect(branchGuardIdx).toBeLessThan(firstIssuesGetIdx);

    // Pull-request numbers are rejected after issues.get and before mutations.
    const prGuardIdx = script.indexOf("const pullRequestFailure = rejectsWorkflowDispatchPullRequest(");
    const listCommentsIdx = script.indexOf("github.rest.issues.listComments");
    const addLabelsIdx = script.indexOf("github.rest.issues.addLabels");
    expect(prGuardIdx).toBeGreaterThan(-1);
    expect(prGuardIdx).toBeGreaterThan(firstIssuesGetIdx);
    expect(prGuardIdx).toBeLessThan(listCommentsIdx);
    expect(prGuardIdx).toBeLessThan(addLabelsIdx);
    expect(prGuardIdx).toBeLessThan(firstMutationIdx);
    expect(script).toContain("if (pullRequestFailure) {");
    expect(script).toContain("core.setFailed(pullRequestFailure);");

    const translateScript = workflow
      .split("- name: Prepare translation")[1]!
      .split("- name: Detect and translate")[0]!;
    const branchGuardIdxTranslate = translateScript.indexOf(
      "rejectsWorkflowDispatchNonDefaultBranch(",
    );
    const issuesGetIdxTranslate = translateScript.indexOf("github.rest.issues.get({");
    expect(branchGuardIdxTranslate).toBeGreaterThan(-1);
    expect(issuesGetIdxTranslate).toBeGreaterThan(-1);
    expect(branchGuardIdxTranslate).toBeLessThan(issuesGetIdxTranslate);
    expect(translateScript).toContain("resolveControlState");
    expect(translateScript).toContain("Never trust author-editable issue body markers");

    const applyScript = workflow
      .split("- name: Apply inline translation")[1]!
      .split("- name: Persist translation control state")[0]!;
    const staleGuardIdx = applyScript.indexOf("isPreparedSourceStillCurrent({");
    const issueUpdateIdx = applyScript.indexOf("github.rest.issues.update(");
    expect(staleGuardIdx).toBeGreaterThan(-1);
    expect(issueUpdateIdx).toBeGreaterThan(-1);
    expect(staleGuardIdx).toBeLessThan(issueUpdateIdx);
    expect(applyScript).toContain("persistTranslationControlState");
    expect(applyScript).toContain("Translation control state not persisted");
    expect(applyScript).toContain("sourceComplete");
    expect(applyScript).toContain("source remains retryable");
    expect(applyScript).toContain("missingRequiredTranslationFields");
    expect(applyScript).toContain("omitted required field(s)");
    expect(applyScript).toMatch(/sourceComplete,\s*\n\s*\}/);
    expect(applyScript.indexOf("missingRequiredTranslationFields({")).toBeLessThan(
      applyScript.indexOf("github.rest.issues.update("),
    );

    const parseStep = workflow
      .split("- name: Parse AI response")[1]!
      .split("- name: Apply inline translation")[0]!;
    expect(parseStep).toContain("parse-issue-translation-response.cjs");
    expect(parseStep).not.toContain("node -e");
    expect(parseStep).not.toContain("node <<");
    // AI output must stay in env, never interpolated into the shell run script.
    expect(parseStep.split(/\n\s*run:\s*/)[1] || "").not.toContain("${{");

    const persistStep = workflow
      .split("- name: Persist translation control state")[1]!
      .split(/\n {2}[a-zA-Z]/)[0]!;
    expect(persistStep).toContain("always()");
    expect(persistStep).toContain("requires_translation != 'true'");
    expect(persistStep).toContain("persistTranslationControlState");
    expect(persistStep).toContain("SOURCE_COMPLETE");
    expect(persistStep).toContain("detectedLanguageForControlPersist");
    expect(persistStep).toContain('const sourceComplete = process.env.SOURCE_COMPLETE === "true"');
    expect(persistStep).toMatch(/sourceComplete,\s*\n\s*\}/);
    // Missing DETECTED_LANG on incomplete/skipped parse must not default to English.
    expect(persistStep).not.toContain('DETECTED_LANG || "English"');
    expect(persistStep).not.toContain("DETECTED_LANG || 'English'");
    expect(persistStep).not.toContain("silent_state");
    expect(persistStep).not.toContain("cleanup_comment_ids");
    expect(workflow).not.toContain("Save translation control state cache");
    expect(workflow).not.toContain("Remove migrated English control comments");
    expect(workflow).not.toContain("Restore translation control state cache");

    const commentPersist = workflow
      .split("- name: Persist comment translation control state")[1]!
      .split(/\n {2}[a-zA-Z]/)[0]!;
    expect(commentPersist).toContain('const sourceComplete = process.env.SOURCE_COMPLETE === "true"');
    expect(commentPersist).toContain("detectedLanguageForControlPersist");
    expect(commentPersist).toMatch(/sourceComplete,\s*\n\s*\}/);
    expect(commentPersist).not.toContain('DETECTED_LANG || "English"');
    expect(commentPersist).not.toContain("DETECTED_LANG || 'English'");
    const commentApplyStep = workflow
      .split("- name: Apply inline comment translation")[1]!
      .split("- name: Persist comment translation control state")[0]!;
    expect(commentApplyStep).toContain("sourceComplete");
    expect(commentApplyStep).toContain("source remains retryable");
    expect(commentApplyStep).toContain("missingRequiredTranslationFields");
    expect(commentApplyStep).toContain("omitted required field(s)");
    const commentMissingAt = commentApplyStep.indexOf("missingRequiredTranslationFields({");
    const commentUpdateAt = commentApplyStep.indexOf("updateComment");
    expect(commentMissingAt).toBeGreaterThanOrEqual(0);
    expect(commentUpdateAt).toBeGreaterThanOrEqual(0);
    expect(commentMissingAt).toBeLessThan(commentUpdateAt);

    // Helper contract: always-visible bookkeeping; sticky oldest upsert; body non-authoritative.
    const helperSrc = await readText(".github/scripts/issue-translation.cjs");
    expect(helperSrc).toContain("shouldOmitVisibleBookkeeping");
    expect(helperSrc).toContain("findStickyControlComment");
    expect(helperSrc).toContain("detectedLanguageForControlPersist");
    expect(helperSrc).toContain("Automated translation bookkeeping");
    expect(helperSrc).toContain("canonical comment first");
    expect(helperSrc).toContain("Authoritative control state comes only from verified bot-owned comments");
    expect(helperSrc).toContain("sourceComplete");
    expect(helperSrc).not.toContain("writeFileControlState");
    expect(helperSrc).not.toContain(".ocx-translation-state");
  });

  test("React Doctor workflow is SHA-pinned, engine-pinned, gating, and read-only", async () => {
    const workflow = await readText(".github/workflows/react-doctor.yml");

    expect(workflow).toContain("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8");
    expect(workflow).toContain("millionco/react-doctor@01820bb4fd4d0a4aebcd8df2b2a143a098649cb2");
    expect(workflow).not.toMatch(
      /^\s*-\s+uses:\s+\S+@(?![0-9a-f]{40}(?=[ \t]*(?:#.*)?$))\S+/m,
    );

    // Engine pin: the action wrapper would fetch react-doctor@latest without it.
    expect(workflow).toContain('version: "0.9.11"');

    // Action pin must accept CLI JSON schemaVersion 3 (baseline reports from 0.9.x).
    // v2.1.0's ensure-json-report only knew schemas 1–2 and failed every PR scan.
    // Gating + least privilege: read-only token, all write-scoped outputs off.
    // pull-requests: read is required so the action can list PR files for
    // --changed-files-from; without it, fork PRs fail with ENOENT on that file.
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).not.toContain(": write");
    expect(workflow).toMatch(/^\s+blocking:\s+warning\s*$/m);
    expect(workflow).toMatch(/^\s+comment:\s+false\s*$/m);
    expect(workflow).toMatch(/^\s+review-comments:\s+false\s*$/m);
    expect(workflow).toMatch(/^\s+commit-status:\s+false\s*$/m);
    expect(workflow).toContain("timeout-minutes: 10");
  });

  test("React Doctor package scripts pin the exact engine version with no @latest anywhere", async () => {
    const guiPkg = await readText("gui/package.json");
    const rootPkg = await readText("package.json");
    const doctorConfig = await readText("gui/doctor.config.json");

    expect(guiPkg).toContain("react-doctor@0.9.11");
    expect(guiPkg).not.toContain("react-doctor@latest");
    expect(rootPkg).not.toContain("react-doctor@latest");
    expect(doctorConfig).toContain('"blocking": "warning"');
    expect(rootPkg).toContain('"doctor:gui:if-changed": "bun scripts/doctor-gui-if-changed.ts"');
    expect(rootPkg).toContain('"lint:gui": "cd gui && bun run lint"');
    expect(rootPkg).toContain('"lint:gui:if-changed": "bun scripts/lint-gui-if-changed.ts"');
    // Gating steps include lint and React Doctor only on gui/ pushes.
    expect(rootPkg).toContain("bun run typecheck && bun run lint:gui:if-changed && bun run test");
    expect(rootPkg).toContain("bun run privacy:scan && bun run doctor:gui:if-changed");
  });
});

describe("doctor-gui-if-changed", () => {
  test("guiPathsChanged is a slash-guarded gui/ prefix predicate", async () => {
    const { guiPathsChanged } = await import("../scripts/doctor-gui-if-changed");

    expect(guiPathsChanged(["gui/src/App.tsx"])).toBe(true);
    expect(guiPathsChanged(["gui"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts", "gui/package.json"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts"])).toBe(false);
    expect(guiPathsChanged(["guitools/x.ts"])).toBe(false);
    expect(guiPathsChanged([])).toBe(false);
  });

  test("looksLikeDoctorInfraFailure detects registry/network outages", async () => {
    const { looksLikeDoctorInfraFailure } = await import("../scripts/doctor-gui-if-changed");
    expect(looksLikeDoctorInfraFailure("npm ERR! network getaddrinfo ENOTFOUND registry.npmjs.org")).toBe(true);
    expect(looksLikeDoctorInfraFailure("npm ERR! code ECONNRESET")).toBe(true);
    expect(looksLikeDoctorInfraFailure("npm ERR! network timeout")).toBe(true);
    expect(looksLikeDoctorInfraFailure("All 2 issues\nBugs > 1 errors")).toBe(false);
    // Findings copy can mention "network" without being an infra outage.
    expect(looksLikeDoctorInfraFailure("Network requests > 1 errors")).toBe(false);
  });

  test("DRY_RUN prints the run/skip decision without spawning the doctor", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "gui/src/App.tsx\nscripts/x.ts" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("doctor:run");

    const skip = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "scripts/x.ts\nREADME.md" },
    });
    expect(skip.exitCode).toBe(0);
    expect(skip.stdout.toString()).toContain("doctor:skip");
  });

  test("degrades gracefully when the doctor engine is unavailable (offline prepush)", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "definitely-not-a-real-command-xyz",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.toString()).toContain("skipping scan");
  });

  test("soft-skips when doctor exits nonzero due to a registry/network failure", () => {
    // Simulate `bun run doctor` starting, then npx failing offline: numeric status
    // plus registry noise in stderr — must not gate the push.
    // cwd for DOCTOR_CMD is gui/, so reach fixtures via ../scripts/...
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "bun ../scripts/fixtures/doctor-offline-exit.ts",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.toString()).toContain("skipping scan");
  });

  test("propagates a non-zero doctor exit so findings gate the push", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "bun ../scripts/fixtures/doctor-findings-exit.ts",
      },
    });
    expect(run.exitCode).not.toBe(0);
  });

  test("isDoctorBufferOverflow recognizes ENOBUFS / maxBuffer errors", async () => {
    const { isDoctorBufferOverflow } = await import("../scripts/doctor-gui-if-changed");
    expect(isDoctorBufferOverflow("ENOBUFS")).toBe(true);
    expect(isDoctorBufferOverflow("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")).toBe(true);
    expect(isDoctorBufferOverflow("ENOENT")).toBe(false);
    expect(isDoctorBufferOverflow(undefined)).toBe(false);
  });

  test("hard-fails when doctor output exceeds maxBuffer (does not soft-skip)", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "bun ../scripts/fixtures/doctor-huge-output.ts",
        // Tiny buffer so the fixture's stdout trips the overflow branch.
        OCX_DOCTOR_MAX_BUFFER: "256",
      },
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("exceeded buffer");
  });
});

describe("lint-gui-if-changed", () => {
  test("DRY_RUN prints the run/skip decision without spawning lint", () => {
    const run = Bun.spawnSync(["bun", lintGuiIfChangedScript], {
      env: { ...process.env, LINT_DRY_RUN: "1", LINT_FILES: "gui/src/App.tsx\nscripts/x.ts" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("lint:run");

    const skip = Bun.spawnSync(["bun", lintGuiIfChangedScript], {
      env: { ...process.env, LINT_DRY_RUN: "1", LINT_FILES: "scripts/x.ts\nREADME.md" },
    });
    expect(skip.exitCode).toBe(0);
    expect(skip.stdout.toString()).toContain("lint:skip");
  });

  test("runs eslint when gui/ changed and fails the push on findings", () => {
    // `bun run lint` in gui/ exits non-zero on findings; a fake command makes
    // the spawn deterministic without depending on the real eslint output.
    const run = Bun.spawnSync(["bun", lintGuiIfChangedScript], {
      env: {
        ...process.env,
        LINT_FILES: "gui/src/App.tsx",
        LINT_CMD: "bun ../scripts/fixtures/lint-findings-exit.ts",
      },
    });
    expect(run.exitCode).not.toBe(0);
  });

  test("skips eslint when gui/ did not change", () => {
    const run = Bun.spawnSync(["bun", lintGuiIfChangedScript], {
      env: {
        ...process.env,
        LINT_FILES: "scripts/x.ts\nREADME.md",
        LINT_CMD: "bun ../scripts/fixtures/lint-findings-exit.ts",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("lint:gui: skip");
  });
});

describe("gui exhaustive-deps suppression stays scoped and effective", () => {
  // `bun run doctor:gui` exited 1 on dev for one deliberate exception at
  // gui/src/pages/Models.tsx, and doctor:gui runs inside `prepush`, so every
  // gui-touching push needed --no-verify. Two config edits fixed it, and each has a
  // failure mode that is silent rather than loud, which is what these assertions cover.

  test("the oxlint override carries its own react plugin, or it resolves to nothing", async () => {
    const oxlintrc = JSON.parse(await readText("gui/.oxlintrc.json")) as {
      overrides?: Array<{ files?: string[]; rules?: Record<string, unknown>; plugins?: string[] }>;
    };
    const overrides = oxlintrc.overrides ?? [];
    const scoped = overrides.filter(entry => (entry.files ?? []).includes("src/pages/Models.tsx"));

    expect(scoped).toHaveLength(1);
    const override = scoped[0]!;

    // Rule id must match the style the rest of this config uses ("react/..."). The
    // eslint-style "react-hooks/..." id silently matches nothing here.
    expect(override.rules?.["react/exhaustive-deps"]).toBe("off");
    expect(override.rules).not.toHaveProperty("react-hooks/exhaustive-deps");

    // Without a per-override plugins key the override is inert: the rule stays on and
    // the warning comes back. This is the assertion that catches a well-meaning cleanup
    // that deletes a key looking redundant next to the top-level plugin list.
    expect(override.plugins).toContain("react");

    // Narrow by construction: the override turns off exactly one rule. rules-of-hooks and
    // react-compiler must keep firing in that file, and a probe confirmed they do.
    expect(Object.keys(override.rules ?? {})).toEqual(["react/exhaustive-deps"]);
  });

  test("react-doctor scopes the ignore to one file instead of going blind everywhere", async () => {
    const config = JSON.parse(await readText("gui/doctor.config.json")) as {
      blocking?: string;
      ignore?: { overrides?: Array<{ files?: string[]; rules?: string[] }> };
      rules?: Record<string, unknown>;
    };

    // A global rules entry was tried first and rejected: it silenced the rule repo-wide,
    // proven by injecting a missing-dep violation into Startup.tsx and watching doctor
    // report "No issues". ignore.overrides keeps that violation failing.
    expect(config.rules).not.toHaveProperty("react-doctor/exhaustive-deps");
    expect(config.rules).not.toHaveProperty("react-hooks/exhaustive-deps");

    const overrides = config.ignore?.overrides ?? [];
    const scoped = overrides.filter(entry => (entry.files ?? []).includes("src/pages/Models.tsx"));
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.rules).toContain("react-hooks/exhaustive-deps");

    // Every ignore override must name at least one file. An empty or missing files list
    // would apply the ignore to the whole scan, which is the failure this pair guards.
    for (const entry of overrides) {
      expect((entry.files ?? []).length).toBeGreaterThan(0);
      expect((entry.rules ?? []).length).toBeGreaterThan(0);
    }

    // blocking must stay at warning; flipping it to error would hide the next finding
    // instead of this one. scripts/doctor-gui-if-changed.ts documents that contract.
    expect(config.blocking).toBe("warning");
  });

  test("the effect keeps the in-file record of why the dep array stays short", async () => {
    const models = await readText("gui/src/pages/Models.tsx");
    const effectEnd = models.indexOf("}, [catalogActive, loadShadowCall, loadV2]);");
    expect(effectEnd).toBeGreaterThan(-1);

    // The reasoning has to sit on the effect, not in a commit message. Read the comment
    // block immediately above the dep array rather than the whole file, or this passes on
    // any incidental mention elsewhere.
    const preceding = models.slice(0, effectEnd).split(/\r?\n/).slice(-8).join("\n");
    expect(preceding).toContain("PreserveManualMemo");
    expect(preceding).toContain("five react-compiler");

    // Both suppressions are config-side, so the note must point at the two files a reader
    // would otherwise have to find by grep.
    expect(preceding).toContain("gui/.oxlintrc.json");
    expect(preceding).toContain("gui/doctor.config.json");

    // An in-file react-doctor disable was tried and removed: doctor passes without it, and
    // react/react-compiler penalises a component merely for carrying suppressions. If one
    // reappears, the config route has been misunderstood.
    expect(models).not.toContain("react-doctor-disable-next-line");
  });
});
