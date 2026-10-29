import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { remoteConfig, hubConfig } from "../helpers/management-auth-fixture";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import {
  createManagementSessionControl, initializeManagementAuthState, issueGuiSession,
  managementPrincipal, managementSessionIssuance, requireManagementAuth,
} from "../../src/server/management-auth";
import { consumeGuiPairingGrant, createGuiPairingGrant } from "../../src/server/gui-session";
import { markTrustedHubManagementRequest } from "../../src/server/auth-cors";
import { serveGuiFile, serveSessionBootstrap } from "../../src/server/gui-static";
import * as atomic from "../../src/config/atomic-write";
import * as accountList from "../../src/codex/auth-api/account-list";
import { invalidateStarStatusCache, setStarDepsForTests } from "../../src/github/star-state";
import type { OcxConfig } from "../../src/types";
import { startMachineListener } from "../../src/client/machine-listener";
import { createDesktopCompatibilityRuntime } from "../../src/codex/desktop-compatibility/runtime";

const ORIGIN = "https://dashboard.example.test";
const ADMIN = "ocx_admin_admission_fixture";
const PROOF_HEADER = "X-OpenCodex-Device-Proof";
let home: TempHome;
let config: OcxConfig;
let state: ReturnType<typeof initializeManagementAuthState>;
let previousToken: string | undefined;
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  home = createTempHome("ocx-dashboard-admission-");
  previousToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN;
  config = remoteConfig();
  state = initializeManagementAuthState(config);
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  setStarDepsForTests(null); invalidateStarStatusCache();
  if (previousToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousToken;
  home.remove();
});
function request(path: string, options: { origin?: string; method?: string; headers?: HeadersInit; body?: object; token?: string | null } = {}) {
  const origin = options.origin ?? ORIGIN;
  const headers = new Headers({ Host: new URL(origin).host, Origin: origin, "User-Agent": "dashboard-admission-fixture" });
  if (options.token !== null) headers.set("X-OpenCodex-API-Key", options.token ?? ADMIN);
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  return new Request(origin + path, { method: options.method ?? "POST", headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
}
async function dispatch(req: Request, deps: ManagementApiDeps = {}, trustedLoopback = false) {
  const denial = requireManagementAuth(req, state, config);
  if (denial) return denial;
  return (await handleManagementAPI(req, new URL(req.url), config, deps,
    managementPrincipal(req, state, config)!, createManagementSessionControl(state), {
      trustedLoopback, guiSessionIssuance: managementSessionIssuance(req, state),
    }))!;
}
async function remember(origin = ORIGIN) {
  const response = await dispatch(request("/api/session/remember", { origin }));
  expect(response.status).toBe(200);
  const body = await response.json();
  return { response, body, cookie: response.headers.get("Set-Cookie")!.split(";")[0]!, origin };
}
type Device = Awaited<ReturnType<typeof remember>>;
function deviceRequest(device: Device, path: string, options: { body?: object; csrf?: boolean; method?: string } = {}) {
  return request(path, { origin: device.origin, token: device.body.session.token, method: options.method,
    body: options.body, headers: { Cookie: device.cookie, "X-OpenCodex-GUI-Origin": device.origin,
      ...(options.csrf === false ? {} : { "X-OpenCodex-CSRF-Token": device.body.session.csrfToken }) } });
}
function resume(device: Device, proof: string | null = device.body.device.proof, path = "/opencodex-session", extra: HeadersInit = {}) {
  return issueGuiSession(request(path, { origin: device.origin, token: null, method: "GET",
    headers: { Cookie: device.cookie, ...(proof === null ? {} : { [PROOF_HEADER]: proof }), ...extra } }), config, state);
}

test("real remember admission requires admin, exact Origin, HTTPS or loopback", async () => {
  expect((await dispatch(request("/api/session/remember", { token: null }))).status).toBe(401);
  const missingOrigin = request("/api/session/remember"); missingOrigin.headers.delete("Origin");
  expect((await dispatch(missingOrigin)).status).toBe(403);
  for (const headers of [{ Origin: "https://other.test" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }]) {
    expect((await dispatch(request("/api/session/remember", { headers }))).status).toBe(403);
  }
  expect((await dispatch(request("/api/session/remember", { origin: "http://dashboard.example.test" }))).status).toBe(403);
  const device = await remember();
  expect((await dispatch(deviceRequest(device, "/api/session/remember"))).status).toBe(403);
  expect((await remember("http://127.0.0.1:10100")).body.session.issuance).toBe("remembered-admin");
});

test("forwarded headers cannot upgrade plaintext or change the origin binding", async () => {
  const headers = { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "dashboard.example.test", "X-Forwarded-For": "127.0.0.1" };
  expect((await dispatch(request("/api/session/remember", { origin: "http://dashboard.example.test", headers }))).status).toBe(403);
  const req = request("/api/session/remember", { headers: { ...headers, Host: "other.example.test" } });
  expect((await dispatch(req)).status).toBe(403);
  const device = await remember();
  expect(resume(device, device.body.device.proof, "/opencodex-session", headers)?.issuance).toBe("remembered-admin");
});

function hubListenerRequest(path: string, method: string, headers: HeadersInit, token: string | null = ADMIN) {
  // The dedicated hub management listener receives plain HTTP from a local TLS terminator.
  const req = new Request("http://127.0.0.1:4100" + path, { method, headers: {
    Host: "hub.example.test", Origin: "https://hub.example.test", "User-Agent": "dashboard-admission-fixture",
    ...(token === null ? {} : { "X-OpenCodex-API-Key": token }), ...Object.fromEntries(new Headers(headers)) } });
  markTrustedHubManagementRequest(req);
  return req;
}

test("the process-marked hub management listener can remember; unmarked and relayed planes cannot", async () => {
  config = hubConfig(); state = initializeManagementAuthState(config);
  const response = await dispatch(hubListenerRequest("/api/session/remember", "POST", {}));
  expect(response.status).toBe(200);
  const body = await response.json() as { device: { proof: string } };
  const cookie = response.headers.get("Set-Cookie")!;
  expect(cookie.startsWith("__Host-")).toBe(true);
  expect(cookie).toContain("Secure");
  const resumed = issueGuiSession(hubListenerRequest("/opencodex-session", "GET",
    { Cookie: cookie.split(";")[0]!, [PROOF_HEADER]: body.device.proof }, null), config, state);
  expect(resumed?.issuance).toBe("remembered-admin");
  const withoutProof = issueGuiSession(hubListenerRequest("/opencodex-session", "GET", { Cookie: cookie.split(";")[0]! }, null), config, state);
  expect(withoutProof?.issuance).not.toBe("remembered-admin");
  // Forwarded headers cannot manufacture the listener mark: an unmarked plain-HTTP request claiming TLS is refused.
  const forged = new Request("http://hub.example.test/api/session/remember", { method: "POST", headers: {
    Host: "hub.example.test", Origin: "https://hub.example.test", "User-Agent": "dashboard-admission-fixture",
    "X-OpenCodex-API-Key": ADMIN, "X-Forwarded-Proto": "https", "X-Forwarded-Host": "hub.example.test" } });
  expect((await dispatch(forged)).status).toBe(403);
  config = remoteConfig(); state = initializeManagementAuthState(config);
  const relayed = request("/api/session/remember"); markTrustedHubManagementRequest(relayed);
  expect((await dispatch(relayed)).status).toBe(403);
});

test("all issueGuiSession bootstrap shapes require proof before remembered issuance", async () => {
  const device = await remember(); state = initializeManagementAuthState(config);
  for (const path of ["/opencodex-session", "/", "/settings"]) {
    expect(resume(device, null, path)?.issuance).not.toBe("remembered-admin");
    expect(resume(device, "ocx_proof_" + "x".repeat(43), path)?.issuance).not.toBe("remembered-admin");
    expect(resume(device, device.body.device.proof, path)?.issuance).toBe("remembered-admin");
  }
  config.hostname = "127.0.0.1";
  const loopback = await remember("http://127.0.0.1:10100");
  expect(resume(loopback, null)?.issuance).toBe("loopback");
  expect(resume(loopback)?.issuance).toBe("remembered-admin");
  expect(resume(device, device.body.device.proof, "/", { Origin: "https://other.test" })).toBeNull();
  expect(issueGuiSession(request("/opencodex-session", { origin: ORIGIN + ":444", method: "GET", token: null,
    headers: { Cookie: device.cookie, [PROOF_HEADER]: device.body.device.proof } }), config, state)).toBeNull();
  expect(resume(device, device.body.device.proof, "/", { Cookie: device.cookie + "; " + device.cookie })).toBeNull();
});

test("the live machine listener checks proof on fetch bootstrap and navigation", async () => {
  writeFileSync(home.path("config.json"), JSON.stringify(config));
  const oldDist = process.env.OPENCODEX_GUI_DIST;
  mkdirSync(home.path("machine-gui"));
  writeFileSync(home.path("machine-gui", "index.html"), "<html><head></head><body></body></html>");
  process.env.OPENCODEX_GUI_DIST = home.path("machine-gui");
  const listener = startMachineListener(0, { managementAuthState: state, state: {
    serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test", managementTransport: "direct",
    selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "fixture-client",
    tokenFingerprint: "a".repeat(64), protocolVersion: 1, connectedAt: "2026-10-18T00:00:00Z",
    catalogSyncedAt: "2026-10-18T00:00:00Z",
  } });
  try {
    const origin = `http://127.0.0.1:${listener.port}`;
    const device = await remember(origin);
    for (const path of ["/opencodex-session", "/"]) {
      for (const proof of [null, "ocx_proof_" + "x".repeat(43), device.body.device.proof]) {
        const response = await fetch(origin + path, { headers: { Cookie: device.cookie,
          "User-Agent": "dashboard-admission-fixture", ...(proof === null ? {} : { [PROOF_HEADER]: proof }) } });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).not.toContain(device.body.device.proof);
        const token = /name="opencodex-session-token" content="([^"]+)"/.exec(html)?.[1];
        expect(token).toBeDefined();
        expect(state.available && state.sessions.get(token!)?.issuance).toBe(proof === device.body.device.proof ? "remembered-admin" : "loopback");
      }
    }
  } finally {
    await listener.stop(true);
    if (oldDist === undefined) delete process.env.OPENCODEX_GUI_DIST;
    else process.env.OPENCODEX_GUI_DIST = oldDist;
  }
});

test("proof stays out of cookies, bootstrap HTML, URLs, disk plaintext and logs", async () => {
  const logs: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(spyOn(console, level).mockImplementation((...args) => { logs.push(args.map(String).join(" ")); }));
  }
  const device = await remember(); const proof = device.body.device.proof;
  expect(proof).toMatch(/^ocx_proof_[A-Za-z0-9_-]{43}$/);
  expect(device.response.headers.get("Cache-Control")).toBe("no-store");
  expect(device.response.headers.get("Set-Cookie")).not.toContain(proof);
  const record = JSON.parse(readFileSync(home.path("dashboard-sessions.json"), "utf8"))[0];
  expect(Object.keys(record).sort()).toEqual(["credential", "digest", "expiresAt", "proof", "serverOrigin", "userAgent"]);
  expect(record.proof).toBe(createHash("sha256").update(proof).digest("hex"));
  expect(JSON.stringify(record)).not.toContain(proof);
  const bootstrap = resume(device)!;
  expect(await serveSessionBootstrap(bootstrap).text()).not.toContain(proof);
  const dist = home.path("gui"); mkdirSync(dist); writeFileSync(home.path("gui", "index.html"), "<html><head></head><body></body></html>");
  for (const path of ["/", "/settings"]) {
    const navigation = resume(device, null, path);
    const html = await serveGuiFile(path, dist, navigation ?? undefined)!.text();
    expect(html).not.toContain(proof); expect(html).not.toContain(device.body.session.token);
  }
  expect(deviceRequest(device, "/api/config").url).not.toContain(proof);
  expect(logs.join("\n")).not.toContain(proof);
});

test("logout needs CSRF; successful forget survives a new auth state reading disk", async () => {
  const device = await remember();
  expect((await dispatch(deviceRequest(device, "/api/session/logout", { csrf: false }))).status).toBe(401);
  expect(resume(device)?.issuance).toBe("remembered-admin");
  const response = await dispatch(deviceRequest(device, "/api/session/logout"));
  expect(response.status).toBe(200); expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(JSON.parse(readFileSync(home.path("dashboard-sessions.json"), "utf8"))).toEqual([]);
  state = initializeManagementAuthState(config); expect(resume(device)).toBeNull();
});

test.each(["enrolled", "resumed"])("UA-drifted %s session admits only authenticated durable logout", async source => {
  const device = await remember();
  const sibling = resume(device)!;
  if (source === "resumed") device.body.session = resume(device)!;
  const drifted = (path = "/api/session/logout", method = "POST") => {
    const req = deviceRequest(device, path, { method });
    req.headers.set("User-Agent", "dashboard-admission-upgraded");
    return req;
  };
  const stored = readFileSync(home.path("dashboard-sessions.json"), "utf8");
  expect(resume(device, device.body.device.proof, "/", { "User-Agent": "dashboard-admission-upgraded" })).toBeNull();
  for (const [path, method] of [["/api/config", "GET"], ["/api/session/logout", "GET"],
    ["/api/session/remember", "POST"], ["/api/session/logout/extra", "POST"]]) {
    expect((await dispatch(drifted(path, method))).status).toBe(401);
  }
  for (const header of ["Origin", "X-OpenCodex-CSRF-Token", "Cookie", "X-OpenCodex-API-Key", "X-OpenCodex-GUI-Origin"]) {
    for (const value of [null, "invalid"]) {
      const req = drifted();
      if (value === null) req.headers.delete(header); else req.headers.set(header, value);
      expect((await dispatch(req)).status).toBe(401);
      expect(readFileSync(home.path("dashboard-sessions.json"), "utf8")).toBe(stored);
    }
  }
  const wrongServer = drifted(); wrongServer.headers.set("Host", "other.example.test");
  expect((await dispatch(wrongServer)).status).toBe(401);
  // Credential binding is checked on disk even while the derived session remains in memory.
  const rows = JSON.parse(stored);
  writeFileSync(home.path("dashboard-sessions.json"), JSON.stringify([{ ...rows[0], credential: "0".repeat(64) }]));
  expect((await dispatch(drifted())).status).toBe(401);
  writeFileSync(home.path("dashboard-sessions.json"), stored);
  expect((await dispatch(deviceRequest(device, "/api/config", { method: "GET" }))).status).toBe(200);
  const response = await dispatch(drifted());
  expect(response.status).toBe(200);
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(JSON.parse(readFileSync(home.path("dashboard-sessions.json"), "utf8"))).toEqual([]);
  for (const session of [device.body.session, sibling]) {
    const replay = deviceRequest({ ...device, body: { ...device.body, session } }, "/api/config", { method: "GET" });
    expect((await dispatch(replay)).status).toBe(401);
  }
  expect(resume(device)).toBeNull();
  state = initializeManagementAuthState(config);
  expect(JSON.parse(readFileSync(home.path("dashboard-sessions.json"), "utf8"))).toEqual([]);
  expect(resume(device)).toBeNull();
});

test("failed durable forget keeps disk records and all derived sessions for retry", async () => {
  const device = await remember(); const recovered = resume(device)!;
  const before = readFileSync(home.path("dashboard-sessions.json"), "utf8");
  const writer = spyOn(atomic, "atomicWriteFileNoFollowStreamed").mockImplementation(() => { throw new Error("fixture persistence failure"); });
  try {
    expect((await dispatch(deviceRequest(device, "/api/session/logout"))).status).toBe(503);
    expect(readFileSync(home.path("dashboard-sessions.json"), "utf8")).toBe(before);
    expect(state.available && state.sessions.has(recovered.token)).toBe(true);
    expect((await dispatch(deviceRequest(device, "/api/config", { method: "GET" }))).status).toBe(200);
  } finally { writer.mockRestore(); }
  expect((await dispatch(deviceRequest(device, "/api/session/logout"))).status).toBe(200);
});

test("admin-token rotation invalidates a stored cookie and proof", async () => {
  const device = await remember(); process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx_admin_rotated_fixture";
  state = initializeManagementAuthState(config); expect(resume(device)).toBeNull();
});

test("malformed schema is preserved byte-for-byte and Remember returns 503", async () => {
  await remember();
  const record = JSON.parse(readFileSync(home.path("dashboard-sessions.json"), "utf8"))[0];
  const { proof: _proof, ...legacy } = record;
  const malformed = ["not-json\n", "{}", '[{"digest":"bad"}]', JSON.stringify([legacy]),
    ...[null, "x".repeat(64), "A".repeat(64), "a".repeat(63)].map(proof => JSON.stringify([{ ...record, proof }])),
    JSON.stringify([{ ...record, extra: true }])];
  for (const bytes of malformed) {
    writeFileSync(home.path("dashboard-sessions.json"), bytes);
    expect((await dispatch(request("/api/session/remember"))).status).toBe(503);
    expect(readFileSync(home.path("dashboard-sessions.json"), "utf8")).toBe(bytes);
  }
});

test.skipIf(process.platform === "win32")("symlinked store is refused without changing its target", async () => {
  const bytes = "[]"; writeFileSync(home.path("other.json"), bytes);
  symlinkSync(home.path("other.json"), home.path("dashboard-sessions.json"));
  expect((await dispatch(request("/api/session/remember"))).status).toBe(503);
  expect(readFileSync(home.path("other.json"), "utf8")).toBe(bytes);
});
test.skipIf(process.platform === "win32")("hardlinked store is refused without changing either entry", async () => {
  writeFileSync(home.path("other.json"), "[]"); linkSync(home.path("other.json"), home.path("dashboard-sessions.json"));
  expect((await dispatch(request("/api/session/remember"))).status).toBe(503);
  expect(readFileSync(home.path("other.json"), "utf8")).toBe("[]");
});
test.skipIf(process.platform === "win32")("oversized store is preserved", async () => {
  const bytes = " ".repeat(128 * 1024 + 1); writeFileSync(home.path("dashboard-sessions.json"), bytes);
  expect((await dispatch(request("/api/session/remember"))).status).toBe(503);
  expect(readFileSync(home.path("dashboard-sessions.json"), "utf8")).toBe(bytes);
});

test("the 128-record limit refuses an additional device without overwriting the store", async () => {
  await remember(); const record = JSON.parse(readFileSync(home.path("dashboard-sessions.json"), "utf8"))[0];
  const rows = Array.from({ length: 128 }, (_, i) => ({ ...record, digest: createHash("sha256").update(String(i)).digest("hex") }));
  const bytes = JSON.stringify(rows); writeFileSync(home.path("dashboard-sessions.json"), bytes);
  expect((await dispatch(request("/api/session/remember"))).status).toBe(503);
  expect(readFileSync(home.path("dashboard-sessions.json"), "utf8")).toBe(bytes);
});

const guarded = [
  ["/api/github/star", {}, "agent_consent_required"],
  ["/api/anthropic/reset-grants/consume", {}, "session_required"],
  ["/api/codex-prompt/repair", {}, "dashboard_session_required"],
  ["/api/oauth/login", { provider: "meta-muse" }, "oauth_consent_required"],
  ["/api/codex/desktop-compatibility/certificate", { action: "prepare", confirmed: true }, "local_dashboard_confirmation_required"],
  ["/api/codex/desktop-compatibility/runtime", { action: "observe", confirmed: true }, "local_dashboard_confirmation_required"],
  ["/api/codex/desktop-compatibility/settings", { startOnProxyStart: false, revision: "a".repeat(64), confirmed: true }, "local_dashboard_confirmation_required"],
] as const;
test("remembered admission reaches and refuses all seven consent routes even with trusted loopback ingress", async () => {
  const device = await remember("http://127.0.0.1:10100");
  for (const [path, body, code] of guarded) {
    const response = await dispatch(deviceRequest(device, path, { body }), {}, true);
    expect(response.status).toBe(403);
    const result = await response.json(); expect(result.code ?? result.error?.code ?? result.error).toBe(code);
  }
  for (const path of ["/api/oauth/login/code"]) {
    const response = await dispatch(deviceRequest(device, path, { body: { provider: "meta-muse" } }), {}, true);
    expect(response.status).toBe(403); expect((await response.json()).code).toBe("oauth_consent_required");
  }
});

test("ordinary loopback sessions reach the sidebar and paired sessions reach desktop services", async () => {
  config.hostname = "127.0.0.1"; config.port = 10100;
  const origin = "http://127.0.0.1:10100";
  const session = issueGuiSession(request("/", { origin, method: "GET", token: null }), config, state)!;
  expect(session.issuance).toBe("loopback");
  const loopback = { origin, cookie: "", body: { session } } as Device;
  let stars = 0;
  setStarDepsForTests({ runGh: async () => { stars++; return { status: 0 }; }, nowMs: () => Date.now() });
  const star = await dispatch(deviceRequest(loopback, "/api/github/star"));
  expect(star.status).toBe(200); expect(stars).toBeGreaterThan(0);
  const calls: string[] = [];
  const status = { supported: true, state: "prepared" as const, busy: null };
  const deps: ManagementApiDeps = { desktopCertificateService: {
    status: async () => status, prepare: async () => { calls.push("prepare"); return status; },
    trust: async () => status, removeTrust: async () => status, renew: async () => status,
  } };
  // Desktop compatibility mutations additionally require a paired session.
  expect((await dispatch(deviceRequest(loopback, guarded[4][0], { body: guarded[4][1] }), deps, true)).status).toBe(403);
  expect(calls).toEqual([]);
  const grant = createGuiPairingGrant(origin, config, state);
  const paired = consumeGuiPairingGrant(request("/opencodex-session", { origin, method: "POST", token: null }), { grant: grant.grant },
    config, state, Date.now(), { ingress: "public", peerAddress: "127.0.0.1", tailscaleUser: null, browserOrigin: origin });
  expect(paired && "token" in paired).toBe(true);
  const device = { origin, cookie: "", body: { session: paired } } as Device;
  expect((await dispatch(deviceRequest(device, guarded[4][0], { body: guarded[4][1] }), deps, true)).status).toBe(200);
  expect(calls).toEqual(["prepare"]);
  const runtime = createDesktopCompatibilityRuntime({ platform: "linux" });
  runtime.observe = async () => { calls.push("observe"); return runtime.status(); };
  deps.desktopCompatibilityRuntime = runtime;
  deps.desktopStartupSettings = {
    status: () => ({ startOnProxyStart: false, revision: "a".repeat(64) }),
    set: (value, revision) => { calls.push("settings"); return { startOnProxyStart: value, revision }; },
  };
  for (const index of [5, 6] as const) {
    expect((await dispatch(deviceRequest(device, guarded[index][0], { body: guarded[index][1] }), deps, true)).status).toBe(200);
  }
  expect(calls).toEqual(["prepare", "observe", "settings"]);
});

test("account refresh validates pending accounts only for ordinary dashboard sessions", async () => {
  const validations: unknown[] = [];
  spies.push(spyOn(accountList, "listCodexAuthAccounts").mockImplementation(async (_config, _refresh, options) => {
    validations.push(options?.validatePending); return [];
  }));
  const device = await remember("http://127.0.0.1:10100");
  expect((await dispatch(deviceRequest(device, "/api/codex-auth/accounts/refresh"))).status).toBe(200);
  expect((await dispatch(request("/api/codex-auth/accounts/refresh"))).status).toBe(200);
  config.hostname = "127.0.0.1";
  const session = issueGuiSession(request("/", { origin: device.origin, method: "GET", token: null }), config, state)!;
  expect((await dispatch(deviceRequest({ ...device, cookie: "", body: { session } }, "/api/codex-auth/accounts/refresh"))).status).toBe(200);
  expect(validations).toEqual([false, false, true]);
});

test("remembered sessions cannot pair, reveal data keys, or authorize local links", async () => {
  const device = await remember("http://127.0.0.1:10100");
  const req = deviceRequest(device, "/api/keys/reveal", { body: { id: "fixture" } });
  const control = createManagementSessionControl(state);
  expect(control.isPaired(req, config)).toBe(false); expect(control.canRevealDataKeys?.(req, config)).toBe(false);
  expect((await dispatch(req)).status).toBe(403);
  const link = await dispatch(deviceRequest(device, "/api/link/join", { body: {} }), {}, true);
  expect(link.status).toBe(403);
});
