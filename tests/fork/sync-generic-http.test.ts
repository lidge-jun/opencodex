import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createHttpCoordinator } from "../../scripts/fork/sync/coordinators/http";
import type { SyncEvent } from "../../scripts/fork/sync/types";

const SECRET = "generic-webhook-secret";

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

describe("generic HTTP coordinator", () => {
  test("posts pin updates with configurable HMAC and auth headers", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return new Response(null, { status: 202 });
    };
    await createHttpCoordinator({
      url: "https://agent.example/hooks/fork-sync",
      secret: SECRET,
      signatureHeader: "x-webhook-signature",
      signaturePrefix: "",
      authHeader: "Bearer agent-token",
      fetchImpl,
    }).start(event());

    const body = JSON.stringify(event());
    expect(request?.url).toBe("https://agent.example/hooks/fork-sync");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.body).toBe(body);
    expect(request?.init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer agent-token",
      "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"),
    });
  });

  test("posts without a secret for token-authenticated HTTP endpoints", async () => {
    let calls = 0;
    await createHttpCoordinator({
      url: "https://agent.example/webhook",
      authHeader: "Bearer agent-token",
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    }).start(event());
    expect(calls).toBe(1);
  });

  test("posts all actionable lane events", async () => {
    const postedKinds: string[] = [];
    for (const kind of ["pin-updated", "main-behind", "history-diverged"] as const) {
      await createHttpCoordinator({
        url: "https://agent.example/webhook",
        fetchImpl: async (_url, init) => {
          postedKinds.push((JSON.parse(String(init?.body)) as SyncEvent).kind);
          return new Response(null, { status: 200 });
        },
      }).start(event(kind));
    }
    expect(postedKinds).toEqual(["pin-updated", "main-behind", "history-diverged"]);
  });

  test("does not post non-updated events or without a URL", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    };
    await createHttpCoordinator({ url: "https://agent.example/hook", fetchImpl }).start(event("already-current"));
    await createHttpCoordinator({ fetchImpl }).start(event());
    expect(calls).toBe(0);
  });

  test("throws on a non-success response", async () => {
    await expect(createHttpCoordinator({
      url: "https://agent.example/hook",
      fetchImpl: async () => new Response(null, { status: 503 }),
    }).start(event())).rejects.toThrow("503");
  });
});
