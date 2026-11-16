import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReleaseNotes, type ReleaseCommit } from "../../scripts/build-release-changelog";
import { CODE_SIGNING_ATTRIBUTION, codeSigningFooter, readWindowsSigningOutcomes } from "../../scripts/release-signing-footer";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

/**
 * The release body states whether that release's Windows files were actually Authenticode-signed (#7207). Each Windows
 * leg records what its signing plan and the verified swap produced; the publish job reads those records, and nothing but
 * a recorded release-trust signature lets the notes say "signed". The SignPath attribution stays on every release.
 */

type Step = { id?: string; name?: string; if?: string; uses?: string; run?: string; shell?: string; env?: Record<string, string>;
  with?: Record<string, unknown>; "continue-on-error"?: boolean };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };
const release = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8")) as Workflow;
const stepsOf = (job: string): Step[] => release.jobs?.[job]?.steps ?? [];

function outcomes(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-signing-outcome-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const record = (kind: string, signed: boolean) => JSON.stringify({ schema: "ocx.windows-signing-outcome/1", kind, signed }) + "\n";

describe("the release body's code signing footer", () => {
  const commits: ReleaseCommit[] = [{ sha: "a".repeat(40), subject: "fix(api): keep coverage (#10)", body: "", pulls: [
    { number: 10, title: "fix(api): keep coverage", author: "alice", labels: ["bug"], merged: true },
  ] }];
  const notes = (dir: string | undefined) => buildReleaseNotes({ version: "1.1.0", tags: ["v1.0.0"], npmMetadata: "", repository: "lidge-jun/opencodex",
    generatedNotes: "", commits, windowsSigning: readWindowsSigningOutcomes(dir) });

  test("both Windows files signed with release trust: the notes say so, with the attribution", () => {
    const dir = outcomes({ "standalone.json": record("standalone", true), "desktop.json": record("desktop", true) });
    try {
      const body = notes(dir).body;
      expect(body).toContain(CODE_SIGNING_ATTRIBUTION);
      expect(body).toContain("are Authenticode-signed");
      expect(body).not.toContain("not code-signed");
      expect(body.trimEnd().endsWith(codeSigningFooter(readWindowsSigningOutcomes(dir)))).toBe(true);
    } finally { removeTreeWithRetry(dir); }
  });

  test("neither signed: the notes say the Windows files are not code-signed and keep the attribution", () => {
    const dir = outcomes({ "standalone.json": record("standalone", false), "desktop.json": record("desktop", false) });
    try {
      const body = notes(dir).body;
      expect(body).toContain(CODE_SIGNING_ATTRIBUTION);
      expect(body).toContain("**The Windows files in this release are not code-signed.**");
      expect(body).not.toContain("are Authenticode-signed");
    } finally { removeTreeWithRetry(dir); }
  });

  test("one signed and one not: the notes name which file is which", () => {
    const dir = outcomes({ "standalone.json": record("standalone", true), "desktop.json": record("desktop", false) });
    try {
      const body = notes(dir).body;
      expect(body).toContain("**Not every Windows file in this release is code-signed.**");
      expect(body).toMatch(/`ocx\.exe`[^\n]*: signed/);
      expect(body).toMatch(/MSI installer[^\n]*: not code-signed/);
    } finally { removeTreeWithRetry(dir); }
  });

  test("one file not signed and the other not recorded reads as not code-signed, never as partly signed", () => {
    const dir = outcomes({ "standalone.json": record("standalone", false) });
    try {
      expect(readWindowsSigningOutcomes(dir).status).toBe("unsigned");
      const body = notes(dir).body;
      expect(body).toContain("**The Windows files in this release are not code-signed.**");
      expect(body).not.toContain("Not every Windows file");
    } finally { removeTreeWithRetry(dir); }
  });

  test("missing, malformed or mislabelled records never read as signed", () => {
    const cases: Array<Record<string, string>> = [
      {},
      { "standalone.json": record("standalone", true) },
      { "standalone.json": record("standalone", true), "desktop.json": "{not json" },
      { "standalone.json": record("standalone", true), "desktop.json": record("standalone", true) },
      { "standalone.json": record("standalone", true), "desktop.json": JSON.stringify({ schema: "ocx.windows-signing-outcome/1", kind: "desktop", signed: "true" }) },
      { "standalone.json": record("standalone", true), "desktop.json": JSON.stringify({ schema: "other/1", kind: "desktop", signed: true }) },
    ];
    for (const files of cases) {
      const dir = outcomes(files);
      try {
        const outcome = readWindowsSigningOutcomes(dir);
        expect(outcome.status, JSON.stringify(files)).not.toBe("signed");
        const body = notes(dir).body;
        expect(body).toContain(CODE_SIGNING_ATTRIBUTION);
        expect(body).not.toContain("are Authenticode-signed");
        expect(body).toMatch(/not code-signed|not recorded/);
      } finally { removeTreeWithRetry(dir); }
    }
    // A directory that does not exist (the download step failed) is the same as no records.
    expect(readWindowsSigningOutcomes(join(tmpdir(), "ocx-no-such-signing-outcome-dir")).status).toBe("unknown");
    expect(readWindowsSigningOutcomes(undefined).status).toBe("unknown");
  });

  test("without signing evidence the builder defaults to not claiming a signature", () => {
    const body = buildReleaseNotes({ version: "1.1.0", tags: ["v1.0.0"], npmMetadata: "", repository: "lidge-jun/opencodex", generatedNotes: "", commits }).body;
    expect(body).toContain(CODE_SIGNING_ATTRIBUTION);
    expect(body).not.toContain("are Authenticode-signed");
  });
});

describe("Windows signing outcome record (scripts/ci/windows-signing-outcome.sh)", () => {
  const bash = process.platform === "win32" ? null : Bun.which("bash");
  function run(kind: string, env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "ocx-signing-record-"));
    try {
      const out = join(dir, "out");
      const result = Bun.spawnSync([bash!, "--noprofile", "--norc", repoPath("scripts", "ci", "windows-signing-outcome.sh"), kind, out], {
        env: { PATH: process.env.PATH ?? "", BASH_ENV: "", ENV: "", ...env },
      });
      let text: string | null = null;
      try { text = readFileSync(join(out, kind + ".json"), "utf8"); } catch { text = null; }
      return { exitCode: result.exitCode, record: text === null ? null : JSON.parse(text) as Record<string, unknown> };
    } finally { removeTreeWithRetry(dir); }
  }

  test.skipIf(!bash)("only a release-trust plan whose verified swap succeeded records signed", () => {
    const cases: Array<[Record<string, string>, boolean]> = [
      [{ SIGNING_MODE: "sign", SIGNING_TRUST: "release", SIGNED: "true" }, true],
      [{ SIGNING_MODE: "sign", SIGNING_TRUST: "release", SIGNED: "false" }, false],
      [{ SIGNING_MODE: "sign", SIGNING_TRUST: "release", SIGNED: "" }, false],
      [{ SIGNING_MODE: "sign", SIGNING_TRUST: "test", SIGNED: "true" }, false],
      [{ SIGNING_MODE: "skip", SIGNING_TRUST: "", SIGNED: "" }, false],
      [{}, false],
    ];
    for (const kind of ["standalone", "desktop"]) {
      for (const [env, signed] of cases) {
        const result = run(kind, env);
        expect(result.exitCode, JSON.stringify(env)).toBe(0);
        expect(result.record, JSON.stringify(env)).toEqual({ schema: "ocx.windows-signing-outcome/1", kind, signed });
      }
    }
  });

  test.skipIf(!bash)("an unknown kind writes nothing and fails the step", () => {
    const result = run("other", { SIGNING_MODE: "sign", SIGNING_TRUST: "release", SIGNED: "true" });
    expect(result.exitCode).not.toBe(0);
    expect(result.record).toBeNull();
  });
});

describe("release workflow wiring of the signing outcome", () => {
  const legs = [
    { job: "package-standalone", kind: "standalone", swap: "Swap in the verified signed Windows binary" },
    { job: "package-desktop", kind: "desktop", swap: "Swap in the verified signed Windows installer" },
  ];

  test("each Windows leg records its swap's signed output after the swap, on every Windows run, without failing it", () => {
    for (const { job, kind, swap } of legs) {
      const steps = stepsOf(job);
      const swapIndex = steps.findIndex(step => step.name === swap);
      const swapStep = steps[swapIndex]!;
      expect(swapStep.id, job).toBeTruthy();
      const recordIndex = steps.findIndex(step => step.name === "Record the Windows signing outcome");
      const recordStep = steps[recordIndex]!;
      expect(recordIndex, job).toBeGreaterThan(swapIndex);
      expect(recordStep.run).toContain("windows-signing-outcome.sh " + kind + " ");
      expect(recordStep.if).toBe("always() && runner.os == 'Windows'");
      expect(recordStep["continue-on-error"]).toBe(true);
      expect(recordStep.env?.SIGNING_MODE).toBe("${{ steps.windows-signing.outputs.mode }}");
      expect(recordStep.env?.SIGNING_TRUST).toBe("${{ steps.windows-signing.outputs.trust }}");
      expect(recordStep.env?.SIGNED).toBe("${{ steps." + swapStep.id + ".outputs.signed }}");
      const upload = steps[recordIndex + 1]!;
      expect(upload.uses?.startsWith("actions/upload-artifact@")).toBe(true);
      expect(upload.if).toBe("always() && runner.os == 'Windows'");
      expect(upload["continue-on-error"]).toBe(true);
      const name = String(upload.with?.name);
      expect(name).toBe("windows-signing-outcome-" + kind);
      // A re-run of a leg that recorded signed and then failed before its asset upload must replace that record: without
      // overwrite the second upload is a swallowed 409 (continue-on-error) and the stale "signed" reaches the notes.
      expect(upload.with?.overwrite).toBe(true);
      // verify-release bundles standalone-* and desktop-*; the record must never become a release asset.
      expect(name.startsWith("standalone-") || name.startsWith("desktop-")).toBe(false);
    }
  });

  test("each Windows leg starts its record as not signed before signing, so a failed record step never keeps an older one", () => {
    // The final upload then always finds a file, so overwrite always replaces an earlier attempt's record (#8780 review r3).
    for (const { job, kind, swap } of legs) {
      const steps = stepsOf(job);
      const decide = steps.findIndex(step => step.id === "windows-signing");
      const reset = steps.findIndex(step => step.name === "Start the Windows signing outcome as not signed");
      const swapIndex = steps.findIndex(step => step.name === swap);
      expect(reset, job).toBeGreaterThan(decide);
      expect(reset).toBeLessThan(swapIndex);
      const step = steps[reset]!;
      expect(step.if).toBe("runner.os == 'Windows'");
      expect(step.run).toBe('bash scripts/ci/windows-signing-outcome.sh ' + kind + ' "$RUNNER_TEMP/windows-signing-outcome"');
      // No plan or swap input: the script records signed false.
      expect(step.env).toBeUndefined();
    }
  });

  test("the publish job reads the records into the changelog build", () => {
    const steps = stepsOf("publish");
    const download = steps.findIndex(step => step.uses?.startsWith("actions/download-artifact@") && step.with?.pattern === "windows-signing-outcome-*");
    const build = steps.findIndex(step => step.name === "Build and validate release changelog");
    expect(download).toBeGreaterThanOrEqual(0);
    expect(download).toBeLessThan(build);
    // A failed download leaves no records, which the footer reads as "not recorded", never as signed.
    expect(steps[download]!["continue-on-error"]).toBe(true);
    expect(steps[download]!.with?.["merge-multiple"]).toBe(true);
    expect(steps[build]!.run).toContain('--windows-signing-outcomes "$RUNNER_TEMP/windows-signing-outcome"');
    expect(steps[download]!.with?.path).toBe("${{ runner.temp }}/windows-signing-outcome");
  });

  test("a resumed run that reuses a draft rewrites its body from this run's notes (#8780 review)", () => {
    // The Windows legs rerun on a resume and record a fresh outcome; the draft's body from the earlier run could claim a
    // signature the files this run attaches do not have.
    const step = stepsOf("publish").find(step => step.run?.includes("reusing it for attachment"));
    expect(step).toBeDefined();
    const run = step!.run!;
    const reuse = run.indexOf("reusing it for attachment");
    const refresh = run.indexOf('gh release edit "$release_tag" --notes-file "$notes_file"');
    expect(refresh).toBeGreaterThan(reuse);
    // Only a draft is edited: a published release is immutable and its assets must already match this run's digests.
    expect(run.slice(reuse, refresh)).toContain("--json isDraft --jq .isDraft");
  });

  test("the swap script reports signed only after the verified swap", () => {
    const script = readFileSync(repoPath("scripts", "ci", "apply-signed-windows-artifact.ps1"), "utf8");
    const success = script.indexOf('Write-SignedOutput "true"');
    const swap = script.indexOf("Copy-Item -LiteralPath $staged -Destination $targetPath -Force");
    const failure = script.indexOf('Write-SignedOutput "false"');
    expect(success).toBeGreaterThan(swap);
    expect(failure).toBeGreaterThan(success);
    expect(script.slice(script.indexOf("} catch {"))).toContain('Write-SignedOutput "false"');
  });
});

describe("the build script requires the signing records argument", () => {
  test("the usage names --windows-signing-outcomes", () => {
    const source = readFileSync(repoPath("scripts", "build-release-changelog.ts"), "utf8");
    expect(source).toContain("--windows-signing-outcomes <dir>");
  });
});

