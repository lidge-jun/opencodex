import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  SCRIPT_BINDINGS,
  callsTo,
  methodsOf,
  runEnforcePrTarget,
  type HarnessResult,
} from "./helpers/enforce-pr-target-harness";

/** Final enforcer comment body after pending/draft checkpoints. */
function lastEnforcerCommentBody(result: HarnessResult): string {
  const updates = callsTo(result, "issues.updateComment") as Array<{ body: string }>;
  if (updates.length > 0) return updates[updates.length - 1]!.body;
  const creates = callsTo(result, "issues.createComment") as Array<{ body: string }>;
  return creates[creates.length - 1]!.body;
}

const root = new URL("../", import.meta.url);
const doctorGuiIfChangedScript = fileURLToPath(new URL("../scripts/doctor-gui-if-changed.ts", import.meta.url));

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function count(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

describe("GitHub Actions hardening", () => {
  test("cross-platform CI keeps bounded jobs and immutable action references", async () => {
    const workflow = await readText(".github/workflows/ci.yml");

    // The cross-platform `test` job sits at 20 minutes: a green Windows run measured
    // 11.8 min against 4.6 on Linux, and the previous 12-minute ceiling left ~12s of
    // margin, so runner variance rather than the code decided the verdict (#717).
    // `npm-global-smoke` stays at 8; it finishes in 1-2 minutes. The windows-runner
    // selector job is bounded at 2 minutes — it only picks a label.
    expect(count(workflow, "timeout-minutes: 20")).toBe(1);
    expect(count(workflow, "timeout-minutes: 8")).toBe(1);
    expect(count(workflow, "timeout-minutes: 2\n")).toBe(1);
    // Every job must stay bounded — an unbounded job can hang a queue for hours.
    expect(count(workflow, "timeout-minutes:")).toBe(3);
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(workflow).toContain("bun test --isolate tests");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("PR checks reach every branch the target gate accepts", async () => {
    // These two lists have to move together with enforce-pr-target.yml. A PR
    // that passes the gate but triggers no checks is worse than one that is
    // blocked: it looks reviewable and has nothing behind it. Pin the
    // pull_request branch lists to the gate's allow-list plus main.
    const gate = await readText(".github/workflows/enforce-pr-target.yml");
    const allowed = gate.match(/const ALLOWED_BASES = \[([^\]]*)\];/);
    expect(allowed).not.toBeNull();
    const bases = [...(allowed?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(m => m[1]);
    expect(bases).toEqual(["dev"]);

    for (const path of [".github/workflows/ci.yml", ".github/workflows/service-lifecycle.yml"]) {
      const workflow = Bun.YAML.parse(await readText(path)) as {
        on?: { pull_request?: Record<string, unknown> };
      };
      const trigger = workflow.on?.pull_request ?? {};
      const branches = (trigger.branches as string[] | undefined) ?? [];
      expect([...branches].sort()).toEqual(["dev", "main"]);

      // Narrowing a default is a mutation that deletes nothing. Omitting
      // `types` means opened + synchronize + reopened; writing
      // `types: [opened]` keeps the workflow, keeps the branch list, and stops
      // running checks on every commit pushed after the PR was opened — the
      // review then reads a green tick that belongs to an older tree. An
      // absent key is only pinned by asserting the key set, so assert it.
      expect(Object.keys(trigger).sort()).toEqual(["branches", "paths"]);
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
        pull_request?: { paths?: string[] };
      };
    };
    expect([...(ci.on?.push?.branches ?? [])].sort()).toEqual(["dev", "main", "preview"]);

    // The path filter decides whether the job runs at all. Deleting one entry
    // deletes nothing visible: the workflow still exists, still lists the right
    // branches, and simply never fires for a PR that touches only that surface.
    // Round 16 dropped `src/**`, `tests/**`, and both workflow self-references
    // one at a time and the suite stayed green each time. Pin the list.
    const ciPaths = [
      ".gitattributes",
      ".github/workflows/ci.yml",
      ".github/workflows/enforce-pr-target.yml",
      ".github/workflows/release.yml",
      ".github/workflows/stale-needs-info.yml",
      ".npmignore",
      "bin/**",
      "bun.lock",
      "gui/**",
      "package.json",
      "scripts/**",
      "src/**",
      "tests/**",
      "tsconfig.json",
    ];
    expect([...(ci.on?.pull_request?.paths ?? [])].sort()).toEqual(ciPaths);
    // Push and pull_request have to cover the same surfaces, or a change lands
    // on dev having been checked on one trigger and not the other.
    expect([...(ci.on?.push?.paths ?? [])].sort()).toEqual(ciPaths);
  });

  test("cross-platform CI keeps the GUI lint and build gates", async () => {
    // Review finding (PR #97): the GUI build gate was silently dropped once; assert the
    // enhanced gate (PR #99) stays wired so broken GUI builds cannot merge unnoticed.
    const workflow = await readText(".github/workflows/ci.yml");

    expect(workflow).toContain("- name: GUI lint");
    expect(workflow).toContain("bun run lint");
    expect(workflow).toContain("- name: GUI build");
    expect(workflow).toContain("bun run build");
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

    // Least privilege + never cancel a publish mid-flight.
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 15");

    // Dry-run first by default; tokenless trusted publishing only.
    expect(workflow).toMatch(/dry-run:[\s\S]*?default: true/);
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN:");

    // Immutable action references.
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
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

    // Release notes must include PR categories and the full channel commit range
    // (branch merges + direct commits). Preflight forbids an existing release, so
    // only create (not edit) is wired. Stable releases also carry matching preview notes.
    expect(workflow).toContain("releases/generate-notes");
    expect(workflow).toContain("git log --pretty=format:'- %s (%h)'");
    expect(workflow).toContain('commit_range="${notes_range_start}..${GITHUB_SHA}"');
    expect(workflow).toContain('previous_tag_name=${notes_range_start}');
    expect(workflow).toContain("skipping generate-notes (commits-only notes)");
    expect(workflow).toContain("bun scripts/release-notes.ts strip-carried");
    expect(workflow).toContain("bun scripts/release-notes.ts assemble");
    expect(workflow).toContain("bun scripts/release-notes.ts matching-preview-tags");
    expect(workflow).toContain("bun scripts/release-notes.ts previous-release-tag");
    expect(workflow).toContain("bun scripts/release-notes.ts has-meaningful");
    expect(workflow).toContain("bun scripts/release-notes.ts join-carried");
    expect(workflow).toContain("bun scripts/release-notes.ts credit-takeovers");
    expect(workflow).toContain('if [ -s "$carried_file" ]; then');
    expect(workflow).toContain('if [ -s "$delta_file" ]; then');
    // Preview notes must baseline any prior release (stable or preview), not preview-only.
    expect(workflow).toContain('bun scripts/release-notes.ts previous-release-tag "$RELEASE_VERSION"');
    expect(workflow).not.toMatch(
      /RELEASE_VERSION" == \*-preview\.\*[\s\S]{0,200}grep -- '-preview\\.'/,
    );
    expect(workflow).toContain("releases/tags/");
    expect(workflow).toContain('gh api "repos/${GITHUB_REPOSITORY}" --jq \'.full_name\'');
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("operational error, not a missing release");
    expect(workflow).toContain("not an ancestor");
    expect(workflow).toContain("newest_carried_preview_tag");
    expect(workflow).not.toMatch(/newest_preview_tag="\$preview_carry_tag"/);
    expect(workflow).toContain("--commits");
    expect(workflow).toContain('git tag --list "v${RELEASE_VERSION}-preview.*"');
    expect(workflow).toContain("Carrying preview release notes from");
    // Every subcommand the workflow invokes must be dispatched by the CLI.
    const releaseNotesHelper = await readText("scripts/release-notes.ts");
    const invoked = [...workflow.matchAll(/bun scripts\/release-notes\.ts ([a-z-]+)/g)]
      .map(m => m[1]!);
    expect(invoked.length).toBeGreaterThan(0);
    for (const cmd of new Set(invoked)) {
      expect(releaseNotesHelper).toContain(`"${cmd}"`);
    }
    expect(workflow).toMatch(/gh release create[\s\S]*?--notes-file "\$notes_file"/);
    expect(workflow).not.toContain("gh release edit");
    expect(workflow).not.toContain("--generate-notes");
    // Notes must be assembled before tagging so a notes API failure does not leave
    // a remote tag that blocks release retries at preflight.
    const createStep = workflow.split("- name: Create GitHub release")[1]!.split(/\n {6}- name:/)[0]!;
    // Preview carry lookup must use tag-specific API status, not `gh release view` stderr prose.
    expect(createStep).toContain("releases/tags/");
    expect(createStep).not.toContain("gh release view");
    // Fail closed: no soft-skip in any spelling around gh api calls in this step.
    for (const line of createStep.split("\n").filter(l => l.includes("gh api"))) {
      expect(line).not.toMatch(/\|\|\s*(true|echo|:)/);
    }
    expect(createStep).not.toContain("set +e\n            pr_notes");
    expect(createStep.indexOf("gh api")).toBeGreaterThan(-1);
    expect(createStep.indexOf('git tag "$release_tag"')).toBeGreaterThan(-1);
    expect(createStep.indexOf("gh api")).toBeLessThan(createStep.indexOf('git tag "$release_tag"'));
    // First-channel releases must not call generate-notes without an explicit baseline
    // (GitHub would otherwise pick the newest repo tag, possibly from the other channel).
    // Scope to the single if-block that owns generate-notes; createStep has two
    // `[ -n "$notes_range_start" ]` blocks, so an unanchored [\s\S]* can straddle them.
    const notesBlock = createStep
      .split(/if \[ -n "\$notes_range_start" \]; then/)[1]!
      .split(/\n {10}if \[/)[0]!;
    expect(notesBlock).toContain("previous_tag_name=${notes_range_start}");
    expect(notesBlock).toContain("skipping generate-notes");
    expect(notesBlock).toMatch(/\n {10}else\n/);
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
    on?: { pull_request_target?: { types?: string[] } };
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

  const SCRIPT_LOAD = ["require", "require"] as const;

  /** Reads every allowed-base PR performs before any enforcement writes. */
  function readsAllowedBase(tail: string[] = []): string[] {
    return [
      ...SCRIPT_LOAD,
      "pulls.get",
      "issues.listComments",
      "repos.getCollaboratorPermissionLevel",
      "repos.compareCommitsWithBasehead",
      "repos.compareCommitsWithBasehead",
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

    // Top level: these five keys and nothing else.
    expect(Object.keys(workflow).sort()).toEqual([
      "concurrency",
      "jobs",
      "name",
      "on",
      "permissions",
    ]);

    // pull_request_target runs with the base repo's token. Checking out or
    // executing the PR's code under it is the classic escalation.
    expect(Object.keys(workflow.on ?? {})).toEqual(["pull_request_target"]);

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

    // Exactly the scopes this gate needs. `pull-requests: write` covers title
    // and comment updates. `contents: write` is required for the draft GraphQL
    // mutations with GITHUB_TOKEN (#626: "Resource not accessible by integration"
    // when contents was unset). Asserting the whole object pins both presence
    // and the absence of anything broader (write-all, contents alone, …).
    expect(workflow.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });

    // One run per PR, so two rapid events cannot race on the title/draft state,
    // and no `cancel-in-progress` — cancelling the in-flight run mid-mutation is
    // how the bot ends up having prefixed the title but not recorded that it did.
    expect(workflow.concurrency).toEqual({
      group: "enforce-pr-target-${{ github.event.pull_request.number }}",
    });

    // One job, and it is this one. An audit round added a `sidecar:` job that
    // inherited the PR-write token and un-drafted the PR — every assertion below
    // still passed, because they only ever looked at `enforce-target`.
    expect(jobs.map(([name]) => name)).toEqual(["enforce-target"]);

    // The job is exactly a runner plus steps. No `if:` (which silently disables
    // the whole gate), no `permissions:` (a job-level block overrides the narrow
    // workflow-level one), no `container:`/`strategy:`/`outputs:`/`env:`/
    // `defaults:`, and no `<<:` merge key to reintroduce any of them sideways.
    const [, job] = jobs[0]!;
    expect(Object.keys(job).sort()).toEqual(["runs-on", "steps"]);
    expect(job["runs-on"]).toBe("ubuntu-latest");

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
      ref: "${{ github.event.repository.default_branch }}",
      "persist-credentials": false,
      "sparse-checkout": ".github/scripts",
    });

    expect(Object.keys(scriptStep).sort()).toEqual(["name", "uses", "with"]);

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
      "opened",
      "ready_for_review",
      "reopened",
      "synchronize",
    ]);

    // The verdict is a live PR read plus ancestry/description checks.
    expect(script).toContain("github.rest.pulls.get");
    expect(script).toContain("collectPrQualityFailures");
    expect(script).toContain("github.rest.repos.getCollaboratorPermissionLevel");
    expect(script).toContain("github.rest.repos.compareCommitsWithBasehead");
    // The allow-list is the gate's whole policy, so it is pinned by value and
    // not just by shape: a widened list is the one edit that opens every base
    // at once while every behavioural scenario below still passes.
    expect(script).toMatch(/const ALLOWED_BASES = \["dev"\];/);
    expect(script).toMatch(/const DEFAULT_BASE = "dev";/);

    // Every mutation targets the PR the event fired for. `pull_number` is the
    // only handle the script has, and an audit round repointed it at
    // `Number(context.payload.pull_request.title)` — a value the PR author
    // controls, which turns the bot into a write primitive against any PR
    // number the author can name. Bind it to the immutable event field.
    expect(script).toMatch(
      /const pull_number = context\.payload\.pull_request\.number;/,
    );
    expect(script.match(/pull_number\s*=/g) ?? []).toHaveLength(1);

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

    // The two title rewrites — one adds the prefix, one removes it on a correct
    // retarget. `base`, `state`, and `body` are all accepted by this endpoint
    // and none of them belong here.
    expect(callArgs("github.rest.pulls.update")).toEqual([
      ["owner", "pull_number", "repo", "title"],
      ["owner", "pull_number", "repo", "title"],
      ["owner", "pull_number", "repo", "title"],
    ]);

    // Both comment writes address the PR being enforced, by its own number.
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

    // These are the only three mutating REST calls. A fourth is a new write
    // nobody reviewed. `pulls.list` is a stacked-base read, not a write.
    const restWrites = [...script.matchAll(/github\.rest\.[\w.]+/g)]
      .map(match => match[0])
      .filter(
        name =>
          !name.endsWith(".get") &&
          !name.endsWith(".list") &&
          !name.endsWith(".listComments") &&
          name !== "github.rest.repos.getCollaboratorPermissionLevel" &&
          name !== "github.rest.repos.compareCommitsWithBasehead",
      );
    expect([...new Set(restWrites)].sort()).toEqual([
      "github.rest.issues.createComment",
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
      const result = await run({ pr: { base: { ref: "dev" } } });

      // Reads only. If a rewrite adds a write here, it appears in this list.
      expect(methodsOf(result)).toEqual(readsAllowedBase());
      expect(result.logs.join(" ")).toContain("All PR quality gates passed");
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

      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "issues.createComment",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));
      const commentBody = lastEnforcerCommentBody(result);
      expect(commentBody).toContain("Wrong branch ancestry");
      expect(commentBody).not.toContain("Wrong target branch");
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
      expect(lastEnforcerCommentBody(result)).toContain("Pull request description");
      expect(lastEnforcerCommentBody(result)).toContain("body is empty");
      expect(callsTo(result, "graphql")).toHaveLength(1);
    });

    test("literal backslash-n in the body fails the description gate", async () => {
      const result = await run({
        pr: {
          base: { ref: "dev" },
          body: "## Summary\\n\\nThis uses escaped newlines instead of real breaks.\\n\\n## Test plan\\n\\nAlso escaped here.",
        },
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("literal `\\n` escape sequences");
    });

    test("clears prior bot state when every gate passes again", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, draft: true },
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
        "issues.updateComment",
      ]));
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
      const [cleared] = callsTo(result, "issues.updateComment") as [{ body: string }];
      expect(cleared.body).toContain('"active":false');
      expect(cleared.body).toContain("PR quality gates passed");
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
          "issues.createComment",
          "pulls.update",
          "issues.updateComment",
          "graphql",
          "issues.updateComment",
          "issues.updateComment",
        ]));
        expect(lastEnforcerCommentBody(result)).toContain(`\`${ref}\``);
        expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      }
    });

    test("a PR retargeted from main to dev is restored, not left prefixed", async () => {
      // A contributor who follows the bot's own instruction must end up with
      // their original title and ready state back. If the restoration path
      // does not fire, they are left with a permanently renamed, drafted PR
      // and no state to explain it.
      const result = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Port the runtime entry" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "graphql",
        "issues.updateComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Port the runtime entry" },
      ]);
      const [cleared] = callsTo(result, "issues.updateComment") as [{ body: string }];
      expect(cleared.body).toContain('"active":false');
      // The confirmation names where the PR actually went, read from the live
      // PR rather than assumed.
      expect(cleared.body).toContain("now targets `dev`");
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
        "issues.updateComment",
        "pulls.update",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
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

      expect(commentBody).toContain("must target one of `dev`");
      expect(commentBody).toContain("Please retarget this PR to `dev`");
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
        "issues.createComment",
        "pulls.update",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));

      // The title update carries the title and nothing else. `base`, `state`
      // and `body` are all accepted by this endpoint; an audit round added
      // `base: "main"` here and no static assertion caught it.
      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] Add a thing" },
      ]);

      // The first comment create addresses this PR, by its own number.
      const [created] = callsTo(result, "issues.createComment") as [{ issue_number: number; body: string }];
      expect(created.issue_number).toBe(42);
      expect(created.body).toContain(MARKER);
      const commentBody = lastEnforcerCommentBody(result);
      expect(commentBody).toContain("@contributor");
      expect(commentBody).toContain('"autoDraftedByBot":true');

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
        "issues.createComment",
        "pulls.update",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
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
        "issues.createComment",
        "pulls.update",
        "issues.updateComment",
      ]));
      expect(lastEnforcerCommentBody(wrong)).toContain('"autoDraftedByBot":false');
      expect(wrong.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);

      // Now retarget it correctly, feeding that state back in.
      const restored = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: false, titlePrefixedByBot: true })],
      });

      // The prefix comes off; the draft stays. No GraphQL at all.
      expect(methodsOf(restored)).toEqual(readsAllowedBase([
        "pulls.update",
        "issues.updateComment",
      ]));
      expect(callsTo(restored, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
      ]);
    });

    test("a corrected PR gets its title and ready state back", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "graphql",
        "issues.updateComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
      ]);
      const [ready] = callsTo(result, "graphql") as [{ query: string }];
      expect(ready.query).toContain("markPullRequestReadyForReview");

      // The comment is edited in place, and the state is cleared so a later
      // run does not try to restore twice.
      const [update] = callsTo(result, "issues.updateComment") as [{ comment_id: number; body: string }];
      expect(update.comment_id).toBe(7);
      expect(update.body).toContain('"active":false');
      expect(update.body).toContain("PR quality gates passed");
    });

    test("only this workflow's own prefix is removed, not a contributor's edits", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, draft: false, title: "[WRONG BRANCH] Add a thing (v2)" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: false, titlePrefixedByBot: true })],
      });

      expect(callsTo(result, "pulls.update")).toEqual([
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
        "issues.updateComment",
        "issues.updateComment",
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
        "issues.createComment",
        "pulls.update",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));
      expect(callsTo(wentWrong, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] Add a thing" },
      ]);

      // …and the reverse: the event says main, the live PR says dev. No writes.
      const wasFixed = await run({
        pr: { base: { ref: "dev" } },
        eventPayload: { base: { ref: "main" } },
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
      expect(lastEnforcerCommentBody(wrongTarget)).toContain("currently targets `main`");
      expect(lastEnforcerCommentBody(wrongTarget)).not.toContain("currently targets `dev`");

      // The corrected-path sentence: the event still carries the old wrong
      // base, the live PR is on dev. Naming the event's base here tells the
      // author their retarget did not take.
      const corrected = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        eventPayload: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: false, titlePrefixedByBot: true })],
      });
      const [edited] = callsTo(corrected, "issues.updateComment") as [{ body: string }];
      expect(edited.body).toContain("now targets `dev`");
      expect(edited.body).not.toContain("now targets `main`");
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
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        commentPages: [
          filler,
          [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
        ],
      });

      // Found it: the prefix comes off, the PR is marked ready, and the
      // existing comment is edited rather than duplicated.
      expect(methodsOf(result)).toEqual(readsAllowedBasePaged([
        "pulls.update",
        "graphql",
        "issues.updateComment",
      ]));
      expect(callsTo(result, "issues.createComment")).toEqual([]);
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
        "issues.updateComment",
        "pulls.update",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
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
        "issues.updateComment",
        "issues.updateComment",
      ]));

      // Corrected: nothing to undo, but the state must still be cleared or the
      // next wrong-target event resumes from a stale record.
      const corrected = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment(noRecordedChanges)],
      });
      expect(methodsOf(corrected)).toEqual(readsAllowedBase(["issues.updateComment"]));
      const [cleared] = callsTo(corrected, "issues.updateComment") as [{ body: string }];
      expect(cleared.body).toContain('"active":false');
      expect(cleared.body).toContain("PR quality gates passed");
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

      // Nothing to un-draft, the prefix comes off, and the state is cleared.
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "issues.updateComment",
      ]));
      const [cleared] = callsTo(result, "issues.updateComment") as [{ body: string }];
      expect(cleared.body).toContain('"active":false');
    });

    test("a title the author already fixed by hand is not sliced a second time", async () => {
      // `titlePrefixedByBot: true` while the live title no longer starts with
      // the prefix — the author removed it themselves. Slicing anyway would eat
      // the first 15 characters of their title.
      const result = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "issues.updateComment",
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
      // Names every branch involved, so the instruction is actionable without
      // context: where the PR is now and where it should go.
      expect(commentBody).toContain("`main`");
      expect(commentBody).toContain("`dev`");
      // Points at the documentation rather than assuming the reader knows.
      expect(commentBody).toContain("https://lidge-jun.github.io/opencodex/contributing/");
      // And carries the state the next run needs.
      expect(commentBody).toContain(MARKER);
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
      const [posted] = callsTo(wrong, "issues.createComment") as [{ body: string }];
      expect(posted.body).toContain('"version":1');

      const cleared = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });
      const [done] = callsTo(cleared, "issues.updateComment") as [{ body: string }];
      expect(done.body).toContain('"version":1');
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
          pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
          comments: [botComment(active)],
        });
        expect(methodsOf(restored)).toEqual(readsAllowedBase([
          "pulls.update",
          "graphql",
          "issues.updateComment",
        ]));
        expect(callsTo(restored, "pulls.update")).toEqual([
          { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
        ]);
        const [cleared] = callsTo(restored, "issues.updateComment") as [{ body: string }];
        expect(cleared.body).toContain('"version":1');
        expect(cleared.body).toContain('"active":false');

        // Still wrong: enforcement proceeds, and the spread carries the
        // unknown version through untouched. Pinning that is what makes a
        // future migration a visible decision rather than a silent rewrite.
        const wrong = await run({
          pr: { base: { ref: "main" }, draft: false, title: "Add a thing" },
          comments: [botComment(active)],
        });
        expect(methodsOf(wrong)).toEqual(readsWrongBase([
          "issues.updateComment",
          "pulls.update",
          "issues.updateComment",
          "graphql",
          "issues.updateComment",
          "issues.updateComment",
        ]));
        expect(lastEnforcerCommentBody(wrong)).toContain(`"version":${version}`);
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
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: "true", autoDraftedByBot: 1, titlePrefixedByBot: "yes" })],
      });
      expect(methodsOf(loose)).toEqual(readsAllowedBase([
        "pulls.update",
        "graphql",
        "issues.updateComment",
      ]));
      expect(callsTo(loose, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
      ]);

      // And the falsy side is symmetric: `null` and `0` skip their own
      // restoration without stopping the run or the clearing write.
      const falsy = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: null, titlePrefixedByBot: 0 })],
      });
      expect(methodsOf(falsy)).toEqual(readsAllowedBase(["issues.updateComment"]));
      const [cleared] = callsTo(falsy, "issues.updateComment") as [{ body: string }];
      expect(cleared.body).toContain('"active":false');
    });

    test("ownership comment is checkpointed before mutations and finalized after", async () => {
      // Ownership is written before title/draft. autoDraftedByBot is claimed and
      // checkpointed before convertToDraft so a successful convert followed by a
      // failed comment still restores later.
      const result = await run({ pr: { base: { ref: "main" }, draft: false } });
      const methods = methodsOf(result);
      const pending = methods.indexOf("issues.createComment");
      const title = methods.indexOf("pulls.update");
      const draftClaim = methods.indexOf("issues.updateComment");
      const draft = methods.indexOf("graphql");
      const finalUpdate = methods.lastIndexOf("issues.updateComment");
      expect(pending).toBeGreaterThan(-1);
      expect(pending).toBeLessThan(title);
      expect(title).toBeLessThan(draftClaim);
      expect(draftClaim).toBeLessThan(draft);
      expect(draft).toBeLessThan(finalUpdate);
      expect(lastEnforcerCommentBody(result)).toContain('"autoDraftedByBot":true');
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
      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.createComment",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
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
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] " },
      ]);
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.createComment",
        "pulls.update",
        "issues.updateComment",
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
      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.createComment",
        "issues.updateComment",
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
        "issues.createComment",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));
      // Already prefixed by the `startsWith` test, so no third prefix is added.
      expect(callsTo(result, "pulls.update")).toEqual([]);
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
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [first, second],
      });

      // The first comment's state is the one honoured: it says the bot
      // prefixed and drafted, so both are undone.
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "graphql",
        "issues.updateComment",
      ]));
      // And the first comment is the one rewritten, not the second.
      const [updated] = callsTo(result, "issues.updateComment") as [{ comment_id: number }];
      expect(updated.comment_id).toBe(7);
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
      const result = await run({ pr: { base: { ref: "dev" } } });
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
          "issues.createComment",
          "pulls.update",
          "issues.updateComment",
          "graphql",
          "issues.updateComment",
        ]));
        const commentBody = lastEnforcerCommentBody(result);
        expect(commentBody).toContain('"autoDraftedByBot":false');
        expect(commentBody).toContain("Automatic draft conversion failed");
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
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
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
        failOn: ["graphql"],
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
    expect(script).toMatch(/storedState\.autoDraftedByBot/);
    expect(script).toMatch(/storedState\.titlePrefixedByBot/);
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
    expect(script).toMatch(/\n\s*if \(!storedState\?\.active\) \{\n/);
    expect(script).toMatch(/\n\s*if \(failures\.length > 0\) \{\n/);

    // Pending ownership is written before mutations; convertToDraft runs next;
    // a later upsertComment records autoDraftedByBot only after success (#631).
    const branchStart = script.indexOf("if (failures.length > 0) {");
    expect(branchStart).toBeGreaterThan(-1);
    const branch = script.slice(branchStart);
    const pendingWriteIndex = branch.indexOf("await upsertComment(");
    const draftCallIndex = branch.indexOf("await convertToDraft()");
    const afterDraftWriteIndex = branch.indexOf("await upsertComment(", draftCallIndex);
    expect(pendingWriteIndex).toBeGreaterThan(-1);
    expect(draftCallIndex).toBeGreaterThan(-1);
    expect(pendingWriteIndex).toBeLessThan(draftCallIndex);
    expect(afterDraftWriteIndex).toBeGreaterThan(draftCallIndex);
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
    expect(workflow).toMatch(
      /jobs:\s*\n\s*translate:[\s\S]*?permissions:\s*\n(?:\s*#.*\n)*\s*contents: read\s*\n(?:\s*#.*\n)*\s*issues: write\s*\n(?:\s*#.*\n)*\s*models: read/,
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
    expect(workflow).toContain("millionco/react-doctor@938008119a288f2fb47c66a69cd9279a21f31784");
    expect(workflow).not.toMatch(
      /^\s*-\s+uses:\s+\S+@(?![0-9a-f]{40}(?=[ \t]*(?:#.*)?$))\S+/m,
    );

    // Engine pin: the action wrapper would fetch react-doctor@latest without it.
    expect(workflow).toContain('version: "0.9.2"');

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

    expect(guiPkg).toContain("react-doctor@0.9.2");
    expect(guiPkg).not.toContain("react-doctor@latest");
    expect(rootPkg).not.toContain("react-doctor@latest");
    expect(doctorConfig).toContain('"blocking": "warning"');
    expect(rootPkg).toContain('"doctor:gui:if-changed": "bun scripts/doctor-gui-if-changed.ts"');
    expect(rootPkg).toContain('"lint:gui": "cd gui && bun run lint"');
    // Gating steps include React Doctor after privacy scan on gui/ pushes.
    expect(rootPkg).toContain("bun run typecheck && bun run lint:gui && bun run test");
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
