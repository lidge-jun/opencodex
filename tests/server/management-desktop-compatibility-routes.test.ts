import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { handleDesktopCompatibilityRoutes } from "../../src/server/management/desktop-compatibility-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { DesktopCertificateService } from "../../src/codex/desktop-compatibility/certificate-service";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { createManagementSessionControl, requireManagementAuth, managementPrincipal, managementSessionIssuance,
  type ManagementAuthState } from "../../src/server/management-auth";
import { consumeGuiPairingGrant, createGuiPairingGrant, issueGuiSession, type GuiSessionBootstrap } from "../../src/server/gui-session";

const url = new URL("http://127.0.0.1:10100/api/codex/desktop-compatibility/certificate");
const pairedSession = { isPaired: () => true } as NonNullable<ManagementContext["sessionControl"]>;
function fixture(method: string, body?: object, principal: ManagementContext["principal"] = "gui-session", loopback = true) {
  const calls: string[] = [];
  const status = { supported: true, state: "prepared" as const, busy: null };
  const service: DesktopCertificateService = { status: async () => { calls.push("status"); return status; },
    prepare: async () => { calls.push("prepare"); return status; }, trust: async fp => { calls.push("trust:" + fp); return status; },
    removeTrust: async fp => { calls.push("remove:" + fp); return status; }, renew: async fp => { calls.push("renew:" + fp); return status; } };
  const ctx = { req: new Request(url, { method, headers: { host: url.host, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }),
    url, config: { providers: {}, port: 10100, hostname: "127.0.0.1" }, principal, trustedLoopbackIngress: loopback,
    sessionControl: { canMutateLocalDesktop: () => true }, deps: { desktopCertificateService: service } } as ManagementContext;
  return { calls, ctx };
}
test("status reads do not invoke setup or OS trust", async () => {
  const io = fixture("GET", undefined, "admin-token"); expect((await handleDesktopCompatibilityRoutes(io.ctx))?.status).toBe(200);
  expect(io.calls).toEqual(["status"]);
});
test("only authenticated local dashboard mutations reach the service", async () => {
  for (const [principal, loopback] of [["admin-token", true], ["gui-session", false], [undefined, true]] as const) {
    const io = fixture("POST", { action: "prepare", confirmed: true }, principal, loopback);
    if (principal === undefined) io.ctx.principal = undefined;
    expect((await handleDesktopCompatibilityRoutes(io.ctx))?.status).toBe(403); expect(io.calls).toEqual([]);
  }
  const unpaired = fixture("POST", { action: "prepare", confirmed: true });
  unpaired.ctx.sessionControl = { ...pairedSession, isPaired: () => false };
  expect((await handleDesktopCompatibilityRoutes(unpaired.ctx))?.status).toBe(403); expect(unpaired.calls).toEqual([]);
});
test("real loopback bootstrap stays read-only until a local pairing grant establishes mutation authority", async () => {
  const config = { hostname: "127.0.0.1", port: 10100, runtimeRole: "standalone", providers: {} } as OcxConfig;
  const state: ManagementAuthState = { available: true, token: "fixture-admin", source: "file", sessions: new Map(), pairingGrants: new Map() };
  const bootstrap = new Request(url.origin + "/opencodex-session", { headers: { host: url.host, origin: url.origin } });
  const automatic = issueGuiSession(bootstrap, config, state)!;
  expect(automatic.issuance).toBe("loopback");
  const grant = createGuiPairingGrant(url.origin, config, state);
  const paired = consumeGuiPairingGrant(new Request(bootstrap, { method: "POST" }), { grant: grant.grant }, config, state, Date.now(),
    { ingress: "public", peerAddress: "127.0.0.1", tailscaleUser: null, browserOrigin: url.origin });
  expect(paired && "token" in paired).toBe(true);
  const sessionControl = createManagementSessionControl(state);
  for (const [session, authorized] of [[automatic, false], [paired as GuiSessionBootstrap, true]] as const) {
    if (authorized) {
      // Pairing alone does not authorize mutations: the paired session still consumes a
      // single-use Desktop grant before POSTs are admitted.
      const desktopGrant = createGuiPairingGrant(url.origin, config, state, Date.now(), true);
      const authIo = fixture("POST", { grant: desktopGrant.grant });
      authIo.ctx.config = config; authIo.ctx.sessionControl = sessionControl;
      const authUrl = new URL(url.origin + "/api/codex/desktop-compatibility/authorization");
      authIo.ctx.url = authUrl;
      const authHeaders = new Headers(authIo.ctx.req.headers);
      authHeaders.set("origin", url.origin); authHeaders.set("x-opencodex-api-key", session.token);
      authHeaders.set("x-opencodex-gui-origin", session.browserOrigin); authHeaders.set("x-opencodex-csrf-token", session.csrfToken);
      authIo.ctx.req = new Request(authUrl, { method: "POST", headers: authHeaders, body: JSON.stringify({ grant: desktopGrant.grant }) });
      expect((await handleDesktopCompatibilityRoutes(authIo.ctx))?.status).toBe(200);
    }
    for (const method of ["GET", "POST"]) {
      const io = fixture(method, method === "POST" ? { action: "prepare", confirmed: true } : undefined);
      io.ctx.config = config; io.ctx.sessionControl = sessionControl;
      const headers = new Headers(io.ctx.req.headers);
      headers.set("origin", url.origin); headers.set("x-opencodex-api-key", session.token);
      headers.set("x-opencodex-gui-origin", session.browserOrigin); headers.set("x-opencodex-csrf-token", session.csrfToken);
      io.ctx.req = new Request(io.ctx.req, { headers });
      const response = (await handleDesktopCompatibilityRoutes(io.ctx))!;
      expect(response.status).toBe(method === "POST" && !authorized ? 403 : 200);
      if (method === "GET") expect((await response.json()).certificate.mutationAuthorized).toBe(authorized);
      expect(io.calls).toEqual(method === "GET" ? ["status"] : authorized ? ["prepare"] : []);
    }
  }
});
test("explicit confirmation and exact fingerprint are validated before any side effect", async () => {
  for (const body of [{ action: "prepare" }, { action: "trust", confirmed: true }, { action: "trust", confirmed: true, fingerprint: "wrong" },
    { action: "prepare", confirmed: true, injected: true }, { action: ["prepare"], confirmed: true }]) {
    const io = fixture("POST", body); expect((await handleDesktopCompatibilityRoutes(io.ctx))?.status).toBe(400); expect(io.calls).toEqual([]);
  }
  const valid = fixture("POST", { action: "trust", confirmed: true, fingerprint: "A".repeat(64) });
  expect((await handleDesktopCompatibilityRoutes(valid.ctx))?.status).toBe(200); expect(valid.calls).toEqual(["trust:" + "A".repeat(64)]);
});
test("unexpected errors never expose process output or credential strings", async () => {
  const io = fixture("POST", { action: "prepare", confirmed: true });
  io.ctx.deps.desktopCertificateService!.prepare = async () => { throw new Error("synthetic-private-key-output"); };
  const response = await handleDesktopCompatibilityRoutes(io.ctx); expect(response?.status).toBe(409);
  expect(await response!.json()).toEqual({ ok: false, error: "operation_failed" });
});

test("renewal requires fresh fingerprint and explicit local dashboard confirmation", async () => {
  const invalid = fixture("POST", { action: "renew", confirmed: true });
  expect((await handleDesktopCompatibilityRoutes(invalid.ctx))?.status).toBe(400); expect(invalid.calls).toEqual([]);
  const valid = fixture("POST", { action: "renew", confirmed: true, fingerprint: "A".repeat(64) });
  expect((await handleDesktopCompatibilityRoutes(valid.ctx))?.status).toBe(200); expect(valid.calls).toEqual(["renew:" + "A".repeat(64)]);
});
test("the real management dispatcher reaches setup with principal and ingress intact", async () => {
  const io = fixture("POST", { action: "prepare", confirmed: true });
  const response = await handleManagementAPI(io.ctx.req, url, io.ctx.config,
    io.ctx.deps, "gui-session", io.ctx.sessionControl, { trustedLoopback: true });
  expect(response?.status).toBe(200); expect(io.calls).toEqual(["prepare"]);
});

const desktopPosts = [
  ["certificate", { action: "prepare", confirmed: true }],
  ...["trust", "remove-trust", "renew"].map(action => ["certificate", { action, confirmed: true, fingerprint: "A".repeat(64) }]),
  ...["start", "stop", "observe", "launch"].map(action => ["runtime", { action, confirmed: true }]),
  ["runtime", { action: "apply", confirmed: true, accountWideConsent: true }],
  ["settings", { startOnProxyStart: false, revision: "a".repeat(64), confirmed: true }],
] as const;

function desktopBoundary(origin = "http://localhost:10100", hostname = "127.0.0.1") {
  const config = { providers: {}, runtimeRole: "standalone", hostname, port: 10100 } as OcxConfig;
  const state: Extract<ManagementAuthState, { available: true }> = { available: true, token: "fixture-admin", source: "environment", sessions: new Map(), pairingGrants: new Map() };
  const bootstrap = issueGuiSession(new Request(origin, { headers: { host: new URL(origin).host, Origin: origin } }), config, state)!;
  const control = createManagementSessionControl(state), calls: string[] = [];
  const result = { supported: true, state: "prepared", busy: null };
  const status = { supported: true, phase: "off", running: false };
  const hit = (name: string) => { calls.push(name); return status; };
  const deps = { desktopCertificateService: {
    status: async () => result, prepare: async () => { calls.push("prepare"); return result; },
    trust: async () => { calls.push("trust"); return result; }, removeTrust: async () => { calls.push("remove-trust"); return result; },
    renew: async () => { calls.push("renew"); return result; },
  }, desktopCompatibilityRuntime: { status: () => status, start: async () => hit("start"), stop: async () => hit("stop"), observe: async () => hit("observe"),
    launch: async () => { hit("launch"); return { status: "started" }; }, apply: async () => { hit("apply"); return { accepted: true }; } },
  desktopStartupSettings: { status: () => ({ startOnProxyStart: false, revision: "a".repeat(64) }), set: () => { hit("settings"); return { startOnProxyStart: false, revision: "a".repeat(64) }; } },
  } as unknown as ManagementContext["deps"];
  function request(path: string, body?: unknown, extra: Record<string, string> = {}) {
    return new Request(origin + "/api/codex/desktop-compatibility/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { host: new URL(origin).host, Origin: origin, "content-type": "application/json", "x-opencodex-api-key": bootstrap.token,
        "x-opencodex-gui-origin": origin, "x-opencodex-csrf-token": bootstrap.csrfToken, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function dispatch(req: Request, trusted = true) {
    const refused = requireManagementAuth(req, state, config); if (refused) return refused;
    // Mirror the real dispatcher: it always supplies the resolved issuance alongside ingress.
    return (await handleManagementAPI(req, new URL(req.url), config, deps, managementPrincipal(req, state, config)!, control,
      { trustedLoopback: trusted, guiSessionIssuance: managementSessionIssuance(req, state) }))!;
  }
  async function authorize() {
    const grant = createGuiPairingGrant(origin, config, state, Date.now(), true);
    const response = await dispatch(request("authorization", { grant: grant.grant }));
    expect(response.status).toBe(200); return grant.grant;
  }
  return { config, state, bootstrap, control, calls, deps, request, dispatch, authorize };
}

test("every Desktop POST fails closed for bootstrap/admin/forged/remote sessions; reads remain inert", async () => {
  const io = desktopBoundary();
  for (const [path, body] of desktopPosts) {
    expect((await io.dispatch(io.request(path, body, { "x-opencodex-desktop-purpose": "true" }))).status).toBe(403);
    expect((await io.dispatch(io.request(path, body, { "x-opencodex-api-key": io.state.token }))).status).toBe(403);
  }
  expect((await io.dispatch(io.request("certificate"))).status).toBe(200);
  expect(io.calls).toEqual([]);
  await io.authorize();
  for (const [path, body] of desktopPosts) {
    expect((await io.dispatch(io.request(path, body), false)).status).toBe(403);
    expect((await io.dispatch(io.request(path, body, { Forwarded: "for=127.0.0.1" }))).status).toBe(403);
  }
  expect(io.calls).toEqual([]);
  for (const [path, body] of desktopPosts) expect([200, 202]).toContain((await io.dispatch(io.request(path, body))).status);
  expect(io.calls).toEqual(["prepare", "trust", "remove-trust", "renew", "start", "stop", "observe", "launch", "apply", "settings"]);
  expect(io.control.isPaired(io.request("certificate"), io.config)).toBe(false);
  expect(io.control.canRevealDataKeys!(io.request("certificate"), io.config)).toBe(false);
});

test("the Desktop authorization exchange refuses raw tokens, remembered sessions, forged CSRF/origin, proxied ingress and replay", async () => {
  const io = desktopBoundary(), origin = "http://localhost:10100";
  const digest = (grant: string) => createHash("sha256").update(grant).digest("base64url");
  const post = (session: GuiSessionBootstrap, body: object, extra: Record<string, string> = {}) =>
    io.request("authorization", body, { "x-opencodex-api-key": session.token,
      "x-opencodex-gui-origin": session.browserOrigin, "x-opencodex-csrf-token": session.csrfToken, ...extra });
  // Every refusal must also leave the grant unspent, or a prober could burn the operator's consent.
  async function refused(expected: number, headers: HeadersInit, token: string, trusted = true) {
    const grant = createGuiPairingGrant(origin, io.config, io.state, Date.now(), true).grant;
    const request = new Request(origin + "/api/codex/desktop-compatibility/authorization", { method: "POST",
      headers: { host: "localhost:10100", Origin: origin, "content-type": "application/json", "x-opencodex-api-key": token, ...headers },
      body: JSON.stringify({ grant }) });
    expect((await io.dispatch(request, trusted)).status).toBe(expected);
    expect(io.state.pairingGrants.has(digest(grant))).toBe(true);
  }
  // A raw admin token is not a GUI session, so it cannot spend an operator grant.
  await refused(403, {}, io.state.token);
  // A remembered-admin session proves the durable admin token, not the operator's presence at
  // this machine. The handler refuses it before reading the body, so the differential below
  // also proves the refusal is issuance-driven rather than a port, origin or body mismatch.
  const durable = issueGuiSession(io.request("certificate"), io.config, io.state)!;
  io.state.sessions.set(durable.token, { ...io.state.sessions.get(durable.token)!, issuance: "remembered-admin" });
  await refused(403, { "x-opencodex-gui-origin": origin, "x-opencodex-csrf-token": durable.csrfToken }, durable.token);
  // That refusal happens before the body is read, which is the part a downstream record check
  // would not give: an unparseable body would otherwise answer 400 and reveal the route's
  // parsing to a credential that is not allowed to reach it at all.
  const malformed = new Request(origin + "/api/codex/desktop-compatibility/authorization", { method: "POST",
    headers: { host: "localhost:10100", Origin: origin, "content-type": "application/json", "x-opencodex-api-key": durable.token,
      "x-opencodex-gui-origin": origin, "x-opencodex-csrf-token": durable.csrfToken }, body: "{not json" });
  expect((await io.dispatch(malformed)).status).toBe(403);
  io.state.sessions.set(durable.token, { ...io.state.sessions.get(durable.token)!, issuance: "loopback" });
  expect((await io.dispatch(post(durable, { grant: createGuiPairingGrant(origin, io.config, io.state, Date.now(), true).grant }))).status).toBe(200);
  io.state.sessions.delete(durable.token);
  // The current browser session must prove itself: CSRF and Origin are both required.
  await refused(401, { "x-opencodex-gui-origin": origin, "x-opencodex-csrf-token": "wrong" }, io.bootstrap.token);
  await refused(401, { Origin: "http://127.0.0.1:10100", "x-opencodex-gui-origin": origin,
    "x-opencodex-csrf-token": io.bootstrap.csrfToken }, io.bootstrap.token);
  // A forwarded or untrusted-ingress request is refused even with a live loopback session.
  await refused(403, { Forwarded: "for=127.0.0.1", "x-opencodex-gui-origin": origin,
    "x-opencodex-csrf-token": io.bootstrap.csrfToken }, io.bootstrap.token);
  await refused(403, { "x-opencodex-gui-origin": origin, "x-opencodex-csrf-token": io.bootstrap.csrfToken }, io.bootstrap.token, false);
  // One use: the first success spends the grant, and a replayed exchange holds no authority.
  const once = createGuiPairingGrant(origin, io.config, io.state, Date.now(), true).grant;
  expect((await io.dispatch(post(io.bootstrap, { grant: once }))).status).toBe(200);
  expect(io.state.pairingGrants.has(digest(once))).toBe(false);
  expect((await io.dispatch(post(io.bootstrap, { grant: once }))).status).toBe(403);
  // Replay neither re-mints the grant nor reaches a service call.
  expect(io.state.pairingGrants.has(digest(once))).toBe(false);
  expect(io.calls).toEqual([]);
});

test("a configured localhost bind reports Desktop unsupported and refuses its authorization route", async () => {
  const io = desktopBoundary("http://localhost:10100", "localhost");
  const read = await io.dispatch(io.request("authorization"));
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ ok: true, supported: false, authorized: false, rememberedSession: false });
  // `startServer` canonicalizes this bind to 127.0.0.1, so the configured spelling never names
  // the served origin. The signed grant route is closed too: no usable command can be offered.
  // A grant actually issued for the literal listener must still be unspent after the refusal.
  const issued = createGuiPairingGrant("http://localhost:10100", { ...io.config, hostname: "127.0.0.1" },
    io.state, Date.now(), true);
  expect((await io.dispatch(io.request("authorization", { grant: issued.grant }))).status).toBe(403);
  expect(io.state.pairingGrants.has(createHash("sha256").update(issued.grant).digest("base64url"))).toBe(true);
  expect(io.calls).toEqual([]);
});

test("unsupported status is also returned for forwarded or nonlocal ingress", async () => {
  const io = desktopBoundary();
  for (const response of [await io.dispatch(io.request("authorization"), false),
    await io.dispatch(io.request("authorization", undefined, { Forwarded: "for=127.0.0.1" }))]) {
    expect(await response.json()).toEqual({ ok: true, supported: false, authorized: false, rememberedSession: false });
  }
  expect(io.calls).toEqual([]);
});

test("Desktop grants are purpose/origin bound, one use, and cannot mint a general pairing session", async () => {
  const io = desktopBoundary(), other = desktopBoundary("http://127.0.0.1:10100");
  const ordinary = createGuiPairingGrant("http://127.0.0.1:10100", io.config, io.state);
  expect((await io.dispatch(io.request("authorization", { grant: ordinary.grant }))).status).toBe(403);
  const stale = createGuiPairingGrant("http://localhost:10100", io.config, io.state, Date.now() - 5 * 60_000 - 1, true);
  expect((await io.dispatch(io.request("authorization", { grant: stale.grant }))).status).toBe(403);
  const wrongOrigin = createGuiPairingGrant("http://127.0.0.1:10100", io.config, io.state, Date.now(), true);
  expect((await io.dispatch(io.request("authorization", { grant: wrongOrigin.grant }))).status).toBe(403);
  const grant = createGuiPairingGrant("http://localhost:10100", io.config, io.state, Date.now(), true);
  expect(consumeGuiPairingGrant(new Request("http://localhost:10100/opencodex-session", { method: "POST", headers: {
    host: "localhost:10100", Origin: "http://localhost:10100",
  } }), { grant: grant.grant }, io.config, io.state, Date.now(), { ingress: "public", peerAddress: "127.0.0.1", tailscaleUser: null, browserOrigin: "http://localhost:10100" })).toBeNull();
  expect(other.control.authorizeLocalDesktop!(other.request("authorization", { grant: grant.grant }), other.config, grant.grant)).toBe(false);
  expect((await io.dispatch(io.request("authorization", { grant: grant.grant }))).status).toBe(200);
  expect((await io.dispatch(io.request("authorization", { grant: grant.grant }))).status).toBe(403);
  expect(io.state.sessions.size).toBe(1);
});

test("Desktop scope is fixed, session-bound and revoked after role/listener changes or logout", async () => {
  const io = desktopBoundary(); await io.authorize();
  const original = io.state.sessions.get(io.bootstrap.token)!;
  const actualNow = Date.now;
  try {
    Date.now = () => actualNow() + 5 * 60_000 + 1;
    original.expiresAt = Date.now() + 60_000;
    expect((await io.dispatch(io.request("runtime", { action: "stop", confirmed: true }))).status).toBe(403);
  } finally { Date.now = actualNow; }
  expect(io.calls).toEqual([]);
  await io.authorize(); io.config.runtimeRole = "hub";
  expect((await io.dispatch(io.request("runtime", { action: "stop", confirmed: true }))).status).toBe(403);
  io.config.runtimeRole = "standalone";
  expect((await io.dispatch(io.request("runtime", { action: "stop", confirmed: true }))).status).toBe(403);
  await io.authorize(); io.control.revokeCurrent(io.request("certificate"));
  expect((await io.dispatch(io.request("runtime", { action: "stop", confirmed: true }))).status).toBe(401);
  expect(io.calls).toEqual([]);
});

test("Desktop authorization preserves an existing local pairing's independent privileges", () => {
  const cfg = { providers: {}, runtimeRole: "standalone", hostname: "127.0.0.1", port: 10100 } as OcxConfig;
  const state: Extract<ManagementAuthState, { available: true }> = { available: true, token: "fixture-admin", source: "environment", sessions: new Map(), pairingGrants: new Map() };
  const origin = "http://127.0.0.1:10100", grant = createGuiPairingGrant(origin, cfg, state);
  const bootstrap = consumeGuiPairingGrant(new Request(origin + "/opencodex-session", { method: "POST", headers: { host: "127.0.0.1:10100", Origin: origin } }),
    { grant: grant.grant }, cfg, state, Date.now(), { ingress: "public", peerAddress: "127.0.0.1", tailscaleUser: null, browserOrigin: origin });
  if (!bootstrap || "allowed" in bootstrap) throw new Error("fixture pairing refused");
  const req = new Request(origin + "/api/codex/desktop-compatibility/authorization", { method: "POST", headers: {
    host: "127.0.0.1:10100", Origin: origin, "x-opencodex-api-key": bootstrap.token, "x-opencodex-gui-origin": origin, "x-opencodex-csrf-token": bootstrap.csrfToken,
  } });
  const control = createManagementSessionControl(state), desktop = createGuiPairingGrant(origin, cfg, state, Date.now(), true);
  expect(control.authorizeLocalDesktop!(req, cfg, desktop.grant)).toBe(true);
  expect(control.isPaired(req, cfg)).toBe(true); expect(control.canRevealDataKeys!(req, cfg)).toBe(true);
  expect(state.sessions.size).toBe(1);
});

test("listener changes, eviction, independent sessions and wrong browser origins cannot reuse Desktop scope", async () => {
  const io = desktopBoundary(); await io.authorize();
  expect(io.control.canMutateLocalDesktop!(io.request("runtime", { action: "stop", confirmed: true }, { Origin: "http://127.0.0.1:10100" }), io.config)).toBe(false);
  const second = issueGuiSession(new Request("http://localhost:10100", { headers: { host: "localhost:10100" } }), io.config, io.state)!;
  expect(io.control.canMutateLocalDesktop!(io.request("runtime", { action: "stop", confirmed: true }, {
    "x-opencodex-api-key": second.token, "x-opencodex-csrf-token": second.csrfToken,
  }), io.config)).toBe(false);
  expect(io.control.canMutateLocalDesktop!(io.request("certificate"), { ...io.config, port: 10101 })).toBe(false);
  expect(io.control.canMutateLocalDesktop!(io.request("certificate"), io.config)).toBe(false);
  await io.authorize(); io.state.sessions.delete(io.bootstrap.token);
  expect(io.control.canMutateLocalDesktop!(io.request("certificate"), io.config)).toBe(false);
  expect(io.calls).toEqual([]);
});

test("session revocation while each POST body is read prevents every service call", async () => {
  for (const [path, body] of desktopPosts) {
    const io = desktopBoundary(); await io.authorize();
    const original = io.request(path, body);
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      io.control.revokeCurrent(io.request("certificate"));
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close();
    } }, { highWaterMark: 0 });
    const req = new Request(original.url, { method: "POST", headers: original.headers, body: stream, duplex: "half" } as RequestInit);
    const response = await handleManagementAPI(req, new URL(req.url), io.config, {
      desktopCertificateService: { prepare: async () => { io.calls.push("unexpected"); } },
      desktopCompatibilityRuntime: { stop: async () => { io.calls.push("unexpected"); } },
      desktopStartupSettings: { set: () => { io.calls.push("unexpected"); } },
    } as unknown as ManagementContext["deps"], "gui-session", io.control, { trustedLoopback: true });
    expect(response?.status).toBe(403); expect(io.calls).toEqual([]);
  }
});

test("expiry prevents the next operation without interrupting a service operation already admitted", async () => {
  const io = desktopBoundary(); await io.authorize();
  let began!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  io.deps.desktopCertificateService!.prepare = async () => { io.calls.push("prepare"); began(); await pending; return { supported: true, state: "prepared", busy: null }; };
  const response = io.dispatch(io.request("certificate", { action: "prepare", confirmed: true })); await started;
  const now = Date.now;
  try {
    Date.now = () => now() + 5 * 60_000 + 1; finish();
    expect((await response).status).toBe(200); expect(io.calls).toEqual(["prepare"]);
    expect(io.control.canMutateLocalDesktop!(io.request("certificate"), io.config)).toBe(false);
  } finally { Date.now = now; finish(); }
});
