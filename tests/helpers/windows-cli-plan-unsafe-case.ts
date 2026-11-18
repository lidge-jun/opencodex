import { expect } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { settleBackgroundWork } from "../../src/lib/background-work";
import { assertNotRealHomeUnderTest, isTestHomeGuardArmed, protectedHomeForTests } from "../../src/lib/test-home-guard";
import { flushWindowsSecretAclReapsBeforeRemoval, hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { setWindowsOwnerAclAsyncRunnerForTests, verifyWindowsEntriesAclAsync } from "../../src/lib/windows-owner-acl";
import { readWindowsJobStore } from "../../src/codex/cli-update-job-store-windows";
import { consumeGuiPairingGrant, createGuiPairingGrant } from "../../src/server/gui-session";
import { createManagementSessionControl, initializeManagementAuthState, issueGuiSession,
  managementPrincipal, managementSessionIssuance, requireManagementAuth } from "../../src/server/management-auth";
import type { ManagementContext } from "../../src/server/management/context";
import { handleCodexCliUpdateRoutes } from "../../src/server/management/codex-cli-update-routes";
import type { OcxConfig } from "../../src/types";
import { assertWindowsPlanChildrenExited } from "./windows-plan-child-processes";
import { observeWindowsPlanJunction } from "./windows-plan-junction-observer";

const root = realpathSync.native(process.env.OCX_TEST_OWNED_ROOT!);
const tempParent = realpathSync.native(process.env.OCX_TEST_TEMP_PARENT!);
const configDir = resolve(process.env.OPENCODEX_HOME!);
if (!isTestHomeGuardArmed() || resolve(protectedHomeForTests()).toLowerCase() !== resolve(process.env.OCX_TEST_PROTECTED_HOME!).toLowerCase()) {
  throw new Error("test home guard identity mismatch");
}
if (relative(root, configDir) !== "absent-home") throw new Error("plan config escaped its owned root");
const within = relative(tempParent, root);
if (!within || within === ".." || within.startsWith("..\\") || isAbsolute(within)) throw new Error("plan fixture escaped its temp parent");
assertNotRealHomeUnderTest(configDir);
// Parent invokes its teardown while this child is held, then closes stdin to continue.
console.log("WINDOWS_CLI_PLAN_UNSAFE_CASE_READY");
for await (const chunk of Bun.stdin.stream()) { void chunk; }

// Model a verifier returning timedOut while its real child is still running.
// The receipt gate must refuse until that child's actual exit, not its verdict.
assertWindowsPlanChildrenExited();
let releaseProbe: (() => Promise<number>) | undefined;
let probeExitCode: (() => number | null) | undefined;
let simulatedTimeoutReturned = false;
setWindowsOwnerAclAsyncRunnerForTests(async () => {
  const child = Bun.spawn([process.execPath, "-e", 'process.stdout.write("READY\\n"); for await (const chunk of Bun.stdin.stream()) { void chunk; }'],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  releaseProbe = () => { child.stdin.end(); return child.exited; };
  probeExitCode = () => child.exitCode;
  const reader = child.stdout.getReader();
  try {
    let ready = ""; const decoder = new TextDecoder();
    while (!ready.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("probe exited before readiness");
      ready += decoder.decode(chunk.value, { stream: true });
    }
    expect(ready).toBe("READY\n");
  } finally { reader.releaseLock(); }
  simulatedTimeoutReturned = true;
  return { success: false, timedOut: true, stdout: "" };
});
try {
  expect(await verifyWindowsEntriesAclAsync([{ path: root, directory: true }], 5000)).toBe(false);
  expect(simulatedTimeoutReturned).toBe(true);
  expect(probeExitCode?.()).toBeNull();
  expect(() => assertWindowsPlanChildrenExited()).toThrow("subprocess exit unconfirmed");
} finally {
  setWindowsOwnerAclAsyncRunnerForTests(null);
  if (releaseProbe) expect(await releaseProbe()).toBe(0);
}
assertWindowsPlanChildrenExited();

await hardenSecretDirAsync(root, { required: true });
const junctionObservation = observeWindowsPlanJunction(root, configDir);
const prefix = join(root, "npm");
const packageRoot = join(prefix, "node_modules", "@openai", "codex");
const backing = join(packageRoot, "bin", "node_modules", "@openai", "codex-win32-x64");
const npmRoot = join(prefix, "node_modules", "npm");
const cmd = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL',
  'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (',
  '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');
const pe = Buffer.alloc(128); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64); pe.writeUInt16LE(0x8664, 68);
const files = new Map<string, string | Buffer>([
  [join(prefix, "codex.cmd"), cmd],
  [join(prefix, "codex.opencodex-real.cmd"), "stale unselected shim backup"],
  [join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.2.3", bin: { codex: "bin/codex.js" } })],
  [join(packageRoot, "bin", "codex.js"), 'throw new Error("Codex must never execute");'],
  [join(backing, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.2.3-win32-x64" })],
  [join(backing, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"), "synthetic backing bytes"],
  [join(npmRoot, "package.json"), JSON.stringify({ name: "npm", version: "11.0.0", bin: { npm: "bin/npm-cli.js" } })],
  [join(npmRoot, "bin", "npm-cli.js"), 'throw new Error("npm must never execute");'],
  [join(prefix, "node.exe"), pe],
]);
for (const [path, value] of files) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
const inspectionDeps = { env: { CODEX_CLI_PATH: join(prefix, "codex.cmd"), PATH: prefix, PATHEXT: ".EXE;.CMD" },
  configDir, selectionAttested: true, arch: "x64" as const, observeInstallContent: true };
// A real unsupported config-root reparse point tests the ledger independently of TEMP ACLs.
const ledgerTarget = join(root, "ledger-target");
mkdirSync(ledgerTarget);
symlinkSync(ledgerTarget, configDir, "junction");
const control = join(root, "control-home");
mkdirSync(control);
expect(await readWindowsJobStore(control)).toBeNull();
expect(existsSync(join(control, "codex-cli-update-jobs"))).toBe(false);
const deps = { inspectionDeps,
  resolveTarget: () => ({ kind: "resolved" as const, version: "1.2.4", integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") }),
  scanProcesses: () => ({ kind: "observed" as const, processes: [] }) };
const plan = await createCodexCliUpdatePlan(deps);
expect(plan.planId).toMatch(/^[a-f0-9]{32}$/);
expect(plan).toMatchObject({ applicable: false, refusal: "windows_apply_disabled" });

const origin = "http://127.0.0.1:10100";
const config = { hostname: "127.0.0.1", port: 10100, providers: {} } as OcxConfig;
const oldAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx_admin_windows_plan_fixture";
let state: ReturnType<typeof initializeManagementAuthState>;
try { state = initializeManagementAuthState(config); }
finally {
  if (oldAdmin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = oldAdmin;
}
if (!state.available) throw new Error("fixture management authority unavailable");
const baseHeaders = { Host: "127.0.0.1:10100", Origin: origin, "User-Agent": "windows-plan-fixture" };
const ordinary = issueGuiSession(new Request(`${origin}/`, { headers: baseHeaders }), config, state);
if (!ordinary) throw new Error("ordinary fixture session unavailable");
const grant = createGuiPairingGrant(origin, config, state);
const exchange = new Request(`${origin}/opencodex-session`, { method: "POST", headers: baseHeaders });
const paired = consumeGuiPairingGrant(exchange, { grant: grant.grant }, config, state, Date.now(), {
  ingress: "public", peerAddress: "127.0.0.1", tailscaleUser: null, browserOrigin: origin,
});
if (!paired || "allowed" in paired) throw new Error("fixture pairing redemption refused");
expect(paired.issuance).toBe("pairing");
expect(state.pairingGrants.size).toBe(0);
const requestFor = (session: typeof paired) => new Request(`${origin}/api/codex/cli-update/apply`, { method: "POST",
  headers: { ...baseHeaders, "content-type": "application/json", "X-OpenCodex-API-Key": session.token,
    "X-OpenCodex-GUI-Origin": origin, "X-OpenCodex-CSRF-Token": session.csrfToken },
  body: JSON.stringify({ requestId: "windows-nonapplicable-plan-001", planId: plan.planId, confirmed: true }) });
const sessionControl = createManagementSessionControl(state);
const contextFor = (req: Request): ManagementContext => {
  expect(requireManagementAuth(req, state, config)).toBeNull();
  const principal = managementPrincipal(req, state, config);
  expect(principal).toBe("gui-session");
  return { req, url: new URL(req.url), config, deps: {}, version: "test", principal: principal!,
    trustedLoopbackIngress: true, guiSessionIssuance: managementSessionIssuance(req, state), sessionControl,
    convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
    syncClaudeAgentDefsBestEffort: async () => {} };
};
const unpairedRequest = requestFor(ordinary);
expect(sessionControl.isPaired(unpairedRequest, config)).toBe(false);
const denied = await handleCodexCliUpdateRoutes(contextFor(unpairedRequest));
expect(denied?.status).toBe(403);
expect(await denied?.json()).toEqual({ error: "local_dashboard_confirmation_required" });
expect(denied?.headers.get("Retry-After")).toBeNull();
expect(existsSync(join(ledgerTarget, "codex-cli-update-jobs"))).toBe(false);
const pairedRequest = requestFor(paired);
expect(sessionControl.isPaired(pairedRequest, config)).toBe(true);
expect(managementSessionIssuance(pairedRequest, state)).toBe("pairing");
let response: Response | null;
let pairedEvidence: string[];
junctionObservation.begin();
try { response = await handleCodexCliUpdateRoutes(contextFor(pairedRequest)); }
finally { pairedEvidence = junctionObservation.end(); }
expect(response?.status).toBe(503);
expect(await response?.json()).toEqual({ error: "unsafe_store" });
expect(pairedEvidence).toEqual(["ancestry-ok", "junction-reparse"]);
expect(response?.headers.get("Retry-After")).toBeNull();
expect(existsSync(join(ledgerTarget, "codex-cli-update-jobs"))).toBe(false);
let leaseAttempts = 0, installAttempts = 0;
const apply = await applyCodexCliUpdate(plan.planId!, { platform: "win32", inspectionDeps,
  acquireLease: () => { leaseAttempts += 1; return null; },
  resolveTarget: deps.resolveTarget, scanProcesses: deps.scanProcesses,
  install: async () => { installAttempts += 1; return { terminal: true, exitCode: 0 }; } });
expect(apply).toMatchObject({ outcome: "refused", reason: "windows_apply_disabled" });
expect(leaseAttempts).toBe(0);
expect(installAttempts).toBe(0);
await settleBackgroundWork();
await flushWindowsSecretAclReapsBeforeRemoval(root);
assertWindowsPlanChildrenExited();
console.log("WINDOWS_CLI_PLAN_UNSAFE_CASE_PASS");
