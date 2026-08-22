import { describe, expect, test } from "bun:test";
import { createGitHubIssueNotifier } from "../../scripts/fork/sync/notifiers/github-issue";
import { enabledNotifiers, registerNotifier } from "../../scripts/fork/sync/registry";
import type { GitHubIssue, GitHubIssuesClient, SyncEvent } from "../../scripts/fork/sync/types";

const TAG_SHA = "1111111111111111111111111111111111111111";

function event(
  kind: SyncEvent["kind"] = "pin-updated",
  recommendedLane?: SyncEvent["recommendedLane"],
): SyncEvent {
  return {
    kind,
    upstreamRepo: "upstream",
    latestTag: "v2.29.0",
    latestTagSha: TAG_SHA,
    vendorMainSha: "2222222222222222222222222222222222222222",
    vendorDevSha: "3333333333333333333333333333333333333333",
    detectedAt: "2026-08-22T18:00:00.000Z",
    ...(recommendedLane ? { recommendedLane } : {}),
  };
}

function client(issues: GitHubIssue[] = []) {
  const calls: Array<{ method: string; value: unknown }> = [];
  const api: GitHubIssuesClient = {
    async listOpen(value) {
      calls.push({ method: "list", value });
      return issues;
    },
    async create(value) {
      calls.push({ method: "create", value });
    },
    async update(value) {
      calls.push({ method: "update", value });
    },
  };
  return { api, calls };
}

describe("fork sync GitHub issue notifier", () => {
  test("creates a labeled issue for a new sync event", async () => {
    const fake = client();
    await createGitHubIssueNotifier({
      client: fake.api,
      upstreamRepo: "lidge-jun/opencodex",
    }).notify(event());

    expect(fake.calls.map(call => call.method)).toEqual(["list", "create"]);
    const created = fake.calls[1]?.value as { title: string; body: string; labels: string[] };
    expect(created.labels).toEqual(["fork-sync"]);
    expect(created.title).toContain("v2.29.0");
    expect(created.body).toContain(TAG_SHA);
    expect(created.body).not.toContain("FORK_SYNC_CURSOR_WEBHOOK_SECRET");
  });

  test("updates the existing same-tag issue and preserves its labels", async () => {
    const fake = client([{
      number: 42,
      title: "fork sync v2.29.0",
      body: "latestTag=v2.29.0",
      state: "open",
      labels: [{ name: "fork-sync" }, { name: "triage" }],
    }]);
    await createGitHubIssueNotifier({
      client: fake.api,
      upstreamRepo: "lidge-jun/opencodex",
    }).notify(event());

    expect(fake.calls.map(call => call.method)).toEqual(["list", "update"]);
    expect((fake.calls[1]?.value as { issueNumber: number }).issueNumber).toBe(42);
    expect((fake.calls[1]?.value as { labels: string[] }).labels).toEqual(["fork-sync", "triage"]);
  });

  test("recommends a merge-from-main draft PR for daily-merge events", async () => {
    const fake = client();
    await createGitHubIssueNotifier({
      client: fake.api,
      upstreamRepo: "lidge-jun/opencodex",
    }).notify(event("main-behind", "daily-merge"));

    const created = fake.calls[1]?.value as { body: string };
    expect(created.body).toContain("recommendedLane: daily-merge");
    expect(created.body).toContain("open or update a merge-from-main draft PR");
    expect(created.body).not.toContain("rebuild run/main");
  });

  test("does not call GitHub for an already-current event", async () => {
    const fake = client();
    await createGitHubIssueNotifier({
      client: fake.api,
      upstreamRepo: "upstream",
    }).notify(event("already-current"));
    expect(fake.calls).toEqual([]);
  });

  test("rejects an unknown notifier selected by environment", () => {
    expect(() => enabledNotifiers({ FORK_SYNC_NOTIFIERS: "missing" }))
      .toThrow("unknown fork sync notifier");
  });

  test("selects registered notifier IDs after trimming empty entries", () => {
    const selected = { id: "notify-test", notify: async () => {} };
    registerNotifier(selected);
    expect(enabledNotifiers({ FORK_SYNC_NOTIFIERS: " , notify-test, " }))
      .toEqual([selected]);
  });
});
