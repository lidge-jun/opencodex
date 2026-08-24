import { describe, expect, test } from "bun:test";
import type { FetchImplementation, PrepareResult, SyncEvent } from "../../scripts/fork/sync/types";
import { createDraftPullRequestClient } from "../../scripts/fork/sync/pull-request";

const event: SyncEvent = {
  kind: "pin-updated",
  upstreamRepo: "lidge-jun/opencodex",
  latestTag: "v2.32.0",
  latestTagSha: "1111111111111111111111111111111111111111",
  vendorMainSha: "2222222222222222222222222222222222222222",
  vendorDevSha: "3333333333333333333333333333333333333333",
  detectedAt: "2026-08-24T12:00:00.000Z",
  recommendedLane: "daily-merge",
};

const result: PrepareResult = {
  status: "merged",
  branch: "sync/upstream-20260824",
  resolutions: [{
    path: "package.json",
    classification: "recipe",
    action: "merge package recipe",
  }],
  unresolved: [],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fork sync draft pull requests", () => {
  test("creates a draft PR with the merge result", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: FetchImplementation = async (input, init) => {
      requests.push({ input: String(input), init });
      return requests.length === 1
        ? response([])
        : response({ number: 17 });
    };

    const number = await createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({ event, result });

    expect(number).toBe(17);
    expect(requests.map(request => [request.input, request.init?.method ?? "GET"])).toEqual([
      ["https://api.github.com/repos/yansigit/opencodex/pulls?state=open&base=main", "GET"],
      ["https://api.github.com/repos/yansigit/opencodex/pulls", "POST"],
    ]);
    const body = JSON.parse(String(requests[1]?.init?.body));
    expect(body).toMatchObject({
      title: "sync: upstream v2.32.0",
      head: "sync/upstream-20260824",
      base: "main",
      draft: true,
    });
    expect(body.body).toContain(event.latestTagSha);
    expect(body.body).toContain("package.json");
    expect(body.body).toContain("## Summary");
  });

  test("updates the existing same-tag and head PR instead of creating another", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: FetchImplementation = async (input, init) => {
      requests.push({ input: String(input), init });
      return requests.length === 1
        ? response([{
          number: 23,
          title: "sync: upstream v2.32.0",
          body: `tag SHA: ${event.latestTagSha}`,
          state: "open",
          draft: true,
          head: { ref: result.branch },
          base: { ref: "main" },
        }])
        : response({ number: 23 });
    };

    await createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({ event, result });

    expect(requests[1]?.input).toBe(
      "https://api.github.com/repos/yansigit/opencodex/pulls/23",
    );
    expect(requests[1]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(requests[1]?.init?.body)).draft).toBe(true);
    expect(String(requests[1]?.init?.body)).not.toContain("secret-token");
  });

  test("does not expose a merge endpoint", async () => {
    const requests: string[] = [];
    const fetchImpl: FetchImplementation = async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return requests.length === 1 ? response([]) : response({ number: 1 });
    };

    await createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({ event, result });

    expect(requests.join("\n")).not.toContain("/merge");
  });
});
