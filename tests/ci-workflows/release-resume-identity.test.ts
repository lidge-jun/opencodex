import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertResumeSourceMetadata } from "../../scripts/verify-release-resume";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SHA = "a".repeat(40);
const workflow = Bun.YAML.parse(readFileSync(repoPath(".github/workflows/release.yml"), "utf8")) as {
  jobs: { "validate-dispatch": { steps: Array<{ name: string; run?: string }> }; publish: { steps: Array<{ name: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown> }> } };
};
const sourceStep = workflow.jobs["validate-dispatch"].steps.find(step => step.name === "Resolve eligible source")!;

test.each(["", "null", "{}", "[]", '"short"', JSON.stringify("b".repeat(40)), JSON.stringify(SHA.toUpperCase()), JSON.stringify(` ${SHA}`), JSON.stringify("x".repeat(1025))])("resume rejects nonmatching or nonscalar registry metadata %s", raw => {
  expect(() => assertResumeSourceMetadata(raw, SHA)).toThrow();
});
test("resume metadata helper accepts only exact audited source metadata", () => {
  expect(() => assertResumeSourceMetadata(JSON.stringify(SHA), SHA)).not.toThrow();
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
      { EXPECTED_DIGEST: "bad" }, { GITHUB_RUN_ATTEMPT: "3" }, { GITHUB_RUN_ID: "1e2" }, { NPM_DIST_TAG: "other" }]) {
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
    const valid = run(prepare.run!); expect(valid.exitCode, valid.stderr.toString()).toBe(0);
    expect(existsSync(join(root, "publication/receipt.json"))).toBe(false);
    const acknowledged = run(create.run!); expect(acknowledged.exitCode, acknowledged.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "publication/receipt.json"), "utf8"))).toEqual({
      sourceSha: SHA, workflowSha, version: "9.8.7", channel: "stable", sha256: digest,
      runId: 123, attempt: 2, published: true, assets: { "app.zip": assetDigest },
    });
    expect(run(create.run!).exitCode).not.toBe(0);
  } finally { removeTreeWithRetry(root); }
});

test.skipIf(process.platform === "win32")("dispatch refuses resume before evidence lookup or publication", () => {
  expect(sourceStep.run).toBeDefined();
  for (const dryRun of ["true", "false"]) {
    const result = Bun.spawnSync(["bash", "-e", "-c", sourceStep.run!], { cwd: repoRoot(), env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/dev",
      GITHUB_SHA: SHA, REQUESTED_SHA: SHA, RESUME: "true", DRY_RUN: dryRun,
    }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString() + result.stderr.toString()).toContain("Resume requires a durable verified receipt");
  }
  const publication = workflow.jobs.publish.steps.find(step => step.name === "Publish verified npm tarball")!;
  expect(publication.run).not.toContain("RESUME");
});
