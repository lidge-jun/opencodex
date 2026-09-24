import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVersionCache } from "../../src/update/notify";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { handleManagementAPI } from "../../src/server/management-api";
import { withManagementCors } from "../../src/server/auth-cors";
import { invalidateStarStatusCache, setStarDepsForTests, type StarDeps } from "../../src/github/star-state";
import type { OcxConfig } from "../../src/types";

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
  principal?: "admin-token" | "gui-session" | "gui-pair-capability",
): Promise<{ status: number; body: unknown; raw: string; routed: boolean }> {
  // `isAllowedManagementOrigin` derives the expected origin from the Host header and
  // rejects the request outright when it is missing, so Host is required here. Omitting
  // Origin models the GUI's own same-origin fetch.
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  const req = new Request(url, { method, headers: { host: "127.0.0.1:10100", ...headers } });
  const res = await handleManagementAPI(req, url, config, {}, principal);
  if (!res) return { status: 404, body: null, raw: "", routed: false };
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null, raw, routed: true };
}

const DESKTOP_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DESKTOP_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DESKTOP_ORIGIN_TEST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const desktopPayload = (sessionId = DESKTOP_A) => ({
  sessionId, currentVersion: "2.61.0", latestVersion: "2.62.0",
  available: true, checkedAtMs: Date.now(), phase: "available",
});

async function desktopPost(body: string | Uint8Array, principal?: "admin-token" | "gui-session",
  contentType = "application/json", origin?: string, routeConfig = config, applyCors = false) {
  const url = new URL("http://127.0.0.1:10100/api/update/desktop-snapshot");
  const req = new Request(url, {
    method: "POST",
    headers: { host: "127.0.0.1:10100", "content-type": contentType, ...(origin === undefined ? {} : { origin }) },
    body,
  });
  const routed = await handleManagementAPI(req, url, routeConfig, {}, principal);
  const response = routed && applyCors ? withManagementCors(routed, req, routeConfig) : routed;
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() as Record<string, unknown>,
    allowOrigin: response!.headers.get("access-control-allow-origin") };
}

async function withStarDeps<T>(deps: StarDeps, run: () => Promise<T>): Promise<T> {
  setStarDepsForTests(deps);
  try {
    return await run();
  } finally {
    setStarDepsForTests(null);
  }
}

/** Runs `fn` with the given env vars set, restoring the previous values after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(vars).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The env this suite must neutralize: the test runner itself is agent/CI-driven. */
const NO_AGENT_ENV = {
  CI: undefined,
  GITHUB_ACTIONS: undefined,
  CLAUDECODE: undefined,
  CLAUDE_CODE_ENTRYPOINT: undefined,
  CLAUDE_CODE_SSE_PORT: undefined,
  CODEX_THREAD_ID: undefined,
  CODEX_SHELL: undefined,
  CODEX_CI: undefined,
  CODEX_SANDBOX: undefined,
  CODEX_SANDBOX_NETWORK_DISABLED: undefined,
  CURSOR_TRACE_ID: undefined,
  CURSOR_SESSION_TOKEN: undefined,
  CURSOR_AGENT: undefined,
  AIDER_CHAT: undefined,
  OPENCODE_BIN_PATH: undefined,
  GEMINI_CLI: undefined,
  REPL_ID: undefined,
  GITLAB_CI: undefined,
  BUILDKITE: undefined,
  JENKINS_URL: undefined,
  TEAMCITY_VERSION: undefined,
  CODESPACES: undefined,
} as const;

// Why there is no per-test timeout here any more.
//
// 600ef52f2 raised these two tests to a 20s budget, and the diagnosis behind it was
// right: star-state's 5s AUTH kill raced Bun's 5s default, so a slow Windows
// credential helper failed the test even when spawnGh resolved `gh` correctly.
//
// The budget is moot once the route stops spawning `gh` at all. What these tests
// actually claim is that the route is reachable, answers in the documented shape, and
// never serializes gh output — none of which needs a real process. Injecting the
// existing StarDeps seam makes them deterministic in microseconds instead of buying
// headroom against an external binary's worst case.

describe("GET /api/update/badge", () => {
  test("repeated reads do not advance the package cache timestamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-badge-route-"));
    const previous = process.env.OPENCODEX_HOME;
    try {
      process.env.OPENCODEX_HOME = dir;
      writeVersionCache({ latest_version: "2.7.44", last_checked_at: "2026-09-24T00:00:00.000Z", tag: "latest" });
      const before = readFileSync(join(dir, "version.json"), "utf8");
      expect((await call("GET", "/api/update/badge")).status).toBe(200);
      expect((await call("GET", "/api/update/badge")).status).toBe(200);
      expect(readFileSync(join(dir, "version.json"), "utf8")).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(dir);
    }
  });


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

describe("desktop snapshot route", () => {
  test("rejects dashboard and allowed cross-origin publishers without storing their snapshots", async () => {
    const body = JSON.stringify(desktopPayload(DESKTOP_ORIGIN_TEST));
    const routeConfig = { ...config, corsAllowOrigins: ["https://operator.example"] };
    for (const origin of ["http://127.0.0.1:10100", "https://operator.example", ""]) {
      const refused = await desktopPost(body, "admin-token", "application/json", origin, routeConfig);
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: "desktop snapshot does not accept browser-origin requests" });
      const unread = await call("GET", "/api/update/badge?surface=desktop&session=" + DESKTOP_ORIGIN_TEST);
      expect(unread.body).toMatchObject({ unknown: true, updateAvailable: false });
    }
    const accepted = await desktopPost(body, "admin-token", "application/json", undefined, routeConfig);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ ok: true });
    const stored = await call("GET", "/api/update/badge?surface=desktop&session=" + DESKTOP_ORIGIN_TEST);
    expect(stored.body).toMatchObject({ unknown: false, updateAvailable: true });
  });

  test("requires the raw admin-token principal, not a GUI session or missing principal", async () => {
    const body = JSON.stringify(desktopPayload());
    expect((await desktopPost(body)).status).toBe(403);
    expect((await desktopPost(body, "gui-session")).status).toBe(403);
    expect((await desktopPost(body, "admin-token")).status).toBe(200);
  });

  test("rejects extra fields, malformed JSON and over-1KiB streams without echoing input", async () => {
    expect((await desktopPost(JSON.stringify({ ...desktopPayload(), token: "sentinel" }), "admin-token")).status).toBe(400);
    expect((await desktopPost("{", "admin-token")).status).toBe(400);
    expect((await desktopPost("", "admin-token")).status).toBe(400);
    expect((await desktopPost(new Uint8Array([0xff]), "admin-token")).status).toBe(400);
    expect((await desktopPost(JSON.stringify(desktopPayload()), "admin-token", "text/plain")).status).toBe(400);
    const oversized = await desktopPost("x".repeat(1025), "admin-token");
    expect(oversized.status).toBe(413);
    expect(JSON.stringify(oversized.body)).not.toContain("x".repeat(32));
  });

  test("desktop GET isolates sessions and never reads the package badge for an absent session", async () => {
    expect((await desktopPost(JSON.stringify(desktopPayload()), "admin-token")).status).toBe(200);
    const seen = await call("GET", "/api/update/badge?surface=desktop&session=" + DESKTOP_A);
    expect(seen.body).toMatchObject({ installer: "desktop", updateAvailable: true, unknown: false });
    expect(seen.raw).not.toContain(DESKTOP_A);
    const other = await call("GET", "/api/update/badge?surface=desktop&session=" + DESKTOP_B);
    expect(other.body).toMatchObject({ installer: "desktop", updateAvailable: false, unknown: true });
    const missing = await call("GET", "/api/update/badge?surface=desktop");
    expect(missing.body).toMatchObject({ installer: "desktop", unknown: true });
    expect((await call("GET", "/api/update/badge")).body).not.toMatchObject({ installer: "desktop" });
    expect((await call("GET", "/api/update/badge?surface=typo")).status).toBe(400);
  });
});

describe("GET /api/github/star", () => {
  test("is routed and reports one of the three known states", async () => {
    const calls: string[][] = [];
    await withStarDeps({
      nowMs: () => 0,
      // An absent CLI is the deterministic equivalent of a runner where `gh`
      // cannot start. The route must still answer without spawning anything.
      async runGh(args) { calls.push(args); return null; },
    }, async () => {
      invalidateStarStatusCache();
      const { status, body } = await call("GET", "/api/github/star");
      expect(status).toBe(200);
      const star = body as Record<string, unknown>;
      expect(["starred", "not-starred", "unauthenticated"]).toContain(star.state);
      expect(star.repo).toBe("lidge-jun/opencodex");
      expect(star.url).toBe("https://github.com/lidge-jun/opencodex");
    });
    expect(calls).toEqual([["auth", "status", "--hostname", "github.com"]]);
  });

  test("never serializes gh output, tokens, or account identifiers", async () => {
    const calls: string[][] = [];
    await withStarDeps({
      nowMs: () => 0,
      // A non-zero status models a CLI whose credential helper has stalled or
      // failed, without executing that external helper in this route test.
      async runGh(args) { calls.push(args); return { status: 1 }; },
    }, async () => {
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
    expect(calls).toEqual([["auth", "status", "--hostname", "github.com"]]);
  });
});

describe("route surface", () => {
  test("an agent-driven POST is refused and told to ask the user", async () => {
    const calls: string[][] = [];
    await withEnv({ ...NO_AGENT_ENV, CODEX_THREAD_ID: "019fbc94" }, () => withStarDeps({
      nowMs: () => 0,
      async runGh(args) { calls.push(args); return { status: 0 }; },
    }, async () => {
      invalidateStarStatusCache();
      const { status, body } = await call("POST", "/api/github/star");
      expect(status).toBe(403);
      const refusal = body as Record<string, unknown>;
      expect(refusal.ok).toBe(false);
      expect(refusal.code).toBe("agent_consent_required");
      expect(String(refusal.message)).toContain("ask the user");
    }));
    // The decisive assertion: `gh` was never invoked, so no star was written with
    // the user's identity. A refusal that still spawned the write would be useless.
    expect(calls).toEqual([]);
  });

  test("a dashboard click still stars even when an agent started the proxy", async () => {
    const calls: string[][] = [];
    await withEnv({ ...NO_AGENT_ENV, CODEX_THREAD_ID: "019fbc94" }, () => withStarDeps({
      nowMs: () => 0,
      async runGh(args) { calls.push(args); return { status: 0 }; },
    }, async () => {
      invalidateStarStatusCache();
      // Browser-session evidence is the CREDENTIAL, not the headers: the auth gate
      // resolved a minted GUI session, which it only issues to a browser and only
      // accepts for a mutation after matching origin and the per-session CSRF token.
      const { status, body } = await call("POST", "/api/github/star", {
        origin: "http://127.0.0.1:10100",
        "x-opencodex-gui-origin": "http://127.0.0.1:10100",
        "x-opencodex-csrf-token": "csrf-token",
      }, "gui-session");
      expect(status).toBe(200);
      expect((body as Record<string, unknown>).ok).toBe(true);
    }));
    expect(calls.some(args => args.includes("PUT"))).toBe(true);
  });

  test("forged dashboard headers on an admin-token call cannot star", async () => {
    // The consent guard used to read the request's Origin/CSRF/GUI-origin headers and
    // trust them as proof of a browser click. The auth gate accepts a raw admin token
    // BEFORE it consults the session table, so an agent that can read that token — any
    // process running as the user — could send exactly these headers with arbitrary
    // values and star the repository with the user's identity.
    const calls: string[][] = [];
    await withEnv({ ...NO_AGENT_ENV, CODEX_THREAD_ID: "019fbc94" }, () => withStarDeps({
      nowMs: () => 0,
      async runGh(args) { calls.push(args); return { status: 0 }; },
    }, async () => {
      invalidateStarStatusCache();
      const { status, body } = await call("POST", "/api/github/star", {
        origin: "http://127.0.0.1:10100",
        "x-opencodex-gui-origin": "http://127.0.0.1:10100",
        "x-opencodex-csrf-token": "forged-by-the-token-holder",
      }, "admin-token");
      expect(status).toBe(403);
      expect((body as Record<string, unknown>).code).toBe("agent_consent_required");
    }));
    expect(calls).toEqual([]);
  });

  test("a GUI pairing capability is not a consent-bearing session principal", async () => {
    const calls: string[][] = [];
    await withStarDeps({
      nowMs: () => 0,
      async runGh(args) { calls.push(args); return { status: 0 }; },
    }, async () => {
      invalidateStarStatusCache();
      const { status, body } = await call("POST", "/api/github/star", {}, "gui-pair-capability");
      expect(status).toBe(403);
      expect((body as Record<string, unknown>).code).toBe("agent_consent_required");
    });
    expect(calls).toEqual([]);
  });

  test("a direct dispatch with no resolved principal is treated as untrusted", async () => {
    // Defense in depth for callers that bypass the HTTP gate (route-level tests, future
    // internal dispatchers): an unknown principal must never satisfy the consent check.
    const calls: string[][] = [];
    await withEnv({ ...NO_AGENT_ENV, CODEX_THREAD_ID: "019fbc94" }, () => withStarDeps({
      nowMs: () => 0,
      async runGh(args) { calls.push(args); return { status: 0 }; },
    }, async () => {
      invalidateStarStatusCache();
      const { status } = await call("POST", "/api/github/star", {
        origin: "http://127.0.0.1:10100",
        "x-opencodex-gui-origin": "http://127.0.0.1:10100",
        "x-opencodex-csrf-token": "csrf-token",
      });
      expect(status).toBe(403);
    }));
    expect(calls).toEqual([]);
  });

  test("a clean-environment server still refuses a raw-token star", async () => {
    // The guard used to fire only when isAgentDriven() was true — but that reads
    // the SERVER's environment, not the caller's. A proxy running as a service has
    // no agent markers, so this exact request (raw admin token, no dashboard
    // session) starred the repository for anyone who could read the token, which
    // is every agent on the machine. Caller provenance is not knowable here; the
    // credential is, so the dashboard session is required unconditionally.
    const calls: string[][] = [];
    await withEnv(NO_AGENT_ENV, () => withStarDeps({
      nowMs: () => 0,
      async runGh(args) { calls.push(args); return { status: 0 }; },
    }, async () => {
      invalidateStarStatusCache();
      const { status, body } = await call("POST", "/api/github/star", {}, "admin-token");
      expect(status).toBe(403);
      expect((body as Record<string, unknown>).code).toBe("agent_consent_required");
    }));
    expect(calls).toEqual([]);
  });

  test("a dashboard click on a clean-environment server still stars", async () => {
    const calls: string[][] = [];
    await withEnv(NO_AGENT_ENV, () => withStarDeps({
      nowMs: () => 0,
      async runGh(args) { calls.push(args); return { status: 0 }; },
    }, async () => {
      invalidateStarStatusCache();
      const { status } = await call("POST", "/api/github/star", {}, "gui-session");
      expect(status).toBe(200);
    }));
    expect(calls.some(args => args.includes("PUT"))).toBe(true);
  });

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
