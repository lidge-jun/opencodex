import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { remoteConfig } from "../helpers/management-auth-fixture";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import {
  createManagementSessionControl, initializeManagementAuthState, issueGuiSession,
  managementPrincipal, managementSessionIssuance, requireManagementAuth,
} from "../../src/server/management-auth";
import { MANAGEMENT_ROUTES } from "../../src/server/management/route-registry";
import { trustedLoopbackForIngress } from "../../src/server/index/serve-options";
import * as jobs from "../../src/codex/cli-update-job";
import * as workers from "../../src/codex/cli-update-job-worker";

const ORIGIN = "http://127.0.0.1:10100";
const ADMIN = "ocx_admin_consent_fixture";
const APPLY = { requestId: "b".repeat(32), planId: "a".repeat(32), confirmed: true };
const JOB: jobs.CodexCliUpdateJobDto = {
  jobId: "11111111-1111-4111-8111-111111111111", planId: APPLY.planId, status: "queued",
  ownerState: "active", lifetimeUncertain: false, childState: "not_started",
  leaseState: "not_acquired_or_released", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", outcome: null, reason: null, cleanupErrors: [],
};
const payloads: Record<string, object> = {
  "/api/codex/cli-update/apply": APPLY,
  "/api/codex/desktop-compatibility/certificate": { action: "prepare", confirmed: true },
  "/api/codex/desktop-compatibility/runtime": { action: "observe", confirmed: true },
  "/api/codex/desktop-compatibility/settings": { startOnProxyStart: false, revision: "a".repeat(64), confirmed: true },
};
const sessionMutations = MANAGEMENT_ROUTES.filter(route => route.mutates && route.exempt?.reason === "session-only");
let home: TempHome;
let config: ReturnType<typeof remoteConfig>;
let state: ReturnType<typeof initializeManagementAuthState>;
let previousToken: string | undefined;
let previousWorkspace: string | undefined;
let effects: string[];
let deps: ManagementApiDeps;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  home = createTempHome("ocx-dashboard-consent-");
  previousToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  previousWorkspace = process.env.OCX_REMOTE_WORKSPACE_ENABLED;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN;
  process.env.OCX_REMOTE_WORKSPACE_ENABLED = "1";
  config = { ...remoteConfig(), hostname: "127.0.0.1" };
  state = initializeManagementAuthState(config);
  effects = [];
  deps = {};
  for (const key of ["desktopCertificateService", "desktopCompatibilityRuntime", "desktopStartupSettings",
    "remoteWorkspaceStopping", "linkSupervisor", "issueApiKey"] as const) {
    Object.defineProperty(deps, key, { get() { effects.push(key); throw new Error("Unexpected service access"); } });
  }
  spies.push(spyOn(jobs, "admitCodexCliUpdateJob").mockImplementation(() => {
    effects.push("admit"); return { kind: "accepted", job: JOB, generation: "fixture" };
  }));
  spies.push(spyOn(jobs, "runCodexCliUpdateJob").mockImplementation(async (_id, _generation, execute) => {
    effects.push("run"); await execute(); return JOB;
  }));
  spies.push(spyOn(workers, "runCodexCliUpdateApplyInWorker").mockImplementation(async () => {
    effects.push("worker");
    return { outcome: "refused", reason: "plan_refused", planId: APPLY.planId,
      installedVersion: null, targetVersion: null, installerExitCode: null,
      leaseRetained: false, verificationPid: null, cleanupErrors: [] };
  }));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (previousToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousToken;
  if (previousWorkspace === undefined) delete process.env.OCX_REMOTE_WORKSPACE_ENABLED;
  else process.env.OCX_REMOTE_WORKSPACE_ENABLED = previousWorkspace;
  home.remove();
});

function request(path: string, method: string, token: string, body?: object, headers: HeadersInit = {}) {
  return new Request(ORIGIN + path, { method, headers: {
    Host: new URL(ORIGIN).host, Origin: ORIGIN, "User-Agent": "dashboard-consent-fixture",
    "X-OpenCodex-API-Key": token, ...Object.fromEntries(new Headers(headers)),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function dispatch(req: Request, local = true) {
  const denied = requireManagementAuth(req, state, config);
  if (denied) return denied;
  return (await handleManagementAPI(req, new URL(req.url), config, deps,
    managementPrincipal(req, state, config)!, createManagementSessionControl(state), {
      trustedLoopback: trustedLoopbackForIngress("public", local ? config.hostname : "0.0.0.0"),
      guiSessionIssuance: managementSessionIssuance(req, state),
    }))!;
}
async function remember(resumed: boolean) {
  const response = await dispatch(request("/api/session/remember", "POST", ADMIN));
  expect(response.status).toBe(200);
  const body = await response.json();
  const cookie = response.headers.get("Set-Cookie")!.split(";")[0]!;
  let session = body.session;
  if (resumed) {
    state = initializeManagementAuthState(config);
    session = issueGuiSession(request("/opencodex-session", "GET", "", undefined,
      { Cookie: cookie, "X-OpenCodex-Device-Proof": body.device.proof }), config, state);
  }
  expect(session?.issuance).toBe("remembered-admin");
  return { session: session!, cookie };
}
function sessionRequest(device: Awaited<ReturnType<typeof remember>>, path: string, method: string, body?: object) {
  return request(path, method, device.session.token, body, {
    Cookie: device.cookie, "X-OpenCodex-GUI-Origin": ORIGIN, "X-OpenCodex-CSRF-Token": device.session.csrfToken,
  });
}
function files(dir = home.root): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(files(path)) : [[path, createHash("sha256").update(readFileSync(path)).digest("hex")]];
  }));
}

for (const resumed of [false, true]) {
  for (const route of sessionMutations) {
    // Logout is the current session's revocation operation, including remembered devices.
    if (route.method === "POST" && route.path === "/api/session/logout") continue;
    test(`${resumed ? "resumed" : "enrolled"} remembered session refuses ${route.method} ${route.path}`, async () => {
      const device = await remember(resumed);
      if (route.path.startsWith("/api/remote-workspace/")) config.runtimeRole = "hub";
      const path = route.path.replace(/\{[^}]+\}/g, JOB.jobId);
      const req = sessionRequest(device, path, route.method, payloads[route.path] ?? {});
      expect(requireManagementAuth(req, state, config)).toBeNull();
      expect(managementPrincipal(req, state, config)).toBe("gui-session");
      expect(managementSessionIssuance(req, state)).toBe("remembered-admin");
      const before = files();
      const response = await dispatch(req);
      expect({ status: response.status, effects, files: files() }).toEqual({ status: 403, effects: [], files: before });
    });
  }
  test(`${resumed ? "resumed" : "enrolled"} remembered session can still log out`, async () => {
    expect(sessionMutations.some(route => route.path === "/api/session/logout")).toBe(true);
    const device = await remember(resumed);
    expect((await dispatch(sessionRequest(device, "/api/session/logout", "POST"))).status).toBe(200);
    expect((await dispatch(sessionRequest(device, "/api/codex/cli-update/apply", "POST", APPLY))).status).toBe(401);
    expect(JSON.parse(readFileSync(home.path("dashboard-sessions.json"), "utf8"))).toEqual([]);
    expect(effects).toEqual([]);
  });
}

test("ordinary loopback GUI apply retains confirmation and ingress gates, then dispatches once", async () => {
  const session = issueGuiSession(request("/", "GET", ""), config, state)!;
  expect(session.issuance).toBe("loopback");
  const device = { session, cookie: "" };
  expect((await dispatch(sessionRequest(device, "/api/codex/cli-update/apply", "POST", { ...APPLY, confirmed: false }))).status).toBe(400);
  expect((await dispatch(sessionRequest(device, "/api/codex/cli-update/apply", "POST", APPLY), false)).status).toBe(403);
  expect(effects).toEqual([]);
  expect((await dispatch(sessionRequest(device, "/api/codex/cli-update/apply", "POST", APPLY))).status).toBe(202);
  expect(effects).toEqual(["admit", "run", "worker"]);
});

test("remembered CLI plan and job reads retain ordinary management admission", async () => {
  const device = await remember(true);
  const plan = spyOn(workers, "runCodexCliUpdatePlanInWorker").mockRejectedValue(new Error("Fixture plan unavailable"));
  const status = spyOn(jobs, "readCodexCliUpdateJob").mockReturnValue(JOB);
  spies.push(plan, status);
  for (const [path, expected] of [["/api/codex/cli-update/plan", 503], [`/api/codex/cli-update/jobs/${JOB.jobId}`, 200]] as const) {
    expect((await dispatch(request(path, "GET", ""))).status).toBe(401);
    expect((await dispatch(sessionRequest(device, path, "GET"), false)).status).toBe(expected);
  }
  expect(plan).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenCalledTimes(1);
  expect(effects).toEqual([]);
});
