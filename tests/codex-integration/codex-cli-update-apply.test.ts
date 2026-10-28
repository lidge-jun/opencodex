import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { dirname, join } from "node:path";
import { applyCodexCliUpdate, verifyInstalledCodexVersion, type CodexCliApplyDeps } from "../../src/codex/cli-update-apply";
import { admitCodexCliUpdateJob, finishCodexCliUpdateJob, runCodexCliUpdateJob, type CodexCliUpdateJobDto } from "../../src/codex/cli-update-job";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { acquireCodexCliApplyLease } from "../../src/codex/cli-update-lease";
import { createCodexCliApplyFixture, waitForApplyAdmission, writeFixtureNpmWrapper } from "../helpers/codex-cli-apply-fixture";
import { fixtureArtifactSet } from "../helpers/codex-cli-apply-artifact";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { codexCliPlatformBacking } from "../../src/codex/cli-install-provenance";
import { observeCodexCliFileSet, sameCodexCliFiles } from "../../src/codex/cli-update-files";
import {
  createCodexCliUpdateFence, cancelCodexCliUpdateFence, codexCliUpdateIsCancelled,
  codexCliUpdateSelectionGate, beginCodexCliSelectionParentWrite,
  createWorkerCommitWindow,
} from "../../src/codex/cli-update-selection-gate";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });
const posix = process.platform !== "win32";
function fixture(targetNativeSource?: string) {
  const root = createCodexCliTestRoot("ocx-apply-private-"); roots.push(root);
  return createCodexCliApplyFixture(root, process.platform, process.arch, targetNativeSource);
}
function depsFor(f: ReturnType<typeof fixture>, overrides: Partial<CodexCliApplyDeps> = {}): CodexCliApplyDeps {
  return { platform: process.platform, temporaryRoot: f.temporaryRoot,
    inspectionDeps: { env: f.env, configDir: join(f.home, "ocx"), selectionAttested: true, selectedCommand: f.launcher },
    scanProcesses: () => ({ kind: "observed", processes: [] }),
    resolveTarget: () => ({ kind: "resolved", version: "1.1.0", integrity: f.target.artifacts.main.integrity, artifacts: f.target.artifacts }),
    fetchArtifact: async artifact => artifact.version === "1.1.0" ? f.target.main.bytes : f.target.backing.bytes,
    ...overrides };
}
async function approved(f: ReturnType<typeof fixture>, deps = depsFor(f)) {
  const plan = await createCodexCliUpdatePlan(deps);
  expect(plan.applicable, JSON.stringify(plan)).toBe(true); expect(plan.planId).toMatch(/^[0-9a-f]{32}$/);
  return plan.planId!;
}
function cli(f: ReturnType<typeof fixture>, args: string[]) {
  const result = spawnSync(Bun.which("node")!, [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", ...args, "--json"], {
    cwd: repoRoot(), encoding: "utf8", env: f.env, timeout: 60_000,
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
function fixtureInWorkspaceScratch() {
  const scratch = join(repoRoot(), ".tmp");
  mkdirSync(scratch, { recursive: true });
  const stat = lstatSync(scratch);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(scratch) !== scratch) {
    throw new Error("workspace .tmp is not a private local directory");
  }
  const root = mkdtempSync(join(scratch, "codex-cli-management-e2e-")); roots.push(root);
  return createCodexCliApplyFixture(root, process.platform, process.arch);
}

function managementTestEnv(f: ReturnType<typeof fixture>) {
  const node = Bun.which("node");
  if (!node) throw new Error("fixture node executable unavailable");
  const home = f.home;
  const configDir = join(home, "ocx");
  const env: NodeJS.ProcessEnv = {
    PATH: [join(f.root, "bin"), join(f.prefix, "bin"), dirname(node), "/usr/bin", "/bin"].join(":"),
    HOME: home, CODEX_HOME: join(home, ".codex"), TMPDIR: f.temporaryRoot, TEMP: f.temporaryRoot, TMP: f.temporaryRoot,
    OPENCODEX_HOME: configDir, CODEX_CLI_PATH: f.launcher, OPENCODEX_BUN_PATH: process.execPath,
    OCX_NO_DESKTOP_HANDOFF: "1", NODE_COMPILE_CACHE: join(f.root, "node-compile-cache"),
    XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_CACHE_HOME: join(home, "xdg-cache"), XDG_DATA_HOME: join(home, "xdg-data"),
  };
  return { node, configDir, env };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("private listener port unavailable");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function startFixtureManagementServer(f: ReturnType<typeof fixture>, port: number, gate: string) {
  const { node, env } = managementTestEnv(f);
  env.OCX_FIXTURE_NPM_GATE = gate;
  const child = spawn(node, [repoPath("bin", "ocx.mjs"), "start", "--port", String(port)], {
    cwd: f.root, env, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-64 * 1024); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, closed, output: () => output, env };
}

async function waitForManagementServer(base: string, child: ChildProcess, closed: Promise<unknown>, output: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited early (${child.exitCode}); outputBytes=${Buffer.byteLength(output())}`);
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* the isolated listener is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`fixture server readiness timed out; outputBytes=${Buffer.byteLength(output())}`);
}

function closeOrTimeout(closed: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    closed.then(() => { clearTimeout(timer); resolve(true); });
  });
}

async function stopFixtureManagementServer(server: ReturnType<typeof startFixtureManagementServer>): Promise<void> {
  const pid = server.child.pid;
  if (!pid) throw new Error("fixture server pid unavailable during owned cleanup");
  const groupAlive = () => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill("SIGINT");
    await closeOrTimeout(server.closed, 10_000);
  }
  if (groupAlive()) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* owned process group already exited */ }
    await closeOrTimeout(server.closed, 5_000);
  }
  if (groupAlive()) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* owned process group already exited */ }
    await closeOrTimeout(server.closed, 2_000);
  }
}

async function issueFixtureGuiSession(base: string) {
  const origin = new URL(base).origin;
  const response = await fetch(`${base}/opencodex-session`, { headers: { origin } });
  if (!response.ok) throw new Error(`fixture GUI session refused (${response.status})`);
  const html = await response.text();
  const read = (name: string) => new RegExp(`<meta name="${name}" content="([^"]+)"`).exec(html)?.[1] ?? null;
  const token = read("opencodex-session-token"), csrf = read("opencodex-session-csrf");
  const browserOrigin = read("opencodex-session-origin");
  if (!token || !csrf || browserOrigin !== origin) throw new Error("fixture GUI session bootstrap invalid");
  return { token, csrf, origin };
}

function fixtureSessionHeaders(session: { token: string; csrf: string; origin: string }, write = false) {
  return { authorization: `Bearer ${session.token}`, origin: session.origin,
    "x-opencodex-gui-origin": session.origin,
    ...(write ? { "x-opencodex-csrf-token": session.csrf, "content-type": "application/json" } : {}) };
}

async function sendLostApplyResponse(base: string, session: { token: string; csrf: string; origin: string }, body: unknown) {
  const url = new URL(`${base}/api/codex/cli-update/apply`);
  const payload = Buffer.from(JSON.stringify(body));
  const headers = [
    `POST ${url.pathname} HTTP/1.1`, `Host: ${url.host}`, `Origin: ${session.origin}`,
    `Authorization: Bearer ${session.token}`, `x-opencodex-gui-origin: ${session.origin}`,
    `x-opencodex-csrf-token: ${session.csrf}`, "content-type: application/json",
    `content-length: ${payload.byteLength}`, "Connection: close", "", "",
  ].join("\r\n");
  return new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let connected = false;
    socket.once("error", error => { if (!connected) reject(error); });
    socket.once("connect", () => socket.write(Buffer.concat([Buffer.from(headers), payload]), error => {
      if (error) { socket.destroy(); reject(error); return; }
      connected = true;
      socket.pause();
      resolve(socket);
    }));
  });
}

async function waitForJob(base: string, session: { token: string; csrf: string; origin: string }, jobId: string,
  predicate: (value: Record<string, unknown>) => boolean, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/codex/cli-update/jobs/${jobId}`, { headers: fixtureSessionHeaders(session) });
    if (response.ok) {
      const value = await response.json() as Record<string, unknown>;
      if (predicate(value)) return value;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("fixture management job state timed out");
}

async function waitForDurableAdmission(configDir: string, requestId: string, timeoutMs = 10_000): Promise<string> {
  const file = join(configDir, "codex-cli-update-jobs", "jobs.json");
  const requestKey = createHash("sha256").update(requestId).digest("hex");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const value = JSON.parse(readFileSync(file, "utf8")) as { jobs?: Array<{ id?: string; requestKey?: string }> };
      const job = value.jobs?.find(entry => entry.requestKey === requestKey);
      if (job?.id) return job.id;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("fixture durable job admission was not observed");
}

function gateFixtureNpmInstall(f: Pick<ReturnType<typeof fixture>, "root">) {
  const path = join(f.root, "bin", "npm");
  const source = readFileSync(path, "utf8");
  const marker = "const installed = cp.spawnSync(";
  if (source.split(marker).length !== 2) throw new Error("fixture npm wrapper shape changed");
  const viewMarker = 'if (args[0] === "view") { if (!metadata[args[1]]) process.exit(81); console.log(JSON.stringify(metadata[args[1]])); process.exit(0); }';
  if (source.split(viewMarker).length !== 2) throw new Error("fixture npm metadata wrapper shape changed");
  const metadataTrace = join(f.root, "metadata-view-trace.jsonl");
  const tracedView = [
    'if (args[0] === "view") {',
    '  const spec = args[1], value = metadata[spec];',
    '  const stage = spec === "@openai/codex@latest" ? "latest" : value?.name === "@openai/codex" && value?.version?.includes("-") ? "backing" : "pinned";',
    `  fs.appendFileSync(${JSON.stringify(metadataTrace)}, JSON.stringify({stage,spec,exitCode:value?0:81,signal:null,spawnError:null,stdoutJsonValid:!!value,reason:value?"metadata_returned":"fixture_metadata_missing",name:value?.name??null,version:value?.version??null,optionalDependencyKeys:value?.optionalDependencies?Object.keys(value.optionalDependencies):[],hasIntegrity:typeof value?.dist?.integrity==="string",hasTarball:typeof value?.dist?.tarball==="string"})+"\\n");`,
    '  if (!value) process.exit(81); console.log(JSON.stringify(value)); process.exit(0);',
    '}',
  ].join("\n");
  const tracedSource = source.replace(viewMarker, tracedView);
  const wait = [
    'const fixtureGate = process.env.OCX_FIXTURE_NPM_GATE;',
    'if (fixtureGate) {',
    '  const cell = new Int32Array(new SharedArrayBuffer(4));',
    '  const deadline = Date.now() + 45000;',
    '  while (!fs.existsSync(fixtureGate) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 20);',
    '  if (!fs.existsSync(fixtureGate)) process.exit(85);',
    '}',
  ].join("\n") + "\n";
  writeFileSync(path, tracedSource.replace(marker, wait + marker), { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

async function postFixtureApply(base: string, session: { token: string; csrf: string; origin: string }, body: unknown) {
  return fetch(`${base}/api/codex/cli-update/apply`, { method: "POST", headers: fixtureSessionHeaders(session, true), body: JSON.stringify(body) });
}
test("HTTP fixture npm wrapper returns all metadata under an ESM ancestor", () => {
  const root = createCodexCliTestRoot("ocx-http-npm-module-"); roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const fakeBin = join(root, "bin"); mkdirSync(fakeBin);
  const node = Bun.which("node"); if (!node) throw new Error("fixture node unavailable");
  const f = fixtureArtifactSet("linux", "x64");
  const main = { ...f.mainManifest, dist: { integrity: f.artifacts.main.integrity, tarball: f.artifacts.main.tarball } };
  const backing = { name: f.artifacts.backing.name, version: f.artifacts.backing.version,
    dist: { integrity: f.artifacts.backing.integrity, tarball: f.artifacts.backing.tarball } };
  const metadata = { "@openai/codex@latest": main, "@openai/codex@1.1.0": main,
    ["@openai/codex@" + backing.version]: backing };
  const installTrace = join(root, "install-trace.jsonl");
  writeFixtureNpmWrapper(fakeBin, node, join(root, "unused-npm.cjs"), metadata, {}, installTrace);
  gateFixtureNpmInstall({ root });
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_COMPILE_CACHE: join(root, "node-cache") };
  for (const key of Object.keys(env)) if (["node_options", "node_path", "node_v8_coverage", "node_redirect_warnings"].includes(key.toLowerCase())) delete env[key];
  for (const [spec, expected] of Object.entries(metadata)) {
    const result = spawnSync(node, [join(fakeBin, "npm"), "view", spec, "--json"], {
      cwd: root, env, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect({ exitCode: result.status, spawnFailed: !!result.error,
      requireUndefined: result.stderr?.includes("require is not defined") }).toEqual({ exitCode: 0, spawnFailed: false, requireUndefined: false });
    expect(JSON.parse(result.stdout)).toEqual(expected);
  }
  const views = readFileSync(join(root, "metadata-view-trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(views.map(value => value.stage)).toEqual(["latest", "pinned", "backing"]);
  expect(views.every(value => value.reason === "metadata_returned")).toBe(true);
  expect(existsSync(installTrace)).toBe(false);
});
describe("default version verifier pre-child setup", () => {
  test("a mkdir failure is terminal without creating a child", async () => {
    const root = createCodexCliTestRoot("ocx-version-setup-"); roots.push(root);
    const home = join(root, "version-home");
    writeFileSync(home, "not a directory\n");
    expect(await verifyInstalledCodexVersion("", "1.1.0", root, {})).toEqual({
      terminal: true, ok: false, pid: null,
    });
    expect(readFileSync(home, "utf8")).toBe("not a directory\n");
  });
  test("a synchronous spawn throw is terminal without creating a child", async () => {
    const root = createCodexCliTestRoot("ocx-version-setup-"); roots.push(root);
    const command = "ocx-verifier\0must-not-spawn";
    expect(() => spawn(command, ["--version"], { cwd: root, env: {} })).toThrow(/null bytes/);
    expect(await verifyInstalledCodexVersion(command, "1.1.0", root, {})).toEqual({
      terminal: true, ok: false, pid: null,
    });
    expect(lstatSync(join(root, "version-home")).isDirectory()).toBe(true);
  });
});

describe.skipIf(!posix)("Codex CLI private-prefix POSIX apply", () => {
  test("a held lease and an unsupported prefix are distinct refusal inputs", () => {
    const root = createCodexCliTestRoot("ocx-lease-policy-"); roots.push(root);
    chmodSync(root, 0o700);
    const first = acquireCodexCliApplyLease(root);
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") throw new Error("owned private prefix lease unavailable");
    try { expect(acquireCodexCliApplyLease(root)).toEqual({ kind: "busy" }); }
    finally { expect(first.release()).toBe(true); }
    chmodSync(root, 0o770);
    expect(acquireCodexCliApplyLease(root)).toEqual({ kind: "prefix_unsupported" });
    expect(existsSync(join(root, ".ocx-codex-cli-apply.lock"))).toBe(false);
  });

  test("published Node launcher -> real resolver/provenance -> plan/apply -> verified new files", () => {
    const f = fixture();
    const plan = cli(f, ["plan"]);
    expect(plan.applicable).toBe(true); expect(plan.managed).toBe(true);
    expect(plan.targetArtifacts.backing.name).toBe("@openai/codex");
    const result = cli(f, ["apply", "--plan-id", plan.planId, "--yes"]);
    expect(result).toMatchObject({ status: "applied", outcome: "applied", childState: "terminal",
      leaseState: "not_acquired_or_released", lifetimeUncertain: false });
    const after = cli(f, ["check"]); expect(after.managed).toBe(true); expect(after.packageVersion).toBe("1.1.0");
    const calls = readFileSync(f.trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--offline"); expect(calls[0]).toContain("--ignore-scripts");
    expect(calls[0]![calls[0]!.indexOf("--prefix") + 1]).toBe(f.prefix);
    expect(calls[0]!.filter(arg => arg.includes("@file:"))).toHaveLength(2);
    expect(calls[0]!.join(" ")).not.toContain("@latest");
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
  }, 120_000);

  test("published Node launcher -> isolated management plan, lost-response apply retry, and CLI status", async () => {
    const f = fixtureInWorkspaceScratch();
    const gate = join(f.root, "release-npm-install");
    gateFixtureNpmInstall(f);
    const port = await reserveLoopbackPort();
    const base = `http://127.0.0.1:${port}`;
    let server = startFixtureManagementServer(f, port, gate);
    let releaseGate = false;
    let session: Awaited<ReturnType<typeof issueFixtureGuiSession>> | undefined;
    let jobId: string | undefined;
    let lostSocket: ReturnType<typeof connect> | undefined;
    let finishOldOwner: (() => void) | undefined;
    let oldOwnerWork: Promise<CodexCliUpdateJobDto | null> | undefined;
    try {
      await waitForManagementServer(base, server.child, server.closed, server.output);
      session = await issueFixtureGuiSession(base);
      const planResponse = await fetch(`${base}/api/codex/cli-update/plan`, { headers: fixtureSessionHeaders(session) });
      if (!planResponse.ok) throw new Error(`isolated production plan refused (${planResponse.status})`);
      const plan = await planResponse.json() as { schemaVersion?: number; applicable: boolean; refusal?: string | null;
        planId: string | null; provenance?: string; managed: boolean; installedVersion: string | null;
        targetVersion: string | null; installContentDigest: string | null;
        session?: { state?: string; matches?: number | null } };
      if (!plan.applicable || !plan.planId || !plan.managed || plan.installedVersion !== "1.0.0"
        || plan.targetVersion !== "1.1.0" || !plan.installContentDigest) {
        // Keep the diagnostic useful for separating missing launcher provenance from a
        // fixture/target refusal, without printing paths, commands, environment or IDs.
        const refusalCodes = ["windows_inspection_deferred", "windows_apply_disabled", "not_managed",
          "installed_version_unverified", "install_content_unverified", "target_unresolved", "already_current",
          "target_not_newer", "blocked_active_session", "blocked_process_state_unknown"];
        const provenanceKinds = ["npm-global", "app-bundle", "version-manager", "standalone-unverified", "unknown"];
        const sessionStates = ["none", "active", "unknown", "not-evaluated"];
        const diagnostic = {
          schemaVersion: plan.schemaVersion === 1 ? 1 : null, applicable: plan.applicable === true,
          refusal: typeof plan.refusal === "string" && refusalCodes.includes(plan.refusal) ? plan.refusal : null,
          provenance: typeof plan.provenance === "string" && provenanceKinds.includes(plan.provenance) ? plan.provenance : null,
          managed: plan.managed === true, planIdPresent: typeof plan.planId === "string",
          installedVersionMatches: plan.installedVersion === "1.0.0", targetVersionMatches: plan.targetVersion === "1.1.0",
          installContentDigestPresent: typeof plan.installContentDigest === "string",
          sessionState: typeof plan.session?.state === "string" && sessionStates.includes(plan.session.state) ? plan.session.state : null,
          sessionMatches: Number.isSafeInteger(plan.session?.matches) && (plan.session?.matches ?? -1) >= 0 ? plan.session!.matches : null,
          metadataQueries: existsSync(join(f.root, "metadata-view-trace.jsonl"))
            ? readFileSync(join(f.root, "metadata-view-trace.jsonl"), "utf8").split("\n").filter(Boolean)
              .map(line => JSON.parse(line) as { stage: string; spec: string; exitCode: number; signal: null;
                spawnError: null; stdoutJsonValid: boolean; reason: string; name: string | null; version: string | null;
                optionalDependencyKeys: string[]; hasIntegrity: boolean; hasTarball: boolean })
            : [],
        };
        throw new Error(`published launcher management plan was not applicable: ${JSON.stringify(diagnostic)}`);
      }

      const requestId = "lost-response-management-e2e-01";
      const applyBody = { requestId, planId: plan.planId, confirmed: true };
      lostSocket = await sendLostApplyResponse(base, session, applyBody);
      jobId = await waitForDurableAdmission(join(f.home, "ocx"), requestId);
      lostSocket.destroy(); lostSocket = undefined;
      const installTrace = join(f.root, "install-trace.jsonl");
      const installDeadline = Date.now() + 30_000;
      while (Date.now() < installDeadline) {
        const lines = existsSync(installTrace) ? readFileSync(installTrace, "utf8").split("\n").filter(Boolean) : [];
        if (lines.length > 0) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const beforeRetry = existsSync(installTrace) ? readFileSync(installTrace, "utf8").split("\n").filter(Boolean) : [];
      if (beforeRetry.length !== 1) throw new Error("lost HTTP response did not reach one fixture installer admission");

      const retry = await postFixtureApply(base, session, applyBody);
      if (retry.status !== 202) throw new Error(`same-key management retry returned ${retry.status}`);
      const retryBody = await retry.json() as { job?: { jobId?: string } };
      if (retryBody.job?.jobId !== jobId) throw new Error("same-key retry did not return the admitted job id");
      const conflict = await postFixtureApply(base, session, { ...applyBody, planId: "f".repeat(32) });
      if (conflict.status !== 409) throw new Error(`changed-payload key reuse returned ${conflict.status}`);
      const running = await fetch(`${base}/api/codex/cli-update/jobs/${jobId}`, { headers: fixtureSessionHeaders(session) });
      const runningDto = await running.json() as Record<string, unknown>;
      if (!running.ok || runningDto.status !== "running" || runningDto.ownerState !== "active"
        || runningDto.childState !== "active_or_not_observed" || runningDto.leaseState !== "unknown") {
        throw new Error("active fixture job status lost its execution/lease uncertainty projection");
      }
      const stillOneInstall = readFileSync(installTrace, "utf8").split("\n").filter(Boolean);
      if (stillOneInstall.length !== 1) throw new Error("idempotent response replay scheduled another installer");

      writeFileSync(gate, "release\n", { flag: "wx", mode: 0o600 });
      releaseGate = true;
      const terminal = await waitForJob(base, session, jobId,
        value => value.ownerState === "finished", 45_000);
      if (terminal.outcome !== "applied" || terminal.status !== "applied" || terminal.leaseState !== "not_acquired_or_released") {
        throw new Error("private fixture apply did not finish with verified installation and lease cleanup");
      }
      const args = JSON.parse(readFileSync(installTrace, "utf8").trim()) as string[];
      if (args.length === 0 || !args.includes("--offline") || !args.includes("--ignore-scripts")
        || args[args.indexOf("--prefix") + 1] !== f.prefix || args.filter(arg => arg.includes("@file:")).length !== 2) {
        throw new Error("private npm invocation escaped the fixture prefix or install restrictions");
      }

      const { node, env } = managementTestEnv(f);
      const cli = spawnSync(node, [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "status", jobId, "--json"], {
        cwd: f.root, encoding: "utf8", env, timeout: 30_000,
      });
      if (cli.error || cli.status !== 0) throw new Error("published CLI status consumer failed");
      const cliDto = JSON.parse(cli.stdout.trim()) as Record<string, unknown>;
      if (JSON.stringify(cliDto) !== JSON.stringify(terminal)) throw new Error("CLI and management job DTOs diverged");
      const publicDto = JSON.stringify(terminal);
      for (const privateValue of [f.root, f.home, f.prefix, session.token, session.csrf, gate]) {
        if (publicDto.includes(privateValue)) throw new Error("job DTO exposed fixture-private state");
      }
      for (const field of ["requestKey", "payloadHash", "generation", "ownerPid", "verificationPid", "environment", "token"]) {
        if (Object.hasOwn(terminal, field)) throw new Error("job DTO included a private schema field");
      }
      jobId = undefined;

      // Keep a separate old owner alive across the management server restart. The restarted
      // server must project its persisted running record as unknown, then accept only that
      // original generation's late completion.
      const configDir = join(f.home, "ocx");
      const restartPlanId = "b".repeat(32);
      const oldOwner = await admitCodexCliUpdateJob({ requestId: "server-restart-owner-unknown-01", planId: restartPlanId, confirmed: true, configDir });
      oldOwnerWork = runCodexCliUpdateJob(oldOwner.job.jobId, oldOwner.generation, () => new Promise(resolve => {
        finishOldOwner = () => resolve({ outcome: "applied", reason: "verified_target", planId: restartPlanId,
          installedVersion: "1.0.0", targetVersion: "1.1.0", installerExitCode: 0, leaseRetained: false,
          verificationPid: null, cleanupErrors: [] });
      }), configDir);
      const oldOwnerStatus = await fetch(`${base}/api/codex/cli-update/jobs/${oldOwner.job.jobId}`, { headers: fixtureSessionHeaders(session) });
      const oldOwnerDto = await oldOwnerStatus.json() as Record<string, unknown>;
      if (!oldOwnerStatus.ok || oldOwnerDto.ownerState !== "unknown" || oldOwnerDto.status !== "ambiguous"
        || oldOwnerDto.reason !== "owner_state_unknown") throw new Error("management API treated an unowned running record as stopped");

      await stopFixtureManagementServer(server);
      const restartedPort = await reserveLoopbackPort();
      const restartedBase = `http://127.0.0.1:${restartedPort}`;
      server = startFixtureManagementServer(f, restartedPort, gate);
      await waitForManagementServer(restartedBase, server.child, server.closed, server.output);
      const restartedSession = await issueFixtureGuiSession(restartedBase);
      const afterRestart = await fetch(`${restartedBase}/api/codex/cli-update/jobs/${oldOwner.job.jobId}`,
        { headers: fixtureSessionHeaders(restartedSession) });
      const restartedDto = await afterRestart.json() as Record<string, unknown>;
      if (!afterRestart.ok || restartedDto.ownerState !== "unknown" || restartedDto.reason !== "owner_state_unknown") {
        throw new Error("restarted management process inferred an old owner's termination");
      }
      finishOldOwner?.();
      const lateResult = await oldOwnerWork;
      const staleWrite = await finishCodexCliUpdateJob(oldOwner.job.jobId, oldOwner.generation, 1,
        { outcome: "refused", reason: "late_result", planId: restartPlanId, installedVersion: null,
          targetVersion: null, installerExitCode: null, leaseRetained: false, verificationPid: null,
          cleanupErrors: [] }, configDir);
      if (lateResult.outcome !== "applied" || staleWrite?.outcome !== "applied") {
        throw new Error("late old-generation state overwrote the owner's completed result");
      }
      const afterLate = await fetch(`${restartedBase}/api/codex/cli-update/jobs/${oldOwner.job.jobId}`,
        { headers: fixtureSessionHeaders(restartedSession) });
      const finalDto = await afterLate.json() as Record<string, unknown>;
      if (!afterLate.ok || finalDto.status !== "applied" || finalDto.ownerState !== "finished") {
        throw new Error("restarted management process did not observe the fenced owner completion");
      }
    } finally {
      finishOldOwner?.();
      if (oldOwnerWork) await oldOwnerWork.catch(() => undefined);
      lostSocket?.destroy();
      if (!releaseGate) {
        try { writeFileSync(gate, "release\n", { flag: "wx", mode: 0o600 }); } catch { /* gate was not installed */ }
      }
      if (session && jobId) {
        try { await waitForJob(base, session, jobId, value => value.ownerState === "finished", 45_000); }
        catch { /* preserve the primary assertion; the owned server is still drained below */ }
      }
      await stopFixtureManagementServer(server);
    }
  }, 120_000);

  test("published CLI packs and applies through a symlinked TMPDIR using canonical staging", () => {
    const f = fixture(); const alias = join(f.root, "tmp-alias");
    symlinkSync(f.temporaryRoot, alias, "dir");
    Object.assign(f.env, { TMPDIR: alias, NODE_COMPILE_CACHE: join(f.root, "node-compile-cache") });
    const plan = cli(f, ["plan"]); expect(plan.applicable).toBe(true);
    const result = cli(f, ["apply", "--plan-id", plan.planId, "--yes"]);
    expect(result).toMatchObject({ status: "applied", outcome: "applied", childState: "terminal",
      leaseState: "not_acquired_or_released", lifetimeUncertain: false });
    const after = cli(f, ["check"]);
    expect(after.managed).toBe(true); expect(after.packageVersion).toBe("1.1.0");
    const calls = readFileSync(f.trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    const archives = calls[0]!.filter(arg => arg.includes("@file:")).map(arg => arg.split("@file:")[1]!);
    expect(archives).toHaveLength(2);
    for (const archive of archives) { expect(archive.startsWith(f.temporaryRoot + "/")).toBe(true); expect(archive.startsWith(alias + "/")).toBe(false); }
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  }, 120_000);

  test.each(["stale-content", "same-version-integrity", "active", "unknown", "archive-tamper", "missing-backing"] as const)(
    "%s refuses before installer admission", async scenario => {
      const f = fixture(); let installs = 0;
      const deps = depsFor(f, { install: async () => { installs++; return { terminal: true, exitCode: 0 }; } });
      const id = await approved(f, deps);
      if (scenario === "stale-content") writeFileSync(join(f.prefix, "lib/node_modules/@openai/codex/bin/codex.js"), "#!/usr/bin/env node\n// changed bytes\n");
      const altered = { ...deps } as { -readonly [K in keyof CodexCliApplyDeps]: CodexCliApplyDeps[K] };
      if (scenario === "same-version-integrity") altered.resolveTarget = () => ({ kind: "resolved", version: "1.1.0", integrity: f.target.artifacts.main.integrity,
        artifacts: { ...f.target.artifacts, backing: { ...f.target.artifacts.backing, integrity: "sha512-" + Buffer.alloc(64, 8).toString("base64") } } });
      if (scenario === "active") altered.scanProcesses = () => ({ kind: "observed", processes: [{ pid: 1, command: "codex" }] } as never);
      if (scenario === "unknown") altered.scanProcesses = () => ({ kind: "unavailable" } as never);
      if (scenario === "archive-tamper") altered.fetchArtifact = async () => Buffer.from("invalid archive");
      if (scenario === "missing-backing") altered.fetchArtifact = async artifact => artifact.version === "1.1.0" ? f.target.main.bytes : f.target.main.bytes;
      const result = await applyCodexCliUpdate(id, altered);
      expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
      expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    }, 120_000,
  );
  test("a plan from a different prefix refuses without installing", async () => {
    const first = fixture(), second = fixture(); const id = await approved(first);
    let installs = 0;
    const result = await applyCodexCliUpdate(id, depsFor(second, { install: async () => { installs++; return { terminal: true, exitCode: 0 }; } }));
    expect(result.reason).toBe("plan_changed"); expect(installs).toBe(0);
  }, 120_000);
  test("content and selection are renewed after slow artifact preparation", async () => {
    const f = fixture(); let installs = 0;
    const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, {
      fetchArtifact: async artifact => {
        if (artifact.version !== "1.1.0") writeFileSync(join(f.prefix, "lib/node_modules/@openai/codex/bin/codex.js"), "#!/usr/bin/env node\n// changed during prepare\n");
        return artifact.version === "1.1.0" ? f.target.main.bytes : f.target.backing.bytes;
      }, install: async () => { installs++; return { terminal: true, exitCode: 0 }; },
    }));
    expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
  }, 120_000);
  test.each(["selection", "active", "unknown"] as const)("late %s change refuses after artifact preparation", async kind => {
    const f = fixture(); const id = await approved(f); let prepared = false, installs = 0;
    const result = await applyCodexCliUpdate(id, depsFor(f, {
      fetchArtifact: async artifact => {
        if (artifact.version !== "1.1.0") {
          prepared = true;
          if (kind === "selection") { unlinkSync(f.launcher); symlinkSync(f.target.main.path, f.launcher); }
        }
        return artifact.version === "1.1.0" ? f.target.main.bytes : f.target.backing.bytes;
      },
      scanProcesses: () => prepared && kind !== "selection"
        ? kind === "active" ? { kind: "observed", processes: [{ pid: 1, command: "codex" }] } as never : { kind: "unavailable" } as never
        : { kind: "observed", processes: [] },
      install: async () => { installs++; return { terminal: true, exitCode: 0 }; },
    }));
    expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
  }, 120_000);
  test("artifact fetch keeps the actual AbortSignal identity and event-listener contract", async () => {
    const f = fixture(), id = await approved(f), controller = new AbortController();
    const fence = createCodexCliUpdateFence();
    const signals: AbortSignal[] = [], listeners: Array<() => void> = [];
    let abortEvents = 0, installs = 0;
    try {
      const result = await applyCodexCliUpdate(id, depsFor(f, {
        signal: controller.signal, isCancelled: codexCliUpdateIsCancelled(fence),
        fetchArtifact: async (artifact, signal) => {
          expect(signal).toBe(controller.signal);
          expect(signal).toBeInstanceOf(AbortSignal);
          const listener = () => { abortEvents++; };
          signal!.addEventListener("abort", listener, { once: true });
          signals.push(signal!); listeners.push(listener);
          return artifact.installName === f.target.artifacts.main.installName ? f.target.main.bytes : f.target.backing.bytes;
        },
        install: () => { installs++; return Promise.resolve({ terminal: true, exitCode: 0 }); },
      }));
      expect(result).toMatchObject({ outcome: "not_applied", reason: "original_install_unchanged", leaseRetained: false });
      expect(signals).toHaveLength(2); expect(installs).toBe(1); expect(abortEvents).toBe(0);
      controller.abort(); expect(abortEvents).toBe(2);
      expect(codexCliUpdateIsCancelled(fence)()).toBe(false);
      expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
      expect(readdirSync(f.temporaryRoot)).toEqual([]);
    } finally {
      for (let i = 0; i < signals.length; i++) signals[i]!.removeEventListener("abort", listeners[i]!);
    }
  }, 120_000);
  test.each(["preimage-drift", "selection-change", "signal-abort", "sab-cancel"] as const)(
    "a %s while the process scan is pending refuses before install", async lane => {
      const f = fixture(); const id = await approved(f); let installs = 0;
      const controller = new AbortController(), fence = createCodexCliUpdateFence();
      const commitWindow = createWorkerCommitWindow({ gate: codexCliUpdateSelectionGate(), fence });
      let scans = 0, release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const scanEntered = new Promise<void>(resolve => { entered = resolve; });
      // Two plan scans precede the final scan. Only that final awaited scan is held.
      const pending = applyCodexCliUpdate(id, depsFor(f, {
        signal: controller.signal, isCancelled: codexCliUpdateIsCancelled(fence), commitWindow,
        scanProcessesAsync: async () => {
          if (++scans === 3) { entered(); await held; }
          return { kind: "observed", processes: [] };
        },
        install: () => { installs++; return Promise.resolve({ terminal: true, exitCode: 0 }); },
      }));
      try {
        await waitForApplyAdmission(scanEntered, pending); expect(scans).toBe(3);
        const writer = beginCodexCliSelectionParentWrite();
        try { expect(writer.entered).toBe(false); } finally { writer.exit(); }
        if (lane === "preimage-drift") writeFileSync(join(f.prefix, "lib/node_modules/@openai/codex/bin/codex.js"),
          "#!/usr/bin/env node\n// changed while the final scan was pending\n");
        if (lane === "selection-change") { unlinkSync(f.launcher); symlinkSync(f.target.main.path, f.launcher); }
        if (lane === "signal-abort") controller.abort();
        if (lane === "sab-cancel") {
          expect(cancelCodexCliUpdateFence(fence)).toBe(true);
          expect(controller.signal.aborted).toBe(false);
        }
        release(); const result = await pending;
        expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
        if (lane === "sab-cancel" || lane === "signal-abort") expect(result.reason).toBe("cancelled");
        expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
        expect(readdirSync(f.temporaryRoot)).toEqual([]);
        const next = beginCodexCliSelectionParentWrite();
        try { expect(next.entered).toBe(true); } finally { next.exit(); }
      } finally { release(); await pending.catch(() => {}); }
    }, 120_000);
  test("actual apply holds admission until installer termination and readback", async () => {
    const f = fixture(), id = await approved(f), fence = createCodexCliUpdateFence();
    const commitWindow = createWorkerCommitWindow({ gate: codexCliUpdateSelectionGate(), fence });
    let entered!: () => void, finish!: () => void, installs = 0, settled = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const terminal = new Promise<{ terminal: boolean; exitCode: number }>(resolve => {
      finish = () => resolve({ terminal: true, exitCode: 0 });
    });
    const pending = applyCodexCliUpdate(id, depsFor(f, {
      isCancelled: codexCliUpdateIsCancelled(fence), commitWindow,
      // Deliberately NOT async: this is the documented same-turn child-start seam.
      // It starts only this fake's admission marker, never the production installer.
      install: () => {
        installs++;
        expect(cancelCodexCliUpdateFence(fence)).toBe(false); // commit won before invocation
        expect(codexCliUpdateIsCancelled(fence)()).toBe(false);
        const writer = beginCodexCliSelectionParentWrite();
        try { expect(writer.entered).toBe(false); } finally { writer.exit(); }
        entered(); return terminal;
      },
    })).then(result => { settled = true; return result; });
    try {
      await waitForApplyAdmission(started, pending);
      expect(installs).toBe(1); expect(settled).toBe(false);
      const writer = beginCodexCliSelectionParentWrite();
      try { expect(writer.entered).toBe(false); } finally { writer.exit(); }
      expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(true);
      expect(readdirSync(f.temporaryRoot).length).toBeGreaterThan(0);
    } finally { finish(); await pending.catch(() => {}); }
    expect(await pending).toMatchObject({ outcome: "not_applied", reason: "original_install_unchanged", leaseRetained: false });
    expect(installs).toBe(1);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  }, 120_000);
  test("exit zero with original full files is not_applied", async () => {
    const f = fixture(); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async () => ({ terminal: true, exitCode: 0 }) }));
    expect(result.outcome, JSON.stringify(result)).toBe("not_applied"); expect(result.installerExitCode).toBe(0);
  }, 120_000);
  test("a newly installed sibling backing with unchanged nested-old main is ambiguous", async () => {
    const f = fixture();
    const mainRoot = join(f.prefix, "lib", "node_modules", "@openai", "codex");
    const sibling = join(f.prefix, "lib", "node_modules", ...f.old.artifacts.backing.installName.split("/"));
    const nestedScope = join(mainRoot, "node_modules", "@openai"); mkdirSync(nestedScope, { recursive: true });
    renameSync(sibling, join(nestedScope, f.old.artifacts.backing.installName.split("/")[1]!));
    const before = readFileSync(join(mainRoot, "package.json"), "utf8");
    const originalFiles = observeCodexCliFileSet([mainRoot]);
    expect(existsSync(sibling)).toBe(false);
    const id = await approved(f); let installs = 0;
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
      installs++;
      f.privateNpm(invocation.args.filter(arg => !arg.startsWith(f.target.artifacts.main.installName + "@file:")));
      return { terminal: true, exitCode: 17 };
    } }));
    expect(installs).toBe(1); expect(result.outcome).toBe("ambiguous");
    expect(result.reason).toBe("installation_readback_unverified"); expect(result.leaseRetained).toBe(false);
    expect(result.installedVersion).toBe("1.0.0");
    expect(sameCodexCliFiles(originalFiles, observeCodexCliFileSet([mainRoot]))).toBe(true);
    expect(readFileSync(join(mainRoot, "package.json"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(sibling, "package.json"), "utf8")).version).toBe(f.target.artifacts.backing.version);
  }, 120_000);
  test.each(["complete-nonzero", "missing-auxiliary", "changed-auxiliary", "main-only", "native-nonexecutable"] as const)(
    "%s is classified by complete readback, not installer exit", async scenario => {
      const f = fixture(); const id = await approved(f);
      const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
        const args = scenario === "main-only" ? invocation.args.filter(arg => !arg.startsWith(f.target.artifacts.backing.installName + "@file:")) : [...invocation.args];
        f.privateNpm([...args]);
        const auxiliary = join(f.prefix, "lib", "node_modules", ...f.target.artifacts.backing.installName.split("/"), "vendor/auxiliary.txt");
        if (scenario === "missing-auxiliary") rmSync(auxiliary);
        if (scenario === "changed-auxiliary") writeFileSync(auxiliary, "synthetic auxiliary CHANGED\n");
        if (scenario === "native-nonexecutable") chmodSync(join(f.prefix, "lib", "node_modules", ...f.target.artifacts.backing.installName.split("/"),
          "vendor", codexCliPlatformBacking(process.platform, process.arch)!.triple, "bin/codex"), 0o644);
        return { terminal: true, exitCode: scenario === "complete-nonzero" ? 17 : 0 };
      } }));
      expect(result.outcome, JSON.stringify(result)).toBe(scenario === "complete-nonzero" ? "applied" : "ambiguous");
      expect(result.leaseRetained).toBe(false);
    }, 120_000,
  );
  test.skipIf(process.geteuid?.() === 0)("mode 0641 is not executable by the nonroot file owner", async () => {
    const f = fixture(); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
      f.privateNpm([...invocation.args]);
      chmodSync(join(f.prefix, "lib", "node_modules", ...f.target.artifacts.backing.installName.split("/"),
        "vendor", codexCliPlatformBacking(process.platform, process.arch)!.triple, "bin/codex"), 0o641);
      return { terminal: true, exitCode: 0 };
    } }));
    expect(result.outcome).toBe("ambiguous");
  }, 120_000);
  test.each(["#!/bin/sh\nexit 7\n", "#!/bin/sh\nprintf 'codex-cli 9.9.9\\n'\n"])("verified bytes with unsuccessful/wrong version execution are ambiguous", async source => {
    const f = fixture(source); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
      f.privateNpm([...invocation.args]); return { terminal: true, exitCode: 0 };
    } }));
    expect(result.outcome, JSON.stringify(result)).toBe("ambiguous"); expect(result.reason, JSON.stringify(result)).toBe("version_readback_unverified");
    expect(result.leaseRetained).toBe(false); expect(result.verificationPid).toBeNull();
  }, 120_000);
  test("uncertain owned version child retains lease/staging and exposes its PID", async () => {
    const f = fixture(); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
      f.privateNpm([...invocation.args]); return { terminal: true, exitCode: 0 };
    }, verifyVersion: async () => ({ terminal: false, ok: false, pid: 12345 }) }));
    expect(result.outcome).toBe("ambiguous"); expect(result.reason).toBe("version_process_state_unknown");
    expect(result.leaseRetained).toBe(true); expect(result.verificationPid).toBe(12345);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(true);
    expect(readdirSync(f.temporaryRoot).length).toBeGreaterThan(0);
    // Only an injected lifetime observation: there is no actual PID 12345 owned here.
  }, 120_000);
  test("empty and damaged apply locks remain busy without reclaim", async () => {
    const f = fixture(); const id = await approved(f); let installs = 0;
    const path = join(f.prefix, ".ocx-codex-cli-apply.lock"); mkdirSync(path, { mode: 0o700 });
    for (const owner of [null, "", "{broken"]) {
      if (owner !== null) writeFileSync(join(path, "owner.json"), owner);
      const result = await applyCodexCliUpdate(id, depsFor(f, { install: async () => { installs++; return { terminal: true, exitCode: 0 }; } }));
      expect(result.reason).toBe("installation_busy"); expect(existsSync(path)).toBe(true);
    }
    expect(installs).toBe(0);
  }, 120_000);
  test("one prefix lease excludes a concurrent apply and remains held for an uncertain installer", async () => {
    const f = fixture(); const id = await approved(f);
    let resume!: () => void; let entered!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve; });
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const first = applyCodexCliUpdate(id, depsFor(f, { fetchArtifact: async artifact => {
      entered(); await pending; return artifact.version === "1.1.0" ? f.target.main.bytes : f.target.backing.bytes;
    }, install: async () => ({ terminal: false, exitCode: null }) }));
    try {
      await waitForApplyAdmission(admitted, first);
      const other = await applyCodexCliUpdate(id, depsFor(f));
      expect(other.reason, JSON.stringify(other)).toBe("installation_busy");
    } finally { resume(); await first.catch(() => {}); }
    const result = await first;
    expect(result.outcome).toBe("ambiguous"); expect(result.leaseRetained).toBe(true);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(true);
    expect(acquireCodexCliApplyLease(f.prefix)).toEqual({ kind: "busy" });
    // The uncertain child is a test double; no real installer survives teardown.
  }, 120_000);
  test("original file mode damage is ambiguous, not not_applied", async () => {
    const f = fixture(); const id = await approved(f);
    const native = join(f.prefix, "lib", "node_modules", ...f.old.artifacts.backing.installName.split("/"),
      "vendor", codexCliPlatformBacking(process.platform, process.arch)!.triple, "bin/codex");
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async () => {
      chmodSync(native, 0o644); return { terminal: true, exitCode: 0 };
    } }));
    expect(result.outcome).toBe("ambiguous");
  }, 120_000);
  test("cancellation during npm waits for terminal state, keeping lease and staging until readback", async () => {
    const f = fixture(); const id = await approved(f); const controller = new AbortController();
    let close!: () => void, admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    const terminal = new Promise<void>(resolve => { close = resolve; });
    let done = false;
    const running = applyCodexCliUpdate(id, depsFor(f, { signal: controller.signal, install: async () => {
      admitted(); await terminal; return { terminal: true, exitCode: 0 };
    } })).then(result => { done = true; return result; });
    try {
      await waitForApplyAdmission(started, running); controller.abort(); await Promise.resolve();
      expect(done).toBe(false); expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(true);
      expect(readdirSync(f.temporaryRoot).length).toBeGreaterThan(0);
    } finally { close(); await running.catch(() => {}); }
    const result = await running;
    expect(result.outcome, JSON.stringify(result)).toBe("not_applied"); expect(result.leaseRetained).toBe(false);
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  }, 120_000);
  test.each(["cancel", "error"] as const)("%s during preparation releases only its own lease", async kind => {
    const f = fixture(); const id = await approved(f); const controller = new AbortController();
    let installs = 0;
    const result = await applyCodexCliUpdate(id, depsFor(f, { signal: controller.signal,
      fetchArtifact: async () => { if (kind === "error") throw new Error("synthetic failure"); controller.abort(); return f.target.main.bytes; },
      install: async () => { installs++; return { terminal: true, exitCode: 0 }; },
    }));
    expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  }, 120_000);
  test("lease cleanup failure preserves the original outcome and still removes staging", async () => {
    const f = fixture(); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, {
      acquireLease: prefix => {
        const owned = acquireCodexCliApplyLease(prefix); if (owned.kind !== "acquired") return owned;
        return { kind: "acquired", release: () => { owned.release(); throw new Error("injected cleanup failure"); } };
      },
      install: async () => ({ terminal: true, exitCode: 0 }),
    }));
    expect(result.outcome, JSON.stringify(result)).toBe("not_applied");
    expect(result.cleanupErrors).toEqual(["lease_release_exception"]);
    expect(result.leaseRetained).toBe(true); expect(readdirSync(f.temporaryRoot)).toEqual([]);
  }, 120_000);
  test("a default verifier setup failure before any child releases the lease", async () => {
    const f = fixture(); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
      f.privateNpm([...invocation.args]);
      const staging = readdirSync(f.temporaryRoot).find(name => name.startsWith("ocx-codex-cli-apply-"));
      expect(staging).toBeDefined();
      writeFileSync(join(f.temporaryRoot, staging!, "version-home"), "not a directory\n"); // mkdirSync fails EEXIST
      return { terminal: true, exitCode: 0 };
    } }));
    expect(result.outcome, JSON.stringify(result)).toBe("ambiguous");
    expect(result.reason).toBe("version_readback_unverified");
    expect(result.leaseRetained).toBe(false); expect(result.verificationPid).toBeNull();
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    const again = await applyCodexCliUpdate(id, depsFor(f));
    expect(again.reason, JSON.stringify(again)).not.toBe("installation_busy");
  }, 120_000);
});
