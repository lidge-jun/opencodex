/**
 * The release preflight, asserted by shape and by execution.
 *
 * Run 35783865160 packaged 2.62.0 for nineteen minutes and then failed its ordering gate in
 * `publish` on `v2.63.0-preview.20260923`, a tag that already existed when the run's first job
 * started: the workflow-level `release` concurrency group had held the stable run until the
 * preview run finished. The runs were serialised; the check sat in the wrong place. These cases pin
 * the `preflight` job in front of every packaging job, keep the publish-job gate as the final
 * check, pin the shared concurrency group that makes the early answer trustworthy, and execute
 * `scripts/ci/release-preflight.sh` against a real tag set with fake `gh` and `npm`.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; if?: string; outputs?: Record<string, string>; env?: Record<string, string>; permissions?: Record<string, string>; steps?: Step[]; "runs-on"?: string };
type Workflow = { concurrency?: { group?: string; "cancel-in-progress"?: boolean }; jobs?: Record<string, Job | undefined> };

const release = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8")) as Workflow;
const needsOf = (job: Job | undefined): string[] =>
  job?.needs === undefined ? [] : typeof job.needs === "string" ? [job.needs] : job.needs;
const PREFLIGHT = repoPath("scripts", "ci", "release-preflight.sh");

describe("dev-source release inputs", () => {
  test("resolves a source under the pinned dev workflow and exports both identities and version", () => {
    const job = release.jobs?.["validate-dispatch"];
    expect(job?.outputs).toMatchObject({
      source_sha: "${{ steps.source.outputs.source_sha }}",
      workflow_sha: "${{ steps.source.outputs.workflow_sha }}",
      version: "${{ steps.version.outputs.version }}",
    });
    const steps = job?.steps ?? [];
    const checkout = steps.find(step => step.name === "Checkout trusted workflow revision");
    expect(checkout?.with?.ref).toBe("${{ github.sha }}");
    const resolve = steps.find(step => step.name === "Resolve eligible source");
    expect(resolve?.run).toContain(".github/scripts/release-evidence.cjs resolve");
    expect(resolve?.run).toContain("refs/heads/dev");
    expect(steps.find(step => step.name === "Resolve release version")?.run).toContain("devReleaseVersion");
  });

  test("each build checkout selects the source and stamps all four files before installing", () => {
    for (const id of ["package-standalone", "package-desktop", "package-npm"]) {
      const job = release.jobs?.[id];
      expect(needsOf(job), id).toContain("validate-dispatch");
      expect(job?.env?.SOURCE_SHA, id).toBe("${{ needs.validate-dispatch.outputs.source_sha }}");
      expect(job?.env?.RELEASE_VERSION, id).toBe("${{ needs.validate-dispatch.outputs.version }}");
      const steps = job?.steps ?? [];
      const checkout = steps.find(step => step.name === (id === "package-npm" ? "Checkout selected source" : "Checkout"));
      expect(checkout?.with?.ref, id).toBe("${{ needs.validate-dispatch.outputs.source_sha }}");
      const stamp = steps.find(step => step.name === "Stamp and verify release version");
      expect(stamp?.run, id).toContain("release-version-sources.ts sync");
      expect(stamp?.run, id).toContain("release-version-sources.ts check");
      const install = steps.findIndex(step => /install.*dependenc/i.test(step.name ?? ""));
      if (install >= 0) expect(steps.indexOf(stamp!), id).toBeLessThan(install);
    }
  });

  test("release artifacts and tags identify the selected source", () => {
    const verify = release.jobs?.["verify-release"]?.steps?.find(step => step.name === "Verify release assets");
    const attach = release.jobs?.["attach-release"]?.steps?.find(step => step.name === "Require the verification receipt for this commit");
    const create = release.jobs?.publish?.steps?.find(step => step.name === "Create GitHub release");
    expect(verify?.run).toContain('--sha "$SOURCE_SHA"');
    expect(attach?.run).toContain('receipt.sha !== process.env.SOURCE_SHA');
    expect(create?.run).toContain('git tag "$release_tag" "$SOURCE_SHA"');
    expect(create?.run).toContain('--target "$SOURCE_SHA"');
  });
});

test.skipIf(process.platform === "win32")("the actual stamp step binds source SHA and rewrites all four version sources", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-release-stamp-"));
  try {
    const paths = ["package.json", "desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/Cargo.lock"];
    for (const path of paths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(repoPath(path), join(root, path));
    }
    const trustedScript = join(root, "trusted-release-policy/scripts/release-version-sources.ts");
    mkdirSync(dirname(trustedScript), { recursive: true });
    copyFileSync(repoPath("scripts/release-version-sources.ts"), trustedScript);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    git("init", "-q"); git("add", ...paths); git("commit", "-q", "-m", "fixture");
    const source = git("rev-parse", "HEAD");
    const stamp = release.jobs?.["package-desktop"]?.steps?.find(step => step.name === "Stamp and verify release version")?.run;
    expect(stamp).toBeDefined();
    const execute = (sourceSha: string, version: string) => Bun.spawnSync(["bash", "-e", "-c", stamp!], {
      cwd: root, env: { ...env, SOURCE_SHA: sourceSha, WORKFLOW_SHA: "b".repeat(40), RELEASE_VERSION: version },
      stdout: "pipe", stderr: "pipe",
    });
    const before = paths.map(path => readFileSync(join(root, path), "utf8"));
    expect(execute("a".repeat(40), "9.8.7-preview.20261108.1").exitCode).not.toBe(0);
    expect(execute(source, "").exitCode).not.toBe(0);
    expect(paths.map(path => readFileSync(join(root, path), "utf8"))).toEqual(before);
    const success = execute(source, "9.8.7-preview.20261108.1");
    expect(success.exitCode, success.stderr.toString()).toBe(0);
    const checked = Bun.spawnSync([process.execPath, trustedScript, "check", "9.8.7-preview.20261108.1", "--root", root], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    expect(checked.exitCode, checked.stderr.toString()).toBe(0);
  } finally { removeTreeWithRetry(root); }
});

test.skipIf(process.platform === "win32")("source resolution refuses invalid dispatch and evidence before exporting identities", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-release-source-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, ".github/scripts"), { recursive: true });
    copyFileSync(repoPath(".github/scripts/release-dispatch-guard.cjs"), join(root, ".github/scripts/release-dispatch-guard.cjs"));
    writeFileSync(join(bin, "node"), '#!/bin/sh\nif [ "$1" = .github/scripts/release-evidence.cjs ]; then printf "%s\\n" "$EVIDENCE"; exit "$EVIDENCE_STATUS"; fi\nexec "$REAL_NODE" "$@"\n', { mode: 0o755 });
    const script = release.jobs?.["validate-dispatch"]?.steps?.find(step => step.name === "Resolve eligible source")?.run;
    const source = "a".repeat(40), workflow = "b".repeat(40), output = join(root, "output");
    const execute = (extra: Record<string, string> = {}) => {
      writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-e", "-c", script!], { cwd: root, env: {
        PATH: `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`, REAL_NODE: Bun.which("node")!,
        GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/dev", GITHUB_SHA: workflow,
        GITHUB_OUTPUT: output, REQUESTED_SHA: "", REQUESTED_VERSION: "", DRY_RUN: "false", RESUME: "false", EVIDENCE_STATUS: "0",
        EVIDENCE: JSON.stringify({ sourceSha: source, ciRunId: 123 }), ...extra,
      }, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, output: readFileSync(output, "utf8"), stderr: result.stderr.toString() };
    };
    for (const bad of [
      { GITHUB_REF: "refs/heads/feature" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_SHA: "short" },
      { REQUESTED_SHA: "short" }, { REQUESTED_SHA: "c".repeat(40) }, { EVIDENCE_STATUS: "1" },
      { EVIDENCE: JSON.stringify({ sourceSha: source, ciRunId: 0 }) }, { EVIDENCE: "{}" },
      { RESUME: "true", REQUESTED_VERSION: "2.1.0" },
      { RESUME: "true", REQUESTED_SHA: source },
      { RESUME: "true", REQUESTED_SHA: source, REQUESTED_VERSION: "2.1.0", DRY_RUN: "true" },
    ]) {
      const result = execute(bad);
      expect(result.code, JSON.stringify(bad)).not.toBe(0);
      expect(result.output, JSON.stringify(bad)).toBe("");
    }
    // An omitted source is accepted only after the same resolver supplies valid evidence.
    const selected = execute();
    expect(selected.code, selected.stderr).toBe(0);
    expect(selected.output).toBe(`source_sha=${source}\nworkflow_sha=${workflow}\n`);
    for (const bad of [{ EVIDENCE_STATUS: "1" }, { EVIDENCE: "{}" }, { EVIDENCE: JSON.stringify({ sourceSha: "bad", ciRunId: 123 }) }]) {
      const result = execute(bad);
      expect(result.code, JSON.stringify(bad)).not.toBe(0);
      expect(result.output, JSON.stringify(bad)).toBe("");
    }
    const valid = execute({ REQUESTED_SHA: source });
    expect(valid.code, valid.stderr).toBe(0);
    expect(valid.output).toBe(`source_sha=${source}\nworkflow_sha=${workflow}\n`);
    const resume = execute({ RESUME: "true", REQUESTED_SHA: source, REQUESTED_VERSION: "2.1.0" });
    expect(resume.code, resume.stderr).toBe(0);
    expect(resume.output).toBe(`source_sha=${source}\nworkflow_sha=${workflow}\n`);
  } finally { removeTreeWithRetry(root); }
});

test.skipIf(process.platform === "win32")("the actual version step derives the version and rejects inconsistent inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-release-version-"));
  try {
    const paths = ["package.json", "desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/Cargo.lock"];
    for (const path of paths) {
      const target = join(root, "candidate", path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(repoPath(path), target);
    }
    copyFileSync(repoPath("package.json"), join(root, "package.json"));
    mkdirSync(join(root, "scripts"));
    for (const path of ["version-line.ts", "release-version-sources.ts"]) copyFileSync(repoPath("scripts", path), join(root, "scripts", path));
    const bin = join(root, "bin"), temp = join(root, "tmp"), output = join(root, "output");
    mkdirSync(bin); mkdirSync(temp);
    writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$MOCK_NPM_VERSIONS"\n', { mode: 0o755 });
    const env = { PATH: `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: root, GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
    const command = (...args: string[]) => {
      const result = Bun.spawnSync(args, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    };
    command(process.execPath, "scripts/release-version-sources.ts", "sync", "2.2.0", "--root", "candidate");
    command("git", "init", "-q"); command("git", "add", "package.json"); command("git", "commit", "-q", "-m", "fixture");
    command("git", "tag", "v2.2.0");
    const script = release.jobs?.["validate-dispatch"]?.steps?.find(step => step.name === "Resolve release version")?.run;
    const execute = (extra: Record<string, string> = {}) => {
      writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-e", "-c", script!], { cwd: root, env: { ...env,
        RUNNER_TEMP: temp, GITHUB_OUTPUT: output, CHANNEL: "latest", EXPECTED_VERSION: "", RESUME: "false", MOCK_NPM_VERSIONS: '["2.2.0"]', ...extra,
      }, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, output: readFileSync(output, "utf8"), stderr: result.stderr.toString() };
    };
    const stable = execute();
    expect(stable.code, stable.stderr).toBe(0);
    expect(stable.output).toBe("version=2.2.1\n");
    const resume = execute({ RESUME: "true", EXPECTED_VERSION: "2.2.0", MOCK_NPM_VERSIONS: "not-json" });
    expect(resume.code, resume.stderr).toBe(0);
    expect(resume.output).toBe("version=2.2.0\n");
    expect(execute({ RESUME: "true", EXPECTED_VERSION: "" }).code).not.toBe(0);
    const preview = execute({ CHANNEL: "preview" });
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.output).toMatch(/^version=2\.2\.1-preview\.\d{8}\.1\n$/);
    for (const bad of [{ EXPECTED_VERSION: "2.2.0" }, { CHANNEL: "unknown" }, { MOCK_NPM_VERSIONS: "{}" }]) {
      const result = execute(bad);
      expect(result.code, JSON.stringify(bad)).not.toBe(0);
      expect(result.output).toBe("");
    }
  } finally { removeTreeWithRetry(root); }
});

describe("the release preflight job", () => {
  const preflight = release.jobs?.preflight;

  test("runs after dispatch validation with read-only permissions", () => {
    expect(needsOf(preflight)).toEqual(["validate-dispatch"]);
    expect(preflight?.permissions).toEqual({ contents: "read" });
    expect(preflight?.["runs-on"]).toBe("ubuntu-latest");
  });

  test("gates every packaging job", () => {
    for (const name of ["package-standalone", "package-desktop"]) {
      expect(`${name}:${needsOf(release.jobs?.[name]).includes("preflight")}`).toBe(`${name}:true`);
    }
  });

  test("runs the preflight script with dispatch inputs passed through env", () => {
    const step = (preflight?.steps ?? []).find(candidate => candidate.run?.includes("scripts/ci/release-preflight.sh"));
    expect(step?.run?.trim()).toBe("bash scripts/ci/release-preflight.sh");
    expect(step?.env).toMatchObject({
      RELEASE_VERSION: "${{ needs.validate-dispatch.outputs.version }}",
      NPM_DIST_TAG: "${{ inputs.tag }}",
      DRY_RUN: "${{ inputs.dry-run }}",
      RESUME: "${{ inputs.resume-after-npm-publish }}",
    });
    // The script reads origin/dev and the tag set; both must be present in the checkout.
    const checkout = (preflight?.steps ?? []).find(candidate => candidate.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-tags"]).toBe(true);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect((preflight?.steps ?? []).some(candidate => candidate.run?.includes("+refs/heads/dev:refs/remotes/origin/dev"))).toBe(true);
  });

  test("leaves the publish-time ordering gate in place as the final check", () => {
    const steps = release.jobs?.publish?.steps ?? [];
    const ordering = steps.find(step => step.name === "Refuse a release the current tag set already outranks");
    const publish = steps.find(step => step.name === "Publish verified npm tarball");
    expect(ordering?.run).toContain("assert-releasable");
    expect(steps.indexOf(ordering!)).toBeLessThan(steps.indexOf(publish!));
  });

  test("keeps one release slot shared by every ref", () => {
    // A constant group is what serialised the stable run behind the preview one. A per-ref group
    // would let a main and a preview release run at once, and then no early check could be final.
    expect(release.concurrency?.group).toBe("release");
    expect(release.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});

// These steps run in ubuntu-latest jobs; Windows need not have a POSIX bash on PATH.
describe.skipIf(process.platform === "win32")("release publication hold", () => {
  test("refuses real publication unless the repository variable is exactly true", () => {
    const step = release.jobs?.publish?.steps?.find(candidate => candidate.name === "Require publication hold to be enabled");
    expect(step?.env?.PUBLISH_ENABLED).toBe("${{ vars.OCX_DEV_RELEASE_PUBLISH_ENABLED }}");
    expect(step?.env?.DRY_RUN).toBe("${{ inputs.dry-run }}");
    for (const [dryRun, enabled, status] of [
      ["false", "", 1], ["false", "false", 1], ["false", "TRUE", 1],
      ["false", "true", 0], ["true", "", 0],
    ] as const) {
      const result = Bun.spawnSync(["bash", "-e", "-c", step!.run!], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DRY_RUN: dryRun, PUBLISH_ENABLED: enabled },
        stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode, `dry-run=${dryRun} enabled=${enabled}`).toBe(status);
    }
    const publish = release.jobs?.publish?.steps?.find(candidate => candidate.name === "Publish verified npm tarball");
    expect(release.jobs!.publish!.steps!.indexOf(step!)).toBeLessThan(release.jobs!.publish!.steps!.indexOf(publish!));
  });

  test("does not run the outcome script after dispatch validation fails", () => {
    const outcomes = release.jobs?.["release-outcomes"];
    expect(needsOf(outcomes)).toContain("validate-dispatch");
    expect(outcomes?.if).toContain("needs.validate-dispatch.result == 'success'");
  });
});

type Scenario = {
  version?: string;
  ref?: string;
  distTag?: string;
  tags?: string[];
  devVersion?: string | null;
  npm?: "absent" | "present" | "unreadable";
  githubRelease?: boolean;
  dryRun?: boolean;
  resume?: boolean;
  sourceSha?: string;
  workflowSha?: string;
};

// The script checks the real version sources (package.json and the desktop manifests) through its own
// repository root, so the scenarios release the checkout's own version; only the tag set, dev, gh
// and npm are fixtures.
const OWN_VERSION = (JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as { version: string }).version;
const [MAJOR, MINOR] = OWN_VERSION.split(/[.-]/).map(Number) as [number, number];
const OWN_IS_PREVIEW = OWN_VERSION.includes("-preview.");
const OWN_REF = "refs/heads/dev";
const OWN_TAG = OWN_IS_PREVIEW ? "preview" : "latest";
const NEXT_CORE = `${MAJOR}.${MINOR + 1}.0`;

const FAKE_GH = [
  "#!/bin/sh",
  '[ "$FIXTURE_GH_RELEASE" = "yes" ] && exit 0',
  'echo "release not found" >&2',
  "exit 1",
  "",
].join("\n");
const FAKE_NPM = [
  "#!/bin/sh",
  'case "$FIXTURE_NPM" in',
  '  present) echo "$RELEASE_VERSION" ;;',
  '  unreadable) echo "npm error code ETIMEDOUT" >&2; exit 1 ;;',
  '  *) echo "npm error code E404" >&2; exit 1 ;;',
  "esac",
  "",
].join("\n");

function run(cwd: string, env: Record<string, string>, ...command: string[]): string {
  const result = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function preflight(scenario: Scenario): { status: number | null; output: string; summary: string } {
  const directory = mkdtempSync(join(tmpdir(), "ocx-release-preflight-"));
  try {
    const repo = join(directory, "repo");
    const bin = join(directory, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
    writeFileSync(join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
    const gitEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    };
    run(repo, gitEnv, "git", "init", "-q", "-b", "release");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: scenario.version ?? OWN_VERSION }));
    run(repo, gitEnv, "git", "add", "package.json");
    run(repo, gitEnv, "git", "commit", "-q", "-m", "release");
    const head = run(repo, gitEnv, "git", "rev-parse", "HEAD");
    for (const tag of scenario.tags ?? []) run(repo, gitEnv, "git", "tag", tag);
    if (scenario.devVersion !== null) {
      run(repo, gitEnv, "git", "checkout", "-q", "-b", "dev");
      writeFileSync(join(repo, "package.json"), JSON.stringify({ version: scenario.devVersion ?? NEXT_CORE }));
      run(repo, gitEnv, "git", "commit", "-q", "--allow-empty", "-am", "dev pre-move");
      run(repo, gitEnv, "git", "update-ref", "refs/remotes/origin/dev", "HEAD");
      run(repo, gitEnv, "git", "checkout", "-q", "release");
    }
    const summary = join(directory, "summary.md");
    writeFileSync(summary, "");
    const result = Bun.spawnSync(["bash", PREFLIGHT], {
      cwd: repo,
      env: {
        ...gitEnv,
        PATH: `${bin}${delimiter}${gitEnv.PATH}`,
        RELEASE_VERSION: scenario.version ?? OWN_VERSION,
        NPM_DIST_TAG: scenario.distTag ?? OWN_TAG,
        GITHUB_REF: scenario.ref ?? OWN_REF,
        GITHUB_SHA: scenario.workflowSha === "HEAD" ? head : (scenario.workflowSha ?? "b".repeat(40)),
        SOURCE_SHA: scenario.sourceSha ?? head,
        DRY_RUN: String(scenario.dryRun ?? false),
        RESUME: String(scenario.resume ?? false),
        GITHUB_STEP_SUMMARY: summary,
        FIXTURE_GH_RELEASE: scenario.githubRelease ? "yes" : "no",
        FIXTURE_NPM: scenario.npm ?? "absent",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    removeTreeWithRetry(directory);
  }
}

describe.skipIf(process.platform === "win32")("scripts/ci/release-preflight.sh, executed", () => {
  test("replays run 35783865160: a higher-core tag refuses the release before packaging", () => {
    const blocker = OWN_IS_PREVIEW ? `v${NEXT_CORE}` : `v${NEXT_CORE}-preview.20260923`;
    const result = preflight({ tags: ["v0.0.1", blocker] });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`${OWN_VERSION} does not outrank the current tag set`);
    expect(result.output).toContain("found 1 blocking problem(s)");
    expect(result.summary).toContain(`Release preflight refused ${OWN_VERSION}`);
  }, SPAWN_BUDGET_MS);

  test("passes a release every check can already approve", () => {
    const result = preflight({ tags: ["v0.0.1"] });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Release preflight passed");
    expect(result.summary).toBe("");
  }, SPAWN_BUDGET_MS);

  test("refuses a version npm already has unless the run is a dry run", () => {
    const real = preflight({ tags: ["v0.0.1"], npm: "present" });
    expect(real.status, real.output).toBe(1);
    expect(real.output).toContain("already exists on npm");
    const dry = preflight({ tags: ["v0.0.1"], npm: "present", dryRun: true });
    expect(dry.status, dry.output).toBe(0);
    expect(dry.output).toContain("::notice::");
  }, SPAWN_BUDGET_MS);

  test("refuses an existing GitHub release outside the resume path", () => {
    const result = preflight({ tags: ["v0.0.1"], githubRelease: true });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("GitHub Release");
  }, SPAWN_BUDGET_MS);

  test("refuses a resume with nothing on npm to resume from", () => {
    const result = preflight({ tags: ["v0.0.1"], resume: true });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("is not on npm");
  }, SPAWN_BUDGET_MS);

  test("refuses when npm cannot be read", () => {
    const result = preflight({ tags: ["v0.0.1"], npm: "unreadable" });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("Could not establish npm state");
  }, SPAWN_BUDGET_MS);

  test("does not require a dev pre-move and uses source rather than workflow SHA for tags", () => {
    const result = preflight({ tags: [`v${OWN_VERSION}`], devVersion: null, dryRun: true });
    expect(result.status, result.output).toBe(0);
  }, SPAWN_BUDGET_MS);

  test("refuses an exact tag at a different source even when it matches the workflow SHA", () => {
    const result = preflight({ tags: [`v${OWN_VERSION}`], sourceSha: "a".repeat(40), workflowSha: "HEAD", dryRun: true });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("already points at");
  }, SPAWN_BUDGET_MS);

  test("rejects invalid channels, refs and source SHA", () => {
    for (const scenario of [{ distTag: "invalid" }, { ref: "refs/heads/main" }, { sourceSha: "abc" }]) {
      const result = preflight({ tags: ["v0.0.1"], ...scenario });
      expect(result.status, result.output).toBe(1);
    }
  }, SPAWN_BUDGET_MS);

  test("reports every problem in one run", () => {
    const wrongTag = OWN_TAG === "latest" ? "preview" : "latest";
    const result = preflight({ tags: ["v0.0.1"], distTag: wrongTag, npm: "present" });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("version does not match npm dist-tag");
    expect(result.output).toContain("already exists on npm");
    expect(result.output).toContain("found 2 blocking problem(s)");
  }, SPAWN_BUDGET_MS);
});
