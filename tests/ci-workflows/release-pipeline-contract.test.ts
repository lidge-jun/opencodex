import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

type WorkflowStep = {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  shell?: string;
};

type WorkflowJob = {
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
    }

    // The bare names above only resolve end to end if the step checksums from the directory
    // the artifact lives in (it leaves the per-target build directory first), if the upload
    // glob picks the checksum file up, and if the download flattens every artifact beside
    // the verifier. Locking only the final shasum line would leave those joints unguarded.
    // YAML block scalars are dedented on parse, so the script's own lines carry no
    // indentation here.
    expect(archive!.run).toMatch(/^ *cd \.\.\/\.\.$/m);
    const upload = release.jobs?.["package-standalone"]?.steps
      ?.find(candidate => candidate.uses?.startsWith("actions/upload-artifact@"));
    expect(String(upload?.with?.path)).toContain("dist/ocx-*.sha256");

    const download = release.jobs?.["attach-release"]?.steps
      ?.find(candidate => candidate.uses?.startsWith("actions/download-artifact@")
        && candidate.with?.pattern === "standalone-*");
    expect(download?.with?.["merge-multiple"]).toBe(true);
    expect(download?.with?.path).toBe("dist/release");

    const verify = release.jobs?.["attach-release"]?.steps
      ?.find(candidate => candidate.run?.includes("shasum"));
    expect(verify).toBeDefined();
    expect(verify!.run).toContain("cd dist/release");
    expect(verify!.run).toContain("shasum -a 256 -c ./*.sha256");
  });

  test("publication waits for both packaging jobs", () => {
    const publish = release.jobs?.publish;
    expect(publish).toBeDefined();
    expect(needsOf(publish).sort())
      .toEqual(["package-desktop", "package-standalone", "validate-dispatch"]);

    const attach = release.jobs?.["attach-release"];
    expect(attach).toBeDefined();
    expect(needsOf(attach).sort()).toEqual(["package-desktop", "package-standalone", "publish"]);
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
