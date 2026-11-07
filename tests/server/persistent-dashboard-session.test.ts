import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeManagementAuthState, createManagementSessionControl, issueGuiSession, requireManagementAuth } from "../../src/server/management-auth";
import { handleSessionRoutes } from "../../src/server/management/session-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { remoteConfig } from "../helpers/management-auth-fixture";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let previousToken: string | undefined;
const config = remoteConfig();
const origin = "https://dashboard.example.test";
function request(path = "/api/session/remember", cookie?: string, overrides: HeadersInit = {}, method = "POST") {
  return new Request(origin + path, { method, headers: { Host: "dashboard.example.test", Origin: origin,
    "User-Agent": "Safari-PWA-fixture", "X-OpenCodex-API-Key": "ocx_admin_fixture", ...(cookie ? { Cookie: cookie } : {}), ...overrides } });
}
function login() {
  const state = initializeManagementAuthState(config);
  const req = request();
  const response = handleSessionRoutes({ req, url: new URL(req.url), config, principal: "admin-token",
    sessionControl: createManagementSessionControl(state) } as ManagementContext);
  return { state, response };
}
beforeEach(() => { home = createTempHome("ocx-persistent-dashboard-"); previousToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN; process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx_admin_fixture"; });
// Assigning undefined to process.env stores the literal string "undefined" and poisons later
// tests in this process; absence is restored by deleting the key (the fixture restores homes).
afterEach(() => { if (previousToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousToken; home.remove(); });

test("remember exchanges the admin token for a device cookie and a server-issued session", async () => {
  const { response } = login();
  expect(response?.status).toBe(200);
  const cookie = response!.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Strict"); expect(cookie).toContain("Path=/"); expect(cookie).not.toContain("Domain="); expect(cookie).not.toContain("ocx_admin_fixture");
  const body = await response!.json();
  expect(body.session.token).toStartWith("ocx_session_");
  expect(body.session.issuance).toBe("remembered-admin");
  expect(body.device.proof).toMatch(/^ocx_proof_[A-Za-z0-9_-]{43}$/);
  expect(response!.headers.get("Cache-Control")).toBe("no-store");
  expect(cookie).not.toContain(body.device.proof);
  const disk = readFileSync(join(home.root, "dashboard-sessions.json"), "utf8");
  expect(disk).not.toContain(body.device.proof);
  expect(Object.keys(JSON.parse(disk)[0]).sort()).toEqual(["credential", "digest", "expiresAt", "proof", "serverOrigin", "userAgent"]);
  expect(disk).not.toContain("ocx_admin_fixture");
  expect(disk).not.toContain(cookie.split(";")[0]!.split("=")[1]!);
});

test("a device resumes after a server restart, but not on another origin or browser", async () => {
  const { response } = login(); expect(response?.status).toBe(200);
  const cookie = response!.headers.get("set-cookie")!.split(";")[0]!;
  const proof = (await response!.json()).device.proof;
  const restarted = initializeManagementAuthState(config);
  const resumed = issueGuiSession(request("/opencodex-session", cookie, { "X-OpenCodex-Device-Proof": proof }, "GET"), config, restarted);
  expect(resumed?.token).toStartWith("ocx_session_");
  // Valid cookie and proof: only the browser identity differs, so the User-Agent binding is what refuses.
  expect(issueGuiSession(request("/opencodex-session", cookie, { "X-OpenCodex-Device-Proof": proof, "User-Agent": "another-device" }, "GET"), config, restarted)).toBeNull();
  expect(issueGuiSession(request("/opencodex-session", cookie, { "X-OpenCodex-Device-Proof": proof }, "GET"), config, restarted)?.issuance).toBe("remembered-admin");
  const other = new Request("https://other.example.test/opencodex-session", { headers: { Host: "other.example.test", Cookie: cookie, "User-Agent": "Safari-PWA-fixture", "X-OpenCodex-Device-Proof": proof } });
  expect(issueGuiSession(other, config, restarted)).toBeNull();
});

test("expiry is absolute and rotating the admin token invalidates persistent devices", async () => {
  const { response } = login(); expect(response?.status).toBe(200);
  const cookie = response!.headers.get("set-cookie")!.split(";")[0]!;
  const proof = (await response!.json()).device.proof;
  const req = request("/", cookie, { "X-OpenCodex-Device-Proof": proof }, "GET");
  expect(issueGuiSession(req, config, initializeManagementAuthState(config), { trustedTailscaleIngress: false, now: Date.now() + 31 * 86400_000 })).toBeNull();
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx_admin_rotated";
  expect(issueGuiSession(req, config, initializeManagementAuthState(config))).toBeNull();
});

test("logout durably forgets this device and revokes all resumed sessions", async () => {
  const { state, response } = login(); expect(response?.status).toBe(200);
  const cookie = response!.headers.get("set-cookie")!.split(";")[0]!;
  const body = await response!.json();
  const resumed = issueGuiSession(request("/", cookie, { "X-OpenCodex-Device-Proof": body.device.proof }, "GET"), config, state)!;
  const session = body.session;
  const req = request("/api/session/logout", cookie, { "X-OpenCodex-API-Key": session.token, "X-OpenCodex-GUI-Origin": origin, "X-OpenCodex-CSRF-Token": session.csrfToken });
  const result = handleSessionRoutes({ req, url: new URL(req.url), config, principal: "gui-session", sessionControl: createManagementSessionControl(state) } as ManagementContext);
  expect(result?.status).toBe(200); expect(result!.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(issueGuiSession(request("/", cookie, {}, "GET"), config, initializeManagementAuthState(config))).toBeNull();
  const replay = request("/api/config", cookie, { "X-OpenCodex-API-Key": resumed.token, "X-OpenCodex-GUI-Origin": origin }, "GET");
  expect(requireManagementAuth(replay, state, config)?.status).toBe(401);
});

test("logout still removes the record after a browser User-Agent change", async () => {
  const { state, response } = login(); expect(response?.status).toBe(200);
  const cookie = response!.headers.get("set-cookie")!.split(";")[0]!;
  const session = (await response!.json()).session;
  const req = request("/api/session/logout", cookie, { "User-Agent": "Safari-PWA-upgraded",
    "X-OpenCodex-API-Key": session.token, "X-OpenCodex-GUI-Origin": origin, "X-OpenCodex-CSRF-Token": session.csrfToken });
  const result = handleSessionRoutes({ req, url: new URL(req.url), config, principal: "gui-session", sessionControl: createManagementSessionControl(state) } as ManagementContext);
  expect(result?.status).toBe(200);
  expect(JSON.parse(readFileSync(join(home.root, "dashboard-sessions.json"), "utf8"))).toEqual([]);
  expect(issueGuiSession(request("/", cookie, {}, "GET"), config, initializeManagementAuthState(config))).toBeNull();
});

test("the surrounding test process keeps its environment after each round", () => {
  // The fixture's beforeEach/afterEach pair runs around this test too, so a passing
  // round here exercises restoration rather than asserting the helpers in isolation.
  expect(existsSync(join(home.root, "dashboard-sessions.json"))).toBe(false);
});

test("remember rejects cross-origin, plaintext remote and unauthenticated issuance", () => {
  const state = initializeManagementAuthState(config); const control = createManagementSessionControl(state);
  for (const req of [request(undefined, undefined, { Origin: "https://attacker.test" }), new Request("http://dashboard.example.test/api/session/remember", { method: "POST", headers: { Host: "dashboard.example.test", Origin: "http://dashboard.example.test" } })]) {
    const result = handleSessionRoutes({ req, url: new URL(req.url), config, principal: "admin-token", sessionControl: control } as ManagementContext);
    expect(result?.status).toBe(403);
  }
  const req = request(); expect(handleSessionRoutes({ req, url: new URL(req.url), config, principal: "gui-session", sessionControl: control } as ManagementContext)?.status).toBe(403);
});

test("the persistent cookie alone grants no management access, and a derived token needs its cookie", async () => {
  const { state, response } = login(); expect(response?.status).toBe(200);
  const cookie = response!.headers.get("set-cookie")!.split(";")[0]!;
  const session = (await response!.json()).session;
  const cookieOnly = request("/api/config", cookie, {}, "GET"); cookieOnly.headers.delete("X-OpenCodex-API-Key");
  expect(requireManagementAuth(cookieOnly, state, config)?.status).toBe(401);
  const tokenOnly = request("/api/config", undefined, { "X-OpenCodex-API-Key": session.token, "X-OpenCodex-GUI-Origin": origin }, "GET");
  expect(requireManagementAuth(tokenOnly, state, config)?.status).toBe(401);
  const both = request("/api/config", cookie, { "X-OpenCodex-API-Key": session.token, "X-OpenCodex-GUI-Origin": origin }, "GET");
  const control = createManagementSessionControl(state);
  expect(requireManagementAuth(both, state, config)).toBeNull();
  expect(control.isPaired(both, config)).toBe(false); expect(control.canRevealDataKeys?.(both, config)).toBe(false);
});

test("an unreadable or malformed device store fails closed without issuing a cookie or overwriting it", () => {
  writeFileSync(join(home.root, "dashboard-sessions.json"), "not-json", { mode: 0o600 });
  const { response } = login(); expect(response?.status).toBe(503);
  expect(response!.headers.get("set-cookie")).toBeNull();
  expect(readFileSync(join(home.root, "dashboard-sessions.json"), "utf8")).toBe("not-json");
});
