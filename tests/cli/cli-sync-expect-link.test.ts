/**
 * #7694: ocx sync --expect-link / --expect-hub-key. A caller that names the Home (or hub key) it
 * expects gets exactly today's connected sync when that identity holds under the lock that selects
 * the path, and otherwise a distinct refusal that wrote nothing and never fell back to the local
 * providers. Every case is in-process and deterministic: config fixtures are written directly, the
 * Home catalog is a stubbed fetch, and both client locks live in the per-test directory.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { dispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";
import * as connectApi from "../../src/client/connect";
import { handleMachineApi } from "../../src/client/machine-api";
import { markClientConnectPending } from "../../src/client/state";
import { withClientLifecycle } from "../../src/client/lifecycle-lock";
import { prepareConfigMutationDatabasePathForWrite } from "../../src/config/mutation-lock";
import * as restartScope from "../../src/cli/restart-scope";
import * as shimAutoRestore from "../../src/cli/codex-shim-autorestore";
import { runCli } from "../../src/cli/root";
import * as codexSync from "../../src/codex/sync";
import { DEFAULT_CATALOG_PATH } from "../../src/codex/paths";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { OcxClientConnectionConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const KEY = `ocx_data_${"e".repeat(40)}`;
const LINK_ID = "lnk_0123456789abcdef";
const OTHER_LINK_ID = "lnk_fedcba9876543210";
const HUB_KEY_ID = "hub-key-7694";
const TUNNEL = 23461;
const SENTINEL_CATALOG = JSON.stringify({ models: [{ slug: "sentinel-local-model" }] });
const HOME_CATALOG = JSON.stringify({ models: [] });
const realSyncConnectedClient = connectApi.syncConnectedClient;

let root = "";
let previousHome: string | undefined;
let previousExitCode: typeof process.exitCode;
let priorCatalog: string | null = null;

type Shape = { transport: "link" | "hub"; linkId?: string; apiKeyId?: string; pending?: boolean };
type SyncOptions = Parameters<typeof connectApi.syncConnectedClient>[0];

function clientBlock(shape: Shape): Record<string, unknown> {
  const link = shape.transport === "link";
  return {
    serverUrl: link ? `http://127.0.0.1:${TUNNEL}` : "https://hub.example.test",
    managementUrl: link ? `http://127.0.0.1:${TUNNEL}` : "https://hub.example.test",
    managementTransport: "direct",
    ...(link ? { transport: "link", link: { tunnelPort: TUNNEL, linkId: shape.linkId ?? LINK_ID } } : {}),
    // Claude only: the connected sync then skips the Codex injection, so the real path runs end
    // to end without touching the sandboxed Codex config.
    selectedClients: ["claude"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: shape.apiKeyId ?? HUB_KEY_ID,
    tokenFingerprint: serviceApiTokenFingerprint(KEY),
    protocolVersion: 1,
    connectedAt: "2026-10-01T00:00:00.000Z",
    ...(shape.pending ? {
      pendingOperation: {
        kind: "rotate",
        rotationId: "rot-7694",
        newKeyIssuedAt: "2026-10-02T00:00:00.000Z",
        oldKeyBackupPath: join(root, "service-api-token.prev"),
      },
    } : {}),
  };
}

function writeClient(shape: Shape): void {
  writeFileSync(join(root, "config.json"), JSON.stringify({
    port: 10100, providers: {}, defaultProvider: "openai", runtimeRole: "client", client: clientBlock(shape),
  }));
  writeFileSync(join(root, "service-api-token"), `${KEY}\n`, { mode: 0o600 });
}

function writeStandalone(): void {
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 10100, providers: {}, defaultProvider: "openai" }));
}

function homeCatalogFetch(seen: string[], during?: () => void): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    during?.();
    return new Response(HOME_CATALOG, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Real dependencies except the network, the Codex runtime probe and the user-wide lock path. */
function isolatedDeps(seen: string[], during?: () => void) {
  return {
    fetchImpl: homeCatalogFetch(seen, during),
    catalogCompatibility: { supportedEfforts: () => new Set(["low", "medium", "high"]) },
    lifecycleLockDeps: { lockPath: join(root, "locks", "client-lifecycle.sqlite") },
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousExitCode = process.exitCode;
  root = mkdtempSync(join(tmpdir(), "ocx-sync-expect-link-"));
  process.env.OPENCODEX_HOME = root;
  priorCatalog = existsSync(DEFAULT_CATALOG_PATH) ? readFileSync(DEFAULT_CATALOG_PATH, "utf8") : null;
  mkdirSync(dirname(DEFAULT_CATALOG_PATH), { recursive: true });
  writeFileSync(DEFAULT_CATALOG_PATH, SENTINEL_CATALOG);
});

afterEach(() => {
  if (priorCatalog === null) rmSync(DEFAULT_CATALOG_PATH, { force: true });
  else writeFileSync(DEFAULT_CATALOG_PATH, priorCatalog);
  process.exitCode = previousExitCode;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

describe("syncConnectedClient checks the expected identity under its own lock", () => {
  test.each([
    ["a matching link", { transport: "link" } as Shape, { kind: "link", linkId: LINK_ID }, `http://127.0.0.1:${TUNNEL}/v1/catalog`],
    ["a matching hub key", { transport: "hub" } as Shape, { kind: "hub", apiKeyId: HUB_KEY_ID }, "https://hub.example.test/v1/catalog"],
  ] as const)("%s runs today's connected sync", async (_name, shape, expectation, catalogUrl) => {
    writeClient(shape);
    const seen: string[] = [];
    const result = await connectApi.syncConnectedClient({ expect: expectation } as SyncOptions, isolatedDeps(seen));
    expect(seen).toEqual([catalogUrl]);
    expect(result.catalogWritten).toBe(true);
    expect(result.connection.apiKeyId).toBe(HUB_KEY_ID);
    expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(HOME_CATALOG);
  });

  test.each([
    ["another link", { transport: "link", linkId: OTHER_LINK_ID } as Shape, { kind: "link", linkId: LINK_ID }, "child_link_mismatch", "other_link"],
    ["a hub client asked for a link", { transport: "hub" } as Shape, { kind: "link", linkId: LINK_ID }, "child_link_mismatch", "hub_client"],
    ["a pending key rotation", { transport: "link", pending: true } as Shape, { kind: "link", linkId: LINK_ID }, "child_link_mismatch", "pending_operation"],
    ["a link client asked for a hub key", { transport: "link" } as Shape, { kind: "hub", apiKeyId: HUB_KEY_ID }, "hub_client_mismatch", "link_client"],
    ["another hub key", { transport: "hub", apiKeyId: "hub-key-other" } as Shape, { kind: "hub", apiKeyId: HUB_KEY_ID }, "hub_client_mismatch", "other_key"],
  ] as const)("%s is refused before any request or write", async (_name, shape, expectation, phase, reason) => {
    writeClient(shape);
    const configBefore = readFileSync(join(root, "config.json"), "utf8");
    const seen: string[] = [];
    await expect(connectApi.syncConnectedClient({ expect: expectation } as SyncOptions, isolatedDeps(seen)))
      .rejects.toMatchObject({ phase, reason });
    expect(seen).toEqual([]);
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(configBefore);
    expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(SENTINEL_CATALOG);
  });

  test("a disconnected machine is refused, and a connect in flight is named as pending", async () => {
    writeStandalone();
    const link = { expect: { kind: "link", linkId: LINK_ID } } as SyncOptions;
    await expect(connectApi.syncConnectedClient(link, isolatedDeps([])))
      .rejects.toMatchObject({ phase: "child_link_mismatch", reason: "disconnected" });
    markClientConnectPending(serviceApiTokenFingerprint(KEY));
    await expect(connectApi.syncConnectedClient(link, isolatedDeps([])))
      .rejects.toMatchObject({ phase: "child_link_mismatch", reason: "pending_operation" });
    writeFileSync(join(root, "client-connect-pending"), "not a fingerprint");
    await expect(connectApi.syncConnectedClient(link, isolatedDeps([])))
      .rejects.toMatchObject({ phase: "child_link_mismatch", reason: "invalid_state" });
    expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(SENTINEL_CATALOG);
  });

  test("a relink while the Home catalog is read fails the write as before and keeps the catalog", async () => {
    writeClient({ transport: "link" });
    const seen: string[] = [];
    const relink = () => writeClient({ transport: "link", linkId: OTHER_LINK_ID });
    await expect(connectApi.syncConnectedClient(
      { expect: { kind: "link", linkId: LINK_ID } } as SyncOptions,
      isolatedDeps(seen, relink),
    )).rejects.toThrow("client_connection_changed");
    expect(seen).toHaveLength(1);
    expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(SENTINEL_CATALOG);
  });

  test("the classifier names an unfinished disconnect and an unreadable config", async () => {
    const { classifyClientSyncExpectation } = await import("../../src/client/sync-expectation");
    const link = { kind: "link", linkId: LINK_ID } as const;
    const connected = { kind: "connected", value: clientBlock({ transport: "link" }) as unknown as OcxClientConnectionConfig } as const;
    expect(classifyClientSyncExpectation({ kind: "invalid", reason: "x" }, { kind: "absent" }, link)).toBe("invalid_state");
    expect(classifyClientSyncExpectation({ kind: "mismatched", reason: "x" }, { kind: "absent" }, link)).toBe("invalid_state");
    expect(classifyClientSyncExpectation(connected, { kind: "unsafe" }, link)).toBe("disconnect_pending");
    expect(classifyClientSyncExpectation(connected, { kind: "valid", value: { phase: "prepared" } }, link)).toBe("disconnect_pending");
    expect(classifyClientSyncExpectation(connected, { kind: "valid", value: { phase: "complete" } }, link)).toBeNull();
    // A connect only starts from a disconnected machine, so a marker beside a connection is not one.
    expect(classifyClientSyncExpectation(connected, { kind: "absent" }, link, "present")).toBeNull();
  });
});

describe("ocx sync --expect-link / --expect-hub-key", () => {
  async function runSync(args: string[]) {
    let discoveries = 0;
    const errors: string[] = [];
    const connectedCalls: unknown[] = [];
    const localSync = spyOn(codexSync, "syncModelsToCodex").mockImplementation(async () => {
      throw new Error("local fallback must not run");
    });
    // The real connected sync, with its user-wide lock moved into this test's directory.
    const connected = spyOn(connectApi, "syncConnectedClient").mockImplementation(async options => {
      connectedCalls.push(options);
      return realSyncConnectedClient(options, isolatedDeps([]));
    });
    // Never reach a real restart: on an unfixed tree a stray restart flag would end the Codex
    // app-servers and desktop app of whoever runs this file.
    const restarts = spyOn(restartScope, "handleRestartScopeAfterWrite").mockImplementation(async () => ({}));
    const shimRepairs = spyOn(shimAutoRestore, "runCodexShimAutoRestore").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation((...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const deps = {
        args,
        findLiveProxy: async () => { discoveries += 1; return null; },
        handleProxyRestart: async () => { throw new Error("runtime restart must not run"); },
        handleRestartStartWhenStopped: async () => { throw new Error("runtime restart must not run"); },
      } as unknown as CliDispatchDeps;
      const code = await dispatchCommand({ kind: "command", command: "sync", args }, deps);
      return {
        code, discoveries, errors, connectedCalls,
        localSyncCalls: localSync.mock.calls.length, shimRepairs: shimRepairs.mock.calls.length,
      };
    } finally {
      localSync.mockRestore(); connected.mockRestore(); restarts.mockRestore(); shimRepairs.mockRestore();
      error.mockRestore(); log.mockRestore();
    }
  }

  function lastJson(errors: string[]): Record<string, unknown> {
    return JSON.parse(errors.at(-1) ?? "null") as Record<string, unknown>;
  }

  test("a disconnected machine exits 5 with a machine-readable phase and no local fallback", async () => {
    writeStandalone();
    const run = await runSync(["sync", "--expect-link", LINK_ID]);
    expect(run.code).toBe(5);
    expect(run.localSyncCalls).toBe(0);
    expect(run.discoveries).toBe(0);
    expect(run.shimRepairs).toBe(0);
    expect(lastJson(run.errors)).toEqual({ phase: "child_link_mismatch", reason: "disconnected" });
    expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(SENTINEL_CATALOG);
  });

  test("a hub client asked for a link and another link are refused the same way", async () => {
    writeClient({ transport: "hub" });
    const hub = await runSync(["sync", "--expect-link", LINK_ID]);
    expect(hub.code).toBe(5);
    expect(lastJson(hub.errors)).toEqual({ phase: "child_link_mismatch", reason: "hub_client" });
    writeClient({ transport: "link", linkId: OTHER_LINK_ID });
    const other = await runSync(["sync", `--expect-link=${LINK_ID}`]);
    expect(other.code).toBe(5);
    expect(lastJson(other.errors)).toEqual({ phase: "child_link_mismatch", reason: "other_link" });
    expect(hub.localSyncCalls + other.localSyncCalls).toBe(0);
    expect(hub.shimRepairs + other.shimRepairs).toBe(0);
    expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(SENTINEL_CATALOG);
  });

  test("an unreadable client config is a mismatch under the expectation, not the generic exit 1", async () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({
      port: 10100, providers: {}, defaultProvider: "openai", runtimeRole: "client", client: { apiKeyId: "half-present" },
    }));
    const run = await runSync(["sync", "--expect-link", LINK_ID]);
    expect(run.code).toBe(5);
    expect(lastJson(run.errors)).toEqual({ phase: "child_link_mismatch", reason: "invalid_state" });
    expect(run.localSyncCalls).toBe(0);
  });

  test("--expect-hub-key refuses a link Child and a disconnected machine", async () => {
    writeClient({ transport: "link" });
    const link = await runSync(["sync", "--expect-hub-key", HUB_KEY_ID]);
    expect(link.code).toBe(5);
    expect(lastJson(link.errors)).toEqual({ phase: "hub_client_mismatch", reason: "link_client" });
    writeStandalone();
    const none = await runSync(["sync", "--expect-hub-key", HUB_KEY_ID]);
    expect(none.code).toBe(5);
    expect(lastJson(none.errors)).toEqual({ phase: "hub_client_mismatch", reason: "disconnected" });
    expect(link.localSyncCalls + none.localSyncCalls).toBe(0);
  });

  test.each([
    ["link", { transport: "link" } as Shape, ["sync", "--expect-link", LINK_ID], { kind: "link", linkId: LINK_ID }],
    ["hub", { transport: "hub" } as Shape, ["sync", "--expect-hub-key", HUB_KEY_ID], { kind: "hub", apiKeyId: HUB_KEY_ID }],
  ] as const)("a matching %s runs the real connected sync with the expectation attached", async (_name, shape, args, expectation) => {
    writeClient(shape);
    const run = await runSync([...args]);
    expect(run.code).toBe(0);
    expect(run.localSyncCalls).toBe(0);
    expect(run.discoveries).toBe(0);
    // The root skipped the shim repair for a pinned sync; it runs once the identity held.
    expect(run.shimRepairs).toBe(1);
    expect(run.connectedCalls).toEqual([{ restartCodex: false, expect: expectation }]);
    expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(HOME_CATALOG);
  });

  test("a real link connect paused at its readiness read makes a pinned sync a pending refusal", async () => {
    writeStandalone();
    const configBefore = readFileSync(join(root, "config.json"), "utf8");
    let reached!: () => void;
    const atReadiness = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const home = `http://127.0.0.1:${TUNNEL}`;
    // The connect holds the apply lock from its first lock through its network reads.
    const connecting = connectApi.connectClient({
      serverUrl: home, managementUrl: home, managementTransport: "direct", transport: "link",
      link: { tunnelPort: TUNNEL, linkId: LINK_ID },
      credential: { kind: "link", apiKeyId: HUB_KEY_ID, key: KEY },
      selectedClients: ["claude"], noSync: true,
    } as Parameters<typeof connectApi.connectClient>[0], {
      fetchImpl: (async () => {
        reached();
        await released;
        return Response.json({
          service: "opencodex", version: "0.0.0", uptime: 1, pid: 1, port: TUNNEL,
          status: "pending", protocol: 1, minimumClientProtocol: 1, managementUrl: home,
        }, { status: 503 });
      }) as typeof fetch,
      lifecycleLockDeps: isolatedDeps([]).lifecycleLockDeps,
    });
    const settled = connecting.then(() => "connected", (error: Error) => error.message);
    await atReadiness;
    const during = await runSync(["sync", "--expect-link", LINK_ID]);
    expect(during.code).toBe(5);
    expect(lastJson(during.errors)).toEqual({ phase: "child_link_mismatch", reason: "pending_operation" });
    expect(during.localSyncCalls).toBe(0);
    expect(during.discoveries).toBe(0);
    expect(during.shimRepairs).toBe(0);
    expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(SENTINEL_CATALOG);
    release();
    expect(await settled).toContain("hub is not ready");
    // The connect rolled back and released the lock; the same command now reads the real state.
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(configBefore);
    const after = await runSync(["sync", "--expect-link", LINK_ID]);
    expect(after.code).toBe(5);
    expect(lastJson(after.errors)).toEqual({ phase: "child_link_mismatch", reason: "disconnected" });
  });

  test("a held client lifecycle lock refuses even a Child that would match, before its check", async () => {
    writeClient({ transport: "link" });
    const configBefore = readFileSync(join(root, "config.json"), "utf8");
    const run = await withClientLifecycle(
      () => runSync(["sync", "--expect-hub-key", HUB_KEY_ID]).then(async () => runSync(["sync", "--expect-link", LINK_ID])),
      isolatedDeps([]).lifecycleLockDeps,
    );
    expect(run.code).toBe(5);
    expect(lastJson(run.errors)).toEqual({ phase: "child_link_mismatch", reason: "pending_operation" });
    expect(run.connectedCalls).toHaveLength(1);
    expect(run.shimRepairs).toBe(0);
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(configBefore);
    expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(SENTINEL_CATALOG);
    // Released, the same Child matches and syncs.
    const free = await runSync(["sync", "--expect-link", LINK_ID]);
    expect(free.code).toBe(0);
  });

  test("a config writer holding the config lock is a pending refusal before the check, and itself after it", async () => {
    writeClient({ transport: "link" });
    const configBefore = readFileSync(join(root, "config.json"), "utf8");
    const holder = new Database(prepareConfigMutationDatabasePathForWrite(), { create: true });
    let held = false;
    const hold = () => { holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); held = true; };
    const free = () => { if (held) holder.exec("ROLLBACK"); held = false; };
    try {
      hold();
      const link = await runSync(["sync", "--expect-link", LINK_ID]);
      const key = await runSync(["sync", "--expect-hub-key", HUB_KEY_ID]);
      expect([link.code, key.code]).toEqual([5, 5]);
      expect(lastJson(link.errors)).toEqual({ phase: "child_link_mismatch", reason: "pending_operation" });
      expect(lastJson(key.errors)).toEqual({ phase: "hub_client_mismatch", reason: "pending_operation" });
      // Without an expectation the same contention stays the ordinary connected-sync failure.
      const plain = await runSync(["sync"]);
      expect(plain.code).toBe(1);
      expect(plain.errors.join("\n")).not.toContain("pending_operation");
      expect(link.localSyncCalls + key.localSyncCalls + plain.localSyncCalls).toBe(0);
      free();
      expect(readFileSync(join(root, "config.json"), "utf8")).toBe(configBefore);
      expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(SENTINEL_CATALOG);

      // Taken only after the check passed (during the Home catalog read), contention is a real
      // failure of a sync that already knew its connection: exit 1, no refusal phase.
      const connected = spyOn(connectApi, "syncConnectedClient").mockImplementation(async options =>
        realSyncConnectedClient(options, isolatedDeps([], hold)));
      const lateErrors: string[] = [];
      const error = spyOn(console, "error").mockImplementation((...parts: unknown[]) => { lateErrors.push(parts.map(String).join(" ")); });
      try {
        const late = await dispatchCommand({ kind: "command", command: "sync", args: ["sync", "--expect-link", LINK_ID] }, {
          args: ["sync", "--expect-link", LINK_ID], findLiveProxy: async () => null,
        } as unknown as CliDispatchDeps);
        expect(late).toBe(1);
        expect(held).toBe(true);
        expect(lateErrors.join("\n")).toContain("Config mutation already in progress");
        expect(lateErrors.join("\n")).not.toContain("pending_operation");
      } finally {
        connected.mockRestore(); error.mockRestore();
        free();
      }
      expect(readFileSync(DEFAULT_CATALOG_PATH, "utf8")).toBe(SENTINEL_CATALOG);
    } finally {
      free();
      holder.close();
    }
  });

  test.each([
    [["sync", "--expect-link"]],
    [["sync", "--expect-link", "not-a-link-id"]],
    [["sync", "--expect-link", LINK_ID, "--expect-link", LINK_ID]],
    [["sync", "--expect-link", LINK_ID, "--expect-hub-key", HUB_KEY_ID]],
    [["sync", "--expect-hub-key", "   "]],
    [["sync", "--expect-hub-key", "--not-a-value"]],
  ])("usage error %p exits 2 before reading any state", async args => {
    writeClient({ transport: "link" });
    const run = await runSync(args);
    expect(run.code).toBe(2);
    expect(run.connectedCalls).toEqual([]);
    expect(run.localSyncCalls).toBe(0);
    expect(run.discoveries).toBe(0);
    expect(run.shimRepairs).toBe(0);
  });
});

describe("the CLI root leaves a pinned sync to its own check", () => {
  test("the shim preflight skips a pinned sync and keeps repairing a plain one", () => {
    const skips = shimAutoRestore.skipsCodexShimAutoRestore;
    expect(skips("sync", ["sync", "--expect-link", LINK_ID])).toBe(true);
    expect(skips("sync", ["sync", `--expect-hub-key=${HUB_KEY_ID}`])).toBe(true);
    expect(skips("sync", ["sync"])).toBe(false);
    expect(skips("sync", ["sync", "--expect-linked"])).toBe(false);
  });

  test("a malformed pinned sync exits 2 at the root, before any preflight", async () => {
    const exits: unknown[] = [];
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code);
      throw new Error("process.exit");
    }) as typeof process.exit);
    const error = spyOn(console, "error").mockImplementation(() => {});
    const preflight = spyOn(shimAutoRestore, "maybeAutoRestoreCodexShim");
    try {
      await expect(runCli(["sync", "--expect-link", "not-a-link-id"])).rejects.toThrow("process.exit");
      expect(exits).toEqual([2]);
      expect(preflight).not.toHaveBeenCalled();
      // Control: the spy does see the root preflight, which a valid pinned sync reaches and skips.
      const head = await runCli(["sync", "--expect-link", LINK_ID]);
      expect(head.kind).toBe("command");
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(exits).toEqual([2]);
    } finally {
      exit.mockRestore(); error.mockRestore(); preflight.mockRestore();
    }
  });
});

test("the machine sync route does not return the saved connection", async () => {
  const connection = clientBlock({ transport: "hub" }) as unknown as OcxClientConnectionConfig;
  const response = await handleMachineApi(
    new Request("http://127.0.0.1/api/machine/sync", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
    new URL("http://127.0.0.1/api/machine/sync"),
    connection,
    {
      sync: async () => ({ catalogWritten: true, cacheSynced: true, injected: false, stale: false, connection }),
      disconnect: async () => { throw new Error("unused"); },
      scheduleStandaloneRecycle: () => {},
    },
  );
  expect(await response?.json()).toEqual({ success: true, catalogWritten: true, cacheSynced: true, injected: false, stale: false });
});
