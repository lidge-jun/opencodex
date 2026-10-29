import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGEMENT_ROUTES } from "../../src/server/management/route-registry";
import { handleCodexCliUpdateRoutes } from "../../src/server/management/codex-cli-update-routes";
import * as updateJobs from "../../src/codex/cli-update-job";
import * as cliUpdatePlanModule from "../../src/codex/cli-update-plan";
import * as cliUpdateWorkerModule from "../../src/codex/cli-update-job-worker";
import type { ManagementContext } from "../../src/server/management/context";
import { initializeNodeLauncherContext, NODE_LAUNCH_CONTEXT_ENV, NODE_LAUNCH_PROOF_PREFIX } from "../../src/cli/launcher-context";
import { SIBLING_REFUSED_MANAGEMENT_PATHS, siblingRefusesManagementRequest } from "../../src/server/management/sibling-guard";
import { markSiblingStart, resetSiblingStartForTests } from "../../src/codex/sibling-start";
import { scanRoutes, distinctRoutes } from "../helpers/management-route-scan";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * Reconciles the declared route registry against source, in three directions.
 *
 * Why three, and why none of them is sufficient alone -- stated here because the
 * original plan for this gate specified ONE mechanism that could not work, and a future
 * reader is otherwise likely to "simplify" it back:
 *
 * 1. SOURCE -> REGISTRY. Every `(method, path)` pair resolvable from source must be
 *    declared. Catches an added route. Cannot see the 18 routes registered by regex,
 *    `endsWith`, `slice`, prefix decode, or a path constant.
 * 2. REGISTRY -> SOURCE. Every declared literal route's path must appear in its declared
 *    owner file. Catches a typo or a stale declaration. Cannot hold for the 18
 *    non-literal routes, whose paths contain `{param}` placeholders that appear nowhere.
 * 3. PER-MODULE RECONCILIATION. For each module, declared count must equal scanned pairs
 *    plus declared non-literal routes. This is the one that catches an UNDER-declared
 *    registry: a route omitted from the registry AND invisible to check 1 is invisible
 *    to both other checks, and that is precisely where a gate passes vacuously.
 *
 * The reconciliation counts `(method, path)` PAIRS, never `rg` line hits. Line counting
 * cannot balance: one guard registers two routes when it reads `PUT || PATCH`, nineteen
 * path guards decide their method in a preceding sibling guard or a nested one, and two
 * live routes are written `pathname !== "…"` so an equality scan never sees them. One
 * module has one route and zero equality literals.
 *
 * The scanner fails loud: a path guard whose method it cannot resolve comes back with
 * `method: null` and test 4 fails on it. It never assumes GET.
 */
const repoRoot = resolveRepoRoot();

/** Files that carry management routes. Kept explicit: two live outside `management/`. */
function routeCarryingFiles(): string[] {
  const files = [
    "src/server/management-api.ts",
    // Mounted outside the `??` chain (management-api.ts:284, :289), which is why a scan
    // scoped to `src/server/management/` misses 29 route literals entirely.
    "src/codex/auth-api/routes.ts",
    "src/codex/native-profile-api.ts",
  ];
  for (const f of readdirSync(join(repoRoot, "src/server/management")).sort()) {
    // Skip the registry itself: it is a data table whose doc comment quotes route paths,
    // so scanning it would reconcile the declaration against its own prose.
    if (f.endsWith(".ts") && f !== "route-registry.ts") files.push(`src/server/management/${f}`);
  }
  return files;
}

const moduleOf = (file: string): string => file.replace(/^src\//, "").replace(/\.ts$/, "");
const key = (method: string, path: string): string => `${method} ${path}`;

describe("management route registry reconciliation", () => {
  test("dashboard plan uses the shared proof-bound production inspection path", async () => {
    const proof = "P".repeat(43);
    const root = process.platform === "win32" ? "C:\\fixture-only" : "/tmp/fixture-only";
    const candidate = process.platform === "win32" ? "C:\\fixture-only\\codex.cmd" : "/tmp/fixture-only/codex";
    const env: NodeJS.ProcessEnv = { [NODE_LAUNCH_CONTEXT_ENV]: JSON.stringify({ version: 1, proof, anthropicEnvSlots: [],
      codexCliInspectionEnv: { codexCliPath: candidate, path: root, pathExt: null, managerRoots: {}, transportEnv: {},
        arch: process.arch, configDir: root } }) };
    initializeNodeLauncherContext(["bun", "test", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], env);
    try {
      const request = new Request("http://localhost/api/codex/cli-update/plan");
      const ctx: ManagementContext = { req: request, url: new URL(request.url), config: { port: 10100, providers: {} } as import("../../src/types").OcxConfig,
        deps: {}, version: "test", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
        convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
        syncClaudeAgentDefsBestEffort: async () => {} };
      const response = await handleCodexCliUpdateRoutes(ctx);
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ applicable: false, schemaVersion: 1 });
    } finally { initializeNodeLauncherContext(["bun", "test"], {}); }
  });

  test("a gated registry child leaves concurrent management requests responsive", async () => {
    // Regression for the planning P1: a slow npm query must not park the proxy event
    // loop. The gated child answers like npm view --json but only once the release
    // file appears — with its own cap so a regression cannot hang the suite — and it
    // runs through the production async spawn runner, not a mocked event loop.
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-cli-update-gated-npm-")));
    const gateFile = join(dir, "release");
    // Hosted Windows took 2703ms before answering (run 40796504652). Keep
    // responsiveness relative to the child's cap, with room for runner contention.
    const gateCapMs = process.platform === "win32" ? INTERNAL_DEADLINE_MS : 4_000;
    const responsiveMs = gateCapMs * 5 / 8;
    const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
    const mainJson = JSON.stringify({ name: "@openai/codex", version: "1.4.2",
      optionalDependencies: { "@openai/codex-linux-x64": "1.4.2" },
      dist: { integrity, tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.4.2.tgz" } });
    const backingJson = JSON.stringify({ name: "@openai/codex-linux-x64", version: "1.4.2",
      dist: { integrity, tarball: "https://registry.npmjs.org/@openai/codex-linux-x64/-/codex-linux-x64-1.4.2.tgz" } });
    const gatedSpawn: cliUpdatePlanModule.CodexCliUpdateSpawn = (_bin, args, options) =>
      cliUpdatePlanModule.spawnCodexCliUpdateMetadata(process.execPath, [
        "-e",
        'const fs=require("node:fs"),g=process.env.OCX_GATE_FILE,a=process.env.OCX_GATE_ANSWER,d=Date.now()+Number(process.env.OCX_GATE_CAP_MS);'
        + 'const t=setInterval(()=>{if(!fs.existsSync(g)&&Date.now()<=d)return;clearInterval(t);process.stdout.write(a+"\\n",()=>process.exit(0))},15)',
      ], { ...options, timeout: SPAWN_BUDGET_MS, windowsVerbatimArguments: false,
        env: { ...options.env, OCX_GATE_FILE: gateFile, OCX_GATE_CAP_MS: String(gateCapMs),
          OCX_GATE_ANSWER: args.join(" ").includes("@openai/codex-linux-x64@") ? backingJson : mainJson } });
    const managed = { schemaVersion: 1, candidateAvailable: true, candidateVersion: "1.0.0",
      candidateSource: "environment", selectionAttested: true,
      versionEvidence: { kind: "package-manifest" }, provenance: "npm-global", managed: true,
      reason: "managed_npm_global", location: "<npm-global>/@openai/codex",
      installDigest: "a".repeat(64), installContentDigest: "c".repeat(64),
      packageVersion: "1.0.0", shim: { status: "not-tracked", backingKind: null },
      evidence: ["package_manifest", "global_npm_layout"] };
    const realPlan = cliUpdatePlanModule.createCodexCliUpdatePlan;
    // The route dispatches into another realm: parent planner spies cannot reach it.
    // This dispatch seam tests HTTP + real async metadata-child behavior only;
    // cli-update-worker.test.ts separately exercises the actual Worker boundary.
    const planner = spyOn(cliUpdateWorkerModule, "runCodexCliUpdatePlanInWorker").mockImplementation(() =>
      realPlan({ platform: "linux", inspectionDeps: { arch: "x64" }, inspect: async () => managed as never,
        spawnProcess: gatedSpawn,
        scanProcessesAsync: async () => ({ kind: "observed", processes: [] }) }));
    const oldHome = process.env.OPENCODEX_HOME;
    const emptyHome = join(dir, "empty-home");
    mkdirSync(emptyHome, { recursive: true });
    process.env.OPENCODEX_HOME = emptyHome;
    let responseDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const makeCtx = (pathname: string): ManagementContext => {
        const req = new Request(`http://localhost${pathname}`);
        return { req, url: new URL(req.url), config: { port: 10100, providers: {} } as import("../../src/types").OcxConfig,
          deps: {}, version: "test", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
          convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
          syncClaudeAgentDefsBestEffort: async () => {} };
      };
      const planPromise = handleCodexCliUpdateRoutes(makeCtx("/api/codex/cli-update/plan"));
      // Let the first gated child spawn, then an unrelated request must still answer.
      const firedAt = Date.now();
      await new Promise(resolve => setTimeout(resolve, 150));
      const concurrent = await Promise.race([
        handleCodexCliUpdateRoutes(makeCtx("/api/codex/cli-update/jobs/11111111-2222-3333-4444-555555555555"))
          .then(response => ({ kind: "responded" as const, response })),
        new Promise<{ kind: "blocked" }>(resolve => { responseDeadline = setTimeout(() => resolve({ kind: "blocked" }), responsiveMs); }),
      ]);
      // Under a synchronous spawn this race can only settle after the child cap.
      expect(concurrent.kind).toBe("responded");
      // A parked event loop defers BOTH arms past the child cap, so the response
      // arriving "first" is not enough — the wall clock is the discriminator.
      expect(Date.now() - firedAt).toBeLessThan(responsiveMs);
      if (concurrent.kind === "responded") {
        // POSIX reads an empty store (404); Windows refuses the unsupported store
        // lane (503). Either way the unrelated request answered while planning waited.
        expect([404, 503]).toContain(concurrent.response?.status ?? 0);
      }
      writeFileSync(gateFile, "release");
      const response = await planPromise;
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ applicable: true, targetVersion: "1.4.2" });
      expect(planner).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(responseDeadline);
      planner.mockRestore();
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(dir, { recursive: true, force: true });
    }
  }, SPAWN_BUDGET_MS);

  test("plan dispatch failure returns HTTP 503 without a second dispatch", async () => {
    const dispatch = spyOn(cliUpdateWorkerModule, "runCodexCliUpdatePlanInWorker")
      .mockRejectedValue(new Error("plan_unavailable"));
    const req = new Request("http://localhost/api/codex/cli-update/plan");
    const ctx: ManagementContext = { req, url: new URL(req.url),
      config: { port: 10100, providers: {} } as import("../../src/types").OcxConfig,
      deps: {}, version: "test", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
      convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
      syncClaudeAgentDefsBestEffort: async () => {} };
    try {
      const response = await handleCodexCliUpdateRoutes(ctx);
      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({ error: "plan_unavailable" });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { dispatch.mockRestore(); }
  });

  test("Codex CLI HTTP apply requires a GUI session and trusted loopback before admission", async () => {
    const config = { port: 10100, providers: {} } as import("../../src/types").OcxConfig;
    const request = new Request("http://localhost/api/codex/cli-update/apply", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "retry-key-00001", planId: "a".repeat(32), confirmed: true }),
    });
    const ctx: ManagementContext = { req: request, url: new URL(request.url), config, deps: {}, version: "test",
      principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
      convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
      syncClaudeAgentDefsBestEffort: async () => {} };
    const response = await handleCodexCliUpdateRoutes(ctx);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "local_dashboard_confirmation_required" });
    ctx.principal = "gui-session";
    ctx.trustedLoopbackIngress = false;
    const untrustedIngress = await handleCodexCliUpdateRoutes(ctx);
    expect(untrustedIngress?.status).toBe(403);
    expect(await untrustedIngress?.json()).toEqual({ error: "local_dashboard_confirmation_required" });
    ctx.trustedLoopbackIngress = true;
    ctx.req = new Request(request.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "retry-key-00001", planId: "a".repeat(32), confirmed: false }) });
    const unconfirmed = await handleCodexCliUpdateRoutes(ctx);
    expect(unconfirmed?.status).toBe(400);
    ctx.req = new Request(request.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "retry-key-00001", planId: "a".repeat(32), confirmed: true,
        prefix: "/tmp/ignored", executable: "/tmp/ignored", managed: true, selectionAttested: true }) });
    const clientEvidence = await handleCodexCliUpdateRoutes(ctx);
    expect(clientEvidence?.status).toBe(400);
  });

  test.each(["job_store_busy", "store_full"])("HTTP admission %s schedules no worker and only contention advertises retry", async code => {
    const admission = spyOn(updateJobs, "admitCodexCliUpdateJob").mockImplementation(() => { throw new Error(code); });
    const worker = spyOn(updateJobs, "runCodexCliUpdateJob");
    try {
      const req = new Request("http://localhost/api/codex/cli-update/apply", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "busy-response-01", planId: "e".repeat(32), confirmed: true }) });
      const ctx: ManagementContext = { req, url: new URL(req.url),
        config: { port: 10100, providers: {} } as import("../../src/types").OcxConfig, deps: {}, version: "test",
        principal: "gui-session", trustedLoopbackIngress: true, guiSessionIssuance: "loopback",
        convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
        syncClaudeAgentDefsBestEffort: async () => {} };
      const response = await handleCodexCliUpdateRoutes(ctx);
      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({ error: code });
      expect(response?.headers.get("Retry-After")).toBe(code === "job_store_busy" ? "1" : null);
      expect(worker).not.toHaveBeenCalled();
    } finally { admission.mockRestore(); worker.mockRestore(); }
  });

  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("HTTP apply retry returns the durable job without scheduling a second engine run", async () => {
    const outer = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-cli-update-http-test-")));
    const parent = join(outer, "private-parent"), configDir = join(parent, "ocx");
    const oldHome = process.env.OPENCODEX_HOME;
    try {
      chmodSync(outer, 0o700);
      mkdirSync(parent, { mode: 0o700 }); chmodSync(parent, 0o700);
      mkdirSync(configDir, { mode: 0o700 }); chmodSync(configDir, 0o700);
      process.env.OPENCODEX_HOME = realpathSync.native(configDir);
      const makeRequest = () => new Request("http://localhost/api/codex/cli-update/apply", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "lost-response-retry-01", planId: "e".repeat(32), confirmed: true }) });
      const ctx: ManagementContext = { req: makeRequest(), url: new URL("http://localhost/api/codex/cli-update/apply"),
        config: { port: 10100, providers: {} } as import("../../src/types").OcxConfig, deps: {}, version: "test",
        principal: "gui-session", trustedLoopbackIngress: true, guiSessionIssuance: "loopback",
        convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
        syncClaudeAgentDefsBestEffort: async () => {} };
      const storeDir = join(configDir, "codex-cli-update-jobs"), heldLock = join(storeDir, "admission.lock");
      mkdirSync(storeDir, { mode: 0o700 }); chmodSync(storeDir, 0o700);
      mkdirSync(heldLock, { mode: 0o700 });
      const worker = spyOn(updateJobs, "runCodexCliUpdateJob");
      try {
        const busy = await handleCodexCliUpdateRoutes(ctx);
        expect(busy?.status).toBe(503);
        expect(await busy?.json()).toEqual({ error: "job_store_busy" });
        expect(busy?.headers.get("Retry-After")).toBe("1");
        expect(worker).not.toHaveBeenCalled();
        expect(existsSync(join(storeDir, "jobs.json"))).toBe(false);
      } finally { worker.mockRestore(); rmSync(heldLock, { recursive: true }); }
      ctx.req = makeRequest();
      const first = await handleCodexCliUpdateRoutes(ctx);
      const firstBody = await first!.json();
      ctx.req = makeRequest();
      const retry = await handleCodexCliUpdateRoutes(ctx);
      const retryBody = await retry!.json();
      const diagnostic = (body: { error?: unknown }) => JSON.stringify({ error:
        typeof body.error === "string" && ["invalid_request", "idempotency_conflict", "store_full",
          "unsupported_store", "unsafe_store", "admission_failed"].includes(body.error) ? body.error : null });
      expect(first?.status, diagnostic(firstBody)).toBe(202);
      expect(retry?.status, diagnostic(retryBody)).toBe(202);
      expect(retryBody.job.jobId).toBe(firstBody.job.jobId);
      let status: { jobId?: string; ownerState?: string; outcome?: string; reason?: string } = {};
      for (let i = 0; i < 100; i += 1) {
        const statusRequest = new Request(`http://localhost/api/codex/cli-update/jobs/${firstBody.job.jobId}`);
        ctx.req = statusRequest; ctx.url = new URL(statusRequest.url);
        status = await (await handleCodexCliUpdateRoutes(ctx))!.json() as typeof status;
        if (status.ownerState === "finished") break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(status).toMatchObject({ jobId: firstBody.job.jobId, ownerState: "finished", outcome: "refused" });
      expect(["not_managed", "mutation_evidence_unverified"].includes(status.reason ?? "")).toBe(true);
    } finally {
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
      rmSync(outer, { recursive: true });
    }
  });

  test("data-key reveal is declared as a dashboard-session-only read", () => {
    expect(MANAGEMENT_ROUTES.find(route => route.method === "POST" && route.path === "/api/keys/reveal"))
      .toMatchObject({ module: "server/management/oauth-account-routes", mutates: false, exempt: { reason: "session-only" } });
  });

  test("the constant-backed Hermes profile list is explicitly declared", () => {
    expect(MANAGEMENT_ROUTES.find(route =>
      route.method === "GET" && route.path === "/api/client-integrations/hermes/profiles"))
      .toMatchObject({
        module: "server/management/hermes-profile-routes",
        mutates: false,
        mechanism: "path-constant",
        exempt: { reason: "gui-only" },
      });
  });

  test("every route resolvable from source is declared in the registry", () => {
    const declared = new Set(MANAGEMENT_ROUTES.map(r => key(r.method, r.path)));
    const undeclared: string[] = [];
    for (const file of routeCarryingFiles()) {
      const { pairs } = distinctRoutes(scanRoutes(join(repoRoot, file)));
      for (const pair of pairs) {
        if (!declared.has(pair)) undeclared.push(`${pair}  (${file})`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  test("every declared literal route's path appears in its owner module", () => {
    const missing: string[] = [];
    const cache = new Map<string, string>();
    for (const route of MANAGEMENT_ROUTES) {
      // Non-literal routes carry `{param}` placeholders or live behind a constant, so
      // their path is not present as text. Check 3 covers them instead.
      if (route.mechanism) continue;
      const file = `src/${route.module}.ts`;
      let src = cache.get(file);
      if (src === undefined) {
        src = readFileSync(join(repoRoot, file), "utf8");
        cache.set(file, src);
      }
      if (!src.includes(`"${route.path}"`)) missing.push(`${key(route.method, route.path)} not in ${file}`);
    }
    expect(missing).toEqual([]);
  });

  test("per-module counts reconcile: declared == scanned pairs + declared non-literal", () => {
    const mismatches: string[] = [];
    for (const file of routeCarryingFiles()) {
      const mod = moduleOf(file);
      const { pairs } = distinctRoutes(scanRoutes(join(repoRoot, file)));
      const declaredForModule = MANAGEMENT_ROUTES.filter(r => r.module === mod);
      const nonLiteral = declaredForModule.filter(r => r.mechanism);
      // A non-literal route can ALSO be scannable (a negated guard is both), so count
      // the union rather than adding two overlapping sets.
      const expected = new Set<string>(pairs);
      for (const r of nonLiteral) expected.add(key(r.method, r.path));
      const actual = new Set(declaredForModule.map(r => key(r.method, r.path)));
      if (expected.size !== actual.size) {
        const onlyExpected = [...expected].filter(k => !actual.has(k));
        const onlyActual = [...actual].filter(k => !expected.has(k));
        mismatches.push(`${mod}: expected ${expected.size} got ${actual.size}; missing=[${onlyExpected}] extra=[${onlyActual}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("the scanner resolves a method for every route guard it finds", () => {
    // Fail loud, never guess. An unresolvable guard means the scanner needs a new
    // narrowing rule, not a default.
    const unresolved: string[] = [];
    for (const file of routeCarryingFiles()) {
      for (const r of distinctRoutes(scanRoutes(join(repoRoot, file))).unresolved) {
        unresolved.push(`${file}:${r.line} ${r.path}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  test("the scanner reports an unresolvable method instead of assuming GET", () => {
    // Drives the fail-loud path red on purpose: without this, a scanner that silently
    // defaulted to GET would satisfy every other test in this file while producing a
    // route table nobody could trust.
    const tempDir = mkdtempSync(join(tmpdir(), "ocx-route-scanner-"));
    const tmp = join(tempDir, "scanner-probe.ts");
    const source = [
      "export async function handleProbe(ctx: any): Promise<Response | null> {",
      "  const { url, req } = ctx;",
      "  const chosen = req.method;",
      '  if (url.pathname === "/api/probe/unknowable") {',
      "    return dispatch(chosen);",
      "  }",
      "  return null;",
      "}",
    ].join("\n");
    try {
      writeFileSync(tmp, source);
      const { unresolved } = distinctRoutes(scanRoutes(tmp));
      expect(unresolved.map(r => r.path)).toEqual(["/api/probe/unknowable"]);
      expect(unresolved[0]?.method).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("a pure delegation guard is not a route, but a guard that works is still read", () => {
    // `/api/codex-auth/main/reauth-device` (#3898) is matched in management-api.ts only to
    // hand the request to its own module, which owns the POST/GET/DELETE dispatch and
    // answers 405 for anything else. The dispatch site names no verb, and the registry
    // declares all three against the handler module. Reporting it unresolved would claim a
    // scanner gap that is not there. The second probe is the guard rail: the same shape
    // plus one line of its own work stays unresolved and still fails loudly.
    const tempDir = mkdtempSync(join(tmpdir(), "ocx-route-delegation-"));
    const delegating = join(tempDir, "delegating-probe.ts");
    const working = join(tempDir, "working-probe.ts");
    try {
      writeFileSync(delegating, [
        "export async function handleProbe(ctx: any): Promise<Response | null> {",
        "  const { url, req, config } = ctx;",
        '  if (url.pathname === "/api/probe/delegated") {',
        '    const { handleDelegated } = await import("./delegated");',
        "    return handleDelegated(req, url, config);",
        "  }",
        "  return null;",
        "}",
      ].join("\n"));
      expect(distinctRoutes(scanRoutes(delegating)).unresolved).toEqual([]);
      expect(distinctRoutes(scanRoutes(delegating)).pairs).toEqual([]);

      writeFileSync(working, [
        "export async function handleProbe(ctx: any): Promise<Response | null> {",
        "  const { url, req, config } = ctx;",
        '  if (url.pathname === "/api/probe/not-delegated") {',
        "    const decided = decide(req);",
        '    const { handleDelegated } = await import("./delegated");',
        "    return handleDelegated(decided, url, config);",
        "  }",
        "  return null;",
        "}",
      ].join("\n"));
      expect(distinctRoutes(scanRoutes(working)).unresolved.map(r => r.path))
        .toEqual(["/api/probe/not-delegated"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("a multi-method disjunction expands into one route per method", () => {
    // `PUT || PATCH` on one guard is two routes. A count keyed on line hits saw one.
    const poolStrategy = MANAGEMENT_ROUTES.filter(r => r.path === "/api/codex-auth/pool-strategy");
    expect(poolStrategy.map(r => r.method).sort()).toEqual(["PATCH", "PUT"]);
  });

  test("the negated-guard routes are declared, and the dead duplicate is GONE", () => {
    // An equality scan cannot see a `pathname !== x` guard at all, so both of these are
    // declared by hand. `/api/storage` previously had TWO declarations: the live guard and a
    // shadowed copy in logs-usage-routes that could never run, exempted as `dead` with a note
    // saying to delete rather than expose it. wp7 deleted it, so exactly one remains and it is
    // the live one -- an unreachable duplicate is a trap for the next reader.
    const storage = MANAGEMENT_ROUTES.filter(r => r.path === "/api/storage");
    expect(storage).toHaveLength(1);
    expect(storage[0]?.module).toMatch(/storage-log-guard-routes$/);
    expect(storage[0]?.exempt).toBeUndefined();
    // No `dead` exemption should survive anywhere: the vocabulary exists for routes awaiting
    // deletion, so a lingering one means the deletion never happened.
    expect(MANAGEMENT_ROUTES.filter(r => r.exempt?.reason === "dead")).toEqual([]);
    expect(MANAGEMENT_ROUTES.some(r => r.path === "/api/routing-analytics")).toBe(true);
  });
});

describe("route exemptions stay honest", () => {
  test("every exemption carries a non-trivial reason", () => {
    const thin = MANAGEMENT_ROUTES
      .filter(r => r.exempt && r.exempt.why.trim().length < 40)
      .map(r => key(r.method, r.path));
    expect(thin).toEqual([]);
  });

  test("a deferred-verb exemption names an owner phase and a TRACKED doc that exists", () => {
    // The owner doc is a repository file, deliberately NOT the goalplan: `.codexclaw/` is
    // gitignored, so a test reading it would pass locally and find nothing in CI -- the
    // same vacuous pass this suite exists to prevent.
    const deferred = MANAGEMENT_ROUTES.filter(r => r.exempt?.reason === "deferred-verb");
    expect(deferred.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const route of deferred) {
      const { owner, ownerDoc } = route.exempt!;
      if (!owner) problems.push(`${key(route.method, route.path)}: no owner`);
      if (!ownerDoc) { problems.push(`${key(route.method, route.path)}: no ownerDoc`); continue; }
      if (!existsSync(join(repoRoot, ownerDoc))) problems.push(`${key(route.method, route.path)}: ownerDoc ${ownerDoc} missing`);
    }
    expect(problems).toEqual([]);
  });

  test("the user-consent star boundary is exempt and never gains a verb", () => {
    const star = MANAGEMENT_ROUTES.find(r => r.path === "/api/github/star" && r.method === "POST");
    expect(star?.exempt?.reason).toBe("session-only");
  });

  test("desktop snapshot is declared as a bounded internal shell mutation", () => {
    const row = MANAGEMENT_ROUTES.find(r =>
      r.method === "POST" && r.path === "/api/update/desktop-snapshot");
    expect(row).toMatchObject({
      module: "server/management/sidebar-routes", mutates: true,
      exempt: { reason: "desktop-internal" },
    });
  });

  test("account-switch and key pause routes remain ordinary management mutations", () => {
    for (const path of [
      "/api/codex-auth/active", "/api/oauth/accounts/active", "/api/providers/keys/active",
      "/api/providers/keys/pause",
    ]) {
      const row = MANAGEMENT_ROUTES.find(r => r.method === "PUT" && r.path === path);
      expect(row?.mutates, path).toBe(true);
      expect(row?.exempt, path).toBeUndefined();
      if (path === "/api/providers/keys/pause") expect(row?.module).toBe("server/management/oauth-account-routes");
    }
  });

  test("every mutating lab route is either verbed or bounded by a deferred-verb owner", () => {
    // The original plan exempted "20 /api/lab/* reads" under local-transport. The family
    // holds 7 mutating routes, and reading local SQLite cannot start an automation run,
    // so local-transport never covered them.
    const mutatingLab = MANAGEMENT_ROUTES.filter(r => r.path.startsWith("/api/lab") && r.mutates);
    expect(mutatingLab).toHaveLength(7);
    for (const route of mutatingLab) {
      expect(route.exempt?.reason, key(route.method, route.path)).toBe("deferred-verb");
    }
  });

  test("no lab route is exempted as local-transport while mutating", () => {
    const wrong = MANAGEMENT_ROUTES
      .filter(r => r.mutates && r.exempt?.reason === "local-transport")
      .map(r => key(r.method, r.path));
    expect(wrong).toEqual([]);
  });
});

describe("the sibling guard refuses only declared shared-state mutations", () => {
  const matches = (entry: { path: string; children: boolean }, path: string): boolean =>
    path === entry.path || (entry.children && path.startsWith(`${entry.path}/`));

  test("every guard entry names at least one declared mutating route", () => {
    // A guard entry that matches no mutation is either a typo or a route that moved; either way
    // the route it was meant to cover is open.
    const orphans = SIBLING_REFUSED_MANAGEMENT_PATHS
      .filter(entry => !MANAGEMENT_ROUTES.some(route => route.mutates && matches(entry, route.path)))
      .map(entry => entry.path);
    expect(orphans).toEqual([]);
  });

  test("unmarked, nothing is refused; marked, reads never are", () => {
    for (const route of MANAGEMENT_ROUTES) {
      expect(siblingRefusesManagementRequest(route.method, route.path)).toBe(false);
    }
    markSiblingStart(10100);
    try {
      for (const route of MANAGEMENT_ROUTES.filter(r => r.method === "GET" || r.method === "HEAD")) {
        expect(siblingRefusesManagementRequest(route.method, route.path), key(route.method, route.path)).toBe(false);
      }
    } finally {
      resetSiblingStartForTests();
    }
  });

  test("marked, shared-state writers are refused and own-home control stays open", () => {
    markSiblingStart(10100);
    try {
      for (const [method, path] of [
        ["PUT", "/api/client-integrations/raycast"],
        ["POST", "/api/sync"],
        ["POST", "/api/link/join"],
        ["POST", "/api/native-main-profiles/switch"],
        ["POST", "/api/codex-auth/main/reauth-device"],
        ["POST", "/api/startup-action"],
        ["PUT", "/api/v2"],
        ["PUT", "/api/native-integrations/grok"],
        ["POST", "/api/system/codex-restart"],
        ["PUT", "/api/codex-prompt/toggle"],
        // Archived-session storage lives in the shared CODEX_HOME.
        ["POST", "/api/storage/cleanup"],
        ["POST", "/api/storage/cleanup-policy/run"],
        ["POST", "/api/storage/trash/restore"],
      ] as const) {
        expect(siblingRefusesManagementRequest(method, path), `${method} ${path}`).toBe(true);
      }
      for (const [method, path] of [
        ["POST", "/api/stop"],
        ["POST", "/api/system/restart"],
        ["PUT", "/api/settings"],
        ["POST", "/api/providers"],
        // The preview reads, and the policy itself is own-home config.
        ["POST", "/api/storage/cleanup/preview"],
        ["PUT", "/api/storage/cleanup-policy"],
        // A prefix is not a path: the guard must not swallow a sibling route that shares one.
        ["POST", "/api/syncx"],
        ["POST", "/api/link/joined"],
      ] as const) {
        expect(siblingRefusesManagementRequest(method, path), `${method} ${path}`).toBe(false);
      }
    } finally {
      resetSiblingStartForTests();
    }
  });

  test("handleManagementAPI answers 409 sibling_instance before any route runs, and only while marked", async () => {
    const { handleManagementAPI } = await import("../../src/server/management-api");
    const { ManagementRequest } = await import("../helpers/management-auth");
    const config = { port: 10199, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai" } as unknown as Parameters<typeof handleManagementAPI>[2];
    const call = async (method: string, path: string, body?: unknown) => {
      const request = new ManagementRequest(`http://127.0.0.1:10199${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), config);
      expect(response, `${method} ${path}`).not.toBeNull();
      return { status: response!.status, body: await response!.json() as { code?: string; error?: string } };
    };
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-sibling-guard-"));
    process.env.OPENCODEX_HOME = home;
    try {
      // Unmarked control: the same cleanup request reaches its handler and fails its own validation.
      expect(await call("POST", "/api/storage/cleanup", { percent: -1 })).toEqual({ status: 400, body: { error: "invalid_percent" } });
      markSiblingStart(10100);
      for (const [method, path] of [["POST", "/api/sync"], ["POST", "/api/storage/cleanup"]] as const) {
        const refused = await call(method, path, { percent: -1 });
        expect(refused.status, `${method} ${path}`).toBe(409);
        expect(refused.body.code).toBe("sibling_instance");
        expect(refused.body.error).toContain("Client routing stays on the proxy at port 10100");
      }
      // A read, and the allowed POST cleanup preview, still reach their handlers.
      const read = await call("GET", "/api/storage/cleanup-policy");
      expect(read.status).toBe(200);
      expect(read.body.code).toBeUndefined();
      expect(await call("POST", "/api/storage/cleanup/preview", { percent: -1 })).toEqual({ status: 400, body: { error: "invalid_percent" } });
    } finally {
      resetSiblingStartForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the registry is inert data", () => {
  test("route-registry.ts imports nothing at all", () => {
    // It is imported by src/server/management-api.ts, which tests/core-lab-boundary
    // protects. A path string creates no module edge; an import would.
    const src = readFileSync(join(repoRoot, "src/server/management/route-registry.ts"), "utf8");
    const imports = src.match(/^\s*(import|export)\s+[^;]*from\s+["'][^"']+["']/gm) ?? [];
    expect(imports).toEqual([]);
    // Check the import graph, not prose: this file's own header explains why it must not
    // import Lab, so a naive substring search flags the explanation as the violation.
    expect(/from\s+["'][^"']*lab[^"']*["']/.test(src)).toBe(false);
    expect(/\bimport\s*\(/.test(src)).toBe(false);
  });
});
