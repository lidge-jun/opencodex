import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swapServiceInstallState } from "../../src/service/state";
import { serviceStatePathsForHomes } from "../../src/service/state-record.mjs";
import { watchdogMs } from "../helpers/ci-watchdog";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

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
    // A port nothing listens on, so the start path's liveness probe reads absent.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
    const freePort = probe.port;
    probe.stop(true);
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
      port: freePort,
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
