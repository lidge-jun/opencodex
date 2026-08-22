import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createCursorWebhookCoordinator } from "../../scripts/fork/sync/coordinators/cursor-webhook";
import { enabledCoordinators, registerCoordinator } from "../../scripts/fork/sync/registry";
import type { SyncEvent } from "../../scripts/fork/sync/types";

const SECRET = "test-webhook-secret";

function event(kind: SyncEvent["kind"] = "pin-updated"): SyncEvent {
  return {
    kind,
    upstreamRepo: "upstream",
    latestTag: "v2.29.0",
    latestTagSha: "1111111111111111111111111111111111111111",
    vendorMainSha: "2222222222222222222222222222222222222222",
    vendorDevSha: "3333333333333333333333333333333333333333",
    detectedAt: "2026-08-22T18:00:00.000Z",
  };
}

describe("fork sync Cursor webhook coordinator", () => {
  test("posts pin-updated with an HMAC signature", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return new Response("accepted", { status: 202 });
    };
    await createCursorWebhookCoordinator({
      url: "https://cursor.example/hook",
      secret: SECRET,
      fetchImpl,
    }).start(event());

    const body = JSON.stringify(event());
    expect(request?.url).toBe("https://cursor.example/hook");
    expect(request?.init?.body).toBe(body);
    expect(request?.init?.headers).toEqual({
      "content-type": "application/json",
      "x-fork-sync-signature": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    });
  });

  test("posts main-behind and history-diverged events", async () => {
    const postedKinds: string[] = [];
    await createCursorWebhookCoordinator({
      url: "https://cursor.example/hook",
      secret: SECRET,
      fetchImpl: async (_url, init) => {
        postedKinds.push((JSON.parse(String(init?.body)) as SyncEvent).kind);
        return new Response(null, { status: 200 });
      },
    }).start(event("main-behind"));
    await createCursorWebhookCoordinator({
      url: "https://cursor.example/hook",
      secret: SECRET,
      fetchImpl: async (_url, init) => {
        postedKinds.push((JSON.parse(String(init?.body)) as SyncEvent).kind);
        return new Response(null, { status: 200 });
      },
    }).start(event("history-diverged"));
    expect(postedKinds).toEqual(["main-behind", "history-diverged"]);
  });

  test("does not post issue-only events", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    };
    for (const kind of ["pin-diverged", "detect-failed", "already-current"] as const) {
      await createCursorWebhookCoordinator({
        url: "https://cursor.example/hook",
        secret: SECRET,
        fetchImpl,
      }).start(event(kind));
    }
    expect(calls).toBe(0);
  });

  test("does not post when either webhook credential is absent", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    };
    await createCursorWebhookCoordinator({ url: "https://cursor.example/hook", fetchImpl }).start(event());
    await createCursorWebhookCoordinator({ secret: SECRET, fetchImpl }).start(event());
    expect(calls).toBe(0);
  });

  test("throws on a non-success response", async () => {
    await expect(createCursorWebhookCoordinator({
      url: "https://cursor.example/hook",
      secret: SECRET,
      fetchImpl: async () => new Response("bad", { status: 500 }),
    }).start(event())).rejects.toThrow("500");
  });

  test("selects registered coordinator IDs from the environment", () => {
    const selected = { id: "coordinator-test", start: async () => {} };
    registerCoordinator(selected);
    expect(enabledCoordinators({ FORK_SYNC_COORDINATORS: " , coordinator-test, " }))
      .toEqual([selected]);
    expect(() => enabledCoordinators({ FORK_SYNC_COORDINATORS: "missing" }))
      .toThrow("unknown fork sync coordinator");
  });
});
