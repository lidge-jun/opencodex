import { expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { OcxConfig } from "../../src/types";
import type { ManagementContext } from "../../src/server/management/context";
import { assertNotRealHomeUnderTest, isTestHomeGuardArmed, protectedHomeForTests } from "../../src/lib/test-home-guard";
import { flushWindowsSecretAclReapsBeforeRemoval, hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { trustWindowsTempFixtureAncestry } from "./windows-temp-ancestry";
import { admitCodexCliUpdateJob } from "../../src/codex/cli-update-job";
import * as updateJobs from "../../src/codex/cli-update-job";
import { handleCodexCliUpdateRoutes } from "../../src/server/management/codex-cli-update-routes";
import { handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import { createManagementSessionControl, initializeManagementAuthState, issueGuiSession,
  managementPrincipal, managementSessionIssuance, requireManagementAuth } from "../../src/server/management-auth";
import { consumeGuiPairingGrant, createGuiPairingGrant } from "../../src/server/gui-session";

const root = realpathSync.native(process.env.OCX_TEST_OWNED_ROOT!);
const tempParent = realpathSync.native(process.env.OCX_TEST_TEMP_PARENT!);
const configDir = resolve(process.env.OPENCODEX_HOME!);
const expectedProtected = resolve(process.env.OCX_TEST_PROTECTED_HOME!);
if (!isTestHomeGuardArmed() || resolve(protectedHomeForTests()).toLowerCase() !== expectedProtected.toLowerCase()) {
  throw new Error("test home guard identity mismatch");
}
if (relative(root, configDir) !== "ocx") throw new Error("job-store config escaped its owned root");
const rootWithinTemp = relative(tempParent, root);
if (!rootWithinTemp || rootWithinTemp === ".." || rootWithinTemp.startsWith(`..\\`) || isAbsolute(rootWithinTemp)) {
  throw new Error("job-store fixture escaped its native temp parent");
}
assertNotRealHomeUnderTest(configDir);
await hardenSecretDirAsync(root, { required: true });
trustWindowsTempFixtureAncestry(root, tempParent);

const accepted = await admitCodexCliUpdateJob({ requestId: "win-http-00001", planId: "a".repeat(32), confirmed: true, configDir });
const lock = join(configDir, "codex-cli-update-jobs", "admission.lock");
mkdirSync(lock);
const origin = "http://127.0.0.1:10100";
const authConfig = { hostname: "127.0.0.1", port: 10100, providers: {} } as OcxConfig;
const previousAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx_admin_windows_job_fixture";
let state: ReturnType<typeof initializeManagementAuthState>;
try { state = initializeManagementAuthState(authConfig); }
finally {
  if (previousAdmin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdmin;
}
if (!state.available) throw new Error("fixture management authority unavailable");
const baseHeaders = { Host: "127.0.0.1:10100", Origin: origin, "User-Agent": "windows-job-store-fixture" };
const ordinary = issueGuiSession(new Request(`${origin}/`, { headers: baseHeaders }), authConfig, state);
if (!ordinary) throw new Error("ordinary fixture session unavailable");
const issued = createGuiPairingGrant(origin, authConfig, state);
const exchange = new Request(`${origin}/opencodex-session`, { method: "POST", headers: baseHeaders });
const paired = consumeGuiPairingGrant(exchange, { grant: issued.grant }, authConfig, state, Date.now(), {
  ingress: "public", peerAddress: "127.0.0.1", tailscaleUser: null, browserOrigin: origin,
});
if (!paired || "allowed" in paired) throw new Error("fixture pairing redemption refused");
expect(paired.issuance).toBe("pairing");
expect(state.pairingGrants.size).toBe(0);
const applyReq = (session: typeof paired) => new Request(`${origin}/api/codex/cli-update/apply`, { method: "POST",
  headers: { ...baseHeaders, "content-type": "application/json", "X-OpenCodex-API-Key": session.token,
    "X-OpenCodex-GUI-Origin": origin, "X-OpenCodex-CSRF-Token": session.csrfToken },
  body: JSON.stringify({ requestId: "win-http-other-1", planId: "e".repeat(32), confirmed: true }) });
const control = createManagementSessionControl(state);
const context = (req: Request): ManagementContext => {
  expect(requireManagementAuth(req, state, authConfig)).toBeNull();
  const principal = managementPrincipal(req, state, authConfig);
  expect(principal).toBe("gui-session");
  return { req, url: new URL(req.url), config: authConfig, deps: {}, version: "test", principal: principal!,
    trustedLoopbackIngress: true, guiSessionIssuance: managementSessionIssuance(req, state), sessionControl: control,
    convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
    syncClaudeAgentDefsBestEffort: async () => {} };
};
const ledgerPath = join(configDir, "codex-cli-update-jobs", "jobs.json");
const before = readFileSync(ledgerPath, "utf8");
const lockEntries = readdirSync(lock).sort();
const worker = spyOn(updateJobs, "runCodexCliUpdateJob").mockImplementation(async () => { throw new Error("unexpected job worker"); });
try {
  const ordinaryReq = applyReq(ordinary);
  expect(control.isPaired(ordinaryReq, authConfig)).toBe(false);
  const denied = await handleCodexCliUpdateRoutes(context(ordinaryReq));
  expect(denied?.status).toBe(403);
  expect(await denied?.json()).toEqual({ error: "local_dashboard_confirmation_required" });
  expect(existsSync(lock)).toBe(true);
  expect(readdirSync(lock).sort()).toEqual(lockEntries);
  expect(readFileSync(ledgerPath, "utf8")).toBe(before);
  expect(worker).not.toHaveBeenCalled();
  const pairedReq = applyReq(paired);
  expect(control.isPaired(pairedReq, authConfig)).toBe(true);
  expect(managementSessionIssuance(pairedReq, state)).toBe("pairing");
  const busy = await handleCodexCliUpdateRoutes(context(pairedReq));
  expect(busy?.status).toBe(503);
  expect(await busy?.json()).toEqual({ error: "job_store_busy" });
  expect(busy?.headers.get("Retry-After")).toBe("1");
  expect(existsSync(lock)).toBe(true);
  expect(readdirSync(lock).sort()).toEqual(lockEntries);
  expect(readFileSync(ledgerPath, "utf8")).toBe(before);
  expect(worker).not.toHaveBeenCalled();
} finally { worker.mockRestore(); }
rmSync(lock, { recursive: true });
const statusReq = new Request(`${origin}/api/codex/cli-update/jobs/${accepted.job.jobId}`);
const status = await handleCodexCliUpdateRoutes({ req: statusReq, url: new URL(statusReq.url), config: authConfig,
  deps: {}, version: "test", principal: "gui-session", trustedLoopbackIngress: true, guiSessionIssuance: "loopback",
  convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
  syncClaudeAgentDefsBestEffort: async () => {} });
expect(status?.status).toBe(200);
expect(await status?.json()).toMatchObject({ jobId: accepted.job.jobId, status: "queued", ownerState: "active" });
const logs: string[] = [];
const oldLog = console.log;
try {
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  expect(await handleCodexCliUpdateCommand(["status", accepted.job.jobId, "--json"])).toBe(0);
} finally { console.log = oldLog; }
expect(JSON.parse(logs[0]!)).toMatchObject({ jobId: accepted.job.jobId, status: "queued" });
await flushWindowsSecretAclReapsBeforeRemoval(root);
console.log("WINDOWS_JOBSTORE_PAIRING_CASE_PASS");
