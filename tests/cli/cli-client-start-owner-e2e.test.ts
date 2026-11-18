import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swapServiceInstallState } from "../../src/service/state";
import { acquireOwnershipMutationLease } from "../../src/service/ownership-mutation-lease.mjs";
import { serviceStatePathsForHomes } from "../../src/service/state-record.mjs";
import { watchdogMs } from "../helpers/ci-watchdog";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

test("a late same-home owner keeps its PID and generation when a connected client starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-late-client-start-owner-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const ocxHome = join(root, "ocx");
  for (const path of [home, codexHome, ocxHome]) mkdirSync(path, { recursive: true });
  const pidPath = join(ocxHome, "ocx.pid");
  const runtimePath = join(ocxHome, "runtime-port.json");
  const generation = crypto.randomUUID();
  let published: string | undefined;
  const owner = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (request.method === "POST") {
        // The contender has released its recovery lease but has yet to acquire its start lease.
        const lease = acquireOwnershipMutationLease(serviceStatePathsForHomes(ocxHome, join(home, ".opencodex")));
        try {
          published = JSON.stringify({ pid: process.pid, port: server.port, hostname: server.hostname, servingGeneration: generation });
          writeFileSync(pidPath, String(process.pid));
          writeFileSync(runtimePath, published);
        } finally { lease.release(); }
        return new Response(null, { status: 204 });
      }
      return Response.json({ service: "opencodex", status: "ok", pid: process.pid });
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
      port: 0, hostname: "127.0.0.1", runtimeRole: "client",
      client: {
        serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test",
        managementTransport: "direct", selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
        apiKeyId: "client-key-1", tokenFingerprint: "a".repeat(64), protocolVersion: 1,
        connectedAt: "2026-08-28T00:00:00.000Z",
      },
    }));
    child = Bun.spawn([process.execPath, "--preload", repoPath("tests/fixtures/client-runtime-claim-preload.ts"),
      repoPath("src/cli/index.ts"), "start"], {
      cwd: root,
      env: { HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome, CODEX_HOME: codexHome,
        OCX_TEST_LATE_OWNER_URL: new URL("/publish", owner.url).href },
      stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const deadline = Date.now() + watchdogMs(10_000);
    while (child.exitCode === null && Date.now() < deadline) {
      if (published && readFileSync(runtimePath, "utf8") !== published) break;
      await Bun.sleep(20);
    }
    expect(published).toBeDefined();
    expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid));
    expect(readFileSync(runtimePath, "utf8")).toBe(published!);
    expect(child.exitCode).toBe(1);
    expect(await stderr).toContain("Proxy appeared before bind");
    expect(await fetch(new URL("/healthz", owner.url)).then(response => response.json())).toMatchObject({ pid: process.pid });
  } finally {
    if (child?.exitCode === null) { child.kill(); await child.exited; }
    await owner.stop(true);
    removeTreeWithRetry(root);
  }
}, Math.max(30_000, watchdogMs(10_000) + 5_000));

test("the refused startup fixture proves absence across both loopback families", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-refused-start-probe-"));
  const child = Bun.spawn([
    process.execPath, "--preload", repoPath("tests/fixtures/refused-local-probe-preload.ts"), "-e", `
      import { observeProxyLiveness, START_OWNERSHIP_LIVENESS } from ${JSON.stringify(repoPath("src/server/proxy-liveness.ts"))};
      console.log(JSON.stringify(await observeProxyLiveness({ ...START_OWNERSHIP_LIVENESS,
        readPidFn: () => null, readRuntimeFn: () => null,
        configFn: () => ({ port: 42101, hostname: "127.0.0.1" }),
        loopbackAvailabilityFn: () => "available", sleepFn: async () => {},
      })));
    `,
  ], {
    cwd: root,
    env: { HOME: root, USERPROFILE: root, OPENCODEX_HOME: join(root, "ocx"), CODEX_HOME: join(root, "codex") },
    stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), watchdogMs(10_000));
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ kind: "absent", live: null });
    expect(stderr.match(/\[refused-probe\] ECONNREFUSED/g)).toHaveLength(6);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) { child.kill(); await child.exited; }
    removeTreeWithRetry(root);
  }
}, Math.max(30_000, watchdogMs(10_000) + 5_000));

// The real handleStart checks ownership, then awaits its configured-port /healthz
// probe. Commit a desktop claim while answering that probe: the lease-held recheck
// must refuse before the connected-client branch. The client runtime's own fence
// rechecks the same decision; its ordering is covered by cli-client-start-fence.test.ts.
// POSIX only: this fixture's SIGTERM cleanup assumes a child handles that signal.
test.skipIf(process.platform === "win32")("a late desktop claim stops a supervised connected-client start before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-client-start-owner-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const ocxHome = join(root, "ocx");
  const runtime = join(root, "runtime");
  for (const path of [home, codexHome, ocxHome, runtime, join(home, ".opencodex")]) {
    mkdirSync(path, { recursive: true });
  }
  let listener: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let probeRequests = 0;
  let claimCommitted = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = watchdogMs(10_000);
  try {
    const statePaths = serviceStatePathsForHomes(ocxHome, join(home, ".opencodex"));
    listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        probeRequests += 1;
        if (probeRequests === 1) {
          expect(request.method).toBe("GET");
          expect(new URL(request.url).pathname).toBe("/healthz");
          const state = swapServiceInstallState(current => ({
            ...(current ?? { version: 2, codexHome, opencodexHome: ocxHome, backend: "scheduler" }),
            ownership: { owner: "desktop", installId: "app-install-a", consentGeneration: 1 },
            consentGenerationCeiling: 1,
            ownershipProtocolVersion: 1,
          }), { paths: statePaths });
          claimCommitted = state?.ownership?.owner === "desktop";
        }
        return new Response(null, { status: 404 });
      },
    });
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
      port: listener.port,
      hostname: "127.0.0.1",
      codexAutoStart: false,
      syncResumeHistory: false,
      clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
      claudeCode: { systemEnv: false },
      providers: {},
      defaultProvider: "openai",
      runtimeRole: "client",
      client: {
        serverUrl: "https://hub.example.test",
        managementUrl: "https://hub.example.test",
        managementTransport: "direct",
        selectedClients: ["codex"],
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
        apiKeyId: "client-key-1",
        tokenFingerprint: "a".repeat(64),
        protocolVersion: 1,
        connectedAt: "2026-08-28T00:00:00.000Z",
      },
    }));
    child = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "start"], {
      cwd: root,
      env: {
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        OPENCODEX_HOME: ocxHome,
        XDG_RUNTIME_DIR: runtime,
        NO_PROXY: "127.0.0.1,localhost",
        OCX_SERVICE: "1",
        OCX_SERVICE_MANAGED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = await Promise.race([
      Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("connected-client start watchdog")), timeoutMs);
      }),
    ]);
    expect(result[0], result[2] || result[1]).toBe(0);
    expect(result[2]).toContain("desktop app owns the runtime");
    // The liveness probe may retry within its attempt budget; the claim landed on the first.
    expect(probeRequests).toBeGreaterThanOrEqual(1);
    expect(claimCommitted).toBe(true);
    expect(existsSync(join(ocxHome, "ocx.pid"))).toBe(false);
    expect(existsSync(join(ocxHome, "runtime-port.json"))).toBe(false);
    // The only configured-port listener is the test probe; no child listener or
    // runtime publication can survive a completed child with no state records.
    expect(child.exitCode).toBe(0);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (child?.exitCode === null) await child.exited;
    listener?.stop(true);
    removeTreeWithRetry(root);
  }
}, Math.max(30_000, watchdogMs(10_000) + 5_000));

// The real connected-client branch: the recovery fence passes (nothing is claimed yet), the
// branch loads src/client/runtime.ts, and the preload commits the desktop claim during that load.
// startClientRuntimeUnderOwnershipLease must then refuse under its own lease, so the real
// startClientRuntime never binds, and neither ocx.pid nor runtime-port.json is published.
test.skipIf(process.platform === "win32")("a desktop claim committed as the client runtime loads stops the real connected-client branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-client-runtime-owner-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const ocxHome = join(root, "ocx");
  const runtime = join(root, "runtime");
  for (const path of [home, codexHome, ocxHome, runtime, join(home, ".opencodex")]) {
    mkdirSync(path, { recursive: true });
  }
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = watchdogMs(10_000);
  try {
    // The child preload refuses the configured-port probe deterministically;
    // the ownership fence must still prevent all runtime publication.
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
      port: 42101,
      hostname: "127.0.0.1",
      codexAutoStart: false,
      syncResumeHistory: false,
      clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
      claudeCode: { systemEnv: false },
      providers: {},
      defaultProvider: "openai",
      runtimeRole: "client",
      client: {
        serverUrl: "https://hub.example.test",
        managementUrl: "https://hub.example.test",
        managementTransport: "direct",
        selectedClients: ["codex"],
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
        apiKeyId: "client-key-1",
        tokenFingerprint: "a".repeat(64),
        protocolVersion: 1,
        connectedAt: "2026-08-28T00:00:00.000Z",
      },
    }));
    child = Bun.spawn([
      process.execPath,
      "--preload",
      repoPath("tests/fixtures/refused-local-probe-preload.ts"),
      "--preload",
      repoPath("tests/fixtures/client-runtime-claim-preload.ts"),
      repoPath("src/cli/index.ts"),
      "start",
    ], {
      cwd: root,
      env: {
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        OPENCODEX_HOME: ocxHome,
        XDG_RUNTIME_DIR: runtime,
        NO_PROXY: "127.0.0.1,localhost",
        OCX_SERVICE: "1",
        OCX_SERVICE_MANAGED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = await Promise.race([
      Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("connected-client runtime watchdog")), timeoutMs);
      }),
    ]);
    const output = result[2] || result[1];
    expect(result[2], output).toContain("[refused-probe] ECONNREFUSED");
    // The claim landed on the connected-client branch, after the recovery fence passed.
    expect(result[2], output).toContain("[claim-preload] desktop claim committed at client runtime load");
    expect(result[0], output).toBe(0);
    expect(result[2]).toContain("desktop app owns the runtime");
    expect(existsSync(join(ocxHome, "ocx.pid"))).toBe(false);
    expect(existsSync(join(ocxHome, "runtime-port.json"))).toBe(false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (child?.exitCode === null) await child.exited;
    removeTreeWithRetry(root);
  }
}, Math.max(30_000, watchdogMs(10_000) + 5_000));
