import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

/**
 * Windows Authenticode signing through SignPath (#7207). The wiring is an improvement layered on
 * a release and must never cost one: no SignPath outage, timeout, rejection or misconfiguration
 * may fail a real release, and a self-signed test certificate must never reach a public release.
 * These contracts pin the gates that guarantee it, and the non-publishing test workflow that
 * exercises signing end to end.
 */

type Step = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
};
type Job = {
  "runs-on"?: string;
  "timeout-minutes"?: number | string;
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Array<Record<string, unknown>> } };
  steps?: Step[];
};
type Workflow = { on?: Record<string, unknown>; permissions?: unknown; env?: Record<string, string>; jobs?: Record<string, Job> };

const SIGNPATH_ACTION = "signpath/github-action-submit-signing-request@f6d04783b4569d051e0c80105fe66e82819d0092";
const releaseText = readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8");
const release = Bun.YAML.parse(releaseText) as Workflow;
const signingTestText = readFileSync(repoPath(".github", "workflows", "windows-signing-test.yml"), "utf8");
const signingTest = Bun.YAML.parse(signingTestText) as Workflow;

function stepsOf(workflow: Workflow, jobId: string): Step[] {
  const steps = workflow.jobs?.[jobId]?.steps;
  expect(steps, jobId).toBeDefined();
  return steps!;
}
const indexOf = (steps: Step[], name: string) => {
  const index = steps.findIndex(step => step.name === name);
  expect(index, name).toBeGreaterThanOrEqual(0);
  return index;
};

describe("Windows signing decision (scripts/ci/windows-signing-plan.sh)", () => {
  const bash = process.platform === "win32" ? null : Bun.which("bash");

  function plan(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "ocx-signing-plan-"));
    try {
      const output = join(dir, "output");
      writeFileSync(output, "");
      const result = Bun.spawnSync([bash!, "--noprofile", "--norc", repoPath("scripts", "ci", "windows-signing-plan.sh")], {
        env: { PATH: process.env.PATH ?? "", BASH_ENV: "", ENV: "", GITHUB_OUTPUT: output, ...env },
      });
      const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n")
        .filter(Boolean).map(line => line.split("=", 2) as [string, string]));
      return { exitCode: result.exitCode, stdout: result.stdout.toString(), outputs };
    } finally {
      removeTreeWithRetry(dir);
    }
  }
  const configured = {
    SIGNPATH_CONFIGURED: "true",
    SIGNPATH_ORGANIZATION_ID: "00000000-0000-0000-0000-000000000000",
    SIGNPATH_PROJECT_SLUG: "opencodex",
  };

  test.skipIf(!bash)("a run without the token skips signing and never fails", () => {
    for (const dryRun of ["true", "false"]) {
      const result = plan({ SIGNPATH_CONFIGURED: "false", DRY_RUN: dryRun });
      expect(result.exitCode).toBe(0);
      expect(result.outputs.mode).toBe("skip");
    }
  });

  test.skipIf(!bash)("a real release under test-signing ships unsigned with a notice", () => {
    const result = plan({ ...configured, SIGNPATH_SIGNING_POLICY: "test-signing", DRY_RUN: "false" });
    expect(result.exitCode).toBe(0);
    expect(result.outputs.mode).toBe("skip");
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toContain("A test certificate never ships");
  });

  test.skipIf(!bash)("a dry run under test-signing signs with test trust", () => {
    const result = plan({ ...configured, SIGNPATH_SIGNING_POLICY: "test-signing", DRY_RUN: "true" });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toEqual({ mode: "sign", policy: "test-signing", trust: "test" });
  });

  test.skipIf(!bash)("release-signing signs both real releases and dry runs with release trust", () => {
    for (const dryRun of ["true", "false"]) {
      const result = plan({ ...configured, SIGNPATH_SIGNING_POLICY: "release-signing", DRY_RUN: dryRun });
      expect(result.exitCode).toBe(0);
      expect(result.outputs).toEqual({ mode: "sign", policy: "release-signing", trust: "release" });
    }
  });

  test.skipIf(!bash)("a partial or malformed configuration warns and skips instead of failing a release", () => {
    const cases: Array<Record<string, string>> = [
      { ...configured, SIGNPATH_SIGNING_POLICY: "" },
      { ...configured, SIGNPATH_PROJECT_SLUG: "", SIGNPATH_SIGNING_POLICY: "release-signing" },
      { ...configured, SIGNPATH_ORGANIZATION_ID: "", SIGNPATH_SIGNING_POLICY: "release-signing" },
      { ...configured, SIGNPATH_SIGNING_POLICY: "release-signing\nmode=sign" },
      { ...configured, SIGNPATH_SIGNING_POLICY: "Release Signing" },
    ];
    for (const env of cases) {
      const result = plan({ ...env, DRY_RUN: "false" });
      expect(result.exitCode, JSON.stringify(env)).toBe(0);
      expect(result.outputs.mode, JSON.stringify(env)).toBe("skip");
      expect(result.stdout).toContain("::warning::");
    }
  });
});

describe("release workflow Windows signing gates", () => {
  const jobs = [
    { id: "package-standalone", target: "bun-windows-x64", artifactConfiguration: "windows-standalone-zip", budget: 90 },
    { id: "package-desktop", target: "x86_64-pc-windows-msvc", artifactConfiguration: "windows-msi-zip", budget: 105 },
  ];

  test("signing is decided once per Windows leg from the token and repository variables", () => {
    for (const { id } of jobs) {
      const decide = stepsOf(release, id).find(step => step.id === "windows-signing");
      expect(decide?.if, id).toBe("runner.os == 'Windows'");
      expect(decide?.run).toBe("bash scripts/ci/windows-signing-plan.sh");
      expect(decide?.env?.SIGNPATH_CONFIGURED).toBe("${{ secrets.SIGNPATH_API_TOKEN != '' }}");
      expect(decide?.env?.SIGNPATH_SIGNING_POLICY).toBe("${{ vars.SIGNPATH_SIGNING_POLICY_SLUG }}");
      expect(decide?.env?.DRY_RUN).toBe("${{ inputs.dry-run }}");
    }
  });

  test("every SignPath step is pinned, gated on the decision, and can never fail the release", () => {
    for (const { id, artifactConfiguration } of jobs) {
      const steps = stepsOf(release, id);
      const signing = steps.filter(step => step.uses?.startsWith("signpath/"));
      expect(signing.length, id).toBe(1);
      const sign = signing[0]!;
      expect(sign.uses).toBe(SIGNPATH_ACTION);
      expect(sign.if).toContain("steps.windows-signing.outputs.mode == 'sign'");
      expect(sign["continue-on-error"]).toBe(true);
      // The policy comes from the decision, which never yields test-signing for a real release.
      expect(sign.with?.["signing-policy-slug"]).toBe("${{ steps.windows-signing.outputs.policy }}");
      expect(sign.with?.["artifact-configuration-slug"]).toBe(artifactConfiguration);
      expect(sign.with?.["api-token"]).toBe("${{ secrets.SIGNPATH_API_TOKEN }}");
      expect(String(sign.with?.["wait-for-completion"])).toBe("true");
      expect(Number(sign.with?.["wait-for-completion-timeout-in-seconds"])).toBe(3600);
      // Every other signing step degrades too: upload, locate and swap all continue on error.
      for (const step of steps) {
        if (step.id === "windows-signing" || !(step.if ?? "").includes("steps.windows-signing.outputs.mode")) continue;
        expect(step["continue-on-error"], step.name).toBe(true);
      }
    }
  });

  test("the swap reads the SignPath outcome, so a failed request keeps the unsigned file", () => {
    for (const { id } of jobs) {
      const steps = stepsOf(release, id);
      const swap = steps.find(step => step.run?.includes("apply-signed-windows-artifact.ps1"));
      const sign = steps.find(step => step.uses?.startsWith("signpath/"));
      expect(swap?.env?.SIGNPATH_OUTCOME, id).toBe("${{ steps." + sign?.id + ".outcome }}");
      expect(swap?.run).toContain('-SubmitOutcome "$env:SIGNPATH_OUTCOME"');
      expect(swap?.run).not.toContain("-FailOnError");
      expect(swap?.shell).toBe("pwsh");
    }
  });

  test("the standalone binary is signed after the smoke test and before it is archived", () => {
    const steps = stepsOf(release, "package-standalone");
    const smoke = indexOf(steps, "Smoke test standalone binary (Windows)");
    const upload = indexOf(steps, "Upload the unsigned Windows binary for signing");
    const sign = indexOf(steps, "Sign the Windows binary through SignPath");
    const swap = indexOf(steps, "Swap in the verified signed Windows binary");
    const archive = indexOf(steps, "Archive standalone release");
    expect(smoke).toBeLessThan(upload);
    expect(upload).toBeLessThan(sign);
    expect(sign).toBeLessThan(swap);
    expect(swap).toBeLessThan(archive);
    // ocx.exe alone at the artifact root is what windows-standalone-zip expects.
    expect(steps[upload]!.with?.path).toBe("dist/standalone/${{ matrix.target }}/ocx.exe");
  });

  test("the MSI is signed before the rename, and its updater signature is regenerated over it", () => {
    const steps = stepsOf(release, "package-desktop");
    const build = indexOf(steps, "Build desktop bundles");
    const sign = indexOf(steps, "Sign the Windows installer through SignPath");
    const swap = indexOf(steps, "Swap in the verified signed Windows installer");
    const rename = indexOf(steps, "Rename release assets");
    expect(build).toBeLessThan(sign);
    expect(sign).toBeLessThan(swap);
    expect(swap).toBeLessThan(rename);
    const swapStep = steps[swap]!;
    expect(swapStep.run).toContain("-Installer");
    expect(swapStep.run).toContain("-UpdaterSignature");
    expect(swapStep.env?.TAURI_SIGNING_PRIVATE_KEY).toBe("${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}");
    expect(swapStep.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}");
  });

  test("unsigned signing inputs never reach the verified release bundle", () => {
    // verify-release downloads standalone-* and desktop-*; the SignPath inputs must match neither.
    let inputs = 0;
    for (const { id } of jobs) {
      for (const step of stepsOf(release, id)) {
        const name = step.with?.name;
        if (typeof name !== "string" || !name.includes("signpath")) continue;
        inputs += 1;
        expect(name.startsWith("standalone-") || name.startsWith("desktop-"), name).toBe(false);
      }
    }
    expect(inputs).toBe(2);
    expect(releaseText).toContain("pattern: standalone-*");
    expect(releaseText).toContain("pattern: desktop-*");
  });

  test("signing jobs run on GitHub-hosted runners with read-only permissions and a bounded wait", () => {
    for (const { id, target, budget } of jobs) {
      const job = release.jobs?.[id];
      expect(job?.permissions, id).toEqual({ actions: "read", contents: "read" });
      const windows = job?.strategy?.matrix?.include?.find(entry => entry.target === target);
      // SignPath Foundation accepts signing requests only from GitHub-hosted builds.
      expect(windows?.os, id).toBe("windows-latest");
      expect(String(job?.["timeout-minutes"])).toContain("matrix.target == '" + target + "' && " + budget);
    }
  });
});

describe("Windows signing test workflow", () => {
  test("is dispatch-only, read-only and publishes nothing", () => {
    expect(Object.keys(signingTest.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(signingTest.permissions).toEqual({});
    for (const [id, job] of Object.entries(signingTest.jobs ?? {})) {
      expect(job.permissions, id).toEqual({ actions: "read", contents: "read" });
      expect(job["runs-on"], id).toBe("windows-latest");
      expect(typeof job["timeout-minutes"], id).toBe("number");
    }
    expect(signingTestText).not.toMatch(/\bgh release\b|npm publish|git push|git tag|: write\b/);
  });

  test("always signs with test-signing and fails loudly", () => {
    expect(signingTest.env?.SIGNPATH_TEST_POLICY).toBe("test-signing");
    const allSteps = Object.values(signingTest.jobs ?? {}).flatMap(job => job.steps ?? []);
    const signing = allSteps.filter(step => step.uses?.startsWith("signpath/"));
    expect(signing.map(step => step.with?.["artifact-configuration-slug"]).sort())
      .toEqual(["windows-msi-zip", "windows-standalone-zip"]);
    for (const step of signing) {
      expect(step.uses).toBe(SIGNPATH_ACTION);
      expect(step.with?.["signing-policy-slug"]).toBe("${{ env.SIGNPATH_TEST_POLICY }}");
      expect(step["continue-on-error"]).toBeUndefined();
    }
    const swaps = allSteps.filter(step => step.run?.includes("apply-signed-windows-artifact.ps1"));
    expect(swaps.length).toBe(2);
    for (const swap of swaps) {
      expect(swap.run).toContain("-Trust test");
      expect(swap.run).toContain("-FailOnError");
      expect(swap["continue-on-error"]).toBeUndefined();
    }
  });
});

/**
 * The swap script runs under PowerShell, which the hosted Ubuntu image ships. A fake verifier and
 * a fake bunx stand in for Authenticode and the Tauri CLI, so these cases prove the ordering the
 * release relies on: nothing is replaced until every check passed, and a failure restores both
 * the installer and its updater signature.
 */
describe("signed artifact swap (scripts/ci/apply-signed-windows-artifact.ps1)", () => {
  const pwsh = process.platform === "win32" ? null : Bun.which("pwsh");
  // PowerShell start-up alone takes seconds on a cold runner.
  const PWSH_TIMEOUT_MS = 30_000;

  function fixture(options: { verifierFails?: boolean; bunxFails?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ocx-signing-swap-"));
    const scripts = join(dir, "scripts");
    const bin = join(dir, "bin");
    const bundle = join(dir, "bundle");
    const signed = join(dir, "signed");
    for (const path of [scripts, bin, bundle, signed]) mkdirSync(path, { recursive: true });
    copyFileSync(repoPath("scripts", "ci", "apply-signed-windows-artifact.ps1"), join(scripts, "apply.ps1"));
    const verifierParams = "param([string]$Msi, [string[]]$RequireInnerExe, [int]$MinimumInnerExe, [string]$Trust)\n";
    writeFileSync(join(scripts, "verify-authenticode.ps1"),
      verifierParams + (options.verifierFails ? 'throw "fake verification failure"\n' : ""));
    const bunx = join(bin, "bunx");
    writeFileSync(bunx, options.bunxFails ? "#!/bin/sh\nexit 3\n" : '#!/bin/sh\nprintf "signature over signed" > "$4.sig"\n');
    chmodSync(bunx, 0o755);
    writeFileSync(join(bundle, "OpenCodex.msi"), "unsigned installer");
    writeFileSync(join(bundle, "OpenCodex.msi.sig"), "signature over unsigned");
    writeFileSync(join(signed, "OpenCodex.msi"), "signed installer");
    const run = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync([pwsh!, "-NoProfile", "-NonInteractive", "-File",
      join(scripts, "apply.ps1"), "-Target", join(bundle, "OpenCodex.msi"), "-SignedDirectory", signed,
      "-Trust", "test", "-Installer", "-TauriDirectory", dir, ...args], {
      env: { PATH: bin + ":" + (process.env.PATH ?? ""), HOME: dir, ...env },
    });
    const read = (name: string) => existsSync(join(bundle, name)) ? readFileSync(join(bundle, name), "utf8") : null;
    return { dir, run, read };
  }

  test.skipIf(!pwsh)("a verified installer is swapped in with an updater signature over the signed bytes", () => {
    const f = fixture();
    try {
      const result = f.run(["-UpdaterSignature"], { TAURI_SIGNING_PRIVATE_KEY: "fake" });
      expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
      expect(f.read("OpenCodex.msi")).toBe("signed installer");
      expect(f.read("OpenCodex.msi.sig")).toBe("signature over signed");
    } finally { removeTreeWithRetry(f.dir); }
  }, PWSH_TIMEOUT_MS);

  test.skipIf(!pwsh)("without an updater key the stale signature over the unsigned bytes is removed", () => {
    const f = fixture();
    try {
      const result = f.run(["-UpdaterSignature"]);
      expect(result.exitCode).toBe(0);
      expect(f.read("OpenCodex.msi")).toBe("signed installer");
      expect(f.read("OpenCodex.msi.sig")).toBeNull();
    } finally { removeTreeWithRetry(f.dir); }
  }, PWSH_TIMEOUT_MS);

  const failures: Array<[string, { verifierFails?: boolean; bunxFails?: boolean }, string[]]> = [
    ["a failed SignPath request", {}, ["-SubmitOutcome", "failure"]],
    ["a failed verification", { verifierFails: true }, []],
    ["a failed updater re-signature", { bunxFails: true }, []],
  ];
  for (const [label, options, args] of failures) {
    test.skipIf(!pwsh)(label + " keeps the unsigned installer and its signature, with a warning", () => {
      const f = fixture(options);
      try {
        const result = f.run(["-UpdaterSignature", ...args], { TAURI_SIGNING_PRIVATE_KEY: "fake" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain("::warning::OpenCodex.msi ships unsigned");
        expect(f.read("OpenCodex.msi")).toBe("unsigned installer");
        expect(f.read("OpenCodex.msi.sig")).toBe("signature over unsigned");
      } finally { removeTreeWithRetry(f.dir); }
    }, PWSH_TIMEOUT_MS);
  }

  test.skipIf(!pwsh)("-FailOnError turns the same failure into a failed step", () => {
    const f = fixture({ verifierFails: true });
    try {
      const result = f.run(["-FailOnError"]);
      expect(result.exitCode).not.toBe(0);
      expect(f.read("OpenCodex.msi")).toBe("unsigned installer");
    } finally { removeTreeWithRetry(f.dir); }
  }, PWSH_TIMEOUT_MS);

  test.skipIf(!pwsh)("both PowerShell scripts parse", () => {
    for (const script of ["verify-authenticode.ps1", "apply-signed-windows-artifact.ps1"]) {
      const path = repoPath("scripts", "ci", script);
      const result = Bun.spawnSync([pwsh!, "-NoProfile", "-NonInteractive", "-Command",
        "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:OCX_PARSE_TARGET, [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }",
      ], { env: { ...process.env, OCX_PARSE_TARGET: path } });
      expect(result.exitCode, script + ": " + result.stdout.toString()).toBe(0);
    }
  }, PWSH_TIMEOUT_MS);
});
