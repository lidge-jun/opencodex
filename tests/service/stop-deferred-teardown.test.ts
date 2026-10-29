import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopProxyGracefully } from "../../src/lib/process-control";
import { performStopTeardown } from "../../src/server/stop-teardown";
import { markSiblingStart, resetSiblingStartForTests } from "../../src/codex/sibling-start";
import type { CodexNativeRestoreResult } from "../../src/codex/inject";
import { STOP_HISTORY_DEFERRED_EXIT_CODE, STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../../src/update/stop-contract.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath, repoPath } from "../helpers/repo-root";
import { createLocalAttestationProof, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER } from "../../src/lib/local-management-attestation";
import { LOCAL_MANAGEMENT_NONCE_HEADER } from "../../src/lib/local-management-capability";

/**
 * Behavioural cover for the deferred shared teardown (#3008).
 *
 * The wiring assertions in tests/providers/xai/grok-lifecycle.test.ts read source text, which cannot
 * tell a working deferral from a plausible-looking one. These tests call the real
 * functions: the graceful-stop client that builds the URL, the teardown decision the
 * route delegates to, and the on-disk receipts that decide whether a deferral is an owned
 * obligation or an unbacked request.
 */

const ENDPOINT = { hostname: "127.0.0.1", port: 10100 };
const FOREIGN_NONCE = "ffffffffffffffffffffffffffffffff";
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-deferred-teardown-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function restoreResult(success: boolean): CodexNativeRestoreResult {
  return {
    success,
    message: success ? "native Codex restored" : "config restore failed",
    artifacts: {
      config: { state: success ? "restored" : "failed" },
      catalog: { state: "restored" },
      history: { state: "restored" },
    },
  } as unknown as CodexNativeRestoreResult;
}

function connectClient(transport: "hub" | "link") {
  const serverUrl = transport === "link" ? "http://127.0.0.1:10200" : "https://hub.example.test";
  writeFileSync(join(home, "config.json"), JSON.stringify({ runtimeRole: "client", providers: {}, defaultProvider: "openai", client: {
    serverUrl, managementUrl: serverUrl, managementTransport: "direct", transport,
    ...(transport === "link" ? { link: { tunnelPort: 10200, linkId: "lnk_0123456789abcdef" } } : {}),
    selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "fixture-client",
    tokenFingerprint: "a".repeat(64), protocolVersion: 1, connectedAt: "2026-10-01T00:00:00.000Z",
  } }));
}

async function runParentStop(options: {
  receipt: boolean; response: unknown; restore: CodexNativeRestoreResult; status?: number; clientTransport?: "hub" | "link";
  serverTeardown?: boolean; json?: boolean;
  clientServer?: "legacy" | "unknown" | "wrong-pid" | "malformed" | "oversized" | "unauthorized" | "redirect" | "body-timeout";
  managerCascades?: boolean; guarded?: boolean; orphan?: boolean; exitCleanup?: boolean;
  nativeSignal?: boolean; apiFailure?: boolean; stopBodyFailure?: boolean;
  alreadyStopped?: boolean; absence?: "dead" | "unknown" | "live"; managerState?: "inactive" | "active" | "unknown";
  disconnectDuringProbe?: boolean; connectDuringDiscovery?: boolean; connectDuringPost?: boolean; lifecycleBusy?: boolean;
  connectAfterBoundary?: boolean; pendingAfterBoundary?: boolean; connectDuringRestore?: boolean;
  connectAfterExitInspection?: boolean; pendingAfterExitInspection?: boolean; pendingAfterGrok?: boolean; receiptClearBusy?: boolean;
}) {
  if (options.clientTransport) connectClient(options.clientTransport);
  const child = spawnSync(process.execPath, [fixturePath("parent-stop-runner.ts")], {
    cwd: repoPath(),
    env: { ...process.env, OPENCODEX_HOME: home },
    input: JSON.stringify(options),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.signal, child.stderr).toBeNull();
  const reportPath = join(home, "parent-stop-result.json");
  expect(existsSync(reportPath), child.stderr).toBe(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    calls: { killed: number; native: number; grok: number; cleared: number; exited: number; service: number };
    probes: string[];
    urls: string[]; transports: string[]; nonce?: string; receiptExists: boolean; unexpectedIo: string[];
  };
  expect(report.unexpectedIo, child.stderr).toEqual([]);
  expect(report.urls, child.stderr).toHaveLength(options.clientServer || options.exitCleanup || options.alreadyStopped ? 0 : 1);
  return { ...report, exitCode: child.status, stderr: child.stderr, stdout: child.stdout };
}

describe("API stop through process exit cleanup", () => {
  for (const query of ["valid", "foreign", "missing", "none"] as const) {
    test(`${query} receipt request keeps the exit cleanup obligation accurate`, () => {
      connectClient("link");
      const codexHome = join(home, "codex");
      mkdirSync(codexHome);
      const child = spawnSync(process.execPath, [fixturePath("api-stop-exit-runner.ts"), query], {
        cwd: repoPath(), env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome },
        encoding: "utf8", timeout: 20_000, windowsHide: true,
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.signal, child.stderr).toBeNull();
      expect(child.status, child.stderr).toBe(0);
      // spawnSync returned only after the child exited. The parent's receipt survives;
      // existing parent CLI tests below cover restoration after proven-down observation.
      const report = JSON.parse(readFileSync(join(home, "api-stop-exit-result.json"), "utf8"));
      expect(report.responseStatus).toBe(200);
      expect(report.body).toMatchObject({ success: true, sharedTeardown: query === "valid" ? "deferred" : "performed" });
      expect(report.receiptState).toBe("valid");
      expect(report.deferredOnExit).toBe(query === "valid");
      expect(report.calls).toMatchObject({ env: 1, pid: 1, runtime: 1 });
      const stopped = report.events.indexOf("listener-stop");
      const released = report.events.indexOf("startup-release");
      const exited = report.events.indexOf("exit-cleanup");
      expect(stopped).toBeGreaterThanOrEqual(0);
      expect(released).toBeGreaterThan(stopped);
      expect(exited).toBeGreaterThan(released);
      if (query === "valid") {
        expect(report.calls).toMatchObject({ apiNative: 0, apiGrok: 0, exitNative: 0, exitGrok: 0 });
      } else {
        // Unbacked query values cannot suppress the child's existing restoration policy.
        expect(report.calls).toMatchObject({ apiNative: 1, apiGrok: 1, exitNative: 1, exitGrok: 1 });
        expect(report.events.indexOf("native-api")).toBeLessThan(stopped);
        expect(report.events.indexOf("grok-api")).toBeLessThan(stopped);
        expect(report.events.indexOf("native-exit")).toBeGreaterThan(exited);
      }
    });
  }
});

describe("parent CLI shared teardown completion", () => {
  test("consecutive connected stops preserve configuration and the stopped managed client remains update-eligible", async () => {
    const first = await runParentStop({ receipt: true, clientTransport: "hub", serverTeardown: true, json: true,
      response: null, restore: restoreResult(true) });
    const before = readFileSync(join(home, "config.json"), "utf8");
    const second = await runParentStop({ receipt: true, clientTransport: "hub", alreadyStopped: true, json: true,
      response: null, restore: restoreResult(true) });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.calls).toMatchObject({ service: 0, killed: 0, native: 0, grok: 0, cleared: 0 });
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, runtimeDown: true, proxy: "not-running", sharedTeardown: "skipped" });
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
    const { decidePostStopUpdate } = await import("../../src/update/stop-decision.mjs");
    expect(decidePostStopUpdate({ status: second.exitCode, hasRuntimeState: false, liveness: "dead", teardownOutstanding: false }))
      .toMatchObject({ proceed: true, reason: "ok" });
  });
  for (const [absence, managerState] of [["unknown", "inactive"], ["live", "inactive"], ["dead", "active"], ["dead", "unknown"]] as const) {
    test(`missing connected target still refuses ${absence} liveness / ${managerState} manager`, async () => {
      const outcome = await runParentStop({ receipt: true, clientTransport: "hub", alreadyStopped: true, absence, managerState,
        json: true, response: null, restore: restoreResult(true) });
      expect(outcome.exitCode).toBe(1);
      expect(outcome.calls).toMatchObject({ service: 0, killed: 0, native: 0, grok: 0, cleared: 0 });
      expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, runtimeDown: false });
    });
  }
  for (const transport of ["hub", "link"] as const) test(`${transport} stop probes and POST bypass environment proxies without exposing the admin token`, async () => {
    connectClient(transport);
    const targetPaths: string[] = [];
    const proxyPaths: string[] = [];
    const proxyTokens: string[] = [];
    const targetTokens: string[] = [];
    let childPid = 0;
    const token = "ocx-test-stop-proof-token";
    const reply = (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") return Response.json({ success: true, sharedTeardown: "not-owned" });
      const nonce = request.headers.get(path === "/healthz" ? LOCAL_ATTESTATION_CHALLENGE_HEADER : LOCAL_MANAGEMENT_NONCE_HEADER);
      const proof = nonce ? createLocalAttestationProof("C".repeat(43), nonce, childPid, target.port!) : null;
      const headers = proof ? { [LOCAL_ATTESTATION_PROOF_HEADER]: proof } : undefined;
      return Response.json(path === "/healthz" ? { service: "opencodex", pid: childPid }
        : { schema: "ocx-stop-capabilities/1", connectedClientOwnership: true, pid: childPid }, { headers });
    };
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      targetPaths.push(`${request.method} ${new URL(request.url).pathname}`);
      const auth = request.headers.get("x-opencodex-api-key");
      if (auth) targetTokens.push(auth);
      return reply(request);
    } });
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      proxyPaths.push(path);
      const auth = request.headers.get("x-opencodex-api-key");
      if (auth) proxyTokens.push(auth);
      return path === "/__proxy-control" ? Response.json({ via: "proxy" }) : reply(request);
    } });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const env = { ...process.env, OPENCODEX_HOME: home, OPENCODEX_ADMIN_AUTH_TOKEN: token };
      delete env.NO_PROXY; delete env.no_proxy;
      for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
        env[key] = `http://127.0.0.1:${proxy.port}`;
      }
      child = Bun.spawn([process.execPath, fixturePath("parent-stop-runner.ts")], {
        cwd: repoPath(), env, stdin: new Blob([JSON.stringify({ proxyProbePort: target.port })]), stdout: "pipe", stderr: "pipe",
      });
      childPid = child.pid;
      watchdog = setTimeout(() => child?.kill(), 8000);
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ok: true, control: "proxy" });
      expect(proxyPaths).toEqual(["/__proxy-control"]);
      expect(proxyTokens).toEqual([]);
      expect(targetPaths).toEqual(["GET /healthz", "GET /api/stop", "POST /api/stop"]);
      expect(targetTokens).toEqual([token]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      await target.stop(true); await proxy.stop(true);
    }
  });
  test("a disconnect committed during the capability probe cannot move the stop POST off direct transport", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "hub", serverTeardown: true, disconnectDuringProbe: true,
      json: true, response: null, restore: restoreResult(true) });
    expect(outcome.probes.some(url => url.endsWith("/api/stop")), outcome.stderr).toBe(true);
    expect(outcome.transports, outcome.stderr).toEqual(["direct"]);
  });
  test("a standalone stop, and a connection committed during orphan discovery, keep the POST on direct transport", async () => {
    const plain = await runParentStop({ receipt: true, json: true, response: { success: true, sharedTeardown: "deferred" },
      restore: restoreResult(true) });
    expect(plain.transports, plain.stderr).toEqual(["direct"]);
    const connecting = await runParentStop({ receipt: true, orphan: true, connectDuringDiscovery: true, json: true,
      response: { success: true, sharedTeardown: "deferred" }, restore: restoreResult(true) });
    expect(connecting.transports, connecting.stderr).toEqual(["direct"]);
  });
  for (const clientServer of ["legacy", "unknown", "wrong-pid", "malformed", "oversized", "unauthorized", "redirect", "body-timeout"] as const) {
    test(`connected stop refuses ${clientServer} preservation before service or POST`, async () => {
      const outcome = await runParentStop({ receipt: true, clientTransport: "hub", clientServer, json: true,
        response: { success: true, sharedTeardown: "performed" }, restore: restoreResult(true) });
      expect(outcome.calls).toMatchObject({ service: 0, killed: 0, native: 0, grok: 0, cleared: 0 });
      expect(outcome.nonce).toBeUndefined();
      expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, runtimeDown: false, sharedTeardown: "skipped" });
      expect(outcome.stderr).toContain("ocx disconnect");
      expect(outcome.exitCode).toBe(1);
    });
  }
  for (const mode of ["tracked", "orphan", "guarded"] as const) {
    test(`connected ${mode} stop refuses an old server before a cascading manager`, async () => {
      const outcome = await runParentStop({ receipt: true, clientTransport: "hub", clientServer: "legacy", json: true,
        orphan: mode === "orphan", guarded: mode === "guarded", managerCascades: true,
        response: { success: true, sharedTeardown: "performed" }, restore: restoreResult(true) });
      expect(outcome.calls).toMatchObject({ service: 0, killed: 0, native: 0, grok: 0, cleared: 0 });
      expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, sharedTeardown: "skipped" });
      expect(outcome.exitCode).toBe(1);
    });
  }
  test("actual Link Child exit cleanup attempts native and Grok restoration", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "link", exitCleanup: true,
      response: null, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ native: 1, grok: 1, service: 0, cleared: 0, killed: 0 });
    expect(outcome.exitCode).toBe(0);
  });
  test("ordinary startup exit cleanup retains native and Grok restoration", async () => {
    const outcome = await runParentStop({ receipt: true, exitCleanup: true, response: null, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ native: 1, grok: 1, service: 0 });
    expect(outcome.exitCode).toBe(0);
  });
  test("PID-identified hub client keeps the 404 to signal path", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "hub", nativeSignal: true, json: true,
      status: 404, response: { error: "not found" }, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ service: 1, killed: 1, native: 0, grok: 0 });
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, sharedTeardown: "skipped" });
    expect(outcome.exitCode).toBe(0);
  });
  test("full preservation capability permits signal fallback after an API failure", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "hub", nativeSignal: true, json: true,
      serverTeardown: true, apiFailure: true, status: 503, response: { error: "unavailable" }, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ service: 1, killed: 1, native: 0, grok: 0 });
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, sharedTeardown: "skipped" });
    expect(outcome.exitCode).toBe(0);
  });
  test("connected stop never signals after a truncated stop refusal", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "hub", nativeSignal: true, json: true,
      serverTeardown: true, stopBodyFailure: true, response: null, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ killed: 0, native: 0, grok: 0, cleared: 0 });
    expect(outcome.exitCode).toBe(1);
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, runtimeDown: false, sharedTeardown: "skipped" });
  });
  // #7563: hub clients route to an authenticated remote origin and preserve that routing on stop.
  test("a successful hub API stop preserves integrations and reports skipped JSON", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "hub", serverTeardown: true, json: true,
      response: null, restore: restoreResult(true) });
    expect(outcome.urls).toEqual(["http://127.0.0.1:10100/api/stop"]);
    expect(outcome.nonce).toBeUndefined();
    expect(outcome.calls).toMatchObject({ native: 0, grok: 0, cleared: 0 });
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, sharedTeardown: "skipped" });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
  });

  test("a hub native client stop leaves the connection's integrations and claims no receipt", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "hub",
      response: { error: "not found" }, status: 404, restore: restoreResult(true) });
    expect(outcome.urls).toEqual(["http://127.0.0.1:10100/api/stop"]);
    expect(outcome.nonce).toBeUndefined();
    expect(outcome.calls).toMatchObject({ native: 0, grok: 0, cleared: 0 });
    expect(outcome.stdout).toContain("this hub client's connection owns them");
    expect(outcome.exitCode, outcome.stderr).toBe(0);
  });

  test("a successful Link Child stop completes the parent's receipt-backed restoration", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "link", serverTeardown: true, json: true,
      response: null, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ native: 1, grok: 1, cleared: 1 });
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, sharedTeardown: "restored" });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
  });

  test("a Link Child not-owned answer without a receipt still gets the parent's restoration", async () => {
    // An old build answers not-owned for ANY connected client before it ever checks the
    // deferral query, and this stop has no receipt to send. That answer preserves the
    // link route instead of tearing it down, so it cannot confirm the parent's teardown:
    // the parent owns the restoration itself, exactly as for an unconfirmed stop.
    const outcome = await runParentStop({ receipt: false, clientTransport: "link", json: true,
      response: { success: true, sharedTeardown: "not-owned" }, restore: restoreResult(true) });
    expect(outcome.urls).toEqual(["http://127.0.0.1:10100/api/stop"]);
    expect(outcome.nonce).toBeUndefined();
    expect(outcome.calls).toMatchObject({ killed: 0, exited: 1, native: 1, grok: 1, cleared: 0 });
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, runtimeDown: true, sharedTeardown: "restored" });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
  });

  test("a connection committed during orphan discovery keeps its hub-owned not-owned answer", async () => {
    // Disconnected at entry, hub-connected by the time the POST lands: the stopped runtime
    // re-reads the fresh config and truthfully answers not-owned for the connection that
    // now owns those integrations. Refusing it would restore over the brand-new connection.
    const outcome = await runParentStop({ receipt: false, orphan: true, connectDuringDiscovery: true,
      serverTeardown: true, json: true, response: null, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ killed: 0, native: 0, grok: 0 });
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, runtimeDown: true, sharedTeardown: "performed-by-proxy" });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
  });

  for (const [label, transition] of [["during orphan discovery", { orphan: true, connectDuringDiscovery: true }],
    ["while the POST is in flight", { connectDuringPost: true }]] as const) {
    for (const receipt of [true, false]) {
      test(`a Link stop never restores over a hub connected ${label} (receipt ${receipt ? "claimed" : "unavailable"})`, async () => {
        // #7736 r5: the late not-owned refusal must not let the parent restore over the hub that
        // now owns routing. Only the ownership read at the restore boundary decides.
        const outcome = await runParentStop({ receipt, clientTransport: "link", serverTeardown: true, json: true,
          response: null, restore: restoreResult(true), ...transition });
        expect(outcome.calls, outcome.stderr).toMatchObject({ killed: 0, native: 0, grok: 0, cleared: receipt ? 1 : 0 });
        expect(outcome.receiptExists).toBe(false);
        // Seen before the POST without a nonce, the hub's not-owned answer already confirms the stop.
        const settledAtPost = "connectDuringDiscovery" in transition && !receipt;
        expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, runtimeDown: true,
          sharedTeardown: settledAtPost ? "performed-by-proxy" : "skipped" });
        if (!settledAtPost) expect(outcome.stdout + outcome.stderr).toContain("A hub connection was committed while this stop ran");
        expect(outcome.exitCode, outcome.stderr).toBe(0);
      });
    }
  }
  for (const transition of ["connectAfterBoundary", "connectDuringRestore"] as const) {
    for (const receipt of [true, false]) {
      test(`R6 ${transition} preserves hub writes (receipt ${receipt})`, async () => {
        const outcome = await runParentStop({ receipt, clientTransport: "link", json: true,
          [transition]: true, response: { success: true, sharedTeardown: "not-owned" }, restore: restoreResult(true) });
        expect(outcome.calls, outcome.stderr).toMatchObject({ native: 0, grok: 0, cleared: receipt ? 1 : 0 });
        expect(outcome.receiptExists).toBe(false);
        expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, sharedTeardown: "skipped" });
        expect(outcome.exitCode, outcome.stderr).toBe(0);
      }, 20_000);
    }
  }
  test("R6 pending connect after inspection preserves the obligation", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "link", json: true, pendingAfterBoundary: true,
      response: { success: true, sharedTeardown: "not-owned" }, restore: restoreResult(true) });
    expect(outcome.calls, outcome.stderr).toMatchObject({ native: 0, grok: 0, cleared: 0 });
    expect(outcome.receiptExists).toBe(true);
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, sharedTeardown: "refused" });
    expect(outcome.exitCode).toBe(1);
  }, 20_000);
  for (const mode of ["native-hub", "file-hub", "native-pending"] as const) {
    test(`R6 real restore revalidates after waiting on writer (${mode})`, () => {
      const codex = join(home, "codex"); mkdirSync(codex);
      writeFileSync(join(home, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", syncResumeHistory: false }));
      const child = spawnSync(process.execPath, [fixturePath("stop-restore-writer-runner.ts"), mode], {
        cwd: repoPath(), env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codex, GROK_HOME: join(home, "grok") },
        encoding: "utf8", timeout: 20_000, windowsHide: true,
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
      expect(result.after).toEqual(result.before);
      expect(result.grokCalls).toBe(0);
      expect(result.result.boundary).toBe(mode === "native-pending" ? "unproven" : "hub-owned");
      expect(result.marker).toBe(mode === "native-pending");
    }, 20_000);
  }
  for (const transition of ["connectAfterExitInspection", "pendingAfterExitInspection"] as const) {
    test(`R6 follow-up signal ${transition} protects shared writes`, async () => {
      const outcome = await runParentStop({ receipt: true, clientTransport: "link", exitCleanup: true,
        [transition]: true, response: null, restore: restoreResult(true) });
      expect(outcome.calls, outcome.stderr).toMatchObject({ native: 0, grok: 0, cleared: 0 });
      expect(outcome.exitCode, outcome.stderr).toBe(transition === "pendingAfterExitInspection" ? 1 : 0);
    }, 20_000);
  }
  for (const transition of ["pendingAfterGrok", "receiptClearBusy"] as const) {
    test(`R6 follow-up receipt ${transition} keeps the obligation`, async () => {
      const outcome = await runParentStop({ receipt: true, clientTransport: "link", json: true,
        [transition]: true, response: { success: true, sharedTeardown: "not-owned" }, restore: restoreResult(true) });
      expect(outcome.calls, outcome.stderr).toMatchObject({ native: 1, grok: 1, cleared: 0 });
      expect(outcome.receiptExists).toBe(true);
      expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, sharedTeardown: "refused" });
      expect(outcome.exitCode).toBe(1);
    }, 20_000);
  }
  for (const mode of ["api-native-hub", "api-file-hub", "api-native-pending", "late-catalog-hub", "late-history-hub"] as const) {
    test(`R6 follow-up real writes (${mode}) preserve new ownership`, () => {
      const codex = join(home, "codex"); mkdirSync(codex);
      writeFileSync(join(home, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", syncResumeHistory: false }));
      const child = spawnSync(process.execPath, [fixturePath("stop-restore-writer-runner.ts"), mode], {
        cwd: repoPath(), env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codex, GROK_HOME: join(home, "grok") },
        encoding: "utf8", timeout: 20_000, windowsHide: true,
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
      expect(result.after).toEqual(result.before);
      expect(result.grokCalls).toBe(0);
      if (mode.startsWith("api-")) expect(result.result).toMatchObject({
        success: mode !== "api-native-pending", sharedTeardown: mode === "api-native-pending" ? "refused" : "not-owned",
      });
      else expect(result.result.boundary).toBe("hub-owned");
    }, 20_000);
  }
  test("R6 follow-up API pending ownership returns 409 and keeps serving", () => {
    connectClient("link");
    const codex = join(home, "codex"); mkdirSync(codex);
    const child = spawnSync(process.execPath, [fixturePath("api-stop-exit-runner.ts"), "pending"], {
      cwd: repoPath(), env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codex },
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(home, "api-stop-exit-result.json"), "utf8"));
    expect(result).toMatchObject({ responseStatus: 409, refusedKeptServing: true, automaticRestarted: true, receiptState: "valid",
      body: { success: false, sharedTeardown: "refused" },
      calls: { apiNative: 0, apiGrok: 0, exitNative: 0, exitGrok: 0 } });
  }, 20_000);
  for (const mode of ["concurrent-refusals", "throws", "drain-refusal", "drain-throws", "deadline-refusal", "drain-deadline-refusal", "listener-deadline-refusal", "accepted-control", "signal-control"] as const) {
    test(`${mode.endsWith("control") ? "stop intent control" : "R6 stop intent"} ${mode} retains the right restart authority`, () => {
      const child = spawnSync(process.execPath, [fixturePath("stop-intent-runner.ts"), mode], {
        cwd: repoPath(), env: { ...process.env, OPENCODEX_HOME: home },
        encoding: "utf8", timeout: 20_000, windowsHide: true,
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
      expect(result.probes).toEqual(mode === "concurrent-refusals" ? [0, 0, 1] : mode === "accepted-control" ? [0, 0, 0] : mode === "signal-control" ? [0, 0] : [0, 1]);
      expect(result.scheduledStops).toBe(mode === "accepted-control" ? 1 : 0);
      if (mode === "throws" || mode === "drain-throws") expect(result.outcomes).toEqual([{ error: "Error: fixture teardown error" }]);
      else expect(result.outcomes.map((outcome: { status: number }) => outcome.status))
        .toEqual(mode === "concurrent-refusals" ? [409, 409] : mode === "accepted-control" ? [200, 409] : [409]);
      if (mode === "deadline-refusal") {
        expect(result.drainBudgets).toEqual([0]);
        expect(result.healthWaits).toEqual([false]);
      }
      if (mode === "drain-deadline-refusal" || mode === "listener-deadline-refusal") {
        expect(result.drainBudgets).toEqual([60_000]);
        expect(result.healthWaits).toEqual([false]);
      }
    }, 20_000);
  }
  test("a busy client lifecycle lock at the restore boundary keeps the obligation instead of restoring", async () => {
    const outcome = await runParentStop({ receipt: true, clientTransport: "link", lifecycleBusy: true, json: true,
      response: { success: true, sharedTeardown: "not-owned" }, restore: restoreResult(true) });
    expect(outcome.calls, outcome.stderr).toMatchObject({ killed: 0, native: 0, grok: 0, cleared: 0 });
    expect(outcome.receiptExists).toBe(true);
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, sharedTeardown: "refused" });
    expect(outcome.exitCode).toBe(1);
  });
  test("receipt failure and unconfirmed child teardown cause real parent restoration without a kill", async () => {
    const outcome = await runParentStop({ receipt: false,
      response: { success: false, sharedTeardown: "performed" }, restore: restoreResult(true) });
    expect(outcome.urls).toEqual(["http://127.0.0.1:10100/api/stop"]);
    expect(outcome.calls).toMatchObject({ killed: 0, exited: 1, native: 1, grok: 1, cleared: 0 });
    expect(outcome.exitCode).toBe(0);
  });

  test("a confirmed performed teardown prevents duplicate parent restoration", async () => {
    const outcome = await runParentStop({ receipt: false,
      response: { success: true, sharedTeardown: "performed" }, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ killed: 0, native: 0, grok: 0 });
    expect(outcome.exitCode).toBe(0);
  });

  test("a failed parent restoration leaves its actual receipt outstanding", async () => {
    const outcome = await runParentStop({ receipt: true,
      response: { success: false, sharedTeardown: "performed" }, restore: restoreResult(false) });
    expect(outcome.urls[0]).toContain(`teardownNonce=${outcome.nonce}`);
    expect(outcome.calls).toMatchObject({ killed: 0, native: 1, grok: 1, cleared: 0 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.receiptExists).toBe(true);
  });

  test("confirmed deferral leaves restoration and receipt discharge to the parent", async () => {
    const outcome = await runParentStop({ receipt: true,
      response: { success: true, sharedTeardown: "deferred" }, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ killed: 0, native: 1, grok: 1, cleared: 1 });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.receiptExists).toBe(false);
  });

  test("history-only parent failure preserves its distinct exit and discharges restored client state", async () => {
    const restore = { ...restoreResult(false), artifacts: {
      config: { state: "restored" }, catalog: { state: "restored" }, history: { state: "failed" },
    } } as unknown as CodexNativeRestoreResult;
    const outcome = await runParentStop({ receipt: true,
      response: { success: false, sharedTeardown: "performed" }, restore });
    expect(outcome.calls).toMatchObject({ killed: 0, native: 1, grok: 1, cleared: 1 });
    expect(outcome.exitCode).toBe(STOP_HISTORY_INCOMPLETE_EXIT_CODE);
    expect(outcome.receiptExists).toBe(false);
  });

  test("a paginated degraded restore releases its receipt and exits successfully", async () => {
    const retained = {
      reason: "history_paginated_requires_native_writer" as const,
      lines: ["# Auto-injected by opencodex", "[model_providers.opencodex]"],
      followUp: "Remove the table explicitly only if tagged conversations may stop opening.",
    };
    const restore = {
      success: true,
      message: "Native routing restored; provider table retained.",
      retainedCodexProviderTable: retained,
      artifacts: {
        config: { state: "partial", action: "routing-restored-provider-retained", retained },
        catalog: { state: "ok" },
        history: { state: "skipped" },
      },
    } as unknown as CodexNativeRestoreResult;
    const outcome = await runParentStop({ receipt: true,
      response: { success: true, sharedTeardown: "deferred" }, restore });
    expect(outcome.calls).toMatchObject({ killed: 0, native: 1, grok: 1, cleared: 1 });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.receiptExists).toBe(false);
  });

  /**
   * #4718, still live after #4812: a refusal that happens BEFORE anything is restored.
   *
   * The paginated-history reason no longer reaches this shape — it takes routing down and
   * reports `partial`, which the test above pins. Every OTHER preflight reason still
   * refuses ahead of the config half, so every artifact comes back untouched rather than
   * failed. `handleStop` had no branch for that shape and fell through to the generic
   * failure, which exited 1 — and the updater reads 1 as "the proxy would not stop" and
   * aborts with the service already down. The obligation really is still owed, so the
   * receipt has to stay; what was wrong was calling it a stop failure.
   *
   * This case is easy to lose while narrowing the paginated reason, and losing it would
   * silently retire exit code 80 along with the updater contract that reads it.
   */
  test("a non-paginated preflight refusal keeps its receipt and reports the deferred code", async () => {
    const restore = {
      success: false,
      message: "Native restore refused: history_state_database_missing. Config, catalog, history and provenance were preserved.",
      historyPreflightRefusal: "history_state_database_missing",
      artifacts: { config: { state: "skipped" }, catalog: { state: "skipped" }, history: { state: "skipped" } },
    } as unknown as CodexNativeRestoreResult;
    const outcome = await runParentStop({ receipt: true,
      response: { success: true, sharedTeardown: "deferred" }, restore });
    // Both halves were attempted; neither was discharged, because neither ran.
    expect(outcome.calls).toMatchObject({ killed: 0, native: 1, grok: 1, cleared: 0 });
    expect(outcome.exitCode).toBe(STOP_HISTORY_DEFERRED_EXIT_CODE);
    // The receipt is the whole point: the client config still points at a proxy that is
    // gone, and only this file says so. Discharging it here loses that permanently.
    expect(outcome.receiptExists).toBe(true);
  });

  test("an all-skipped restore without the structured refusal stays an ordinary failure", async () => {
    // The artifact states alone cannot carry this decision: an ownership refusal and a
    // desired-state skip produce the same three "skipped" values. Treating the shape as
    // benign would let an update proceed past a teardown nobody classified.
    const restore = {
      success: false,
      message: "Native restore skipped for an unrelated reason.",
      artifacts: { config: { state: "skipped" }, catalog: { state: "skipped" }, history: { state: "skipped" } },
    } as unknown as CodexNativeRestoreResult;
    const outcome = await runParentStop({ receipt: true,
      response: { success: true, sharedTeardown: "deferred" }, restore });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.calls).toMatchObject({ native: 1, grok: 1, cleared: 0 });
    expect(outcome.receiptExists).toBe(true);
  });

  test("a refusal that also failed config is a real teardown failure, not a deferral", async () => {
    // The structured reason is not a licence on its own. Config is state a client reads,
    // so a run that damaged it must keep failing the stop however it got there.
    const restore = {
      success: false,
      message: "Native restore refused: history_rollout_record_invalid.",
      historyPreflightRefusal: "history_rollout_record_invalid",
      artifacts: { config: { state: "failed" }, catalog: { state: "skipped" }, history: { state: "skipped" } },
    } as unknown as CodexNativeRestoreResult;
    const outcome = await runParentStop({ receipt: true,
      response: { success: true, sharedTeardown: "deferred" }, restore });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.calls).toMatchObject({ cleared: 0 });
    expect(outcome.receiptExists).toBe(true);
  });

  test("a refused stop keeps the parent from restoring or discharging its receipt", async () => {
    const outcome = await runParentStop({ receipt: true, status: 409,
      response: { success: false, message: "Run the stop outside the installed service." }, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ killed: 0, exited: 0, native: 0, grok: 0, cleared: 0 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.receiptExists).toBe(true);
    expect(outcome.stderr).toContain("Run the stop outside the installed service.");
  });
});

describe("stopProxyGracefully deferral flag", () => {
  test("the default stop asks for no deferral", async () => {
    const urls: string[] = [];
    await stopProxyGracefully(11, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ success: true, sharedTeardown: "performed" }), { status: 200 });
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(urls).toEqual(["http://127.0.0.1:10100/api/stop"]);
  });

  test("a claimed nonce is carried in the query the route reads", async () => {
    const urls: string[] = [];
    await stopProxyGracefully(11, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ success: true, sharedTeardown: "deferred" }), { status: 200 });
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
      deferSharedTeardownNonce: FOREIGN_NONCE,
    });
    expect(urls).toEqual([`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${FOREIGN_NONCE}`]);
  });

  test("the caller's endpoint snapshot is used instead of re-reading the runtime file", async () => {
    const urls: string[] = [];
    // The receipt records the endpoint the stop contacted. If this call re-read the
    // runtime record it could contact a different one, and recovery would then probe an
    // endpoint that was never stopped.
    await stopProxyGracefully(11, {
      readRuntime: () => ({ port: 19999, hostname: "127.0.0.1" }),
      runtimeEndpoint: { hostname: "127.0.0.1", port: 10100 },
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ success: true, sharedTeardown: "performed" }), { status: 200 });
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(urls).toEqual(["http://127.0.0.1:10100/api/stop"]);
  });
});

describe("performStopTeardown", () => {
  test("GET stop capability is bound to the server PID and leaves shared state alone", async () => {
    connectClient("link");
    const before = readFileSync(join(home, "config.json"), "utf8");
    const { handleManagementAPI } = await import("../../src/server/management-api");
    const url = new URL("http://127.0.0.1:10100/api/stop");
    const response = await handleManagementAPI(new Request(url, { headers: { Host: "127.0.0.1:10100" } }), url, {
      port: 10100, providers: {}, defaultProvider: "openai",
    } as never);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ schema: "ocx-stop-capabilities/1", connectedClientOwnership: true, pid: process.pid });
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  });
  test("persisted hub ownership precedes receipt deferral and leaves its receipt intact", async () => {
    connectClient("hub");
    const { claimPendingTeardown, readPendingTeardown } = await import("../../src/config/pending-teardown");
    const receipt = claimPendingTeardown(ENDPOINT, "exact");
    let restored = 0;
    let stripped = 0;
    for (const query of ["", `?deferSharedTeardown=1&teardownNonce=${receipt.nonce}`]) {
      const body = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop${query}`), {
        restoreNativeCodex: async () => { restored++; return restoreResult(true); },
        stripGrok: () => { stripped++; return { ok: true, changed: true, message: "stripped" }; },
      });
      expect(body).toMatchObject({ success: true, sharedTeardown: "not-owned" });
      expect(body.message).toContain("ocx disconnect");
    }
    expect(restored).toBe(0);
    expect(stripped).toBe(0);
    expect(readPendingTeardown(receipt.nonce).state).toBe("valid");
  });

  test("persisted Link ownership does not preserve an unauthenticated loopback route", async () => {
    connectClient("link");
    let restored = 0;
    let stripped = 0;
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      restoreNativeCodex: async () => { restored++; return restoreResult(true); },
      stripGrok: () => { stripped++; return { ok: true, changed: true, message: "stripped" }; },
    });
    expect(body).toMatchObject({ success: true, sharedTeardown: "performed" });
    expect([restored, stripped]).toEqual([1, 1]);
  });

  test("a hub server without a client connection still restores its own integrations", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ runtimeRole: "hub" }));
    let restored = 0;
    let stripped = 0;
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      restoreNativeCodex: async () => { restored++; return restoreResult(true); },
      stripGrok: () => { stripped++; return { ok: true, changed: true, message: "stripped" }; },
    });
    expect(body).toMatchObject({ success: true, sharedTeardown: "performed" });
    expect([restored, stripped]).toEqual([1, 1]);
  });

  test("an ordinary stop restores native Codex and strips the Grok fence", async () => {
    let restored = 0;
    let stripped = 0;
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => { stripped += 1; return { ok: true, changed: true, message: "Grok config restored" }; },
    });
    expect(restored).toBe(1);
    expect(stripped).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
    expect(body.message).toContain("native Codex restored");
  });

  test("a sibling instance restores nothing and hands nothing over, with or without a receipt", async () => {
    // Its CODEX_HOME journal and the Grok fence are the live owner's: restoring here would take
    // Codex off a proxy that is still serving it.
    let restored = 0;
    let stripped = 0;
    const io = {
      ownsReceipt: () => true,
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => { stripped += 1; return { ok: true, changed: true, message: "Grok config restored" }; },
    };
    markSiblingStart(10100);
    try {
      for (const url of [
        "http://127.0.0.1:10199/api/stop",
        `http://127.0.0.1:10199/api/stop?deferSharedTeardown=1&teardownNonce=${FOREIGN_NONCE}`,
      ]) {
        const body = await performStopTeardown(new URL(url), io);
        expect(body).toMatchObject({ success: true, sharedTeardown: "not-owned" });
        expect(body.message).toContain("Client routing stays on the proxy at port 10100");
      }
    } finally {
      resetSiblingStartForTests();
    }
    expect(restored).toBe(0);
    expect(stripped).toBe(0);
  });

  test("a degraded stop reports the retained provider table without turning success into deferral", async () => {
    const retained = {
      reason: "history_paginated_requires_native_writer" as const,
      lines: ["# Auto-injected by opencodex", "[model_providers.opencodex]"],
      followUp: "Run the explicit removal command only if tagged conversations may stop opening.",
    };
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => ({
        ...restoreResult(true),
        retainedCodexProviderTable: retained,
        artifacts: {
          ...restoreResult(true).artifacts,
          config: {
            state: "partial",
            changed: true,
            action: "routing-restored-provider-retained",
            message: "routing restored",
            retained,
          },
        },
      }),
      stripGrok: () => ({ ok: true, changed: false, message: "clean" }),
    });

    expect(body).toMatchObject({ success: true, sharedTeardown: "performed" });
    expect(body.message).toContain("[model_providers.opencodex]");
    expect(body.message).toContain("history_paginated_requires_native_writer");
  });

  test("a receipt-backed deferral touches neither config and says so", async () => {
    let restored = 0;
    let stripped = 0;
    const body = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${FOREIGN_NONCE}`), {
      ownsReceipt: nonce => nonce === FOREIGN_NONCE,
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => { stripped += 1; return { ok: true, changed: true, message: "Grok config restored" }; },
    });
    expect(restored).toBe(0);
    expect(stripped).toBe(0);
    expect(body.sharedTeardown).toBe("deferred");
    expect(body.message).toContain("deferred to the stopping client");
    // The old response claimed a restore that never happened; an operator reading it
    // would believe native Codex was back while the deferral was still outstanding.
    expect(body.message).not.toContain("native Codex restored");
  });

  test("the real ownership check accepts only a nonce with a readable receipt on disk", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    let restored = 0;
    const deferred = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${claimed.nonce}`), {
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(deferred.sharedTeardown).toBe("deferred");
    expect(restored).toBe(0);

    // Another caller riding on the existence of that obligation gets nothing: it does not
    // own the nonce, so it cannot hand its teardown to anyone.
    const ridden = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${FOREIGN_NONCE}`), {
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(ridden.sharedTeardown).toBe("performed");
    expect(restored).toBe(1);
  });

  test("the query alone does not buy a deferral without a receipt", async () => {
    let restored = 0;
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop?deferSharedTeardown=1"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    // An authenticated caller that sets the flag and exits must not be able to leave
    // client config pointed at a proxy that is going away.
    expect(restored).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
  });

  test("an unreadable receipt does not authorize a deferral", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    writeFileSync(mod.pendingTeardownPathFor(claimed.nonce), "{not json");
    let restored = 0;
    const body = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${claimed.nonce}`), {
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(restored).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
  });

  test("a failed restore still reports failure and the remediation", async () => {
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => restoreResult(false),
      stripGrok: () => ({ ok: false, changed: false, message: "grok home is read-only" }),
    });
    expect(body.success).toBe(false);
    expect(body.message).toContain("ocx restore");
    expect(body.message).toContain("Grok config cleanup failed");
  });

  test("a Grok-only failure is not reported as a successful teardown", async () => {
    // The native restore succeeding said nothing about the fence. Deciding success from
    // the native half alone let a caller read success: true while Grok still pointed at a
    // proxy that was exiting — the previous test masked it by failing both halves.
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => restoreResult(true),
      stripGrok: () => ({ ok: false, changed: false, message: "grok home is read-only" }),
    });
    expect(body.success).toBe(false);
    expect(body.sharedTeardown).toBe("performed");
    expect(body.message).toContain("Grok fence was not removed");
    expect(body.message).toContain("ocx restore");
  });

  test("both halves succeeding is the only success", async () => {
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => restoreResult(true),
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(body.success).toBe(true);
    expect(body.message).not.toContain("Grok config cleanup failed");
  });
});

describe("receipt naming is shared by both update lanes", () => {
  test("the launcher's scan and the TypeScript listing agree on what is outstanding", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const names = await import("../../src/config/pending-teardown-names.mjs");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);

    // bin/ocx.mjs runs under plain Node and cannot import the TypeScript module, so the
    // naming rule lives in one shared .mjs. Spelling it twice is exactly how the npm lane
    // ended up watching a filename that no longer existed.
    expect(names.hasPendingTeardownIn(readdirSync, home)).toBe(true);
    expect(mod.pendingTeardownOutstanding()).toBe(true);

    // The retired singleton name is not a receipt.
    expect(names.isPendingTeardownFileName("pending-teardown.json")).toBe(false);
    expect(names.isPendingTeardownFileName(`pending-teardown-${claimed.nonce}.json`)).toBe(true);
    // A quarantined receipt is no longer READ by the recovery loop...
    const quarantinedName = `pending-teardown-${claimed.nonce}.unreadable.json`;
    expect(names.isPendingTeardownFileName(quarantinedName)).toBe(false);
    // ...but it is still an obligation, so it still blocks an update.
    expect(names.isQuarantinedTeardownFileName(quarantinedName)).toBe(true);
    expect(names.isAnyTeardownObligationFileName(quarantinedName)).toBe(true);

    mod.quarantinePendingTeardown(claimed.nonce);
    expect(mod.listPendingTeardowns()).toHaveLength(0);
    // Both lanes still refuse to install over a teardown that never ran.
    expect(names.hasPendingTeardownIn(readdirSync, home)).toBe(true);
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    expect(mod.listQuarantinedTeardowns()).toHaveLength(1);

    // Only a human removing the file ends the enforcement.
    rmSync(mod.listQuarantinedTeardowns()[0]!);
    expect(names.hasPendingTeardownIn(readdirSync, home)).toBe(false);
    expect(mod.pendingTeardownOutstanding()).toBe(false);
  });

  test("a scan that fails is not an empty scan", async () => {
    const names = await import("../../src/config/pending-teardown-names.mjs");
    // Only a missing home is honestly empty. Any other failure may be hiding an
    // obligation, and reporting "none" would let an update install over a teardown that
    // never ran — absence of proof is not proof of absence.
    const enoent = Object.assign(new Error("no such directory"), { code: "ENOENT" });
    expect(names.hasPendingTeardownIn(() => { throw enoent; }, home)).toBe(false);
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(names.hasPendingTeardownIn(() => { throw denied; }, home)).toBe(true);
    expect(names.hasPendingTeardownIn(() => { throw new Error("no code at all"); }, home)).toBe(true);
  });

  test("a home that cannot be scanned is its own state, not a fabricated receipt", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const previous = process.env.OPENCODEX_HOME;
    // A file where the home should be: readdir fails with ENOTDIR, which is not absence.
    const notADir = join(home, "not-a-directory");
    writeFileSync(notADir, "");
    process.env.OPENCODEX_HOME = notADir;
    try {
      const listed = mod.listPendingTeardowns();
      // handleStop must see something blocking rather than an empty set it would restore over.
      expect(listed).toHaveLength(1);
      // Not "invalid": that carries a nonce, and a synthesized one would be handed to the
      // quarantine and clear paths, which could rename or delete a real receipt.
      expect(listed[0]!.state).toBe("unscannable");
      expect(listed[0]).not.toHaveProperty("nonce");
      expect(mod.isPendingTeardownAbandoned(listed[0]!, () => false, 1)).toBe(true);
      expect(mod.pendingTeardownOutstanding()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
    }
  });
});

describe("endpoint provenance", () => {
  test("a guessed endpoint is recorded as such and is not exact evidence", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const guessed = mod.claimPendingTeardown({ hostname: "127.0.0.1", port: 10100 }, "guessed", 1234);
    const read = mod.readPendingTeardown(guessed.nonce);
    expect(read.state === "valid" && read.receipt.endpointSource).toBe("guessed");

    // A proxy started with an explicit --port can be respawned there while the configured
    // address refuses, so a dead probe of THIS address proves nothing. handleStop reads
    // the provenance and fails closed rather than restoring on it.
    const exact = mod.claimPendingTeardown({ hostname: "127.0.0.1", port: 19999 }, "exact", 1234);
    expect(mod.readPendingTeardown(exact.nonce)).toMatchObject({ state: "valid" });
  });

  test("a receipt without provenance is invalid, so an old-format file cannot be trusted", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    writeFileSync(
      mod.pendingTeardownPathFor(claimed.nonce),
      JSON.stringify({ ownerPid: 1234, nonce: claimed.nonce, createdAt: "t", endpoint: ENDPOINT }),
    );
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    writeFileSync(
      mod.pendingTeardownPathFor(claimed.nonce),
      JSON.stringify({ ownerPid: 1234, nonce: claimed.nonce, createdAt: "t", endpoint: ENDPOINT, endpointSource: "maybe" }),
    );
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
  });
});

describe("post-stop update decision", () => {
  test("an outstanding obligation aborts the install even when the stop succeeded", async () => {
    const { decidePostStopUpdate } = await import("../../src/update/stop-decision.mjs");
    // A quarantined receipt lets the stop itself succeed — there is nothing left to stop —
    // so checking only BEFORE the stop let the retry sail through and install over a
    // teardown that never ran.
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: false, liveness: "dead", teardownOutstanding: true }))
      .toEqual({ proceed: false, reason: "teardown-outstanding" });
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: false, liveness: "dead", teardownOutstanding: false }))
      .toEqual({ proceed: true, reason: "ok" });
    // Omitting the field keeps the previous behaviour for any caller that has not adopted it.
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: false, liveness: "dead" }))
      .toEqual({ proceed: true, reason: "ok" });
    // A real stop failure still wins: it is the stronger signal.
    expect(decidePostStopUpdate({ status: 1, hasRuntimeState: false, liveness: "dead", teardownOutstanding: true }))
      .toEqual({ proceed: false, reason: "stop-failed" });
  });
});

describe("pending teardown receipts", () => {
  test("a claim is durable and carries the endpoint it was stopping", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    expect(claimed.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(existsSync(mod.pendingTeardownPathFor(claimed.nonce))).toBe(true);
    const read = mod.readPendingTeardown(claimed.nonce);
    expect(read.state).toBe("valid");
    expect(read.state === "valid" && read.receipt.endpoint).toEqual(ENDPOINT);
    expect(mod.pendingTeardownOutstanding()).toBe(true);
  });

  test("a clear names one obligation, so a concurrent claim cannot be deleted by it", async () => {
    const mod = await import("../../src/config/pending-teardown");
    // Review round 8 reproduced the delete-the-wrong-receipt bug; round 10 pointed out
    // that a read-compare-unlink against ONE shared path is still racy, because the file
    // can be replaced between the compare and the unlink. The nonce is the filename now,
    // so the replacement is a DIFFERENT file and the delete cannot reach it — no ordering
    // of the two operations matters.
    const abandoned = mod.claimPendingTeardown(ENDPOINT, "exact", 1111);
    const concurrent = mod.claimPendingTeardown(ENDPOINT, "exact", 2222);
    expect(mod.listPendingTeardowns()).toHaveLength(2);

    expect(mod.clearPendingTeardown(abandoned.nonce)).toBe(true);
    const survivors = mod.listPendingTeardowns();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.state === "valid" && survivors[0]!.receipt.nonce).toBe(concurrent.nonce);
  });

  test("clearing reports whether the obligation is actually gone", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    expect(mod.clearPendingTeardown(claimed.nonce)).toBe(true);
    // Already gone is still "gone" — an idempotent discharge is not a failure.
    expect(mod.clearPendingTeardown(claimed.nonce)).toBe(true);
    // A receipt that cannot be removed must be reported, or recovery repeats forever.
    const stuck = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    rmSync(mod.pendingTeardownPathFor(stuck.nonce));
    mkdirSync(mod.pendingTeardownPathFor(stuck.nonce), { recursive: true });
    mkdirSync(join(mod.pendingTeardownPathFor(stuck.nonce), "child"), { recursive: true });
    expect(mod.clearPendingTeardown(stuck.nonce)).toBe(false);
    removeTreeWithRetry(mod.pendingTeardownPathFor(stuck.nonce));
  });

  test("an unreadable receipt is invalid, outstanding, and quarantinable", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    writeFileSync(mod.pendingTeardownPathFor(claimed.nonce), "{not json");
    const read = mod.readPendingTeardown(claimed.nonce);
    expect(read.state).toBe("invalid");
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    // It names no endpoint, so nothing can prove its proxy down. Quarantine stops the
    // recovery loop from re-reading garbage on every stop, but the obligation REMAINS
    // outstanding: filing it away to unblock an update would let the next install land
    // over a teardown that never ran.
    const moved = mod.quarantinePendingTeardown(claimed.nonce);
    expect(moved).toBeTruthy();
    expect(existsSync(moved!)).toBe(true);
    expect(mod.listPendingTeardowns()).toHaveLength(0);
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    expect(readdirSync(home).some(n => n.endsWith(".unreadable.json"))).toBe(true);
  });

  /**
   * #4718: "the only obligations left are the ones I chose to keep".
   *
   * `ocx stop` makes that claim across a process boundary, and an updater replaces
   * package files on the strength of it. Membership is the test rather than a count:
   * anything the stop did not name — a quarantined receipt waiting on a human, a
   * concurrent stop's claim — has to answer false, or a deliberate deferral turns into a
   * blanket exemption for every obligation in the home.
   */
  test("an exact-obligation check accepts only the receipts it was given", async () => {
    const mod = await import("../../src/config/pending-teardown");
    // Nothing owed matches nothing expected.
    expect(mod.pendingTeardownsAreExactly([])).toBe(true);

    const kept = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    expect(mod.pendingTeardownsAreExactly([kept.nonce])).toBe(true);
    // The same receipt, unnamed, is an obligation nobody classified.
    expect(mod.pendingTeardownsAreExactly([])).toBe(false);
    // A nonce with no file behind it is not proof of anything either.
    expect(mod.pendingTeardownsAreExactly([FOREIGN_NONCE])).toBe(false);

    // A second claim this stop never saw — another stop in flight — disqualifies it.
    const other = mod.claimPendingTeardown(ENDPOINT, "exact", 1235);
    expect(mod.pendingTeardownsAreExactly([kept.nonce])).toBe(false);
    expect(mod.pendingTeardownsAreExactly([kept.nonce, other.nonce])).toBe(true);
    expect(mod.clearPendingTeardown(other.nonce)).toBe(true);

    // A quarantined receipt is still outstanding and still counts here, which is the
    // whole reason this cannot be built on listPendingTeardowns: that listing skips it.
    const filed = mod.claimPendingTeardown(ENDPOINT, "exact", 1236);
    writeFileSync(mod.pendingTeardownPathFor(filed.nonce), "{not json");
    expect(mod.quarantinePendingTeardown(filed.nonce)).toBeTruthy();
    expect(mod.listPendingTeardowns().map(read => read.state)).not.toContain("invalid");
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    expect(mod.pendingTeardownsAreExactly([kept.nonce])).toBe(false);
  });

  test("a directory where a receipt belongs is invalid, not missing", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    rmSync(mod.pendingTeardownPathFor(claimed.nonce));
    mkdirSync(mod.pendingTeardownPathFor(claimed.nonce), { recursive: true });
    // Reading that as absence hides an obligation that may still be outstanding.
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    removeTreeWithRetry(mod.pendingTeardownPathFor(claimed.nonce));
  });

  test("a receipt whose body disagrees with its filename is invalid", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    writeFileSync(
      mod.pendingTeardownPathFor(claimed.nonce),
      JSON.stringify({ ownerPid: 1234, nonce: FOREIGN_NONCE, createdAt: "t", endpoint: ENDPOINT, endpointSource: "exact" }),
    );
    // Otherwise an edited body could claim an identity the file name does not carry.
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    expect(mod.deferralMatchesReceipt(claimed.nonce)).toBe(false);
  });

  test("a receipt without a usable endpoint is invalid, because recovery could not locate it", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    const path = mod.pendingTeardownPathFor(claimed.nonce);
    const base = { ownerPid: 7, nonce: claimed.nonce, createdAt: "t", endpointSource: "exact" };
    writeFileSync(path, JSON.stringify(base));
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    writeFileSync(path, JSON.stringify({ ...base, endpoint: { hostname: "", port: 10100 } }));
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    writeFileSync(path, JSON.stringify({ ...base, endpoint: { hostname: "127.0.0.1", port: 0 } }));
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
  });

  test("only an abandoned receipt is recoverable", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 4242);
    const live = mod.readPendingTeardown(claimed.nonce);

    // A stop that is still running owns its own obligation; finishing it from here would
    // restore client config while that stop is still deciding whether a proxy survived.
    expect(mod.isPendingTeardownAbandoned(live, () => true, 1)).toBe(false);
    // This process's own receipt is not "abandoned" either.
    expect(mod.isPendingTeardownAbandoned(live, () => false, 4242)).toBe(false);
    // A dead owner left the obligation behind: recover it.
    expect(mod.isPendingTeardownAbandoned(live, () => false, 1)).toBe(true);
    expect(mod.isPendingTeardownAbandoned({ state: "missing" }, () => false, 1)).toBe(false);
  });

  test("a reused owner PID is abandoned, a live opencodex owner is still left alone", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const processState = await import("../../src/config/process-state");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 4242);
    const live = mod.readPendingTeardown(claimed.nonce);

    // The composition `handleStop` uses. Asserted here against the real predicates rather
    // than restated, because the whole defect was that the two halves were not composed:
    // bare liveness reported a recycled PID as a stop still in flight, so the receipt was
    // filtered out of recovery while both updater gates kept refusing on it (#4897).
    // Liveness is pinned true so the identity half is what these assertions measure: PID
    // 4242 is not a real process on this host, and probing it would measure the runner.
    const ownerStillRunning = (pid: number) => processState.isLikelyOcxProcess(pid);

    processState.setProcessCommandLinePlatformForTests("darwin");
    try {
      // NEWLY RECOVERABLE: the owner exited and an unrelated process inherited its number.
      processState.setProcessCommandLineExecForTests(() => "/usr/sbin/cupsd -l\n");
      expect(mod.isPendingTeardownAbandoned(live, ownerStillRunning, 1)).toBe(true);

      // STILL REFUSED: an opencodex process really is holding that PID, so this is a stop
      // in flight and its obligation is not ours to finish. Narrowing the precondition must
      // not turn the concurrency guard into a no-op.
      processState.setProcessCommandLineExecForTests(() => "ocx stop\n");
      expect(mod.isPendingTeardownAbandoned(live, ownerStillRunning, 1)).toBe(false);

      // STILL REFUSED: this process's own receipt is never inherited, whatever the probe says.
      expect(mod.isPendingTeardownAbandoned(live, ownerStillRunning, 4242)).toBe(false);
    } finally {
      processState.setProcessCommandLineExecForTests(null);
      processState.setProcessCommandLinePlatformForTests(null);
    }
  });

  test("deferralMatchesReceipt needs a well-formed nonce that names a readable receipt", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 7);
    expect(mod.deferralMatchesReceipt(claimed.nonce)).toBe(true);
    expect(mod.deferralMatchesReceipt(FOREIGN_NONCE)).toBe(false);
    expect(mod.deferralMatchesReceipt(null)).toBe(false);
    // A path-shaped "nonce" must not be able to reach outside the receipt namespace.
    expect(mod.deferralMatchesReceipt("../config")).toBe(false);
    expect(mod.deferralMatchesReceipt("")).toBe(false);
  });
});

describe("self-unloading manager refusal (#4023)", () => {
  test("a darwin proxy running AS the launchd job reports a self-unload risk", async () => {
    // `stopServiceIfInstalledDetailed()` calls `launchctl unload` on the plist that owns
    // THIS process, so the manager stop can terminate the request handler before the
    // shared teardown two statements later restores native Codex. The Windows guard that
    // prevents exactly this returned early for every non-Windows platform.
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" },
      exists: () => true,
    })).toBe("self-unload");
  });

  test("linux systemd is exempted identically and gets the same answer", async () => {
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "linux", {
      env: { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" },
      exists: () => true,
    })).toBe("self-unload");
  });

  test("a manually started proxy is unaffected, even with a service installed", async () => {
    // Managed service definitions write OCX_SERVICE_MANAGED. Without it this process is not
    // the managed job, so no unload can reach it and the inline stop stays available.
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: {},
      exists: () => true,
    })).toBe("none");
  });

  test("the managed job with no service definition on disk is not at risk", async () => {
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" },
      exists: () => false,
    })).toBe("none");
  });

  test("Windows classification is untouched by the new branch", async () => {
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "present" }) as never, "win32", {
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBe("respawnable");
    expect(installedServiceRespawnRisk(() => ({ status: "unknown" }) as never, "win32")).toBe("unknown");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "win32")).toBe("none");
  });

  
  test("a proxy spawned by an ensure path is not the managed job", async () => {
    // Both `ocx claude` and `ocx opencode` set OCX_SERVICE=1 on their detached child to
    // borrow its routing-preservation meaning (src/cli/claude.ts, src/cli/opencode.ts),
    // so that variable cannot identify the managed job. A user with the service installed
    // but stopped, running one of those commands, must keep a working dashboard Stop.
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBe("none");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "linux", {
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBe("none");
  });


test("the route refuses a self-unload before the manager is touched", () => {
    const source = readFileSync(repoPath("src", "server", "management-api.ts"), "utf8");
    const from = source.indexOf('"/api/stop"');
    const handler = source.slice(from, source.indexOf("/api/codex-auth/", from));
    expect(handler).toContain('code: "self_unload_service"');
    // Same invariant the Windows guard carries: refuse BEFORE acting, and say so.
    expect(handler.indexOf('code: "self_unload_service"'))
      .toBeLessThan(handler.indexOf("stopServiceIfInstalledDetailed()"));
    const branch = handler.slice(handler.indexOf('code: "self_unload_service"'), handler.indexOf('code: "self_unload_service"') + 600);
    expect(branch).toContain("Nothing was changed.");
    expect(branch).toContain("ocx stop");
  });

  test("a receipt-backed ocx stop keeps its deferral path", () => {
    // `ocx stop` claims a receipt, defers the teardown, and performs it itself once the
    // proxy is proven down — so it must not be refused by the new branch.
    const source = readFileSync(repoPath("src", "server", "management-api.ts"), "utf8");
    expect(source).toContain('const respawnRisk = holdsReceipt || sibling ? "none" : installedServiceRespawnRisk();');
  });
});
