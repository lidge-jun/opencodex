import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertResumeSourceMetadata } from "../../scripts/verify-release-resume";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SHA = "a".repeat(40);
const workflow = Bun.YAML.parse(readFileSync(repoPath(".github/workflows/release.yml"), "utf8")) as {
  jobs: { "validate-dispatch": { steps: Array<{ name: string; run?: string }> }; publish: { steps: Array<{ name: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown> }> }; "attach-release": { permissions?: Record<string, string>; steps: Array<{ name: string; run?: string; if?: string; env?: Record<string, string> }> } };
};
const sourceStep = workflow.jobs["validate-dispatch"].steps.find(step => step.name === "Resolve eligible source")!;

test.each(["", "null", "{}", "[]", '"short"', JSON.stringify("b".repeat(40)), JSON.stringify(SHA.toUpperCase()), JSON.stringify(` ${SHA}`), JSON.stringify("x".repeat(1025))])("resume rejects nonmatching or nonscalar registry metadata %s", raw => {
  expect(() => assertResumeSourceMetadata(raw, SHA)).toThrow();
});
test("resume metadata helper accepts only exact audited source metadata", () => {
  expect(() => assertResumeSourceMetadata(JSON.stringify(SHA), SHA)).not.toThrow();
});

test.skipIf(process.platform === "win32")("verified exact resume skips npm publish and rejects registry mismatches", () => {
  const verify = workflow.jobs.publish.steps.find(step => step.name === "Verify resume registry identity");
  const publication = workflow.jobs.publish.steps.find(step => step.name === "Publish verified npm tarball");
  expect(verify?.run).toBeDefined(); expect(publication?.run).toBeDefined();
  const root = mkdtempSync(join(tmpdir(), "ocx-resume-registry-"));
  try {
    const output = join(root, "output"), summary = join(root, "summary"), calls = join(root, "calls");
    const mock = String.raw`
      npm() {
        printf '%s\n' "$*" >> "$CALLS"
        if [ "$1" = view ] && [ "$3" = version ]; then printf '%s\n' "$REGISTRY_VERSION"; return "$REGISTRY_STATUS"; fi
        if [ "$1" = view ] && [ "$3" = gitHead ]; then printf '%s\n' "$REGISTRY_HEAD"; return "$REGISTRY_STATUS"; fi
        return 97
      }
      timeout() { shift 2; "$@"; }
      bun() { "$TEST_BUN" "$@"; }
    `;
    const run = (extra: Record<string, string> = {}, skipVerification = false) => {
      for (const path of [output, summary, calls]) writeFileSync(path, "");
      const script = mock + (skipVerification ? "" : verify!.run!)
        + '\nVERIFIED_RESUME_SHA=$(sed -n "s/^resume_sha=//p" "$GITHUB_OUTPUT")\nVERIFIED_RESUME_DECISION="$DECISION_SHA"\n' + publication!.run!;
      const result = Bun.spawnSync(["bash", "-e", "-c", script], { cwd: repoRoot(), env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", TEST_BUN: process.execPath, SOURCE_SHA: SHA,
        RELEASE_VERSION: "9.8.7", NPM_DIST_TAG: "latest", RESUME: "true", GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary, CALLS: calls, REGISTRY_VERSION: JSON.stringify("9.8.7"),
        REGISTRY_HEAD: JSON.stringify(SHA), REGISTRY_STATUS: "0", DECISION_SHA: SHA, ...extra,
      }, stdout: "pipe", stderr: "pipe" });
      return { result, output: readFileSync(output, "utf8"), calls: readFileSync(calls, "utf8") };
    };
    const valid = run();
    expect(valid.result.exitCode, valid.result.stderr.toString()).toBe(0);
    expect(valid.output).toContain(`resume_sha=${SHA}`);
    expect(valid.output).toContain("published=true");
    expect(valid.calls).not.toContain("publish");
    for (const bad of [{ REGISTRY_VERSION: JSON.stringify("9.8.8") }, { REGISTRY_HEAD: JSON.stringify("b".repeat(40)) },
      { REGISTRY_HEAD: "null" }, { REGISTRY_HEAD: "" }, { REGISTRY_STATUS: "1" }]) {
      const result = run(bad);
      expect(result.result.exitCode, JSON.stringify(bad)).not.toBe(0);
      expect(result.output).not.toContain("published=true");
      expect(result.calls).not.toContain("publish");
    }
    const absent = run({}, true);
    expect(absent.result.exitCode).not.toBe(0);
    expect(absent.calls).not.toContain("publish");
    expect(run({ DECISION_SHA: "" }).result.exitCode).not.toBe(0);
  } finally { removeTreeWithRetry(root); }
});

test.skipIf(process.platform === "win32")("resume rechecks trusted history at publication and assets at attachment", () => {
  const publish = workflow.jobs.publish.steps.find(step => step.name === "Check resume publication");
  const attach = workflow.jobs["attach-release"].steps.find(step => step.name === "Check resume assets");
  expect(publish?.run).toBeDefined(); expect(attach?.run).toBeDefined();
  expect(workflow.jobs["attach-release"].permissions?.contents).toBe("write");
  expect(attach?.env?.GH_TOKEN).toBe("${{ github.token }}");
  const root = mkdtempSync(join(tmpdir(), "ocx-resume-decision-"));
  try {
    const calls = join(root, "calls"), output = join(root, "output");
    const mock = String.raw`
      node() {
        if [ "$1" = .github/scripts/release-resume.cjs ]; then
          printf '%s\n' "$*" >> "$CALLS"; printf '%s\n' "$DECISION"; return "$DECISION_STATUS"
        fi
        command node "$@"
      }
    `;
    const run = (script: string, decision: unknown, status = "0", tag = "latest") => {
      writeFileSync(calls, ""); writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-e", "-c", mock + script], { cwd: root, env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", SOURCE_SHA: SHA, RELEASE_VERSION: "9.8.7", NPM_DIST_TAG: tag,
        GH_TOKEN: "fixture-token", CALLS: calls, GITHUB_OUTPUT: output, DECISION: JSON.stringify(decision), DECISION_STATUS: status,
      }, stdout: "pipe", stderr: "pipe" });
      return { result, calls: readFileSync(calls, "utf8"), output: readFileSync(output, "utf8") };
    };
    const tuple = { version: "9.8.7", sourceSha: SHA, channel: "stable", publishNpm: false, assetsChecked: false };
    const valid = run(publish!.run!, tuple);
    expect(valid.result.exitCode, valid.result.stderr.toString()).toBe(0);
    expect(valid.calls).toContain(`release-resume.cjs check 9.8.7 ${SHA} stable`);
    expect(valid.output).toContain(`resume_checked_sha=${SHA}`);
    for (const bad of [{ ...tuple, publishNpm: true }, { ...tuple, sourceSha: "b".repeat(40) }, { ...tuple, version: "9.8.8" }]) {
      expect(run(publish!.run!, bad).result.exitCode).not.toBe(0);
    }
    expect(run(publish!.run!, tuple, "1").result.exitCode).not.toBe(0);
    const assets = run(attach!.run!, { ...tuple, assetsChecked: true, reuseAssets: [], missingAssets: [] });
    expect(assets.result.exitCode, assets.result.stderr.toString()).toBe(0);
    expect(assets.calls).toContain(`release-resume.cjs check-assets 9.8.7 ${SHA} stable verification/receipt.json`);
    expect(run(attach!.run!, tuple).result.exitCode).not.toBe(0);
  } finally { removeTreeWithRetry(root); }
});

test.skipIf(process.platform === "win32")("publication receipt is recorded only after acknowledgement and binds the original assets", () => {
  const steps = workflow.jobs.publish.steps;
  const publication = steps.find(step => step.name === "Publish verified npm tarball")!;
  const prepare = steps.find(step => step.name === "Prepare publication receipt")!;
  const create = steps.find(step => step.name === "Record acknowledged publication")!;
  const upload = steps.find(step => step.name === "Upload publication receipt")!;
  expect(create?.run).toBeDefined();
  expect(prepare?.run).toBeDefined();
  expect(create?.if).toContain("steps.publication.outputs.published == 'true'");
  expect(upload?.if).toContain("steps.publication.outputs.published == 'true'");
  expect(upload?.with?.name).toBe("release-publication-receipt");
  expect(steps.indexOf(create)).toBeGreaterThan(steps.indexOf(publication));
  expect(steps.indexOf(prepare)).toBeLessThan(steps.indexOf(publication));
  expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(create));
  const root = mkdtempSync(join(tmpdir(), "ocx-publication-receipt-"));
  try {
    mkdirSync(join(root, "verification")); mkdirSync(join(root, "publication"));
    const workflowSha = "b".repeat(40), digest = "c".repeat(64), assetDigest = "d".repeat(64);
    const assetReceipt = { version: "9.8.7", sha: SHA, workflowSha, repo: "org/repo", runId: "123", attempt: "2", assets: { "app.zip": assetDigest } };
    writeFileSync(join(root, "verification/receipt.json"), JSON.stringify(assetReceipt));
    const run = (script: string, extra: Record<string, string> = {}) => Bun.spawnSync(["bash", "-e", "-c", script], { cwd: root, env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", SOURCE_SHA: SHA, WORKFLOW_SHA: workflowSha, RELEASE_VERSION: "9.8.7",
      NPM_DIST_TAG: "latest", EXPECTED_DIGEST: digest, GITHUB_REPOSITORY: "org/repo", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", ...extra,
    }, stdout: "pipe", stderr: "pipe" });
    for (const bad of [{ SOURCE_SHA: "e".repeat(40) }, { WORKFLOW_SHA: "e".repeat(40) }, { RELEASE_VERSION: "9.8.8" },
      { EXPECTED_DIGEST: "bad" }, { GITHUB_RUN_ATTEMPT: "1" }, { GITHUB_RUN_ID: "1e2" }, { NPM_DIST_TAG: "other" }]) {
      expect(run(prepare.run!, bad).exitCode, JSON.stringify(bad)).not.toBe(0);
      expect(existsSync(join(root, "publication/receipt.json"))).toBe(false);
      expect(existsSync(join(root, "publication/pending.json"))).toBe(false);
    }
    writeFileSync(join(root, "verification/receipt.json"), JSON.stringify({ ...assetReceipt, assets: { "app.zip": "bad" } }));
    expect(run(prepare.run!).exitCode).not.toBe(0);
    expect(existsSync(join(root, "publication/pending.json"))).toBe(false);
    unlinkSync(join(root, "verification/receipt.json"));
    expect(run(prepare.run!).exitCode).not.toBe(0);
    expect(existsSync(join(root, "publication/pending.json"))).toBe(false);
    const previewVersion = "9.8.7-preview.20261108.1";
    writeFileSync(join(root, "verification/receipt.json"), JSON.stringify({ ...assetReceipt, version: previewVersion }));
    const preview = run(prepare.run!, { RELEASE_VERSION: previewVersion, NPM_DIST_TAG: "preview" });
    expect(preview.exitCode, preview.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "publication/pending.json"), "utf8")).channel).toBe("preview");
    unlinkSync(join(root, "publication/pending.json"));
    writeFileSync(join(root, "verification/receipt.json"), JSON.stringify(assetReceipt));
    const rerun = run(prepare.run!, { GITHUB_RUN_ATTEMPT: "3" });
    expect(rerun.exitCode, rerun.stderr.toString()).toBe(0);
    unlinkSync(join(root, "publication/pending.json"));
    const valid = run(prepare.run!); expect(valid.exitCode, valid.stderr.toString()).toBe(0);
    expect(existsSync(join(root, "publication/receipt.json"))).toBe(false);
    const acknowledged = run(create.run!); expect(acknowledged.exitCode, acknowledged.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "publication/receipt.json"), "utf8"))).toEqual({
      sourceSha: SHA, workflowSha, version: "9.8.7", channel: "stable", sha256: digest,
      gitHead: SHA, runId: 123, attempt: 2, published: true, assets: { "app.zip": assetDigest },
    });
    expect(run(create.run!).exitCode).not.toBe(0);
  } finally { removeTreeWithRetry(root); }
});

test.skipIf(process.platform === "win32")("resume dispatch requires the explicit tuple and qualifying source evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-resume-dispatch-"));
  try {
    const output = join(root, "output"), calls = join(root, "calls");
    const mock = `node() { if [ "$1" = .github/scripts/release-evidence.cjs ]; then printf '%s\\n' "$*" >> "$CALLS"; printf '%s\\n' "$EVIDENCE"; return "$STATUS"; fi; command node "$@"; }\n`;
    const run = (extra: Record<string, string> = {}) => {
      writeFileSync(output, ""); writeFileSync(calls, "");
      const result = Bun.spawnSync(["bash", "-e", "-c", mock + sourceStep.run!], { cwd: repoRoot(), env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/dev",
        GITHUB_SHA: "b".repeat(40), REQUESTED_SHA: SHA, REQUESTED_VERSION: "9.8.7", RESUME: "true", DRY_RUN: "false",
        GITHUB_OUTPUT: output, CALLS: calls, EVIDENCE: JSON.stringify({sourceSha: SHA, ciRunId: 1}), STATUS: "0", ...extra,
      }, stdout: "pipe", stderr: "pipe" });
      return { result, output: readFileSync(output, "utf8"), calls: readFileSync(calls, "utf8") };
    };
    const valid = run();
    expect(valid.result.exitCode, valid.result.stderr.toString()).toBe(0);
    expect(valid.output).toContain(`source_sha=${SHA}\nworkflow_sha=${"b".repeat(40)}`);
    expect(valid.calls).toContain(`resolve ${SHA}`);
    for (const bad of [{REQUESTED_SHA: ""}, {REQUESTED_VERSION: ""}, {DRY_RUN: "true"},
      {REQUESTED_SHA: "short"}, {GITHUB_REF: "refs/heads/other"}, {STATUS: "1"},
      {EVIDENCE: JSON.stringify({sourceSha: "c".repeat(40), ciRunId: 1})}]) {
      expect(run(bad).result.exitCode, JSON.stringify(bad)).not.toBe(0);
    }
  } finally { removeTreeWithRetry(root); }
});

test.skipIf(process.platform === "win32")("resume version is explicit, channel checked, and never allocated from npm", () => {
  const version = workflow.jobs["validate-dispatch"].steps.find(step => step.name === "Resolve release version")!;
  const root = mkdtempSync(join(tmpdir(), "ocx-resume-version-"));
  try {
    const output = join(root, "output");
    const mock = `bun() { if [ "$1" = scripts/release-version-sources.ts ]; then return 0; fi; command "$TEST_BUN" "$@"; }\nnpm() { return 99; }\n`;
    const run = (value: string, channel: string) => {
      writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-e", "-c", mock + version.run!], { cwd: repoRoot(), env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", TEST_BUN: process.execPath, RESUME: "true", EXPECTED_VERSION: value,
        CHANNEL: channel, GITHUB_OUTPUT: output,
      }, stdout: "pipe", stderr: "pipe" });
      return { result, output: readFileSync(output, "utf8") };
    };
    for (const [value, channel] of [["9.8.7", "latest"], ["9.8.7-preview.20261108.1", "preview"]]) {
      const valid = run(value!, channel!);
      expect(valid.result.exitCode, valid.result.stderr.toString()).toBe(0);
      expect(valid.output).toBe(`version=${value}\n`);
    }
    for (const [value, channel] of [["", "latest"], ["9.8.7", "preview"], ["9.8.7-preview.20261108.1", "latest"], ["9.8.7", "other"]])
      expect(run(value!, channel!).result.exitCode).not.toBe(0);
  } finally { removeTreeWithRetry(root); }
});

test.skipIf(process.platform === "win32")("attachment accepts a same-run receipt from an earlier attempt and rejects future or mismatched receipts", () => {
  const step = workflow.jobs["attach-release"].steps.find(item => item.name === "Require the verification receipt for this commit")!;
  const root = mkdtempSync(join(tmpdir(), "ocx-resume-receipt-"));
  try {
    mkdirSync(join(root, "dist/release"), {recursive: true}); mkdirSync(join(root, "verification"));
    writeFileSync(join(root, "dist/release/app.zip"), "fixture");
    const digest = new Bun.CryptoHasher("sha256").update("fixture").digest("hex"), workflowSha = "b".repeat(40);
    const receipt = {version: "9.8.7", sha: SHA, workflowSha, repo: "org/repo", runId: "123", attempt: "1", assets: {"app.zip": digest}};
    const run = (overrides: Record<string, unknown> = {}) => {
      writeFileSync(join(root, "verification/receipt.json"), JSON.stringify({...receipt, ...overrides}));
      return Bun.spawnSync(["bash", "-e", "-c", step.run!], {cwd: root, env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", SOURCE_SHA: SHA, WORKFLOW_SHA: workflowSha,
        RELEASE_VERSION: "9.8.7", GITHUB_REPOSITORY: "org/repo", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2",
      }, stdout: "pipe", stderr: "pipe"});
    };
    const valid = run(); expect(valid.exitCode, valid.stderr.toString()).toBe(0);
    for (const bad of [{attempt: "3"}, {attempt: "0"}, {attempt: "bad"}, {runId: "124"},
      {sha: "c".repeat(40)}, {version: "9.8.8"}, {assets: {"app.zip": "0".repeat(64)}}]) {
      expect(run(bad).exitCode, JSON.stringify(bad)).not.toBe(0);
    }
  } finally { removeTreeWithRetry(root); }
});
