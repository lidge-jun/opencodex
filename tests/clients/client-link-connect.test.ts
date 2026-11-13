import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { clientConnectionSchema } from "../../src/config/schema/leaf-validators";
import { handleConnectCommand, handleDisconnectCommand } from "../../src/cli/connect";
import { readSecretBytes } from "../../src/cli/runtime-api";
import { joinHome } from "../../src/client/link-join";
import { quoteRemote, remoteOcxArgv } from "../../src/link/ssh-argv";
import { connectClient, routingTarget } from "../../src/client/connect";
import { readServiceApiTokenState } from "../../src/lib/service-secrets";
import { isLinkConnection, readClientConnectionState } from "../../src/client/state";
import { DEFAULT_CATALOG_PATH } from "../../src/codex/paths";
import { createLocalAttestationProof, createLocalAttestationSecret, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER } from "../../src/lib/local-management-attestation";
import { skipsCodexShimAutoRestore } from "../../src/cli/codex-shim-autorestore";
import { withClientLifecycleSync } from "../../src/client/lifecycle-lock";
import { handleConfigCommand } from "../../src/cli/config-command";
import { acquireOwnershipMutationLease } from "../../src/service/ownership-mutation-lease.mjs";
import { inspectServiceManagerInstallation } from "../../src/service-manager-probe";
import { buildServiceShellCommand } from "../../src/service/definition";
import { inspectOrphanServiceAdmission } from "../../src/client/orphan-token-recovery";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";

const linkId = "lnk_0123456789abcdef";
const key = `ocx_data_${"a".repeat(40)}`;
const noService = () => ({ kind: "absent" as const });

function client(overrides: Record<string, unknown> = {}) {
  return {
    serverUrl: "http://127.0.0.1:34567",
    managementUrl: "http://127.0.0.1:34567",
    managementTransport: "direct",
    transport: "link",
    link: { tunnelPort: 34567, linkId },
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "key-1",
    tokenFingerprint: "a".repeat(64),
    protocolVersion: 1,
    connectedAt: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("client link connection contracts", () => {
  test("validates the link field chain and rejects incompatible transport combinations", () => {
    expect(clientConnectionSchema.safeParse(client()).success).toBe(true);
    expect(clientConnectionSchema.safeParse(client({ transport: "hub" })).success).toBe(false);
    expect(clientConnectionSchema.safeParse(client({ managementTransport: "relay" })).success).toBe(false);
    expect(clientConnectionSchema.safeParse(client({ link: { tunnelPort: 1023, linkId } })).success).toBe(false);
    expect(clientConnectionSchema.safeParse(client({ serverUrl: "https://127.0.0.1:34567" })).success).toBe(false);
  });

  test("keeps Codex on the standalone 127.0.0.1 form of the local configured port while retaining link identity", () => {
    const target = routingTarget("http://127.0.0.1:34567", 10100);
    expect(target).toEqual({
      baseUrl: "http://127.0.0.1:10100/v1",
      requiresAdmissionToken: false,
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      link: true,
    });
    // The loopback opt-ins follow the standalone target, so a join changes no Codex routing bytes.
    expect(routingTarget("http://127.0.0.1:34567", 10100, { codexClientCompaction: true }).clientCompaction).toBe(true);
    // A hub client still points Codex at the hub with the admission token in env_key.
    expect(routingTarget("https://hub.example.test")).toEqual({
      baseUrl: "https://hub.example.test/v1", requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    });
    expect(isLinkConnection(client() as never)).toBe(true);
    expect(isLinkConnection(undefined)).toBe(false);
  });

  test("bounds raw stdin bytes at 4 KiB", async () => {
    const input = new EventEmitter() as EventEmitter & { readableEnded?: boolean };
    input.readableEnded = false;
    const pending = readSecretBytes({ stdinImpl: input as never, stdinTimeoutMs: 1000 }, "link credential");
    const chunk = Buffer.alloc(4097, 0x61);
    input.emit("data", chunk);
    await expect(pending).rejects.toThrow("exceeds 4096 bytes");
    expect(chunk.every(byte => byte === 0)).toBe(true);
  });

  test("zeroes a Buffer source after successful secret parsing", async () => {
    const input = new EventEmitter() as EventEmitter & { readableEnded?: boolean };
    input.readableEnded = false;
    const chunk = Buffer.from("secret");
    const pending = readSecretBytes({ stdinImpl: input as never, stdinTimeoutMs: 1000 }, "link credential");
    input.emit("data", chunk);
    input.emit("end");
    await expect(pending).resolves.toEqual(new TextEncoder().encode("secret"));
    expect(chunk.every(byte => byte === 0)).toBe(true);
  });

  async function withLinkHome(
    run: (home: string, codexHome: string) => Promise<void>,
    removeTree: typeof removeTreeAfterBackgroundWork = removeTreeAfterBackgroundWork,
  ): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "ocx-client-link-contract-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-client-link-contract-codex-"));
    const previousHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = codexHome;
    // These are enrollment/catalog contracts. ACL enforcement has its own native tests;
    // real PowerShell/icacls work can consume the five-second semantic test budget.
    let aclCalls = 0;
    const aclSuccess = () => { aclCalls += 1; return { success: true, exitCode: 0, timedOut: false, stdout: "" }; };
    setSyntheticWindowsPrincipalForTests("*S-1-5-21-1-2-3-1001");
    setIcaclsRunnerForTests(aclSuccess);
    setAsyncIcaclsRunnerForTests(async () => aclSuccess());
    let runSucceeded = false;
    try {
      const config = getDefaultConfig();
      config.port = 10100;
      saveConfig(config);
      await run(home, codexHome);
      if (process.platform === "win32") expect(aclCalls).toBeGreaterThan(0);
      runSucceeded = true;
    } finally {
      setIcaclsRunnerForTests(null);
      setAsyncIcaclsRunnerForTests(null);
      setSyntheticWindowsPrincipalForTests(null);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      const cleanupErrors: unknown[] = [];
      for (const path of [home, codexHome]) {
        try { await removeTree(path); } catch (error) { cleanupErrors.push(error); }
      }
      // Keep the original body/assertion error when cleanup also fails.
      if (runSucceeded && cleanupErrors.length > 0) throw cleanupErrors[0];
    }
  }

  for (const runFails of [false, true]) {
    test(`link fixture cleanup attempts both removals after body ${runFails ? "failure" : "success"}`, async () => {
      const previousHome = process.env.OPENCODEX_HOME, previousCodexHome = process.env.CODEX_HOME;
      const bodyFailure = new Error("synthetic fixture body failure");
      const cleanupFailure = new Error("synthetic first removal failure");
      let homes: string[] = [];
      const attempted: string[] = [];
      try {
        await expect(withLinkHome(async (home, codexHome) => {
          homes = [home, codexHome];
          if (runFails) throw bodyFailure;
        }, async path => {
          attempted.push(path);
          if (path === homes[0]) throw cleanupFailure;
          await removeTreeAfterBackgroundWork(path);
        })).rejects.toBe(runFails ? bodyFailure : cleanupFailure);
        expect(attempted).toEqual(homes);
        expect(process.env.OPENCODEX_HOME).toBe(previousHome);
        expect(process.env.CODEX_HOME).toBe(previousCodexHome);
        expect(existsSync(homes[0]!)).toBe(true);
        expect(existsSync(homes[1]!)).toBe(false);
      } finally {
        for (const path of homes) if (existsSync(path)) await removeTreeAfterBackgroundWork(path);
      }
    });
  }

  function linkOptions() {
    return {
      serverUrl: "http://127.0.0.1:34567",
      managementUrl: "http://127.0.0.1:34567",
      managementTransport: "direct" as const,
      transport: "link" as const,
      link: { tunnelPort: 34567, linkId },
      credential: { kind: "link" as const, apiKeyId: "key-1", key },
      selectedClients: ["claude" as const],
      noSync: true,
    };
  }

  test("readiness failure removes the pending link token and leaves config.client unset", async () => {
    await withLinkHome(async home => {
      await expect(connectClient(linkOptions(), {
        fetchImpl: async () => Response.json({
          service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567,
          status: "pending", protocol: 1, minimumClientProtocol: 1,
          managementUrl: "http://127.0.0.1:34567",
        }, { status: 503 }),
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
        catalogCompatibility: { supportedEfforts: () => new Set() },
      })).rejects.toThrow("hub is not ready");
      expect(readServiceApiTokenState()).toEqual({ kind: "absent" });
      expect(readClientConnectionState()).toEqual({ kind: "disconnected" });
    });
  });

  test("cancellation during catalog download prevents late enrollment writes and drains token rollback", async () => {
    await withLinkHome(async home => {
      const prior = '{"models":[{"id":"prior"}]}\n';
      writeFileSync(DEFAULT_CATALOG_PATH, prior);
      const abort = new AbortController();
      let cancelledFetch = false;
      await expect(connectClient(linkOptions(), {
        signal: abort.signal,
        fetchImpl: async (input, init) => {
          if (String(input).endsWith("/readyz")) return Response.json({
            service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567,
            status: "ready", protocol: 1, minimumClientProtocol: 1,
            managementUrl: "http://127.0.0.1:34567",
          });
          abort.abort(new Error("fixture enrollment cancelled"));
          cancelledFetch = init?.signal?.aborted === true;
          // Even a fetch implementation returning after abort cannot authorize a write.
          return Response.json({ models: [] });
        },
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
        catalogCompatibility: { supportedEfforts: () => new Set() },
      })).rejects.toThrow("fixture enrollment cancelled");
      expect(cancelledFetch).toBe(true);
      expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(prior);
      expect(readServiceApiTokenState()).toEqual({ kind: "absent" });
      expect(readClientConnectionState()).toEqual({ kind: "disconnected" });
    });
  });

  test("a real enrollment commit survives a tunnel exit queued before join completion", async () => {
    await withLinkHome(async home => {
      let exit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { exit = resolve; });
      let revoked = 0, restarted = 0;
      const result = await joinHome({
        runner: {
          run: async argv => {
            if (argv.at(-1) === quoteRemote(remoteOcxArgv(["link", "revoke", "--link-id", linkId]))) {
              revoked += 1;
              return { code: 0, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: JSON.stringify({ linkId, apiKeyId: "key-1", key, listenerPort: 45678 }), stderr: "" };
          },
          spawnTunnel: () => { throw new Error("unexpected real tunnel"); },
        },
        knownHostsFile: join(home, "known-hosts"),
        confirmedHost: { alias: "home", fingerprint: "SHA256:fixture", probedAt: 1 },
        now: () => 1, choosePort: async () => 34567,
        writeState: () => {}, clearState: () => {}, readSidecar: () => null,
        spawnTunnel: () => ({ pid: 123, exited, stop: async () => {} }),
        scanListenPids: () => ({ ok: true, pids: [123] }),
        selectedClients: ["claude"],
        fetchImpl: async (input, init) => {
          if (!String(input).endsWith("/readyz")) return Response.json({ models: [] });
          if (!new Headers(init?.headers).has("x-opencodex-api-key")) return new Response(null, { status: 401 });
          return Response.json({ service: "opencodex", version: "0.0.0", uptime: 1, pid: 123,
            port: 34567, status: "ready", protocol: 1, minimumClientProtocol: 1,
            managementUrl: "http://127.0.0.1:34567" });
        },
        connectDeps: { lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          catalogCompatibility: { supportedEfforts: () => new Set() } },
        connect: async (options, deps) => {
          const committed = await connectClient(options, deps);
          exit(255);
          return committed;
        },
        scheduleRestart: () => { restarted += 1; },
      }, { alias: "home" });
      expect(result).toEqual({ linkId, apiKeyId: "key-1" });
      expect(readClientConnectionState()).toMatchObject({ kind: "connected", value: { link: { linkId } } });
      expect(readServiceApiTokenState()).toMatchObject({ kind: "present", token: key });
      expect(revoked).toBe(0);
      expect(restarted).toBe(1);
    });
  });

  test("catalog failure removes the pending link token and leaves config.client unset", async () => {
    await withLinkHome(async home => {
      await expect(connectClient(linkOptions(), {
        fetchImpl: async input => String(input).endsWith("/readyz")
          ? Response.json({
            service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567,
            status: "ready", protocol: 1, minimumClientProtocol: 1,
            managementUrl: "http://127.0.0.1:34567",
          })
          : new Response("catalog failed", { status: 503 }),
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
        catalogCompatibility: { supportedEfforts: () => new Set() },
      })).rejects.toThrow("Hub catalog request failed");
      expect(readServiceApiTokenState()).toEqual({ kind: "absent" });
      expect(readClientConnectionState()).toEqual({ kind: "disconnected" });
    });
  });

  test("link disconnect restores the prior catalog, clears config.client, and omits the key", async () => {
    await withLinkHome(async home => {
      writeFileSync(DEFAULT_CATALOG_PATH, '{"models":[{"id":"prior"}]}\n');
      const connection = await connectClient(linkOptions(), {
        fetchImpl: async input => String(input).endsWith("/readyz")
          ? Response.json({
            service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567,
            status: "ready", protocol: 1, minimumClientProtocol: 1,
            managementUrl: "http://127.0.0.1:34567",
          })
          : Response.json({ models: [] }),
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
        catalogCompatibility: { supportedEfforts: () => new Set() },
      });
      expect(connection.transport).toBe("link");
      const logs = spyOn(console, "log").mockImplementation(() => {});
      try {
        await handleDisconnectCommand([], { lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") } });
      } finally {
        logs.mockRestore();
      }
      expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe('{"models":[{"id":"prior"}]}\n');
      expect(readClientConnectionState()).toEqual({ kind: "disconnected" });
      expect(readServiceApiTokenState()).toEqual({ kind: "absent" });
      expect(existsSync(join(home, "service-api-token"))).toBe(false);
      expect(logs.mock.calls.flat().join(" ")).not.toContain(key);
    });
  });

  test("disconnect --expect-link for another link changes nothing and exits 5 with the child_link_mismatch line", async () => {
    await withLinkHome(async home => {
      await connectClient(linkOptions(), {
        fetchImpl: async input => String(input).endsWith("/readyz")
          ? Response.json({ service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567, status: "ready", protocol: 1, minimumClientProtocol: 1, managementUrl: "http://127.0.0.1:34567" })
          : Response.json({ models: [] }),
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
        // No real Codex probe for its supported efforts (it can take seconds): the catalog here has no models.
        catalogCompatibility: { supportedEfforts: () => new Set() },
      });
      const lines: string[] = [];
      const errors = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
      let exit: number;
      try {
        exit = await handleDisconnectCommand(["--expect-link", "lnk_ffffffffffffffff"], { lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") } });
      } finally { errors.mockRestore(); }
      expect(exit).toBe(5);
      expect(JSON.parse(lines.at(-1) ?? "null")).toEqual({ phase: "child_link_mismatch", reason: "other_link" });
      expect(readClientConnectionState()).toMatchObject({ kind: "connected", value: { link: { linkId } } });
      expect(readServiceApiTokenState()).toMatchObject({ kind: "present" });
    });
  });

  test("disconnect --expect-link for its own link disconnects as a plain disconnect does", async () => {
    await withLinkHome(async home => {
      await connectClient(linkOptions(), {
        fetchImpl: async input => String(input).endsWith("/readyz")
          ? Response.json({ service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567, status: "ready", protocol: 1, minimumClientProtocol: 1, managementUrl: "http://127.0.0.1:34567" })
          : Response.json({ models: [] }),
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
        // No real Codex probe for its supported efforts (it can take seconds): the catalog here has no models.
        catalogCompatibility: { supportedEfforts: () => new Set() },
      });
      const logs = spyOn(console, "log").mockImplementation(() => {});
      let exit: number;
      try {
        exit = await handleDisconnectCommand(["--expect-link", linkId, "--json"], { lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") } });
      } finally { logs.mockRestore(); }
      expect(exit).toBe(0);
      expect(readClientConnectionState()).toEqual({ kind: "disconnected" });
    });
  });

  test("disconnect --expect-link on a disconnected machine exits 5 (reason disconnected) before any teardown", async () => {
    await withLinkHome(async home => {
      const lines: string[] = [];
      const errors = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
      let exit: number;
      try {
        exit = await handleDisconnectCommand(["--expect-link", linkId], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          linkTeardownDeps: { reapOrphanTunnel: async () => { throw new Error("teardown must not run"); } } as never,
        });
      } finally { errors.mockRestore(); }
      expect(exit).toBe(5);
      expect(JSON.parse(lines.at(-1) ?? "null")).toEqual({ phase: "child_link_mismatch", reason: "disconnected" });
      expect(readClientConnectionState()).toEqual({ kind: "disconnected" });
    });
  });

  test("disconnect --expect-link without a valid link id is a usage error and changes nothing", async () => {
    await withLinkHome(async () => {
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await handleDisconnectCommand(["--expect-link", "not-a-link"])).toBe(2);
        expect(await handleDisconnectCommand(["--expect-link", linkId, "--orphaned-token", "--yes"])).toBe(2);
      } finally { errors.mockRestore(); }
    });
  });

  test("confirmed orphan recovery preserves both tokens privately without exposing their bytes", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      writeFileSync(`${tokenPath}.prev`, "previous-private-key\n", { mode: 0o600 });
      const log = spyOn(console, "log").mockImplementation(() => {});
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes", "--json"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => true },
        } as never);
        expect(result).toBe(0);
        const output = log.mock.calls.flat().join(" ");
        expect(output).not.toContain(key);
        expect(output).not.toContain("previous-private-key");
        const payload = JSON.parse(output) as { backupDir: string };
        expect(readFileSync(join(payload.backupDir, "service-api-token"), "utf8")).toBe(`${key}\n`);
        expect(readFileSync(join(payload.backupDir, "service-api-token.prev"), "utf8")).toBe("previous-private-key\n");
        expect(existsSync(tokenPath)).toBe(false);
        expect(existsSync(`${tokenPath}.prev`)).toBe(false);
        if (process.platform !== "win32") {
          expect(lstatSync(payload.backupDir).mode & 0o777).toBe(0o700);
          expect(lstatSync(join(payload.backupDir, "service-api-token")).mode & 0o777).toBe(0o600);
        }
      } finally { log.mockRestore(); err.mockRestore(); }
    });
  });

  test.each(["hub", "non-loopback", "configured-token", "configured-token-file", "matching-api-key", "matching-pending-key", "service-exported", "service-unknown", "service-probe-failed"])(
    "orphan recovery refuses %s admission ownership", async scenario => {
      await withLinkHome(async home => {
        const tokenPath = join(home, "service-api-token");
        writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
        const config = getDefaultConfig();
        if (scenario === "hub") config.runtimeRole = "hub";
        if (scenario === "non-loopback") config.hostname = "0.0.0.0";
        if (scenario === "matching-api-key") config.apiKeys = [{ id: "fixture", name: "fixture", key, createdAt: "2026-01-01T00:00:00.000Z" }];
        if (scenario === "matching-pending-key") config.apiKeys = [{ id: "fixture", name: "fixture", key: "different-key", createdAt: "2026-01-01T00:00:00.000Z", pendingRotation: { id: "rotation", key, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" } }];
        saveConfig(config);
        const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
        const previousTokenFile = process.env.OCX_API_TOKEN_FILE;
        if (scenario === "configured-token") process.env.OPENCODEX_API_AUTH_TOKEN = key;
        if (scenario === "configured-token-file") process.env.OCX_API_TOKEN_FILE = tokenPath;
        let inspectServiceManager = noService;
        if (scenario === "service-exported") {
          const serviceHome = join(home, "service-user");
          const directory = join(serviceHome, ".config", "systemd", "user");
          mkdirSync(directory, { recursive: true });
          const definition = join(directory, "opencodex-proxy.service");
          const simulatedHome = "/home/fixture/.opencodex";
          const simulatedTokenPath = `${simulatedHome}/service-api-token`;
          const command = buildServiceShellCommand("/usr/bin/bun", null, 12345, simulatedTokenPath);
          writeFileSync(definition, `[Service]\nEnvironment="OPENCODEX_HOME=${simulatedHome}"\nExecStart=${command}\n`);
          expect(command).toContain("OPENCODEX_API_AUTH_TOKEN");
          expect(command).toContain(simulatedTokenPath);
          const inspection = inspectServiceManagerInstallation({ platform: "linux", home: serviceHome,
            run: () => ({ status: 0, stdout: `LoadState=loaded\nActiveState=inactive\nFragmentPath=${definition}\nNeedDaemonReload=no\n`, stderr: "", timedOut: false, spawnFailed: false }) });
          expect(inspection.kind).toBe("present");
          if (inspection.kind === "present") expect(inspection.claims[0]?.homes.opencodexHome).toBe(simulatedHome);
          inspectServiceManager = (() => inspection) as typeof noService;
        }
        if (scenario === "service-unknown") inspectServiceManager = (() => ({ kind: "unknown", reason: "fixture" })) as unknown as typeof noService;
        if (scenario === "service-probe-failed") inspectServiceManager = (() => inspectOrphanServiceAdmission({ platform: "linux", home,
          run: () => ({ status: null, stdout: "", stderr: "", timedOut: false, spawnFailed: true }) })) as typeof noService;
        const err = spyOn(console, "error").mockImplementation(() => {});
        const log = spyOn(console, "log").mockImplementation(() => {});
        try {
          const result = await handleDisconnectCommand(["--orphaned-token", "--yes"], {
            lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
            orphanRecoveryDeps: { inspectServiceManager, acquireLease: () => ({ release() {} }), runtimeSafe: async () => true },
          } as never);
          expect(result).toBe(1);
          expect(err.mock.calls.flat().join(" ").toLowerCase()).toContain(scenario === "hub" ? "hub" : "admission");
          expect(readFileSync(tokenPath, "utf8")).toBe(`${key}\n`);
        } finally {
          if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
          if (previousTokenFile === undefined) delete process.env.OCX_API_TOKEN_FILE; else process.env.OCX_API_TOKEN_FILE = previousTokenFile;
          err.mockRestore(); log.mockRestore();
        }
      });
    },
  );

  test("orphan recovery permits a completed disconnect receipt", async () => {
    await withLinkHome(async home => {
      writeFileSync(join(home, "service-api-token"), `${key}\n`, { mode: 0o600 });
      mkdirSync(join(home, "desktop-remote"), { mode: 0o700 });
      const receipt = { version: 1, owner: { serverUrl: "http://127.0.0.1:34567", apiKeyId: "key-1", connectedAt: "2026-09-25T00:00:00.000Z" },
        tokenFingerprint: "a".repeat(64), keepCatalog: false, phase: "complete" };
      writeFileSync(join(home, "desktop-remote", "disconnect.json"), JSON.stringify(receipt), { mode: 0o600 });
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => true },
        } as never)).toBe(0);
      } finally { log.mockRestore(); }
    });
  });

  test("Windows-style recovery closes source handles before moving and retains the identity witness", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      writeFileSync(`${tokenPath}.prev`, "previous-private-key\n", { mode: 0o600 });
      const tokenInode = lstatSync(tokenPath).ino;
      let observed = false;
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes", "--json"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => true,
            windowsMoveForTest: true, onWindowsHandlesClosed: (fds: readonly number[]) => {
              expect(fds.length).toBe(2);
              for (const fd of fds) expect(() => fstatSync(fd)).toThrow();
              observed = true;
            } },
        } as never);
        expect(result).toBe(0);
        expect(observed).toBe(true);
        const backup = JSON.parse(log.mock.calls.flat().join(" ")) as { backupDir: string };
        expect(lstatSync(join(backup.backupDir, "service-api-token")).ino).toBe(tokenInode);
        expect(readFileSync(join(backup.backupDir, "service-api-token"), "utf8")).toBe(`${key}\n`);
        expect(readFileSync(join(backup.backupDir, "service-api-token.prev"), "utf8")).toBe("previous-private-key\n");
        expect(readdirSync(backup.backupDir).sort()).toEqual(["service-api-token", "service-api-token.prev"]);
      } finally { log.mockRestore(); }
    });
  });

  test("orphan recovery rechecks service admission after liveness", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      let checks = 0;
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { acquireLease: () => ({ release() {} }), runtimeSafe: async () => true,
            inspectServiceManager: () => ++checks === 1 ? { kind: "absent" } : { kind: "unknown", reason: "fixture" } },
        } as never);
        expect(result).toBe(1);
        expect(checks).toBe(2);
        expect(err.mock.calls.flat().join(" ")).toContain("admission secret");
        expect(readFileSync(tokenPath, "utf8")).toBe(`${key}\n`);
      } finally { err.mockRestore(); }
    });
  });

  test("orphan recovery rechecks the admission bind after liveness", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => {
            const config = getDefaultConfig(); config.hostname = "0.0.0.0"; saveConfig(config); return true;
          } },
        } as never);
        expect(result).toBe(1);
        expect(err.mock.calls.flat().join(" ")).toContain("admission secret");
        expect(readFileSync(tokenPath, "utf8")).toBe(`${key}\n`);
      } finally { err.mockRestore(); }
    });
  });

  test("orphan recovery rechecks an admission-token environment change after liveness", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      const previous = process.env.OPENCODEX_API_AUTH_TOKEN;
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => {
            process.env.OPENCODEX_API_AUTH_TOKEN = key; return true;
          } },
        } as never);
        expect(result).toBe(1);
        expect(err.mock.calls.flat().join(" ")).toContain("admission secret");
        expect(readFileSync(tokenPath, "utf8")).toBe(`${key}\n`);
      } finally {
        if (previous === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = previous;
        err.mockRestore();
      }
    });
  });

  test("Windows-style identity pin preserves the original if the source name is replaced", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => true,
            windowsMoveForTest: true, onWindowsHandlesClosed: () => {
              renameSync(tokenPath, join(home, "moved-original"));
              writeFileSync(tokenPath, "different-private-key\n", { mode: 0o600 });
            } },
        } as never);
        expect(result).toBe(1);
        expect(readFileSync(tokenPath, "utf8")).toBe("different-private-key\n");
        expect(readFileSync(join(home, "moved-original"), "utf8")).toBe(`${key}\n`);
        const backupName = readdirSync(home).find(name => name.startsWith("orphaned-token-"));
        expect(backupName).toBeDefined();
        // Another name still holds the original, so the refusal removes its identity pin.
        expect(readdirSync(join(home, backupName!))).toEqual([]);
        expect(lstatSync(join(home, "moved-original")).nlink).toBe(1);
        expect(err.mock.calls.flat().join(" ")).toContain("orphan recovery incomplete");
      } finally { err.mockRestore(); }
    });
  });

  test("Windows-style identity pin is kept when it is the last name of the original", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => true,
            windowsMoveForTest: true, onWindowsHandlesClosed: () => {
              rmSync(tokenPath);
              writeFileSync(tokenPath, "different-private-key\n", { mode: 0o600 });
            } },
        } as never);
        expect(result).toBe(1);
        const backupName = readdirSync(home).find(name => name.startsWith("orphaned-token-"));
        expect(readFileSync(join(home, backupName!, ".service-api-token.identity"), "utf8")).toBe(`${key}\n`);
        expect(err.mock.calls.flat().join(" ")).toContain("orphan recovery incomplete");
      } finally { err.mockRestore(); }
    });
  });

  test("a leftover identity pin from an interrupted recovery is named in the refusal", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      const backupDir = join(home, "orphaned-token-2026-11-07T00-00-00-000Z-abc123");
      mkdirSync(backupDir, { mode: 0o700 });
      linkSync(tokenPath, join(backupDir, ".service-api-token.identity"));
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => true },
        } as never);
        expect(result).toBe(1);
        const message = err.mock.calls.flat().join(" ");
        expect(message).toContain("unsafe token file");
        expect(message).toContain(".service-api-token.identity");
        expect(message).toContain("orphaned-token-");
        expect(message).not.toContain(key);
        expect(readFileSync(tokenPath, "utf8")).toBe(`${key}\n`);
      } finally { err.mockRestore(); }
    });
  });

  test("orphan recovery refuses a held start ownership lease", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      const statePaths = [join(home, "service-state.json")];
      const held = acquireOwnershipMutationLease(statePaths, { isolated: true, waitMs: 0 });
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => acquireOwnershipMutationLease(statePaths, { isolated: true, waitMs: 0 }), runtimeSafe: async () => true },
        } as never)).toBe(1);
        expect(err.mock.calls.flat().join(" ")).toContain("mutation lease");
        expect(readFileSync(tokenPath, "utf8")).toBe(`${key}\n`);
      } finally { held.release(); err.mockRestore(); }
    });
  });

  test("orphan recovery bypasses automatic shim repair even without confirmation", () => {
    expect(skipsCodexShimAutoRestore("disconnect", ["disconnect", "--orphaned-token"])).toBe(true);
  });

  test("a Home's link-bound disconnect bypasses automatic shim repair, so a refusal changes nothing", () => {
    expect(skipsCodexShimAutoRestore("disconnect", ["disconnect", "--expect-link", linkId])).toBe(true);
    expect(skipsCodexShimAutoRestore("disconnect", ["disconnect", "--expect-link=" + linkId])).toBe(true);
    expect(skipsCodexShimAutoRestore("disconnect", ["disconnect"])).toBe(false);
  });

  test("orphan token refusal and link enrollment name the explicit recovery command", async () => {
    await withLinkHome(async home => {
      writeFileSync(join(home, "service-api-token"), `${key}\n`, { mode: 0o600 });
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand([], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          linkTeardownDeps: { reapOrphanTunnel: async () => ({ tunnel: "absent" }) },
        });
        expect(result).toBe(1);
        expect(err.mock.calls.flat().join(" ")).toContain("ocx disconnect --orphaned-token --yes");
        await expect(connectClient(linkOptions(), {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
        })).rejects.toThrow("ocx disconnect --orphaned-token --yes");
        expect(readFileSync(join(home, "service-api-token"), "utf8")).toBe(`${key}\n`);
      } finally { err.mockRestore(); }
    });
  });

  test("a new link enrollment succeeds after explicitly preserving the orphan token", async () => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      const lockPath = join(home, "lifecycle.sqlite");
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await handleDisconnectCommand(["--orphaned-token", "--yes", "--json"], {
          lifecycleLockDeps: { lockPath },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => true },
        } as never)).toBe(0);
        const backup = JSON.parse(log.mock.calls.flat().join(" ")) as { backupDir: string };
        const newKey = `ocx_data_${"b".repeat(40)}`;
        const connection = await connectClient({ ...linkOptions(), credential: { kind: "link", apiKeyId: "new-key", key: newKey } }, {
          lifecycleLockDeps: { lockPath },
          catalogCompatibility: { supportedEfforts: () => new Set() },
          fetchImpl: async input => String(input).endsWith("/readyz")
            ? Response.json({ service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567, status: "ready", protocol: 1, minimumClientProtocol: 1, managementUrl: "http://127.0.0.1:34567" })
            : Response.json({ models: [] }),
        });
        expect(connection.apiKeyId).toBe("new-key");
        expect(readFileSync(tokenPath, "utf8")).toBe(`${newKey}\n`);
        expect(readFileSync(join(backup.backupDir, "service-api-token"), "utf8")).toBe(`${key}\n`);
      } finally { log.mockRestore(); }
    });
  });

  test("config import refuses to replace an active connection record", async () => {
    await withLinkHome(async home => {
      const configPath = join(home, "config.json");
      const original = JSON.stringify({ ...getDefaultConfig(), runtimeRole: "client", client: client() });
      writeFileSync(configPath, original);
      const input = join(home, "replacement.json");
      writeFileSync(input, JSON.stringify(getDefaultConfig()));
      const log = spyOn(console, "log").mockImplementation(() => {});
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await handleConfigCommand(["import", input, "--yes"])).not.toBe(0);
        expect(err.mock.calls.flat().join(" ")).toContain("disconnect");
        expect(readFileSync(configPath, "utf8")).toBe(original);
        writeFileSync(input, original);
        expect(await handleConfigCommand(["import", input, "--yes"])).toBe(0);
        expect(readClientConnectionState().kind).toBe("connected");
      } finally { log.mockRestore(); err.mockRestore(); }
    });
  });

  test("orphan recovery holds the client lifecycle lock while checking liveness", async () => {
    await withLinkHome(async home => {
      writeFileSync(join(home, "service-api-token"), `${key}\n`, { mode: 0o600 });
      const lockPath = join(home, "lifecycle.sqlite");
      let proceed!: () => void;
      let observed!: () => void;
      const started = new Promise<void>(resolve => { observed = resolve; });
      const gate = new Promise<void>(resolve => { proceed = resolve; });
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        const pending = handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => { observed(); await gate; return true; } },
        } as never);
        await started;
        expect(() => withClientLifecycleSync(() => {}, { lockPath })).toThrow("client_lifecycle_busy");
        proceed();
        expect(await pending).toBe(0);
      } finally { proceed(); log.mockRestore(); }
    });
  });

  test.each(["missing-confirmation", "pending-connect", "pending-appeared", "disconnect-receipt", "disconnect-in-progress", "connected", "connection-appeared", "config-changed", "config-aba", "client-runtime", "unknown-runtime", "token-replaced", "backup-appeared"])(
    "orphan recovery refuses %s without changing the token", async scenario => {
      await withLinkHome(async home => {
        const tokenPath = join(home, "service-api-token");
        writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
        if (scenario === "pending-connect") writeFileSync(join(home, "client-connect-pending"), `${"a".repeat(64)}\n`, { mode: 0o600 });
        if (scenario === "disconnect-receipt" || scenario === "disconnect-in-progress") {
          mkdirSync(join(home, "desktop-remote"), { mode: 0o700 });
          const receipt = scenario === "disconnect-receipt" ? {} : {
            version: 1, owner: { serverUrl: "http://127.0.0.1:34567", apiKeyId: "key-1", connectedAt: "2026-09-25T00:00:00.000Z" },
            tokenFingerprint: "a".repeat(64), keepCatalog: false, phase: "prepared",
          };
          writeFileSync(join(home, "desktop-remote", "disconnect.json"), JSON.stringify(receipt), { mode: 0o600 });
        }
        if (scenario === "connected") {
          writeFileSync(join(home, "config.json"), JSON.stringify({ ...getDefaultConfig(), runtimeRole: "client", client: client() }));
        }
        const log = spyOn(console, "log").mockImplementation(() => {});
        const err = spyOn(console, "error").mockImplementation(() => {});
        try {
          const args = ["--orphaned-token", ...(scenario === "missing-confirmation" ? [] : ["--yes"])];
          const result = await handleDisconnectCommand(args, {
            lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
            orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => {
              if (scenario === "token-replaced") writeFileSync(tokenPath, "replacement-private-key\n", { mode: 0o600 });
              if (scenario === "backup-appeared") writeFileSync(`${tokenPath}.prev`, "new-backup\n", { mode: 0o600 });
              if (scenario === "pending-appeared") writeFileSync(join(home, "client-connect-pending"), `${"a".repeat(64)}\n`, { mode: 0o600 });
              if (scenario === "connection-appeared") writeFileSync(join(home, "config.json"), JSON.stringify({ ...getDefaultConfig(), runtimeRole: "client", client: client() }));
              if (scenario === "config-changed") writeFileSync(join(home, "config.json"), JSON.stringify({ ...getDefaultConfig(), port: 45678 }));
              if (scenario === "config-aba") {
                const changed = getDefaultConfig(); changed.port = 45678; saveConfig(changed);
                const restored = getDefaultConfig(); restored.port = 10100; saveConfig(restored);
              }
              return scenario !== "client-runtime" && scenario !== "unknown-runtime";
            } },
          } as never);
          expect(result).not.toBe(0);
          const message = err.mock.calls.flat().join(" ");
          const reason: Record<string, string> = {
            "missing-confirmation": "requires --yes", "pending-connect": "client connect is pending",
            "pending-appeared": "client connect is pending",
            "disconnect-receipt": "disconnect is pending or unsafe", connected: "client state is not disconnected",
            "disconnect-in-progress": "disconnect is pending or unsafe", "connection-appeared": "client state is not disconnected",
            "config-changed": "config changed",
            "config-aba": "config changed",
            "client-runtime": "client runtime is live or runtime state is unverified",
            "unknown-runtime": "client runtime is live or runtime state is unverified",
            "token-replaced": "token file changed", "backup-appeared": "token file changed",
          };
          expect(message).toContain(reason[scenario]!);
          expect(readFileSync(tokenPath, "utf8")).toBe(scenario === "token-replaced" ? "replacement-private-key\n" : `${key}\n`);
          if (scenario === "backup-appeared") expect(readFileSync(`${tokenPath}.prev`, "utf8")).toBe("new-backup\n");
        } finally { log.mockRestore(); err.mockRestore(); }
      });
    },
  );

  test.each(["client", "unknown", "absent", "standalone", "live-public-bind", "live-unknown-bind", "dual-client", "legacy-live", "live-pid-no-endpoint"])("orphan recovery checks real local liveness: %s", async scenario => {
    await withLinkHome(async home => {
      const tokenPath = join(home, "service-api-token");
      writeFileSync(tokenPath, `${key}\n`, { mode: 0o600 });
      const secret = createLocalAttestationSecret();
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => {
        if (scenario === "unknown") return new Response("not ready", { status: 503 });
        const response = Response.json({ service: "opencodex", version: "1.0.0", ...(["standalone", "dual-client", "live-public-bind", "live-unknown-bind"].includes(scenario) ? { providerReloadCapability: "v1" } : scenario === "legacy-live" ? {} : { role: "client" }), pid: process.pid, port: server.port, uptime: 1 });
        const challenge = req.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
        const proof = challenge && createLocalAttestationProof(secret, challenge, process.pid, server.port!);
        if (proof) response.headers.set(LOCAL_ATTESTATION_PROOF_HEADER, proof);
        return response;
      } });
      const port = server.port!;
      const second = scenario === "dual-client" ? Bun.serve({ port, hostname: "::1", fetch: () => Response.json({ service: "opencodex", version: "1.0.0", role: "client", pid: process.pid, port, uptime: 1 }) }) : null;
      writeFileSync(join(home, "config.json"), JSON.stringify({ ...getDefaultConfig(), port, hostname: "127.0.0.1" }));
      if (["standalone", "dual-client", "legacy-live", "live-pid-no-endpoint", "live-public-bind", "live-unknown-bind"].includes(scenario)) {
        writeFileSync(join(home, "ocx.pid"), String(process.pid));
        if (scenario !== "live-pid-no-endpoint") writeFileSync(join(home, "runtime-port.json"), JSON.stringify({ pid: process.pid, port,
          ...(scenario === "live-unknown-bind" ? {} : { hostname: scenario === "live-public-bind" ? "0.0.0.0" : "127.0.0.1" }), attestationSecret: secret }));
      }
      if (scenario === "absent" || scenario === "live-pid-no-endpoint") await server.stop(true);
      const log = spyOn(console, "log").mockImplementation(() => {});
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes", "--json"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }) },
        } as never);
        const allowed = scenario === "absent" || scenario === "standalone";
        expect(result).toBe(allowed ? 0 : 1);
        expect(existsSync(tokenPath)).toBe(!allowed);
        if (!allowed) expect(err.mock.calls.flat().join(" ")).toContain(scenario === "live-public-bind" ? "admission secret" : "runtime is live or runtime state is unverified");
      } finally { log.mockRestore(); err.mockRestore(); await second?.stop(true); await server.stop(true); }
    });
  });

  test.each(["symlink", "hardlink"])("orphan recovery preserves an unsafe %s token", async kind => {
    await withLinkHome(async home => {
      const target = join(home, "external-token");
      const token = join(home, "service-api-token");
      writeFileSync(target, `${key}\n`, { mode: 0o600 });
      if (kind === "symlink") symlinkSync(target, token); else linkSync(target, token);
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await handleDisconnectCommand(["--orphaned-token", "--yes"], {
          lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          orphanRecoveryDeps: { inspectServiceManager: noService, acquireLease: () => ({ release() {} }), runtimeSafe: async () => true },
        } as never);
        expect(result).toBe(1);
        expect(err.mock.calls.flat().join(" ")).toContain("unsafe token file");
        expect(readFileSync(target, "utf8")).toBe(`${key}\n`);
        expect(existsSync(token)).toBe(true);
      } finally { err.mockRestore(); }
    });
  });

  test("does not echo malformed link keys from stdin", async () => {
    const input = new EventEmitter() as EventEmitter & { readableEnded?: boolean };
    input.readableEnded = false;
    const secret = `ocx_data_${"b".repeat(40)}`;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const pending = handleConnectCommand([
      "--link", "--key-stdin", "--tunnel-port", "34567", "--link-id", linkId,
    ], { stdinImpl: input as never, stdinTimeoutMs: 1000 });
    input.emit("data", Buffer.from(`{\"apiKeyId\":\"key-1\",\"key\":\"${secret}\"`));
    input.emit("end");
    expect(await pending).toBe(2);
    expect(errors.mock.calls.flat().join(" ")).not.toContain(secret);
    errors.mockRestore();
  });

  test("connects through the link credential strategy without issuing a hub key", async () => {
    await withLinkHome(async (home, codexHome) => {
      writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n');
      const calls: Array<{ url: string; key?: string }> = [];
      const fetchImpl: typeof fetch = async (input, init = {}) => {
        const headers = new Headers(init.headers);
        const url = String(input);
        calls.push({ url, key: headers.get("x-opencodex-api-key") ?? undefined });
        if (url.endsWith("/readyz")) {
          return Response.json({
            service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: 34567,
            status: "ready", protocol: 1, minimumClientProtocol: 1,
            managementUrl: "http://127.0.0.1:34567",
          });
        }
        if (url.endsWith("/v1/catalog")) return Response.json({ models: [] });
        throw new Error(`unexpected link request ${url}`);
      };
      const connection = await connectClient({
        serverUrl: "http://127.0.0.1:34567",
        managementUrl: "http://127.0.0.1:34567",
        managementTransport: "direct",
        transport: "link",
        link: { tunnelPort: 34567, linkId },
        credential: { kind: "link", apiKeyId: "key-1", key },
        selectedClients: ["claude"],
        noSync: true,
      }, {
        fetchImpl,
        catalogCompatibility: { supportedEfforts: () => new Set() },
        lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
      });
      expect(connection.transport).toBe("link");
      expect(connection.link).toEqual({ tunnelPort: 34567, linkId });
      expect(connection.serverUrl).toBe("http://127.0.0.1:34567");
      expect(readServiceApiTokenState()).toMatchObject({ kind: "present", token: key });
      expect(calls.map(call => call.url)).toEqual([
        "http://127.0.0.1:34567/readyz",
        "http://127.0.0.1:34567/v1/catalog",
      ]);
      expect(calls[0]?.key).toBe(key);
      expect(calls[1]?.key).toBe(key);
      expect(calls.some(call => call.url.includes("/api/keys"))).toBe(false);
    });
  });
});
