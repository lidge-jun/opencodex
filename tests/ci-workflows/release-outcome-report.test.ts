/**
 * Release outcomes are reported one fact at a time.
 *
 * The registry smoke warns "Registry lookup not confirmed" and the run still continues to the
 * GitHub release, which is the intended publishing behaviour. What was missing is a record that
 * says which facts a green run actually established. The publish job now exposes the registry
 * read-back and the dist-tag as separate outputs, and an always-run `release-outcomes` job puts the
 * GitHub release, the npm version and the npm dist-tag on separate rows. It is a job of its own
 * because a failed publish skips `attach-release`, which is when the rows matter most.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = { outputs?: Record<string, string>; permissions?: Record<string, string>; steps?: Step[] };
const release = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8")) as {
  jobs: Record<string, Job | undefined>;
};
const publishSteps = release.jobs.publish?.steps ?? [];
const smoke = publishSteps.find(step => step.id === "registry-smoke");
const outcomes = release.jobs["release-outcomes"] as (Job & { needs?: string[]; if?: string }) | undefined;
const report = (outcomes?.steps ?? []).find(step => step.name === "Report release outcomes");
const REPORT_SCRIPT = repoPath("scripts", "ci", "release-outcome-report.sh");

describe("release outcome wiring", () => {
  test("the registry smoke records the version and the dist-tag separately", () => {
    expect(smoke?.run).toContain('echo "npm_version=confirmed" >> "$GITHUB_OUTPUT"');
    expect(smoke?.run).toContain('echo "npm_version=unconfirmed" >> "$GITHUB_OUTPUT"');
    expect(smoke?.run).toContain('echo "npm_dist_tag=${dist_tag_state}" >> "$GITHUB_OUTPUT"');
    expect(smoke?.env?.NPM_DIST_TAG).toBe("${{ inputs.tag }}");
  });

  test("the publish job exposes both registry outcomes", () => {
    expect(release.jobs.publish?.outputs).toMatchObject({
      npm_version: "${{ steps.registry-smoke.outputs.npm_version }}",
      npm_dist_tag: "${{ steps.registry-smoke.outputs.npm_dist_tag }}",
    });
  });

  test("a read-only job reports after publish and attach whatever their result", () => {
    expect(outcomes?.needs).toEqual(["publish", "attach-release"]);
    expect(outcomes?.if).toBe("${{ always() && inputs.dry-run != true }}");
    expect(outcomes?.permissions).toEqual({ contents: "read" });
    expect(report?.run?.trim()).toBe("bash scripts/ci/release-outcome-report.sh");
    expect(report?.env).toMatchObject({
      NPM_VERSION_STATE: "${{ needs.publish.outputs.npm_version }}",
      NPM_DIST_TAG_STATE: "${{ needs.publish.outputs.npm_dist_tag }}",
      RELEASE_VERSION: "${{ inputs.version }}",
      NPM_DIST_TAG: "${{ inputs.tag }}",
      PUBLISH_RESULT: "${{ needs.publish.result }}",
      ATTACH_RESULT: "${{ needs.attach-release.result }}",
    });
    expect(release.jobs["attach-release"]?.permissions).toEqual({ contents: "write" });
  });
});

type SmokeResult = { status: number; outputs: Record<string, string>; stdout: string; summary: string };

async function runSmoke(mode: { tags: string | null; pending?: boolean }): Promise<SmokeResult> {
  const directory = mkdtempSync(join(tmpdir(), "ocx-registry-outcome-"));
  const output = join(directory, "output");
  const summary = join(directory, "summary");
  for (const path of [output, summary]) writeFileSync(path, "");
  const prelude = String.raw`
    node() { echo "@fixture/pkg"; }
    npm() {
      case "$1" in
        view) [ "$FIXTURE_PENDING" = "yes" ] && return 1; echo "$RELEASE_VERSION" ;;
        dist-tag) [ "$FIXTURE_TAGS" = "fail" ] && return 1; printf '%b\n' "$FIXTURE_TAGS" ;;
      esac
    }
    timeout() { shift 2; "$@"; }
    sleep() { :; }
  `;
  try {
    const child = Bun.spawn(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${prelude}\n${smoke!.run!}`], {
      env: {
        ...process.env,
        RELEASE_VERSION: "9.8.7",
        NPM_DIST_TAG: "latest",
        PUBLISHED: "true",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        FIXTURE_PENDING: mode.pending ? "yes" : "no",
        FIXTURE_TAGS: mode.tags ?? "fail",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean)
      .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    return { status, outputs, stdout, summary: readFileSync(summary, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("the registry smoke, executed", () => {
  test("a dist-tag that names the release is confirmed", async () => {
    const result = await runSmoke({ tags: "latest: 9.8.7\\npreview: 9.9.0-preview.20260923" });
    expect(result.status, result.stdout).toBe(0);
    expect(result.outputs).toMatchObject({ verification: "verified", npm_version: "confirmed", npm_dist_tag: "confirmed" });
  }, SPAWN_BUDGET_MS);

  test("a dist-tag that names another version is a mismatch, not a confirmation", async () => {
    const result = await runSmoke({ tags: "latest: 9.8.6" });
    expect(result.status, result.stdout).toBe(0);
    expect(result.outputs.npm_dist_tag).toBe("mismatch");
    expect(result.stdout).toContain("::warning::npm dist-tag latest points at 9.8.6, not 9.8.7");
  }, SPAWN_BUDGET_MS);

  test("an unreadable dist-tag list stays unconfirmed", async () => {
    const result = await runSmoke({ tags: null });
    expect(result.status, result.stdout).toBe(0);
    expect(result.outputs).toMatchObject({ npm_version: "confirmed", npm_dist_tag: "unconfirmed" });
  }, SPAWN_BUDGET_MS);

  test("pending registry reads leave both npm outcomes unconfirmed and still continue", async () => {
    const result = await runSmoke({ tags: "latest: 9.8.7", pending: true });
    expect(result.status, result.stdout).toBe(0);
    expect(result.outputs).toMatchObject({ verification: "pending", npm_version: "unconfirmed", npm_dist_tag: "unconfirmed" });
  }, SPAWN_BUDGET_MS);
});

function runReport(github: "false" | "true" | "missing", versionState: string, tagState: string): { status: number | null; stdout: string; summary: string } {
  const directory = mkdtempSync(join(tmpdir(), "ocx-release-report-"));
  try {
    const summary = join(directory, "summary");
    writeFileSync(summary, "");
    writeFileSync(join(directory, "gh"), [
      "#!/bin/sh",
      'case "$FIXTURE_GH" in false|true) echo "$FIXTURE_GH" ;; *) exit 1 ;; esac',
      "",
    ].join("\n"), { mode: 0o755 });
    const result = Bun.spawnSync(["bash", REPORT_SCRIPT], {
      env: {
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
        RELEASE_VERSION: "9.8.7",
        NPM_DIST_TAG: "latest",
        NPM_VERSION_STATE: versionState,
        NPM_DIST_TAG_STATE: tagState,
        GITHUB_STEP_SUMMARY: summary,
        FIXTURE_GH: github,
        PUBLISH_RESULT: "success",
        ATTACH_RESULT: "success",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { status: result.exitCode, stdout: result.stdout.toString(), summary: readFileSync(summary, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("scripts/ci/release-outcome-report.sh, executed", () => {
  test("a fully confirmed release reads as three confirmed rows and no warning", () => {
    const result = runReport("false", "confirmed", "confirmed");
    expect(result.status).toBe(0);
    expect(result.summary).toContain("| GitHub release `v9.8.7` | published |");
    expect(result.summary).toContain("| npm version `9.8.7` read back from the registry | confirmed |");
    expect(result.summary).toContain("| npm dist-tag `latest` points at `9.8.7` | confirmed |");
    expect(result.stdout).not.toContain("::warning::");
  }, SPAWN_BUDGET_MS);

  test("each unconfirmed fact gets its own row and warning", () => {
    const result = runReport("true", "confirmed", "mismatch");
    expect(result.status).toBe(0);
    expect(result.summary).toContain("| GitHub release `v9.8.7` | draft (not public) |");
    expect(result.summary).toContain("| npm dist-tag `latest` points at `9.8.7` | points at another version |");
    expect(result.stdout).toContain("::warning::GitHub release v9.8.7 is draft (not public)");
    expect(result.stdout).toContain("::warning::npm dist-tag latest points at another version for 9.8.7");
  }, SPAWN_BUDGET_MS);

  test("a run that never reached the registry reports nothing as confirmed and does not fail", () => {
    const result = runReport("missing", "", "");
    expect(result.status).toBe(0);
    expect(result.summary).toContain("| GitHub release `v9.8.7` | not public (draft, missing or unreadable) |");
    expect(result.summary).toContain("Publish job: success. Attach job: success.");
    expect(result.summary).toContain("| npm version `9.8.7` read back from the registry | not confirmed |");
    expect(result.stdout).toContain("::warning::npm version 9.8.7 was not read back from the registry");
  }, SPAWN_BUDGET_MS);
});
