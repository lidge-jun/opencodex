import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReleaseNotes, type ReleaseCommit } from "../../scripts/build-release-changelog";
import { CODE_SIGNING_ATTRIBUTION, codeSigningFooter, readPublishedWindowsDigests, readWindowsSigningOutcomes,
  type PublishedWindowsDigests } from "../../scripts/release-signing-footer";
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
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const record = (kind: string, signed: boolean, sha256: string | null = DIGEST_A, attempt: string | null = "1") =>
  JSON.stringify({ schema: "ocx.windows-signing-outcome/2", kind, signed, sha256, attempt }) + "\n";
const PUBLISHED: PublishedWindowsDigests = { standalone: DIGEST_A, desktop: DIGEST_A };

describe("the release body's code signing footer", () => {
  const commits: ReleaseCommit[] = [{ sha: "a".repeat(40), subject: "fix(api): keep coverage (#10)", body: "", pulls: [
    { number: 10, title: "fix(api): keep coverage", author: "alice", labels: ["bug"], merged: true },
  ] }];
  const notes = (dir: string | undefined, published: PublishedWindowsDigests = PUBLISHED) => buildReleaseNotes({ version: "1.1.0",
    tags: ["v1.0.0"], npmMetadata: "", repository: "lidge-jun/opencodex",
    generatedNotes: "", commits, windowsSigning: readWindowsSigningOutcomes(dir, published) });

  test("both Windows files signed with release trust: the notes say so, with the attribution", () => {
    const dir = outcomes({ "standalone.json": record("standalone", true), "desktop.json": record("desktop", true) });
    try {
      const body = notes(dir).body;
      expect(body).toContain(CODE_SIGNING_ATTRIBUTION);
      expect(body).toContain("are Authenticode-signed");
      expect(body).not.toContain("not code-signed");
      expect(body.trimEnd().endsWith(codeSigningFooter(readWindowsSigningOutcomes(dir, PUBLISHED)))).toBe(true);
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
      expect(readWindowsSigningOutcomes(dir, PUBLISHED).status).toBe("unsigned");
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
      // The first record format carried no digest, so it cannot say which file it describes.
      { "standalone.json": record("standalone", true), "desktop.json": JSON.stringify({ schema: "ocx.windows-signing-outcome/1", kind: "desktop", signed: true }) },
      { "standalone.json": record("standalone", true), "desktop.json": record("desktop", true, null) },
      { "standalone.json": record("standalone", true), "desktop.json": record("desktop", true, DIGEST_A.toUpperCase()) },
      { "standalone.json": record("standalone", true), "desktop.json": record("desktop", true, DIGEST_A, null) },
    ];
    for (const files of cases) {
      const dir = outcomes(files);
      try {
        const outcome = readWindowsSigningOutcomes(dir, PUBLISHED);
        expect(outcome.status, JSON.stringify(files)).not.toBe("signed");
        const body = notes(dir).body;
        expect(body).toContain(CODE_SIGNING_ATTRIBUTION);
        expect(body).not.toContain("are Authenticode-signed");
        expect(body).toMatch(/not code-signed|not recorded/);
      } finally { removeTreeWithRetry(dir); }
    }
    // A directory that does not exist (the download step failed) is the same as no records.
    expect(readWindowsSigningOutcomes(join(tmpdir(), "ocx-no-such-signing-outcome-dir"), PUBLISHED).status).toBe("unknown");
    expect(readWindowsSigningOutcomes(undefined, PUBLISHED).status).toBe("unknown");
  });

  test("a stale signed record from an earlier attempt never vouches for a re-run's assets (#8780 review)", () => {
    // Attempt 1 signed and uploaded its records; attempt 2 rebuilt the files without signing and its record upload failed,
    // so the downloaded records are attempt 1's while the release publishes attempt 2's bytes. Both the record shape
    // written before this fix (no digest) and a current record hashed over attempt 1's file are stale.
    const stale = (kind: string) => [JSON.stringify({ schema: "ocx.windows-signing-outcome/1", kind, signed: true }) + "\n", record(kind, true, DIGEST_A, "1")];
    for (const index of [0, 1]) {
      const dir = outcomes({ "standalone.json": stale("standalone")[index]!, "desktop.json": stale("desktop")[index]! });
      try {
        const rerun = { standalone: DIGEST_B, desktop: DIGEST_B };
        const outcome = readWindowsSigningOutcomes(dir, rerun);
        expect(outcome, String(index)).toEqual({ status: "unknown", files: { standalone: "unknown", desktop: "unknown" } });
        const body = notes(dir, rerun).body;
        expect(body).not.toContain("are Authenticode-signed");
        expect(body).toContain("The release run recorded no signing outcome for them.");
        // Without published digests at all (no receipt), no record is trusted either.
        expect(readWindowsSigningOutcomes(dir, {}).status).toBe("unknown");
      } finally { removeTreeWithRetry(dir); }
    }
  });

  test("a record whose digest differs from the published asset reads as not recorded for that file", () => {
    const dir = outcomes({ "standalone.json": record("standalone", true, DIGEST_A), "desktop.json": record("desktop", true, DIGEST_B) });
    try {
      const outcome = readWindowsSigningOutcomes(dir, { standalone: DIGEST_A, desktop: DIGEST_A });
      expect(outcome).toEqual({ status: "partial", files: { standalone: "signed", desktop: "unknown" } });
      const body = notes(dir).body;
      expect(body).toMatch(/`ocx\.exe`[^\n]*: signed/);
      expect(body).toMatch(/MSI installer[^\n]*: signing outcome not recorded; treat it as not code-signed/);
    } finally { removeTreeWithRetry(dir); }
  });

  test("the published digests come from the verified release receipt under this version's Windows asset names", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-signing-receipt-"));
    try {
      const write = (value: unknown) => { const file = join(dir, "receipt.json"); writeFileSync(file, JSON.stringify(value)); return file; };
      const assets = { "ocx-1.1.0-bun-windows-x64.zip": DIGEST_A, "OpenCodex-1.1.0-windows-x64.msi": DIGEST_B, "ocx-1.1.0-bun-linux-x64.tar.gz": "c".repeat(64) };
      expect(readPublishedWindowsDigests(write({ version: "1.1.0", assets }), "1.1.0")).toEqual({ standalone: DIGEST_A, desktop: DIGEST_B });
      // A receipt for another version, a malformed digest or a missing receipt binds nothing.
      expect(readPublishedWindowsDigests(write({ version: "1.0.9", assets }), "1.1.0")).toEqual({});
      expect(readPublishedWindowsDigests(write({ version: "1.1.0", assets: { ...assets, "OpenCodex-1.1.0-windows-x64.msi": "nope" } }), "1.1.0"))
        .toEqual({ standalone: DIGEST_A });
      expect(readPublishedWindowsDigests(write({ version: "1.1.0", assets: [] }), "1.1.0")).toEqual({});
      expect(readPublishedWindowsDigests(join(dir, "missing.json"), "1.1.0")).toEqual({});
      expect(readPublishedWindowsDigests(undefined, "1.1.0")).toEqual({});
    } finally { removeTreeWithRetry(dir); }
  });

  test("without signing evidence the builder defaults to not claiming a signature", () => {
    const body = buildReleaseNotes({ version: "1.1.0", tags: ["v1.0.0"], npmMetadata: "", repository: "lidge-jun/opencodex", generatedNotes: "", commits }).body;
    expect(body).toContain(CODE_SIGNING_ATTRIBUTION);
    expect(body).not.toContain("are Authenticode-signed");
  });
});

describe("Windows signing outcome record (scripts/ci/windows-signing-outcome.sh)", () => {
  const bash = process.platform === "win32" ? null : Bun.which("bash");
  function run(kind: string, env: Record<string, string>, packaged?: (dir: string) => string) {
    const dir = mkdtempSync(join(tmpdir(), "ocx-signing-record-"));
    try {
      const out = join(dir, "out");
      const extra = packaged ? [packaged(dir)] : [];
      const result = Bun.spawnSync([bash!, "--noprofile", "--norc", repoPath("scripts", "ci", "windows-signing-outcome.sh"), kind, out, ...extra], {
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
        // No packaged file, so nothing binds the record to an asset and it never records signed.
        expect(result.record, JSON.stringify(env)).toEqual({ schema: "ocx.windows-signing-outcome/2", kind, signed: false, sha256: null, attempt: null });
        const bytes = new TextEncoder().encode(kind + " packaged bytes\r\n");
        const bound = run(kind, { ...env, GITHUB_RUN_ATTEMPT: "3" }, dir => { const file = join(dir, "asset.bin"); writeFileSync(file, bytes); return file; });
        expect(bound.exitCode, JSON.stringify(env)).toBe(0);
        expect(bound.record, JSON.stringify(env)).toEqual({ schema: "ocx.windows-signing-outcome/2", kind, signed,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), attempt: "3" });
      }
    }
  });

  test.skipIf(!bash)("a packaged file that does not exist leaves the record unbound and not signed", () => {
    const result = run("desktop", { SIGNING_MODE: "sign", SIGNING_TRUST: "release", SIGNED: "true", GITHUB_RUN_ATTEMPT: "2" },
      dir => join(dir, "missing.msi"));
    expect(result.exitCode).toBe(0);
    expect(result.record).toEqual({ schema: "ocx.windows-signing-outcome/2", kind: "desktop", signed: false, sha256: null, attempt: "2" });
  });

  test.skipIf(!bash)("an unknown kind writes nothing and fails the step", () => {
    const result = run("other", { SIGNING_MODE: "sign", SIGNING_TRUST: "release", SIGNED: "true" });
    expect(result.exitCode).not.toBe(0);
    expect(result.record).toBeNull();
  });
});

describe("release workflow wiring of the signing outcome", () => {
  const legs = [
    { job: "package-standalone", kind: "standalone", swap: "Swap in the verified signed Windows binary", packaging: "Archive standalone release",
      asset: "dist/ocx-${{ needs.validate-dispatch.outputs.version }}-${{ matrix.target }}.zip" },
    { job: "package-desktop", kind: "desktop", swap: "Swap in the verified signed Windows installer", packaging: "Rename release assets",
      asset: "dist/release/OpenCodex-${{ needs.validate-dispatch.outputs.version }}-windows-x64.msi" },
  ];

  test("each Windows leg records its swap's signed output and the packaged asset's digest, on every Windows run, without failing it", () => {
    for (const { job, kind, swap, packaging, asset } of legs) {
      const steps = stepsOf(job);
      const swapIndex = steps.findIndex(step => step.name === swap);
      const swapStep = steps[swapIndex]!;
      expect(swapStep.id, job).toBeTruthy();
      const recordIndex = steps.findIndex(step => step.name === "Record the Windows signing outcome");
      const recordStep = steps[recordIndex]!;
      expect(recordIndex, job).toBeGreaterThan(swapIndex);
      // After the file the release publishes exists, so the digest describes the published bytes (#8780 review).
      expect(recordIndex, job).toBeGreaterThan(steps.findIndex(step => step.name === packaging));
      expect(steps.findIndex(step => step.name === packaging), job).toBeGreaterThan(swapIndex);
      expect(recordStep.run).toBe("bash scripts/ci/windows-signing-outcome.sh " + kind + ' "$RUNNER_TEMP/windows-signing-outcome" "$PACKAGED_FILE"');
      expect(recordStep.env?.PACKAGED_FILE).toBe(asset);
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

  test("the publish job reads the records and the verified receipt's digests into the changelog build", () => {
    const steps = stepsOf("publish");
    const download = steps.findIndex(step => step.uses?.startsWith("actions/download-artifact@") && step.with?.pattern === "windows-signing-outcome-*");
    const build = steps.findIndex(step => step.name === "Build and validate release changelog");
    const receipt = steps.findIndex(step => step.uses?.startsWith("actions/download-artifact@") && step.with?.name === "release-verification-receipt");
    expect(download).toBeGreaterThanOrEqual(0);
    expect(download).toBeLessThan(build);
    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(receipt).toBeLessThan(build);
    expect(steps[receipt]!.with?.path).toBe("verification");
    expect(steps[build]!.run).toContain("--release-receipt verification/receipt.json");
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
    expect(source).toContain("--windows-signing-outcomes <dir> --release-receipt <file>");
  });
});

