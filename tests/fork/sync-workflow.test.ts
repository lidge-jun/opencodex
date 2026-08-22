import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(
  import.meta.dir,
  "../../.github/workflows/fork-upstream-sync.yml",
), "utf8");

describe("fork upstream sync workflow contract", () => {
  test("polls on a schedule and supports manual dispatch", () => {
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
  });

  test("checks out the trusted default branch with the immutable checkout action", () => {
    expect(workflow).toContain(
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
    );
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain("persist-credentials: true");
  });

  test("has only vendor and issue write permissions", () => {
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).not.toMatch(/pull-requests:\s*write/);
  });

  test("passes the two Cursor secrets only to emit", () => {
    expect(workflow).toContain("FORK_SYNC_CURSOR_WEBHOOK_URL");
    expect(workflow).toContain("FORK_SYNC_CURSOR_WEBHOOK_SECRET");
    expect(workflow).toContain("FORK_SYNC_NOTIFIERS: github-issue");
    expect(workflow).toContain("FORK_SYNC_COORDINATORS: cursor-webhook");
  });

  test("emits every non-no-op lane and summarizes its kind", () => {
    expect(workflow).toContain("main-behind");
    expect(workflow).toContain("history-diverged");
    expect(workflow).toContain("Fork sync lane: $kind");
    expect(workflow).toContain("if: steps.pin.outputs.kind != 'already-current'");
  });

  test("does not merge or force-push from the action", () => {
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toMatch(/gh\s+pr\s+merge|git\s+push\s+.*--force|git\s+merge\s+-X/);
  });

  test("pushes only the two vendor refs after a successful pin", () => {
    expect(workflow).toContain(
      "git push origin refs/heads/vendor/main:refs/heads/vendor/main refs/heads/vendor/dev:refs/heads/vendor/dev",
    );
    expect(workflow).toContain(
      "if: steps.pin.outputs.kind == 'pin-updated' || steps.pin.outputs.kind == 'history-diverged'",
    );
    expect(workflow).not.toMatch(/git\s+push\s+origin\s+(?:main|origin\/main)\b/);
  });

  test("bootstraps missing vendor refs from upstream instead of failing the fetch", () => {
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/vendor/main");
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/vendor/dev");
    expect(workflow).toContain("git branch vendor/main upstream/main");
    expect(workflow).toContain("git branch vendor/dev upstream/dev");
  });
});
