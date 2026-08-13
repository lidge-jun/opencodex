import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

/**
 * Route-level proof for the sidebar update-badge endpoint. The star routes were
 * removed: this file checks that the badge is still reachable and that the
 * GitHub identity mutation is no longer dispatched.
 */
const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

async function call(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  principal?: "admin-token" | "gui-session",
): Promise<{ status: number; body: unknown; raw: string; routed: boolean }> {
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  const req = new Request(url, { method, headers: { host: "127.0.0.1:10100", ...headers } });
  const res = await handleManagementAPI(req, url, config, {}, principal);
  if (!res) return { status: 404, body: null, raw: "", routed: false };
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null, raw, routed: true };
}

describe("GET /api/update/badge", () => {
  test("is routed and returns the badge shape", async () => {
    const { status, body } = await call("GET", "/api/update/badge");
    expect(status).toBe(200);
    const badge = body as Record<string, unknown>;
    expect(typeof badge.updateAvailable).toBe("boolean");
    expect(typeof badge.canUpdate).toBe("boolean");
    expect(typeof badge.unknown).toBe("boolean");
    expect(["latest", "preview"]).toContain(badge.channel);
  });

  test("serializes scalars only — no paths, commands, or registry output", async () => {
    const { raw } = await call("GET", "/api/update/badge");
    expect(raw).not.toContain("npm");
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain("node_modules");
  });
});

describe("removed GitHub star routes", () => {
  test("GET and POST /api/github/star are not dispatched", async () => {
    const get = await call("GET", "/api/github/star");
    const post = await call("POST", "/api/github/star", {}, "gui-session");
    expect(get.routed).toBe(false);
    expect(post.routed).toBe(false);
    expect(get.status).toBe(404);
    expect(post.status).toBe(404);
  });
});

describe("route surface", () => {
  test("an unknown method never reaches the badge reader", async () => {
    const { status, raw } = await call("DELETE", "/api/update/badge");
    expect(status).not.toBe(200);
    expect(raw).not.toContain("updateAvailable");
  });

  test("the badge route sits behind the cross-origin gate", async () => {
    const blocked = await call("GET", "/api/update/badge", { origin: "https://evil.example" });
    expect(blocked.status).toBe(403);
    expect(blocked.raw).not.toContain("lidge-jun");
  });
});
