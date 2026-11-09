import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { classifySyncResult, runHomeFanout } from "../../src/cli/sync-fanout";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { homeLinkChildParity } from "../../src/link/child-parity";
import { childArtifactFilename, hostChildTargetTriple } from "../../src/link/child-binary-source";
import { codexSettingsDigest, projectHomeCodexSettings } from "../../src/link/codex-settings";
import { linkStorePath } from "../../src/link/paths";
import { LINK_RELAY_SESSION_HEADER } from "../../src/link/relay-auth";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { readLinkStore, writeLinkStore, type LinkStore } from "../../src/link/store";
import { remotePinnedSyncArgv } from "../../src/link/ssh-argv";
import { handleLinkManagementRequest } from "../../src/server/index/link-management";
import { createLinkRelaySessions } from "../../src/server/index/link-relay-sessions";
import type { ManagementContext } from "../../src/server/management/context";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { OcxConfig } from "../../src/types";

function findOrBuildOcxChildBinary(): string {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  // Cargo resolves a relative CARGO_TARGET_DIR against its working directory, which is ours.
  const cargoTargetDir = process.env.CARGO_TARGET_DIR?.trim();
  const targetDir = cargoTargetDir ? resolve(cargoTargetDir) : repoPath("native", "ocx-child", "target");
  const releaseBin = join(targetDir, "release", `ocx-child${exeSuffix}`);
  const debugBin = join(targetDir, "debug", `ocx-child${exeSuffix}`);
  const realHome = process.env.OCX_REAL_HOME?.trim() || userInfo().homedir;
  const cargo = Bun.which("cargo") ?? join(realHome, ".cargo", "bin", `cargo${exeSuffix}`);
  if (existsSync(cargo)) {
    const build = Bun.spawnSync(
      [cargo, "build", "--locked", "--manifest-path", repoPath("native", "ocx-child", "Cargo.toml")],
      {
        env: {
          ...process.env,
          RUSTUP_HOME: process.env.RUSTUP_HOME || join(realHome, ".rustup"),
          CARGO_HOME: process.env.CARGO_HOME || join(realHome, ".cargo"),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90_000,
      },
    );
    if (build.exitCode !== 0) {
      throw new Error(`cargo build failed: ${build.stderr.toString()}`);
    }
    return debugBin;
  }
  if (existsSync(releaseBin)) return releaseBin;
  if (existsSync(debugBin)) return debugBin;
  throw new Error("neither cargo nor prebuilt ocx-child binary is available");
}

async function pickFreeLoopbackPort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>(resolve => srv.close(() => resolve()));
  return port;
}

function sandboxRemoteSh(script: string, root: string): string {
  return script
    .replaceAll("/Applications/OpenCodex.app/Contents/MacOS/ocx", join(root, "Apps/OpenCodex.app/Contents/MacOS/ocx"))
    .replaceAll("/usr/bin/ocx", join(root, "sys-usr/bin/ocx"))
    .replaceAll("/opt/homebrew/bin", join(root, "sys-homebrew/bin"))
    .replaceAll("/usr/local/bin", join(root, "sys-local/bin"));
}

let scratch = "";
let prevOcxHome: string | undefined;

beforeEach(() => {
  prevOcxHome = process.env.OPENCODEX_HOME;
  scratch = mkdtempSync(join(tmpdir(), "ocx-child-e2e-full-"));
  const homeOcxDir = join(scratch, "home-ocx");
  mkdirSync(homeOcxDir, { recursive: true });
  process.env.OPENCODEX_HOME = homeOcxDir;
  homeLinkChildParity.clear();
});

afterEach(() => {
  homeLinkChildParity.clear();
  if (prevOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevOcxHome;
  removeTreeWithRetry(scratch);
});

describe.skipIf(process.platform === "win32")("end-to-end Home <-> compiled ocx-child lifecycle", () => {
  test("enrolls detached ocx-child, streams SSE with stripped caller credentials, runs Home ocx sync fan-out with OCX-6 rollover/parity, classifies --expect-link mismatch exit 5, and detaches cleanly (#1798) with zero leftover daemon", async () => {
    const binaryPath = findOrBuildOcxChildBinary();
    const childUserHome = join(scratch, "child-home");
    const childOcxHome = join(childUserHome, ".opencodex");
    const childCodexHome = join(childUserHome, ".codex");
    const childLocalBin = join(childUserHome, ".local", "bin");
    mkdirSync(childOcxHome, { recursive: true });
    mkdirSync(childCodexHome, { recursive: true });
    mkdirSync(childLocalBin, { recursive: true });
    const installedChildBin = join(childLocalBin, "ocx-child");
    copyFileSync(binaryPath, installedChildBin);
    chmodSync(installedChildBin, 0o755);
    // Also create symlink `ocx-symlink` in separate dir to verify symlinked invocation later
    const symlinkDir = join(scratch, "symlink-bin");
    mkdirSync(symlinkDir, { recursive: true });
    symlinkSync(installedChildBin, join(symlinkDir, "ocx"));

    writeFileSync(
      join(childCodexHome, "config.toml"),
      "# Initial operator comment\napproval_policy = \"on-request\"\nweb_search = \"live\"\n",
    );

    const childListenPort = await pickFreeLoopbackPort();
    const privateUtils = join(scratch, "private-utils");
    mkdirSync(privateUtils, { recursive: true });
    for (const util of ["sh", "uname", "mktemp", "rm", "sleep", "kill", "wc", "cat", "printf", "awk", "curl"]) {
      let resolved: string | null = null;
      for (const sysDir of ["/bin", "/usr/bin"]) {
        const p = join(sysDir, util);
        if (existsSync(p)) {
          resolved = p;
          break;
        }
      }
      resolved ??= Bun.which(util);
      if (!resolved) {
        throw new Error(`missing required POSIX utility for ocx-child E2E: ${util}`);
      }
      symlinkSync(resolved, join(privateUtils, util));
    }
    const resolvedSh = join(privateUtils, "sh");
    let catalogModels = [{ slug: "home-initial-model" }];
    const observedUpstreamHeaders: Array<Record<string, string>> = [];

    const homeConfig: OcxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      runtimeRole: "standalone",
      defaultProvider: "openai",
      fastMode: false,
      multiAgentMode: "v1",
      webSearchSidecar: { enabled: true } as OcxConfig["webSearchSidecar"],
      providers: {},
      apiKeys: [],
    };

    const catalogCallbacks = new Set<(keyId: string) => void>();
    const relaySessions = createLinkRelaySessions({
      fingerprints: (keyId, linkId) => {
        const store = readLinkStore(linkStorePath());
        const link = store.links.find(l => l.id === linkId && l.apiKeyId === keyId);
        if (!link) return [];
        const keyEntry = (homeConfig.apiKeys ?? []).find(k => k.id === keyId);
        return keyEntry ? [serviceApiTokenFingerprint(keyEntry.key)] : [];
      },
      connectionGeneration: () => "e2e-home-gen:1",
    });

    // Start real Bun.serve Home hub-link listener (serves tunnelPort directly on loopback!)
    const homeHubLinkServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      fetch(req, server) {
        const u = new URL(req.url);
        // Only admit requests that completed same-socket link-relay-auth v2!
        if (u.pathname !== "/.well-known/opencodex/link-relay-auth" && !req.headers.has(LINK_RELAY_SESSION_HEADER)) {
          return new Response(JSON.stringify({ error: "session_required" }), { status: 401 });
        }
        return relaySessions.dispatch(req, server, async innerReq => {
          const url = new URL(innerReq.url);
          const rawAuth = innerReq.headers.get("x-opencodex-api-key")
            ?? innerReq.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
            ?? "";
          const admittedKey = (homeConfig.apiKeys ?? []).find(k => k.key === rawAuth);
          if (!admittedKey) return Response.json({ error: "unauthorized" }, { status: 401 });

          const hdrSnapshot: Record<string, string> = {};
          innerReq.headers.forEach((v, k) => { hdrSnapshot[k.toLowerCase()] = v; });
          observedUpstreamHeaders.push(hdrSnapshot);

          if (url.pathname === "/readyz" && innerReq.method === "GET") {
            return Response.json({
              status: "ready",
              protocolVersion: 1,
              minClientProtocolVersion: 1,
              maxClientProtocolVersion: 1,
              version: "2.98.0",
              managementUrl: `http://127.0.0.1:${server.port}`,
            });
          }
          if (url.pathname === "/v1/catalog" && innerReq.method === "GET") {
            for (const cb of catalogCallbacks) cb(admittedKey.id);
            return Response.json({ models: catalogModels });
          }
          if (url.pathname === "/v1/responses" && innerReq.method === "POST") {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
              start(ctrl) {
                ctrl.enqueue(encoder.encode("event: response.created\ndata: {\"id\":\"resp_e2e\"}\n\n"));
                ctrl.enqueue(encoder.encode("event: response.completed\ndata: {\"done\":true}\n\n"));
                ctrl.close();
              },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
          }
          const mgmt = await handleLinkManagementRequest(
            innerReq,
            url,
            homeConfig,
            {} as never,
            undefined,
            admittedKey.id,
          );
          return mgmt ?? Response.json({ error: "not_found" }, { status: 404 });
        });
      },
    });

    const tunnelPort = homeHubLinkServer.port!;
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: tunnelPort, links: [] });

    const childEnv = {
      HOME: childUserHome,
      OPENCODEX_HOME: childOcxHome,
      CODEX_HOME: childCodexHome,
      OCX_CHILD_LISTEN_PORT: String(childListenPort),
      PATH: privateUtils,
    };

    const runShellAsync = async (argv: string[], stdin?: Uint8Array): Promise<SshRunResult> => {
      const proc = Bun.spawn(argv, {
        cwd: childUserHome,
        env: childEnv,
        stdin: stdin ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (stdin && proc.stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    };

    const runLocalAsSsh = async (remoteCommand: string, stdin?: Uint8Array): Promise<SshRunResult> => {
      let patched = sandboxRemoteSh(remoteCommand, scratch);
      // Force `link port` in enrollment to select our bound tunnelPort so ssh -R is simulated in-process
      if (patched.includes("'link' 'port'")) {
        return { code: 0, stdout: JSON.stringify({ port: tunnelPort }) + "\n", stderr: "" };
      }
      return runShellAsync([resolvedSh, "-c", patched], stdin);
    };

    const sshRunner: SshRunner = {
      async run(argv, options) {
        if (argv[0] === "ssh-keygen") {
          return { code: 0, stdout: "256 SHA256:e2efingerprint01 devbox (ED25519)\n", stderr: "" };
        }
        const cmd = argv.at(-1) ?? "";
        if (cmd === "echo ocx-link-probe") {
          const khArg = argv.find(a => a.startsWith("UserKnownHostsFile="))!;
          const khPath = khArg.slice("UserKnownHostsFile=".length).replace(/^"|"$/g, "");
          writeFileSync(khPath, "devbox ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2E\n");
          return { code: 0, stdout: "ocx-link-probe\n", stderr: "" };
        }
        return runLocalAsSsh(cmd, options?.stdin);
      },
      spawnTunnel() { throw new Error("unused"); },
    };

    let issuedCounter = 0;
    const knownHostsPath = join(scratch, "home-ocx", "known_hosts");
    const linkState: LinkRouteState = {
      pendingHosts: new Map(),
      confirmedHosts: new Map(),
      operations: new Set(),
      listener: {
        ensureStarted: async () => {},
        status: () => ({ state: "listening", port: tunnelPort, reason: null }),
        close: async () => {},
        onAuthenticatedCatalog: cb => {
          catalogCallbacks.add(cb);
          return () => { catalogCallbacks.delete(cb); };
        },
      },
      supervisor: {
        start() {},
        ensureStarted: async () => {},
        reload: async () => {},
        holdLink: () => () => {},
        stopLink: async () => {},
        reconnect: async () => true,
        status: () => readLinkStore(linkStorePath()).links.map(l => ({
          linkId: l.id,
          state: { kind: "connected" as const, since: Date.now() },
        })),
        stop: async () => {},
      },
    };

    const mgmtCall = async (method: string, path: string, body?: unknown): Promise<Response> => {
      const url = new URL(`http://127.0.0.1:10100${path}`);
      const ctx: ManagementContext = {
        req: new Request(url, {
          method,
          ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        }),
        url,
        config: homeConfig,
        deps: {
          sshRunner,
          readLinkStore: () => readLinkStore(linkStorePath()),
          writeLinkStore: next => writeLinkStore(linkStorePath(), next),
          linkKnownHostsPath: () => knownHostsPath,
          liveListenPort: () => 10100,
          issueApiKey: (cfg, name) => {
            const key = {
              id: `link-e2e-${++issuedCounter}`,
              name,
              key: `ocx_data_${String(issuedCounter).padStart(40, "0")}`,
              createdAt: new Date().toISOString(),
            };
            cfg.apiKeys = [...(cfg.apiKeys ?? []), key];
            return key;
          },
          revokeApiKey: (cfg, id) => {
            cfg.apiKeys = (cfg.apiKeys ?? []).filter(k => k.id !== id);
            return true;
          },
        },
        version: "2.98.0",
        principal: "admin-token",
        trustedLoopbackIngress: true,
        guiSessionIssuance: null,
        sessionControl: { isCurrent: () => true, isPaired: () => false, revokeCurrent: () => true },
        convergeCodexCatalog: async () => { throw new Error("unused"); },
        syncClaudeAgentDefsBestEffort: async () => {},
      };
      const res = await handleLinkRoutes(ctx, linkState);
      if (!res) throw new Error("unhandled management route");
      return res;
    };

    try {
      // Step A: Probe -> confirm-host -> apply on clean detached ocx-child
      const probeRes = await mgmtCall("POST", "/api/link/probe", { alias: "devbox", includeVersion: true });
      expect(probeRes.status).toBe(200);
      const probeBody = await probeRes.json() as { fingerprint: string; ocxVersion: string };
      expect(probeBody.ocxVersion).toBe("2.98.0");

      const confirmRes = await mgmtCall("POST", "/api/link/confirm-host", { alias: "devbox", fingerprint: probeBody.fingerprint });
      expect(confirmRes.status).toBe(200);

      const applyRes = await mgmtCall("POST", "/api/link/apply", { alias: "devbox" });
      expect(applyRes.status).toBe(202);
      const { linkId } = await applyRes.json() as { linkId: string };
      expect(linkId).toMatch(/^lnk_[0-9a-f]{16}$/);

      // Step B: Stream SSE POST /v1/responses through ocx-child with caller secret header
      const sseRes = await fetch(`http://127.0.0.1:${childListenPort}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer caller-secret-short",
          "x-api-key": "caller-ant-key",
        },
        body: JSON.stringify({ model: "home-initial-model", input: "hi" }),
      });
      expect(sseRes.status).toBe(200);
      const sseText = await sseRes.text();
      expect(sseText).toContain("event: response.created");
      expect(sseText).toContain("event: response.completed");
      const lastUpHdr = observedUpstreamHeaders.at(-1)!;
      expect(lastUpHdr["x-api-key"]).toBeUndefined();
      expect(lastUpHdr["authorization"]).not.toContain("caller-secret-short");

      // Step C: Mutate Home catalog & settings, then run Home ocx sync fan-out!
      catalogModels = [{ slug: "home-fanout-model-v2" }];
      homeConfig.fastMode = true;
      homeConfig.webSearchSidecar = { enabled: false } as OcxConfig["webSearchSidecar"];
      const expectedDigest = codexSettingsDigest(projectHomeCodexSettings(homeConfig, "2.98.0").settings);

      const statusBeforeSync = await (await mgmtCall("GET", "/api/link/status")).json();
      const fanoutDoc = await runHomeFanout({
        home: { state: "synced", exit: 0 },
        catalogCurrent: true,
        applicable: true,
        readStore: () => readLinkStore(linkStorePath()),
        readLinkStatus: async () => statusBeforeSync,
        runChild: async link => {
          const pinned = remotePinnedSyncArgv(link.id, "posix");
          pinned[2] = sandboxRemoteSh(pinned[2]!, scratch);
          const out = await runShellAsync([...pinned]);
          return { ...classifySyncResult(out), exit: out.code };
        },
      });
      expect(fanoutDoc.fanout.state).toBe("ran");
      expect(fanoutDoc.children).toEqual([
        { linkId, alias: "devbox", state: "synced", reason: null, exit: 0 },
      ]);

      // Verify Child models_cache.json updated & Home GET /api/link/status reflects OCX-6 parity!
      const childCache = JSON.parse(readFileSync(join(childCodexHome, "models_cache.json"), "utf8"));
      expect(childCache.models.map((m: { slug: string }) => m.slug)).toContain("home-fanout-model-v2");

      const statusAfterSync = await (await mgmtCall("GET", "/api/link/status")).json() as {
        links: Array<{ id: string; lastApplyAt: number | null; runtimeStartedAt: number | null; appliedCodexSettingsDigest: string | null }>;
      };
      const linkRow = statusAfterSync.links.find(l => l.id === linkId)!;
      expect(linkRow.appliedCodexSettingsDigest).toBe(expectedDigest);
      expect(linkRow.lastApplyAt).not.toBeNull();
      expect(linkRow.runtimeStartedAt).not.toBeNull();
      expect(linkRow.runtimeStartedAt!).toBeGreaterThanOrEqual(linkRow.lastApplyAt!);

      // Also verify symlinked `ocx status --json` works identically on Child
      const symStatus = Bun.spawnSync([join(symlinkDir, "ocx"), "status", "--json"], {
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(symStatus.exitCode).toBe(0);
      const parsedChildStatus = JSON.parse(symStatus.stdout.toString());
      expect(parsedChildStatus.appliedCodexSettingsDigest).toBe(expectedDigest);
      expect(parsedChildStatus.proxy.running).toBe(true);

      // Step D: Wrong --expect-link exits 5 and classifies as child-link-mismatch:other_link
      const wrongPinned = remotePinnedSyncArgv("lnk_ffffffffffffffff", "posix");
      wrongPinned[2] = sandboxRemoteSh(wrongPinned[2]!, scratch);
      const wrongOut = await runShellAsync([...wrongPinned]);
      expect(wrongOut.code).toBe(5);
      expect(classifySyncResult(wrongOut)).toEqual({ state: "skipped", reason: "child-link-mismatch:other_link" });

      // Step E: Simulate #1798 Codex App comment-stripping rewrite on Child, then Home DELETE /api/link/:id!
      const preDetachCfg = readFileSync(join(childCodexHome, "config.toml"), "utf8");
      const stripped1798 = preDetachCfg
        .split("\n")
        .filter(l => !l.trim().startsWith("#"))
        .join("\n") + "\n[projects.\"/tmp/demo\"]\ntrust_level = \"trusted\"\n";
      writeFileSync(join(childCodexHome, "config.toml"), stripped1798);

      const delRes = await mgmtCall("DELETE", `/api/link/${linkId}`);
      expect(delRes.status).toBe(200);

      // Verify zero leftover daemon (port closed) and byte-accurate surgical restoration
      let portReachable = false;
      try {
        await fetch(`http://127.0.0.1:${childListenPort}/healthz`, { signal: AbortSignal.timeout(300) });
        portReachable = true;
      } catch { portReachable = false; }
      expect(portReachable).toBe(false);

      const finalToml = readFileSync(join(childCodexHome, "config.toml"), "utf8");
      expect(finalToml).not.toContain("openai_base_url");
      expect(finalToml).not.toContain("opencodex-catalog.json");
      expect(finalToml).toContain('web_search = "live"');
      expect(finalToml).toContain('approval_policy = "on-request"');
      expect(finalToml).toContain('[projects."/tmp/demo"]');
      expect(existsSync(join(childCodexHome, "opencodex-catalog.json"))).toBe(false);
      expect(existsSync(join(childCodexHome, "models_cache.json"))).toBe(false);
    } finally {
      // Ensure no child daemon survives even if an assertion failed
      await runShellAsync([installedChildBin, "disconnect"]);
      relaySessions.abortReservations();
      await homeHubLinkServer.stop(true);
    }
  }, 30_000);

  test("streams verified ocx-child binary onto a bare Child host over SSH stdin, relays requests, and removes the planted binary on DELETE --purge", async () => {
    const builtBinary = findOrBuildOcxChildBinary();
    const hostTriple = hostChildTargetTriple();
    if (!hostTriple) return;
    const stagedBinDir = join(scratch, "staged-child-bin");
    mkdirSync(stagedBinDir, { recursive: true, mode: 0o700 });
    chmodSync(stagedBinDir, 0o700);
    const artifactName = childArtifactFilename(hostTriple);
    const stagedBinPath = join(stagedBinDir, artifactName);
    copyFileSync(builtBinary, stagedBinPath);
    chmodSync(stagedBinPath, 0o700);
    const stagedSha = createHash("sha256").update(readFileSync(stagedBinPath)).digest("hex");
    const sumsPath = join(stagedBinDir, "SHA256SUMS");
    writeFileSync(sumsPath, `${stagedSha}  ${artifactName}\n`, { mode: 0o600 });
    chmodSync(sumsPath, 0o600);
    const prevBinDir = process.env.OPENCODEX_CHILD_BIN_DIR;
    process.env.OPENCODEX_CHILD_BIN_DIR = stagedBinDir;
    const childUserHome = join(scratch, "bare-child-home");
    const childOcxHome = join(childUserHome, ".opencodex");
    const childCodexHome = join(childUserHome, ".codex");
    mkdirSync(childCodexHome, { recursive: true });
    writeFileSync(join(childCodexHome, "config.toml"), "approval_policy = \"on-request\"\n");
    const plantedPath = join(childUserHome, ".cache", "opencodex", "bin", "ocx-child");
    expect(existsSync(plantedPath)).toBe(false);

    const childListenPort = await pickFreeLoopbackPort();
    const privateUtils = join(scratch, "bare-private-utils");
    mkdirSync(privateUtils, { recursive: true });
    for (const util of ["sh", "uname", "mktemp", "mkdir", "chmod", "mv", "rmdir", "rm", "sleep", "kill", "wc", "cat", "printf", "awk", "curl"]) {
      let resolved: string | null = null;
      for (const sysDir of ["/bin", "/usr/bin"]) {
        const p = join(sysDir, util);
        if (existsSync(p)) { resolved = p; break; }
      }
      resolved ??= Bun.which(util);
      if (!resolved) throw new Error(`missing POSIX utility: ${util}`);
      symlinkSync(resolved, join(privateUtils, util));
    }
    // The plant script refuses to install a binary it cannot hash, so the bare host needs one tool.
    const hashTool = ["sha256sum", "shasum", "openssl"]
      .flatMap(tool => ["/bin", "/usr/bin", "/sbin", "/usr/sbin"].map(dir => ({ tool, path: join(dir, tool) })))
      .find(candidate => existsSync(candidate.path));
    if (!hashTool) throw new Error("missing SHA-256 tool (sha256sum, shasum, or openssl) for the plant E2E");
    symlinkSync(hashTool.path, join(privateUtils, hashTool.tool));
    const resolvedSh = join(privateUtils, "sh");
    const homeConfig: OcxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      runtimeRole: "standalone",
      defaultProvider: "openai",
      providers: {},
      apiKeys: [],
    };
    const catalogCallbacks = new Set<(keyId: string) => void>();
    const relaySessions = createLinkRelaySessions({
      fingerprints: (keyId, linkId) => {
        const store = readLinkStore(linkStorePath());
        const link = store.links.find(l => l.id === linkId && l.apiKeyId === keyId);
        if (!link) return [];
        const keyEntry = (homeConfig.apiKeys ?? []).find(k => k.id === keyId);
        return keyEntry ? [serviceApiTokenFingerprint(keyEntry.key)] : [];
      },
      connectionGeneration: () => "e2e-bare-gen:1",
    });
    const homeHubLinkServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      fetch(req, server) {
        const u = new URL(req.url);
        if (u.pathname !== "/.well-known/opencodex/link-relay-auth" && !req.headers.has(LINK_RELAY_SESSION_HEADER)) {
          return new Response(JSON.stringify({ error: "session_required" }), { status: 401 });
        }
        return relaySessions.dispatch(req, server, async innerReq => {
          const url = new URL(innerReq.url);
          const rawAuth = innerReq.headers.get("x-opencodex-api-key") ?? innerReq.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
          const admittedKey = (homeConfig.apiKeys ?? []).find(k => k.key === rawAuth);
          if (!admittedKey) return Response.json({ error: "unauthorized" }, { status: 401 });
          if (url.pathname === "/readyz") return Response.json({ status: "ready", protocolVersion: 1, minClientProtocolVersion: 1, maxClientProtocolVersion: 1, version: "2.98.0", managementUrl: `http://127.0.0.1:${server.port}` });
          if (url.pathname === "/v1/catalog") { for (const cb of catalogCallbacks) cb(admittedKey.id); return Response.json({ models: [{ slug: "planted-model" }] }); }
          const mgmt = await handleLinkManagementRequest(innerReq, url, homeConfig, {} as never, undefined, admittedKey.id);
          return mgmt ?? Response.json({ error: "not_found" }, { status: 404 });
        });
      },
    });
    const tunnelPort = homeHubLinkServer.port!;
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: tunnelPort, links: [] });
    const childEnv = {
      HOME: childUserHome,
      OPENCODEX_HOME: childOcxHome,
      CODEX_HOME: childCodexHome,
      OCX_CHILD_LISTEN_PORT: String(childListenPort),
      PATH: privateUtils,
    };
    const runShellAsync = async (argv: string[], stdin?: Uint8Array): Promise<SshRunResult> => {
      const proc = Bun.spawn(argv, { cwd: childUserHome, env: childEnv, stdin: stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
      if (stdin && proc.stdin) { proc.stdin.write(stdin); proc.stdin.end(); }
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    };
    const sshRunner: SshRunner = {
      async run(argv, options) {
        if (argv[0] === "ssh-keygen") return { code: 0, stdout: "256 SHA256:barefingerprint01 barebox (ED25519)\n", stderr: "" };
        const cmd = argv.at(-1) ?? "";
        if (cmd === "echo ocx-link-probe") {
          const khArg = argv.find(a => a.startsWith("UserKnownHostsFile="))!;
          writeFileSync(khArg.slice("UserKnownHostsFile=".length).replace(/^"|"$/g, ""), "barebox ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBARE\n");
          return { code: 0, stdout: "ocx-link-probe\n", stderr: "" };
        }
        const patched = sandboxRemoteSh(cmd, scratch);
        if (patched.includes("'link' 'port'")) return { code: 0, stdout: JSON.stringify({ port: tunnelPort }) + "\n", stderr: "" };
        const bytes = typeof options?.stdin === "string" ? new TextEncoder().encode(options.stdin) : options?.stdin;
        return runShellAsync([resolvedSh, "-c", patched], bytes);
      },
      spawnTunnel() { throw new Error("unused"); },
    };
    let issuedCounter = 0;
    const knownHostsPath = join(scratch, "home-ocx", "bare_known_hosts");
    const linkState: LinkRouteState = {
      pendingHosts: new Map(),
      confirmedHosts: new Map(),
      operations: new Set(),
      listener: {
        ensureStarted: async () => {},
        status: () => ({ state: "listening", port: tunnelPort, reason: null }),
        close: async () => {},
        onAuthenticatedCatalog: cb => { catalogCallbacks.add(cb); return () => { catalogCallbacks.delete(cb); }; },
      },
      supervisor: {
        start() {}, ensureStarted: async () => {}, reload: async () => {}, holdLink: () => () => {}, stopLink: async () => {}, reconnect: async () => true,
        status: () => readLinkStore(linkStorePath()).links.map(l => ({ linkId: l.id, direction: "hub-initiated" as const, state: { kind: "connected" as const, since: Date.now() } })),
        stop: async () => {},
      },
    };
    const mgmtCall = async (method: string, path: string, body?: unknown): Promise<Response> => {
      const url = new URL(`http://127.0.0.1:10100${path}`);
      const ctx: ManagementContext = {
        req: new Request(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }),
        url, config: homeConfig, version: "2.98.0", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
        deps: {
          sshRunner,
          readLinkStore: () => readLinkStore(linkStorePath()),
          writeLinkStore: next => writeLinkStore(linkStorePath(), next),
          linkKnownHostsPath: () => knownHostsPath,
          liveListenPort: () => 10100,
          issueApiKey: (cfg, name) => {
            const hex = String(++issuedCounter).padStart(40, "0");
            const entry = { id: `bare-key-${issuedCounter}`, name, key: `ocx_data_${hex}`, createdAt: new Date().toISOString() };
            cfg.apiKeys = [...(cfg.apiKeys ?? []), entry];
            return entry;
          },
          revokeApiKey: (cfg, id) => { cfg.apiKeys = (cfg.apiKeys ?? []).filter(k => k.id !== id); return true; },
        },
        sessionControl: { isCurrent: () => true, isPaired: () => true, revokeCurrent: () => true },
        convergeCodexCatalog: async () => { throw new Error("unused"); },
        syncClaudeAgentDefsBestEffort: async () => {},
      };
      const r = await handleLinkRoutes(ctx, linkState);
      if (!r) throw new Error("unhandled");
      return r;
    };
    try {
      const probeRes = await mgmtCall("POST", "/api/link/probe", { alias: "barebox" });
      expect(probeRes.status).toBe(200);
      const probeBody = await probeRes.json() as { fingerprint: string };

      const confirmRes = await mgmtCall("POST", "/api/link/confirm-host", { alias: "barebox", fingerprint: probeBody.fingerprint, allowMissing: true });
      expect(confirmRes.status).toBe(200);
      const confirmBody = await confirmRes.json() as { runtimeKind: string; plantable: boolean; binarySizeBytes: number };
      expect(confirmBody.runtimeKind).toBe("missing");
      expect(confirmBody.plantable).toBe(true);
      expect(confirmBody.binarySizeBytes).toBeGreaterThan(100_000);

      const applyRes = await mgmtCall("POST", "/api/link/apply", { alias: "barebox", plant: true });
      expect(applyRes.status).toBe(202);
      const { linkId } = await applyRes.json() as { linkId: string };
      expect(existsSync(plantedPath)).toBe(true);
      expect(readLinkStore(linkStorePath()).links[0]?.childKind).toBe("ephemeral");

      const delRes = await mgmtCall("DELETE", `/api/link/${linkId}`, { purge: true });
      expect(delRes.status).toBe(200);
      expect(existsSync(plantedPath)).toBe(false);
      expect(existsSync(join(childOcxHome, "child"))).toBe(false);
      expect(readFileSync(join(childCodexHome, "config.toml"), "utf8")).toBe("approval_policy = \"on-request\"\n");
    } finally {
      if (prevBinDir === undefined) delete process.env.OPENCODEX_CHILD_BIN_DIR;
      else process.env.OPENCODEX_CHILD_BIN_DIR = prevBinDir;
      if (existsSync(plantedPath)) await runShellAsync([plantedPath, "disconnect", "--purge"]);
      relaySessions.abortReservations();
      await homeHubLinkServer.stop(true);
    }
  }, 30_000);
});
