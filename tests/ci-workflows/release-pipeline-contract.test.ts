import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

type WorkflowStep = {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
  shell?: string;
};

type WorkflowJob = {
  if?: string;
  needs?: string[];
  strategy?: { matrix?: { include?: Array<{ os?: string }> } };
  steps?: WorkflowStep[];
};

type Workflow = { jobs?: Record<string, WorkflowJob | undefined> };

function needsOf(job: WorkflowJob | undefined): string[] {
  if (job?.needs === undefined) return [];
  return typeof job.needs === "string" ? [job.needs] : job.needs;
}

function readWorkflow(...segments: string[]): Workflow {
  return Bun.YAML.parse(readFileSync(repoPath(...segments), "utf8")) as Workflow;
}

function triggerPaths(workflowText: string, trigger: string, until: string): string[] {
  const afterTrigger = workflowText.split(`${trigger}:`)[1]?.split(`${until}:`)[0];
  expect(afterTrigger).toBeDefined();
  return afterTrigger!
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith('- "'))
    .map(line => line.slice(3, -1));
}

/** Keep credentials and shell startup hooks out of mocked release subprocesses. */
function releaseTestEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: "", BASH_ENV: "", ENV: "" };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

/** Prefer native Git Bash on Windows; never invoke the System32 WSL launcher. */
function releaseTestBash(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const git = Bun.which("git");
    if (git) candidates.push(join(dirname(git), "..", "bin", "bash.exe"),
      join(dirname(git), "..", "usr", "bin", "bash.exe"));
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (root) candidates.push(join(root, "Git", "bin", "bash.exe"));
    }
    if (process.env.LOCALAPPDATA) candidates.push(
      join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  const onPath = Bun.which("bash");
  if (onPath && !/[\\/](?:system32|sysnative)[\\/]bash(?:\.exe)?$/i.test(onPath)) {
    candidates.push(onPath);
  }
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate)) continue;
    try {
      const probe = Bun.spawnSync([candidate, "--noprofile", "--norc", "-c", 'printf "%s" "$BASH_VERSION"'],
        { env: releaseTestEnv(), timeout: 2_000, maxBuffer: 4096 });
      if (probe.exitCode === 0 && probe.stdout.toString().trim()) return candidate;
    } catch { /* Try another native installation; no shell means an explicit local skip. */ }
  }
  return null;
}

/**
 * Contracts for the release pipeline itself. Each assertion encodes a defect that a green
 * workflow can still carry: a bash script silently reinterpreted by PowerShell on a Windows
 * runner, a checksum that records a path its verifier cannot resolve, publication that outruns
 * packaging, and a service gate that names one file while the implementation is a directory.
 */
describe("release pipeline contract", () => {
  const release = readWorkflow(".github", "workflows", "release.yml");

  test("every multi-line script on a Windows runner declares an explicit shell", () => {
    for (const jobId of ["package-standalone", "package-desktop"]) {
      const job = release.jobs?.[jobId];
      expect(job, jobId).toBeDefined();
      const runsOnWindows = job!.strategy?.matrix?.include?.some(entry => entry.os === "windows-latest");
      expect(runsOnWindows, `${jobId} exercises Windows`).toBe(true);
      for (const step of job!.steps ?? []) {
        // A single command line is shell-neutral; a script block implies shell-specific
        // syntax and must not fall back to the runner's default shell on Windows.
        if (typeof step.run !== "string" || !step.run.includes("\n")) continue;
        // Steps fenced away from Windows never meet PowerShell.
        if (/runner\.os\s*==\s*'(Linux|macOS)'/.test(step.if ?? "")) continue;
        expect(step.shell, `${jobId} / ${step.name}`).toBeDefined();
      }
    }
  });

  test("the release asset rename runs under bash", () => {
    const step = release.jobs?.["package-desktop"]?.steps
      ?.find(candidate => candidate.run?.includes("collect-release-assets.ts"));
    expect(step).toBeDefined();
    // The script uses backslash continuations and "$VAR" expansion, which PowerShell does
    // not read the way bash does; on the Windows matrix this step is only correct under bash.
    expect(step!.shell).toBe("bash");
  });

  test("standalone checksums record bare names that resolve where the verifier runs", () => {
    const archive = release.jobs?.["package-standalone"]?.steps
      ?.find(candidate => candidate.run?.includes("sha256sum"));
    expect(archive).toBeDefined();
    const checksumLines = archive!.run!.split("\n")
      .filter(line => line.includes("sha256sum") && !line.trim().startsWith("#"));
    expect(checksumLines.length).toBeGreaterThanOrEqual(2);
    for (const line of checksumLines) {
      const argument = /sha256sum\s+"([^"]+)"/.exec(line)?.[1];
      expect(argument, line).toBeDefined();
      // shasum -c resolves the recorded path relative to the verifier's working directory,
      // which is dist/release; any directory prefix names a file that cannot exist there.
      expect(argument!).not.toContain("/");
      // The redirect target gets the same treatment: a bare output name is what makes the
      // checksum file land in the directory the upload glob scans.
      const output = />\s+"([^"]+)"/.exec(line)?.[1];
      expect(output, line).toBeDefined();
      expect(output!).not.toContain("/");
      // verifyChecksums binds each record to its own payload by removing only
      // the final .sha256 suffix, including the archive extension in the name.
      expect(output, line).toBe(`${argument}.sha256`);
    }

    // The bare names above only resolve end to end if the step checksums from the directory
    // the artifact lives in (it leaves the per-target build directory first), if the upload
    // glob picks the checksum file up, and if the pre-publication verifier downloads every
    // artifact flattened beside them. Locking only the final line would leave those joints
    // unguarded. YAML block scalars are dedented on parse, so the script's own lines carry
    // no indentation here.
    expect(archive!.run).toMatch(/^ *cd \.\.\/\.\.$/m);
    const upload = release.jobs?.["package-standalone"]?.steps
      ?.find(candidate => candidate.uses?.startsWith("actions/upload-artifact@"));
    expect(String(upload?.with?.path)).toContain("dist/ocx-*.sha256");

    const download = release.jobs?.["verify-release"]?.steps
      ?.find(candidate => candidate.uses?.startsWith("actions/download-artifact@")
        && candidate.with?.pattern === "standalone-*");
    expect(download?.with?.["merge-multiple"]).toBe(true);
    expect(download?.with?.path).toBe("dist/release");
  });

  test("publication consumes the verified packaging result", () => {
    const verify = release.jobs?.["verify-release"];
    expect(verify).toBeDefined();
    expect(needsOf(verify).sort())
      .toEqual(["package-desktop", "package-standalone", "validate-dispatch"]);
    // Verification is not a publication-mode step: a dry run must prove the same chain
    // a real release relies on, so the job carries no dry-run exemption.
    expect(verify!.if).toBeUndefined();
    expect(verify!.steps?.some(candidate => candidate.run?.includes("verify-release-assets.ts")))
      .toBe(true);

    const publish = release.jobs?.publish;
    expect(publish).toBeDefined();
    expect(needsOf(publish).sort()).toEqual(["validate-dispatch", "verify-release"]);

    const attach = release.jobs?.["attach-release"];
    expect(attach).toBeDefined();
    expect(needsOf(attach).sort()).toEqual(["publish", "verify-release"]);
  });

  test("attach uploads only the verified bundle, and only after requiring its receipt", () => {
    const steps = release.jobs?.["attach-release"]?.steps ?? [];
    // Verification happens exactly once, before publication: attach must not re-verify
    // checksums or regenerate the manifest from unverified parts.
    expect(steps.some(candidate => candidate.run?.includes("shasum"))).toBe(false);
    expect(steps.some(candidate => candidate.run?.includes("updater-manifest.ts"))).toBe(false);

    const bundle = steps.find(candidate => candidate.uses?.startsWith("actions/download-artifact@")
      && candidate.with?.name === "verified-release");
    expect(bundle?.with?.path).toBe("dist/release");

    const receiptCheck = steps.findIndex(candidate => candidate.run?.includes("verification/receipt.json"));
    const upload = steps.findIndex(candidate => candidate.run?.includes("gh release upload"));
    expect(receiptCheck).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(receiptCheck);
  });

  test("the release is a draft until the verified assets are attached", () => {
    // GitHub freezes a release the moment it is published: every later asset upload
    // comes back HTTP 422 "Cannot upload assets to an immutable release". Creating
    // the release published and uploading afterwards is what left v2.55.0 through
    // v2.60.0 with zero assets and the desktop updater with nothing to fetch.
    const releaseText = readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8");
    const createStep = releaseText.split("- name: Create GitHub release")[1] ?? "";
    expect(createStep).toMatch(/gh release create "\$release_tag" --draft/);

    const attachRun = (release.jobs?.["attach-release"]?.steps ?? [])
      .map(candidate => candidate.run ?? "")
      .find(run => run.includes("gh release upload")) ?? "";
    expect(attachRun).toContain("--draft=false");
    expect(attachRun.indexOf("gh release upload")).toBeLessThan(attachRun.indexOf("--draft=false"));
  });

  describe("draft publication shell behavior", () => {
    const bash = releaseTestBash();
    const shellTest = test.skipIf(bash === null);

    test("CI and POSIX hosts must execute the Bash regressions", () => {
      // A Windows workstation need not install Bash just to run static contracts.
      // CI must never turn a missing/broken shell into a green skipped regression.
      if (process.env.CI || process.platform !== "win32") expect(bash).not.toBeNull();
    });

    /** Run the actual YAML block with an allowlisted gh mock and no executable search path. */
    function attach(env: Record<string, string> = {}) {
      const run = release.jobs?.["attach-release"]?.steps
        ?.find(step => step.run?.includes("gh release upload"))?.run;
      expect(run).toBeDefined();
      const cwd = mkdtempSync(join(tmpdir(), "ocx-release-contract-"));
      try {
        const result = Bun.spawnSync([bash!, "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `
          gh() {
            printf 'gh:%s\\n' "$*" >&2
            case "$1:$2" in
              release:upload) return "$UPLOAD_STATUS" ;;
              release:view) printf '%s\\n' "$DRAFT_STATE"; return "$VIEW_STATUS" ;;
              release:edit) return "$EDIT_STATUS" ;;
              *) return 97 ;;
            esac
          }
          ${run}
          printf 'attach-completed\\n'
        `], { cwd, env: releaseTestEnv({ RELEASE_VERSION: "2.65.0", DRAFT_STATE: "true",
          UPLOAD_STATUS: "0", VIEW_STATUS: "0", EDIT_STATUS: "0", ...env }),
          timeout: 3_000, maxBuffer: 16_384 });
        const calls = result.stderr.toString().split(/\r?\n/).filter(line => line.startsWith("gh:"));
        return { code: result.exitCode, calls, completed: result.stdout.toString().includes("attach-completed") };
      } finally {
        removeTreeWithRetry(cwd);
      }
    }

    const upload = "gh:release upload v2.65.0 dist/release/* --clobber";
    const view = "gh:release view v2.65.0 --json isDraft --jq .isDraft";
    const edit = "gh:release edit v2.65.0 --draft=false";

    shellTest("lookup failure propagates even when stdout says true", () => {
      expect(attach({ VIEW_STATUS: "41" })).toEqual({ code: 41, calls: [upload, view], completed: false });
    });
    for (const value of ["", "null", "TRUE", " true", "{}", "true\nfalse"]) {
      shellTest(`unexpected draft state ${JSON.stringify(value)} never publishes`, () => {
        expect(attach({ DRAFT_STATE: value })).toEqual({ code: 1, calls: [upload, view], completed: false });
      });
    }
    shellTest("a draft is published exactly once, after upload and lookup", () => {
      expect(attach()).toEqual({ code: 0, calls: [upload, view, edit], completed: true });
    });
    shellTest("an explicitly public release is not edited again", () => {
      expect(attach({ DRAFT_STATE: "false" })).toEqual({ code: 0, calls: [upload, view], completed: true });
    });
    shellTest("upload failure prevents lookup and publication", () => {
      expect(attach({ UPLOAD_STATUS: "42" })).toEqual({ code: 42, calls: [upload], completed: false });
    });
    shellTest("publication failure remains a failed step", () => {
      expect(attach({ EDIT_STATUS: "43" })).toEqual({ code: 43, calls: [upload, view, edit], completed: false });
    });
  });

  test("a partial publication has a recorded, explicit recovery path", () => {
    const releaseText = readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8");
    // The only way npm publish is ever skipped: an explicit recovery input, requiring
    // the version to already be acknowledged on npm, refusing combination with dry-run.
    expect(releaseText).toContain("resume-after-npm-publish:");

    const publishSteps = release.jobs?.publish?.steps ?? [];
    const preflight = publishSteps.find(candidate => candidate.name === "Preflight release metadata");
    expect(preflight?.run).toContain("no acknowledged publication to resume from");
    expect(preflight?.run).toContain("cannot combine with dry-run");

    const publication = publishSteps.find(candidate => candidate.id === "publication");
    // The summary line references RELEASE_VERSION under set -u; the env must carry it.
    expect(publication?.env?.RELEASE_VERSION).toBe("${{ inputs.version }}");
    expect(publication?.run).toContain('if [ "$RESUME" = "true" ]');
    expect(publication?.run).toContain('echo "published=true" >> "$GITHUB_OUTPUT"');
    // A successful publish records the recovery path at the moment it matters.
    expect(publication?.run).toContain("never republish this version");

    // The version-line gate must let the resume path past a tag it created itself.
    const versionLine = publishSteps.find(candidate => candidate.run?.includes("assert-releasable"));
    expect(versionLine?.env?.RESUME).toBe("${{ inputs.resume-after-npm-publish }}");
    expect(versionLine?.run).toContain('$RESUME');

    // A run that failed after the release was created must be able to complete the
    // attachment on resume; outside resume, an existing release stays a hard failure.
    const create = publishSteps.find(candidate => candidate.name === "Create GitHub release");
    expect(create?.env?.RESUME).toBe("${{ inputs.resume-after-npm-publish }}");
    expect(create?.run).toContain('gh release view "$release_tag"');
    expect(create?.run).toContain("already exists; reusing it for attachment");
    expect(create?.run).toContain("refusing to reuse it outside the resume path");
  });
});

describe("service lifecycle trigger coverage", () => {
  const lifecycleText = readFileSync(repoPath(".github", "workflows", "service-lifecycle.yml"), "utf8");
  const releaseText = readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8");

  test("both triggers cover the service directory and the desktop shell", () => {
    const pushPaths = triggerPaths(lifecycleText, "push", "workflow_dispatch");
    const prPaths = triggerPaths(lifecycleText, "pull_request", "push");
    for (const paths of [prPaths, pushPaths]) {
      expect(paths).toContain("src/service.ts");
      expect(paths).toContain("src/service/**");
      expect(paths).toContain("desktop/**");
    }
    expect([...prPaths].sort()).toEqual([...pushPaths].sort());
  });

  test("the release service gate matches every implemented service module and desktop file", () => {
    const gateSource = releaseText.match(/grep -Eq '(\^\([^']+\)\$)'/)?.[1];
    expect(gateSource).toBeDefined();
    const gate = new RegExp(gateSource!);

    // Derived from the tree, not restated: the service implementation is a directory, so
    // every module in it must satisfy the gate that demands lifecycle evidence.
    const serviceModules = readdirSync(repoPath("src", "service"))
      .filter(entry => entry.endsWith(".ts"));
    expect(serviceModules.length).toBeGreaterThanOrEqual(10);
    for (const module of serviceModules) {
      expect(gate.test(`src/service/${module}`), `src/service/${module}`).toBe(true);
    }
    expect(gate.test("src/service.ts")).toBe(true);

    const desktopSurfaces = [
      ...readdirSync(repoPath("desktop", "scripts")).map(entry => `desktop/scripts/${entry}`),
      ...readdirSync(repoPath("desktop", "src-tauri", "src")).map(entry => `desktop/src-tauri/src/${entry}`),
    ];
    expect(desktopSurfaces.length).toBeGreaterThanOrEqual(10);
    for (const path of desktopSurfaces) {
      expect(gate.test(path), path).toBe(true);
    }

    expect(gate.test("src/router.ts")).toBe(false);
    expect(gate.test("docs-site/src/pages/index.astro")).toBe(false);
  });
});
