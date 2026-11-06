/**
 * The pull-request test lane (scripts/ci/select-test-lane.sh).
 *
 * A fast-lane pull request runs `gates` plus `test changed` instead of the four
 * full Ubuntu shards. The selector must keep the full lane for every other
 * event, an out-of-scope pull request, the `ci:full` label, and any diff that
 * touches an input the import graph cannot follow.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

type Scenario = {
  path?: string;
  event?: string;
  scope?: string;
  label?: string;
  orphan?: boolean;
  expected?: "true" | "false";
  status?: number;
};

function select(scenario: Scenario): { status: number | null; fast: string | undefined; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), "ocx-test-lane-"));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: directory, encoding: "utf8", timeout: 5_000,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
      });
      expect(result.status, result.stderr).toBe(0);
    };
    const commit = () => {
      git("add", ".");
      git("-c", "user.name=CI Fixture", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "-m", "fixture");
    };
    git("init", "--quiet");
    writeFileSync(join(directory, "seed.txt"), "seed\n");
    commit();
    if (!scenario.orphan) {
      const path = join(directory, scenario.path ?? "src/example.ts");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "changed\n");
      commit();
    }
    const output = join(directory, "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", [repoPath("scripts", "ci", "select-test-lane.sh")], {
      cwd: directory, encoding: "utf8", timeout: 5_000,
      env: {
        ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "",
        EVENT_NAME: scenario.event ?? "pull_request", CI_SCOPE: scenario.scope ?? "true", FULL_LABEL: scenario.label ?? "false",
      },
    });
    const fast = /^fast=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1];
    return { status: result.status, fast, stderr: result.stderr };
  } finally {
    removeTreeWithRetry(directory);
  }
}

describe.skipIf(process.platform === "win32")("pull-request test lane", () => {
  test("an ordinary source or test change takes the fast lane", () => {
    for (const path of ["src/router.ts", "tests/server/example.test.ts", "gui/src/App.tsx", "docs/notes.md"]) {
      expect(`${path}:${select({ path }).fast}`).toBe(`${path}:true`);
    }
  });

  test("harness, fixture, toolchain and dependency changes keep the full shards", () => {
    for (const path of [
      ".github/workflows/ci.yml", ".github/actions/setup-project-bun/action.yml", ".github/scripts/x.mjs",
      "scripts/ci/run-changed-tests.sh", "scripts/test.ts", "scripts/test-durations.ts",
      "tests/preload.ts", "tests/fixtures/file-size-baseline.json", "bunfig.toml", "tsconfig.json",
      "package.json", "bun.lock", "gui/package.json", "gui/bun.lock",
    ]) {
      expect(`${path}:${select({ path }).fast}`).toBe(`${path}:false`);
    }
  });

  test("the label, the scope, other events and a missing parent keep the full shards", () => {
    expect(select({ label: "true" }).fast).toBe("false");
    expect(select({ scope: "false" }).fast).toBe("false");
    expect(select({ orphan: true }).fast).toBe("false");
    for (const event of ["push", "workflow_dispatch", "schedule"]) {
      expect(`${event}:${select({ event, scope: "invalid", label: "invalid" }).fast}`).toBe(`${event}:false`);
    }
  });

  test("a malformed pull-request input fails the job instead of choosing a lane", () => {
    for (const scenario of [{ scope: "" }, { label: "yes" }]) {
      const result = select(scenario);
      expect(result.status).toBe(1);
      expect(result.fast).toBeUndefined();
    }
  });

  test("ci.yml wires the selector and the fast-lane job", () => {
    const ci = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8")) as {
      jobs: Record<string, { steps?: Array<{ id?: string; run?: string; env?: Record<string, string> }> }>;
    };
    const lane = ci.jobs.changes?.steps?.find(step => step.id === "lane");
    expect(lane?.run).toBe("bash scripts/ci/select-test-lane.sh");
    expect(lane?.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      CI_SCOPE: "${{ steps.scope.outputs.ci }}",
      FULL_LABEL: "${{ contains(github.event.pull_request.labels.*.name, 'ci:full') }}",
    });
    const run = ci.jobs["test-changed"]?.steps?.map(step => step.run ?? "").join("\n") ?? "";
    expect(run).toContain("bash scripts/ci/run-changed-tests.sh");
  });
});
