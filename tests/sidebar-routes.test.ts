import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { invalidateStarStatusCache } from "../src/github/star-state";
import type { OcxConfig } from "../src/types";

/**
 * Route-level proof for the two sidebar endpoints. The unit tests cover the state
 * machine; this file checks that the routes are actually reachable through the
 * management dispatcher and that the serialized bytes carry no `gh` output, token,
 * or account identifier.
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
): Promise<{ status: number; body: unknown; raw: string; routed: boolean }> {
  // `isAllowedManagementOrigin` derives the expected origin from the Host header and
  // rejects the request outright when it is missing, so Host is required here. Omitting
  // Origin models the GUI's own same-origin fetch.
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  const req = new Request(url, { method, headers: { host: "127.0.0.1:10100", ...headers } });
  const res = await handleManagementAPI(req, url, config);
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

describe("GET /api/github/star", () => {
  test("is routed and reports one of the three known states", async () => {
    invalidateStarStatusCache();
    const { status, body } = await call("GET", "/api/github/star");
    expect(status).toBe(200);
    const star = body as Record<string, unknown>;
    expect(["starred", "not-starred", "unauthenticated"]).toContain(star.state);
    expect(star.repo).toBe("lidge-jun/opencodex");
    expect(star.url).toBe("https://github.com/lidge-jun/opencodex");
  });

  test("never serializes gh output, tokens, or account identifiers", async () => {
    invalidateStarStatusCache();
    const { raw } = await call("GET", "/api/github/star");
    // `gh auth status` prints "Logged in to github.com account <name>" and the token
    // scopes; none of that may cross this boundary.
    expect(raw.toLowerCase()).not.toContain("logged in");
    expect(raw.toLowerCase()).not.toContain("token");
    expect(raw.toLowerCase()).not.toContain("scope");
    expect(raw).not.toContain("gho_");
    expect(raw).not.toContain("ghp_");
  });
});

describe("route surface", () => {
  test("an unknown method never reaches the badge reader", async () => {
    const { status, raw } = await call("DELETE", "/api/update/badge");
    // Whatever the dispatcher decides (405/404), it must not answer with badge data.
    expect(status).not.toBe(200);
    expect(raw).not.toContain("updateAvailable");
  });

  test("both routes sit behind the cross-origin gate", async () => {
    for (const path of ["/api/update/badge", "/api/github/star"]) {
      const blocked = await call("GET", path, { origin: "https://evil.example" });
      expect(blocked.status).toBe(403);
      expect(blocked.raw).not.toContain("lidge-jun");
    }
  });
});
