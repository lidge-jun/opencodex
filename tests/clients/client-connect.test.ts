import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadClientCatalog,
  exchangeConnectPairingGrant,
  fetchHubReady,
  issueClientKey,
  normalizeHubOrigin,
} from "../../src/client/hub-client";
import { handleConnectCommand } from "../../src/cli/connect";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot as findRepoRoot } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS } from "../helpers/test-budget";

const repoRoot = findRepoRoot();

const CLIENT_FIXTURE_FAILURE_CATEGORIES = ["module_load", "config_setup", "desktop_setup", "scenario", "child_failed"] as const;
type ClientFixtureFailureCategory = typeof CLIENT_FIXTURE_FAILURE_CATEGORIES[number];

class ClientStateProbeError extends Error {
  constructor(
    readonly pid: number,
    readonly status: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly timedOut: boolean,
    readonly failureCategory?: ClientFixtureFailureCategory,
  ) {
    // Do not include the child script, environment, stdout or stderr in failure output.
    super(`Client state probe ${timedOut ? "timed out" : "failed"} (status=${status}, signal=${signal}${failureCategory ? `, category=${failureCategory}` : ""})`);
    this.name = "ClientStateProbeError";
  }
}

async function readStateProbe(script: string, home: string, timeoutMs = INTERNAL_DEADLINE_MS) {
  const maxCaptureBytes = 1024 * 1024;
  const cleanupMs = 1_000;
  const result = await new Promise<{ stdout: string; pid: number; status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, ["--eval", script], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: home, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop") },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { reject(new ClientStateProbeError(0, null, null, false)); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let timedOut = false;
    let settled = false;
    let status: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(cleanup);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      const pid = child.pid ?? 0;
      if (failed || status !== 0 || signal !== null) reject(new ClientStateProbeError(pid, status, signal, timedOut));
      else resolve({ stdout: Buffer.concat(chunks).toString("utf8"), pid, status, signal });
    };
    const boundCleanup = () => {
      if (settled) return;
      cleanup ??= setTimeout(() => { failed = true; finish(); }, cleanupMs);
    };
    const stop = () => {
      if (settled || failed) return;
      failed = true;
      clearTimeout(deadline);
      boundCleanup();
      try { child.kill("SIGKILL"); } catch { /* Preserve observed exit metadata, never the OS error text. */ }
    };
    const capture = (chunk: Buffer, stdout: boolean) => {
      if (settled || failed) return;
      bytes += chunk.length;
      if (bytes > maxCaptureBytes) { stop(); return; }
      if (stdout) chunks.push(chunk);
    };
    child.stdout?.on("data", chunk => capture(chunk, true));
    child.stderr?.on("data", chunk => capture(chunk, false));
    child.stdout?.on("error", stop);
    child.stderr?.on("error", stop);
    child.on("error", stop);
    child.once("exit", (code, exitSignal) => {
      status = code; signal = exitSignal;
      // A descendant retaining a pipe must not turn successful exit into an unbounded wait.
      boundCleanup();
    });
    child.once("close", (code, exitSignal) => { status = code; signal = exitSignal; finish(); });
    deadline = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  });
  try { return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}"); }
  catch {
    throw new ClientStateProbeError(result.pid, result.status, result.signal, false);
  }
}

function readyBody(protocol = 1, minimumClientProtocol = 1) {
  return {
    service: "opencodex",
    version: "0.0.0",
    uptime: 1,
    pid: 1,
    port: 443,
    status: "ready",
    protocol,
    minimumClientProtocol,
    managementUrl: "https://manage.example.test",
  };
}

describe("remote hub client boundary", () => {
  test("runtimeRole=hub without client state reads as disconnected so the hub can start", async () => {
    // First clisu-oracle dogfood boot: the hub role refused 'ocx start' because the
    // client-state reader classified role=hub (no client block) as mismatched. A hub
    // is a server; without client state it is simply not a connected client.
    const readScript = `
      const { readClientConnectionState } = require("./src/client/state");
      console.log(JSON.stringify(readClientConnectionState()));
    `;
    const home = mkdtempSync(join(tmpdir(), "ocx-hub-role-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 10190, runtimeRole: "hub" }));
      expect((await readStateProbe(readScript, home)).kind).toBe("disconnected");
      // Hub role WITH a client block stays mismatched (the honest conflict).
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 10190, runtimeRole: "hub", client: { serverUrl: "https://hub.example.test" } }));
      expect((await readStateProbe(readScript, home)).kind).toBe("mismatched");
    } finally {
      removeTreeWithRetry(home);
    }
  }, 35_000); // Two 15s child deadlines plus bounded 1s cleanup each, below the CI 60s cap.

  test("state probe kills a stalled child before parsing its output", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-state-probe-stall-"));
    const startedPath = join(home, "probe-started");
    const script = `
      const fs = require("node:fs");
      fs.writeFileSync(require("node:path").join(process.env.OPENCODEX_HOME, "probe-started"), String(process.pid));
      fs.writeSync(1, "not-json");
      setInterval(() => {}, 1000);
    `;
    try {
      const startedAt = performance.now();
      let failure: unknown;
      try { await readStateProbe(script, home, 2_000); }
      catch (error) { failure = error; }
      expect(performance.now() - startedAt).toBeLessThan(10_000);
      expect(failure).toBeInstanceOf(ClientStateProbeError);
      if (!(failure instanceof ClientStateProbeError)) throw new Error("Expected bounded child failure");
      expect(failure.timedOut).toBe(true);
      expect(failure.status).toBeNull();
      expect(failure.signal).toBe("SIGKILL");
      expect(failure.message).not.toContain("not-json");
      expect(Number(readFileSync(startedPath, "utf8"))).toBe(failure.pid);
      // The async probe must reap this exact child, not merely return while it remains alive.
      let exitCode: string | undefined;
      try { process.kill(failure.pid, 0); }
      catch (error) { exitCode = (error as NodeJS.ErrnoException).code; }
      expect(exitCode).toBe("ESRCH");
    } finally {
      removeTreeWithRetry(home);
    }
  }, 10_000);

  test("canonicalizes origin and terminal /v1 only", () => {
    expect(normalizeHubOrigin("https://hub.example.test/v1")).toBe("https://hub.example.test");
    expect(normalizeHubOrigin("https://hub.example.test/v1/")).toBe("https://hub.example.test");
    for (const value of [
      "ftp://hub.example.test",
      "https://user@hub.example.test",
      "https://hub.example.test/private",
      "https://hub.example.test/?secret=1",
      "https://hub.example.test/#secret",
    ]) expect(() => normalizeHubOrigin(value)).toThrow();
  });

  test("uses Phase-1 readiness compatibility including p2/min1 and rejects p2/min2", async () => {
    const accepted = await fetchHubReady("https://hub.example.test", {
      fetchImpl: async () => Response.json(readyBody(2, 1)),
    });
    expect(accepted.metadata.protocol).toBe(2);

    await expect(fetchHubReady("https://hub.example.test", {
      fetchImpl: async () => Response.json(readyBody(2, 2)),
    })).rejects.toThrow("requires remote protocol 2");
    for (const status of ["pending", "failed"] as const) {
      const result = await fetchHubReady("https://hub.example.test", {
        fetchImpl: async () => Response.json({ ...readyBody(), status }, { status: 503 }),
      });
      expect(result.status).toBe(status);
    }
  });

  test("admin key issuance is HTTPS-only and pairing exchanges into a full GUI session", async () => {
    let calls = 0;
    await expect(issueClientKey("http://hub.example.test", {
      kind: "admin",
      value: new TextEncoder().encode("ocx_admin_secret"),
    }, "client", {
      fetchImpl: async () => { calls += 1; return new Response(); },
    })).rejects.toThrow("only over HTTPS");
    expect(calls).toBe(0);

    const browserOrigin = "http://localhost:10100";
    const sessionHtml = [
      '<meta name="opencodex-session-token" content="ocx_session_test">',
      '<meta name="opencodex-session-csrf" content="csrf-test">',
      `<meta name="opencodex-session-origin" content="${browserOrigin}">`,
      '<meta name="opencodex-session-server-origin" content="https://hub.example.test">',
    ].join("");
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      if (String(input).endsWith("/opencodex-session")) return new Response(sessionHtml);
      return Response.json({
        id: "issued-id",
        name: "client",
        key: `ocx_data_${"a".repeat(40)}`,
        createdAt: "2026-08-28T00:00:00.000Z",
      }, { status: 201 });
    };
    const grant = new TextEncoder().encode(`ocx_pair_${"b".repeat(43)}`);
    const session = await exchangeConnectPairingGrant(
      "https://hub.example.test",
      browserOrigin,
      grant,
      { fetchImpl },
    );
    const issued = await issueClientKey("https://hub.example.test", { kind: "gui-session", value: session }, "client", { fetchImpl });
    expect(issued.id).toBe("issued-id");
    expect(seen[0]?.headers.get("origin")).toBe(browserOrigin);
    expect(seen[1]?.headers.get("x-opencodex-gui-origin")).toBe(browserOrigin);
    expect(seen[1]?.headers.get("x-opencodex-csrf-token")).toBe("csrf-test");
    expect(seen[1]?.body).toBe(JSON.stringify({ name: "client" }));
  });

  test("plaintext HTTP cannot carry a pairing grant, with no opt-in and no request sent", async () => {
    // An earlier revision accepted `--allow-insecure-http` here and this test asserted the
    // opt-in message. The option is gone: the hub refuses the exchange outright, so sending
    // it would only burn a single-use code against a certain rejection.
    let calls = 0;
    await expect(exchangeConnectPairingGrant(
      "http://hub.example.test",
      "http://localhost:10100",
      new TextEncoder().encode(`ocx_pair_${"c".repeat(43)}`),
      { fetchImpl: async () => { calls += 1; return new Response(); } },
    )).rejects.toThrow("loopback or HTTPS");
    // Refused before any request: the grant is still spendable over a permitted transport.
    expect(calls).toBe(0);
  });

  test("the catalog fetch is unconditional and still bounded", async () => {
    // /v1/catalog emits no validator (Phase 1, D2), so the client sends no If-None-Match and
    // has no 304 branch to keep correct. The size bound is unaffected by that change.
    let sentConditional: string | null = null;
    const fresh = await downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      fetchImpl: async (_input, init) => {
        sentConditional = new Headers(init?.headers).get("if-none-match");
        return new Response('{"models":[]}', { headers: { "Content-Type": "application/json" } });
      },
    });
    expect(sentConditional).toBeNull();
    expect(fresh).toMatchObject({ kind: "fresh" });

    await expect(downloadClientCatalog("https://hub.example.test", "ocx_data_test", {
      maxBytes: 4,
      fetchImpl: async () => new Response('{"models":[]}', { headers: { "Content-Type": "application/json" } }),
    })).rejects.toThrow("allowed size");
  });

  test("CLI rejects literal/env credential forms without rendering their values", async () => {
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation(value => { errors.push(String(value)); });
    try {
      expect(await handleConnectCommand([
        "https://hub.example.test",
        "--admin-token-stdin",
        "--admin-token=super-secret-value",
      ])).toBe(2);
      expect(errors.join(" ")).not.toContain("super-secret-value");
      expect(errors.join(" ")).toContain("<redacted>");
      errors.length = 0;
      expect(await handleConnectCommand([
        "rotate",
        "--admin-token-stdin",
        "--admin-token=rotation-secret-value",
      ])).toBe(2);
      expect(errors.join(" ")).not.toContain("rotation-secret-value");
      expect(errors.join(" ")).toContain("<redacted>");
      errors.length = 0;
      expect(await handleConnectCommand(["revoke", "client-key-override", "--admin-token-stdin"])).toBe(2);
      expect(errors.join(" ")).not.toContain("client-key-override");
      errors.length = 0;
      expect(await handleConnectCommand([
        "https://hub.example.test",
        "--admin-token-stdin",
        "--catalog-timeout",
        "0",
      ])).toBe(2);
      expect(errors.join(" ")).toContain("--catalog-timeout must be an integer >= 1");
    } finally {
      spy.mockRestore();
    }
  });
});

/** A catalog the user already had before ever connecting. */
const PRIOR_CATALOG_BYTES = '{"models":[{"slug":"local/only-model"}]}';

function runTransactionScenario(stage: "success" | "catalog" | "preflight" | "commit" | "prior-catalog" | "coordinator") {
  const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-client-connect-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-client-connect-codex-"));
  const configPath = join(opencodexHome, "config.json");
  const originalConfig = {
    port: 10100,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    defaultProvider: "openai",
  };
  writeFileSync(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`, "utf8");
  if (stage !== "preflight") writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
  // A catalog the user already had. Connect overwrites it; disconnect has to put it back.
  if (stage === "prior-catalog") {
    writeFileSync(join(codexHome, "opencodex-catalog.json"), PRIOR_CATALOG_BYTES, "utf8");
  }
  if (stage === "coordinator") {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(opencodexHome, "config-mutation.sqlite"));
  }
  const script = `
    const { existsSync, readFileSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    const { connectClient, disconnectClient } = require("./src/client/connect");
    const { readClientConnectionState } = require("./src/client/state");
    const { serviceApiTokenFilePath } = require("./src/lib/service-secrets");
    const { DEFAULT_CATALOG_PATH } = require("./src/codex/paths");
    const stage = ${JSON.stringify(stage)};
    const { setPersistedConfigMutationBeforeCommitForTests } = require("./src/config");
    let commitFaultTriggered = false;
    const catalog = '{"models":[]}';
    const etag = '"sha256-' + createHash("sha256").update(catalog).digest("base64url") + '"';
    const calls = [];
    const credential = new TextEncoder().encode("ocx_admin_test-authority");
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method || "GET" });
      if (url.endsWith("/readyz")) return Response.json(${JSON.stringify(readyBody())});
      if (url.endsWith("/api/keys") && init.method === "POST") return Response.json({
        id: "issued-id",
        name: "client",
        key: "ocx_data_${"d".repeat(40)}",
        createdAt: "2026-08-28T00:00:00.000Z",
      }, { status: 201 });
      if (url.endsWith("/api/keys") && init.method === "DELETE") return Response.json({ success: true });
      if (url.endsWith("/v1/catalog")) {
        if (stage === "catalog") return Response.json({ error: "down" }, { status: 503 });
        return new Response(catalog, { headers: { ETag: etag, "Content-Type": "application/json" } });
      }
      throw new Error("unexpected request " + url);
    };
    (async () => {
      let connected = null;
      let error = null;
      try {
        connected = await connectClient({
          serverUrl: "https://hub.example.test",
          credential: { kind: "admin", value: credential },
          selectedClients: ["claude"],
          managementTransport: "direct",
          noSync: true,
        }, { fetchImpl, now: () => {
          if (stage === "commit") setPersistedConfigMutationBeforeCommitForTests(() => {
            commitFaultTriggered = true;
            throw new Error("fixture_final_client_commit_failed");
          });
          return new Date("2026-08-28T00:00:00.000Z");
        }, lifecycleLockDeps: { lockPath: process.env.OPENCODEX_HOME + "/lifecycle.sqlite" } });
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      const beforeDisconnect = readClientConnectionState();
      const artifacts = {
        token: existsSync(serviceApiTokenFilePath()),
        catalog: existsSync(DEFAULT_CATALOG_PATH),
        credentialZeroed: credential.every(value => value === 0),
      };
      let disconnected = null;
      if ((stage === "success" || stage === "prior-catalog") && connected) disconnected = await disconnectClient({}, { lifecycleLockDeps: { lockPath: process.env.OPENCODEX_HOME + "/lifecycle.sqlite" } });
      const catalogAfter = existsSync(DEFAULT_CATALOG_PATH) ? readFileSync(DEFAULT_CATALOG_PATH, "utf8") : null;
      console.log(JSON.stringify({ connected, error, beforeDisconnect, artifacts, disconnected, catalogAfter, after: readClientConnectionState(), calls, commitFaultTriggered }));
    })();
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(opencodexHome, "desktop") },
    encoding: "utf8",
  });
  const output = result.stdout.trim().split("\n").at(-1) ?? "{}";
  const parsed = JSON.parse(output) as Record<string, any>;
  return {
    status: result.status,
    stderr: result.stderr,
    parsed,
    configBytes: readFileSync(configPath, "utf8"),
    cleanup: () => {
      removeTreeWithRetry(opencodexHome);
      removeTreeWithRetry(codexHome);
    },
  };
}

describe("connect transaction and offline disconnect", () => {
  test("an unavailable config coordinator refuses before issuing any hub key", () => {
    const run = runTransactionScenario("coordinator");
    try {
      expect(run.status).toBe(0);
      expect(run.parsed.connected).toBeNull();
      expect(run.parsed.calls).toEqual([]);
      expect(run.parsed.artifacts).toEqual({ token: false, catalog: false, credentialZeroed: true });
    } finally { run.cleanup(); }
  });
  test("commits key id/state last, zeroes authority, and disconnects with the hub offline", () => {
    const run = runTransactionScenario("success");
    try {
      expect(run.status).toBe(0);
      expect(run.parsed.error).toBeNull();
      expect(run.parsed.connected.apiKeyId).toBe("issued-id");
      expect(run.parsed.beforeDisconnect).toMatchObject({ kind: "connected", value: { apiKeyId: "issued-id" } });
      expect(run.parsed.artifacts).toEqual({ token: true, catalog: true, credentialZeroed: true });
      expect(run.parsed.disconnected).toMatchObject({ apiKeyId: "issued-id", tokenRemoved: true, catalogRemoved: true });
      expect(run.parsed.after).toEqual({ kind: "disconnected" });
      expect(run.parsed.calls.filter((call: any) => call.method === "DELETE")).toEqual([]);
    } finally { run.cleanup(); }
  });

  test("disconnect puts back the catalog the user had before connecting", () => {
    // Connect overwrites whatever catalog is already on disk. Disconnect used to delete the
    // remote one and report that native Codex state was restored, which left a user who had
    // their own catalog with no catalog at all — the one artifact a rollback cannot
    // reconstruct from anywhere else.
    const run = runTransactionScenario("prior-catalog");
    try {
      expect(run.status).toBe(0);
      expect(run.parsed.error).toBeNull();
      expect(run.parsed.disconnected).toMatchObject({ catalogRestored: true, catalogRemoved: true });
      expect(run.parsed.catalogAfter).toBe(PRIOR_CATALOG_BYTES);
      expect(run.parsed.after).toEqual({ kind: "disconnected" });
    } finally { run.cleanup(); }
  });

  test("disconnect removes the catalog when the user had none", () => {
    // The other half of the same contract: `priorCatalog: ""` records "there genuinely was
    // none", so removal IS the restoration and must not be mistaken for a lost file.
    const run = runTransactionScenario("success");
    try {
      expect(run.parsed.disconnected).toMatchObject({ catalogRemoved: true, catalogRestored: false });
      expect(run.parsed.catalogAfter).toBeNull();
    } finally { run.cleanup(); }
  });

  for (const stage of ["catalog", "preflight", "commit"] as const) {
    test(`rolls back local artifacts when ${stage} fails before final commit`, () => {
      const run = runTransactionScenario(stage);
      try {
        expect(run.status).toBe(0);
        expect(run.parsed.connected).toBeNull();
        expect(run.parsed.beforeDisconnect).toEqual({ kind: "disconnected" });
        expect(run.parsed.artifacts.token).toBe(false);
        expect(run.parsed.artifacts.catalog).toBe(false);
        expect(run.parsed.artifacts.credentialZeroed).toBe(true);
        expect(run.parsed.calls.some((call: any) => call.method === "DELETE")).toBe(true);
        if (stage === "commit") {
          expect(run.parsed.commitFaultTriggered).toBe(true);
          expect(run.parsed.calls.some((call: any) => call.method === "POST" && call.url.endsWith("/api/keys"))).toBe(true);
        }
        expect(run.configBytes).not.toContain("issued-id");
        expect(`${run.parsed.error} ${run.stderr}`).not.toContain(`ocx_data_${"d".repeat(40)}`);
      } finally { run.cleanup(); }
    });
  }
});

function runConnectedStateScenario(mode: "sync-401" | "sync-503" | "disconnect-conflict" | "disconnect-process-journal") {
  const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-client-state-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-client-state-codex-"));
  const token = `ocx_data_${"e".repeat(40)}`;
  const fingerprint = createHash("sha256").update(token).digest("hex");
  const catalog = '{"models":[]}';
  const catalogFingerprint = createHash("sha256").update(catalog).digest("base64url");
  const isDisconnect = mode === "disconnect-conflict" || mode === "disconnect-process-journal";
  const selectedClients = isDisconnect ? ["codex"] : ["claude"];
  writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    runtimeRole: "client",
    client: {
      serverUrl: "https://hub.example.test",
      managementUrl: "https://hub.example.test",
      managementTransport: "direct",
      selectedClients,
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId: "client-key-1",
      tokenFingerprint: fingerprint,
      protocolVersion: 1,
      connectedAt: "2026-08-28T00:00:00.000Z",
      catalogFingerprint,
      catalogSyncedAt: "2026-08-28T00:00:00.000Z",
    },
  }), "utf8");
  writeFileSync(join(opencodexHome, "service-api-token"), `${token}\n`, { mode: 0o600 });
  writeFileSync(join(codexHome, "opencodex-catalog.json"), catalog, "utf8");
  writeFileSync(join(codexHome, "config.toml"), isDisconnect
    ? 'model_provider = "opencodex"\n'
    : 'model_provider = "openai"\n', "utf8");
  if (mode === "disconnect-conflict") {
    writeFileSync(join(codexHome, "opencodex-journal.json"), JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      owner: { kind: "client", apiKeyId: "different-key" },
      pid: 999_999,
      timestamp: "2026-08-28T00:00:00.000Z",
    }));
  }
  if (mode === "disconnect-process-journal") {
    // The state `ocx start` leaves behind: routing is injected and the journal is owned by
    // the proxy PROCESS, not by any client key. Connecting on top of this does not take
    // ownership — writeJournal() refuses to overwrite a journal whose config is already
    // injected — so the process owner survives into the connected state.
    writeFileSync(join(codexHome, "opencodex-journal.json"), JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      owner: { kind: "process", pid: 999_999 },
      pid: 999_999,
      timestamp: "2026-08-28T00:00:00.000Z",
    }));
  }
  const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const { disconnectClient, syncConnectedClient } = require("./src/client/connect");
    const { readClientConnectionState } = require("./src/client/state");
    const mode = ${JSON.stringify(mode)};
    (async () => {
      let result = null;
      let error = null;
      try {
        if (mode === "disconnect-conflict" || mode === "disconnect-process-journal") result = await disconnectClient({}, { lifecycleLockDeps: { lockPath: process.env.OPENCODEX_HOME + "/lifecycle.sqlite" } });
        else result = await syncConnectedClient({}, {
          lifecycleLockDeps: { lockPath: process.env.OPENCODEX_HOME + "/lifecycle.sqlite" },
          fetchImpl: async () => Response.json({ error: "fixture" }, { status: mode === "sync-401" ? 401 : 503 }),
        });
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      console.log(JSON.stringify({
        result,
        error,
        state: readClientConnectionState(),
        tokenExists: fs.existsSync(path.join(process.env.OPENCODEX_HOME, "service-api-token")),
        journalExists: fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json")),
      }));
    })();
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(opencodexHome, "desktop") },
    encoding: "utf8",
  });
  const parsed = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, any>;
  return {
    status: child.status,
    parsed,
    cleanup: () => {
      removeTreeWithRetry(opencodexHome);
      removeTreeWithRetry(codexHome);
    },
  };
}

describe("connected sync and disconnect conflicts", () => {
  test("401 is a hard failure and never falls back to local providers", () => {
    const run = runConnectedStateScenario("sync-401");
    try {
      expect(run.status).toBe(0);
      expect(run.parsed.result).toBeNull();
      expect(run.parsed.error).toContain("401");
      expect(run.parsed.state.kind).toBe("connected");
      expect(run.parsed.tokenExists).toBe(true);
    } finally { run.cleanup(); }
  });

  test("hub 503 keeps and applies the last-known-good catalog as stale", () => {
    const run = runConnectedStateScenario("sync-503");
    try {
      expect(run.status).toBe(0);
      expect(run.parsed.error).toBeNull();
      expect(run.parsed.result).toMatchObject({ stale: true, catalogWritten: false, injected: false });
      expect(run.parsed.state.kind).toBe("connected");
    } finally { run.cleanup(); }
  });

  test("journal ownership conflict preserves every artifact and connected state", () => {
    const run = runConnectedStateScenario("disconnect-conflict");
    try {
      expect(run.status).toBe(0);
      expect(run.parsed.result).toBeNull();
      expect(run.parsed.error).toContain("journal ownership conflicts");
      expect(run.parsed.state.kind).toBe("connected");
      expect(run.parsed.tokenExists).toBe(true);
      expect(run.parsed.journalExists).toBe(true);
    } finally { run.cleanup(); }
  });

  test("a journal left owned by the proxy process does not strand the connection", () => {
    // Connecting after `ocx start` is the normal path, not an edge case: routing is already
    // injected and the journal is owned by the proxy process. Ownership never transfers,
    // because writeJournal() will not overwrite a journal whose config is already injected.
    //
    // Disconnect then read that surviving process owner as a conflict and refused, so the
    // operator could neither disconnect nor make the check pass — the connection was stuck.
    // A process-owned journal is ours to re-own on connect, so disconnect must complete.
    const run = runConnectedStateScenario("disconnect-process-journal");
    try {
      expect(run.status).toBe(0);
      expect(run.parsed.error).toBeNull();
      expect(run.parsed.state.kind).toBe("disconnected");
      expect(run.parsed.journalExists).toBe(false);
    } finally { run.cleanup(); }
  });
});

describe("recoverable connected key rotation", () => {
  test("a dropped first commit is recovered from doubly-accepted current and .prev keys", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-client-rotation-"));
    const oldKey = `ocx_data_${"1".repeat(40)}`;
    const newKey = `ocx_data_${"2".repeat(40)}`;
    const oldFingerprint = createHash("sha256").update(oldKey).digest("hex");
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      runtimeRole: "client",
      client: {
        serverUrl: "https://hub.example.test",
        managementUrl: "https://hub.example.test",
        managementTransport: "direct",
        selectedClients: ["claude"],
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
        apiKeyId: "client-key-1",
        tokenFingerprint: oldFingerprint,
        protocolVersion: 1,
        connectedAt: "2026-08-28T00:00:00.000Z",
      },
    }));
    writeFileSync(join(opencodexHome, "service-api-token"), `${oldKey}\n`, { mode: 0o600 });
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const { rotateConnectedClientKey } = require("./src/client/connect");
      const { readClientConnectionState } = require("./src/client/state");
      let commitCalls = 0;
      let committed = false;
      const oldKey = ${JSON.stringify(oldKey)};
      const newKey = ${JSON.stringify(newKey)};
      const fetchImpl = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/api/keys/rotate") && init.method === "POST") return Response.json({
          id: "client-key-1", name: "client", key: newKey,
          createdAt: "2026-08-28T00:00:01.000Z", rotationId: "rotation-1",
          expiresAt: "2026-08-28T00:10:01.000Z",
        }, { status: 201 });
        if (url.endsWith("/api/keys/rotate/commit")) {
          commitCalls += 1;
          if (commitCalls === 1) throw new Error("dropped commit response");
          committed = true;
          return Response.json({ ok: true });
        }
        if (url.endsWith("/v1/catalog")) {
          const token = new Headers(init.headers).get("x-opencodex-api-key");
          const accepted = token === newKey || (!committed && token === oldKey);
          return accepted
            ? new Response('{"models":[]}', { headers: { "Content-Type": "application/json", "X-OpenCodex-Key-Id": "client-key-1" } })
            : Response.json({ error: "unauthorized" }, { status: 401 });
        }
        throw new Error("unexpected request " + url);
      };
      (async () => {
        const credential = new TextEncoder().encode("ocx_admin_rotation_test");
        const result = await rotateConnectedClientKey({ credential: { kind: "admin", value: credential } }, { fetchImpl, lifecycleLockDeps: { lockPath: process.env.OPENCODEX_HOME + "/lifecycle.sqlite" } });
        console.log(JSON.stringify({
          result,
          state: readClientConnectionState(),
          tokenIsNew: fs.readFileSync(path.join(process.env.OPENCODEX_HOME, "service-api-token"), "utf8").trim() === newKey,
          backup: fs.existsSync(path.join(process.env.OPENCODEX_HOME, "service-api-token.prev")),
          commitCalls,
          credentialZeroed: credential.every(value => value === 0),
        }));
      })();
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, OPENCODEX_HOME: opencodexHome, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(opencodexHome, "desktop") },
      encoding: "utf8",
    });
    try {
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, any>;
      expect(result.commitCalls).toBe(2);
      expect(result.tokenIsNew).toBe(true);
      expect(result.backup).toBe(false);
      expect(result.state).toMatchObject({ kind: "connected", value: { apiKeyId: "client-key-1" } });
      expect(result.state.value.pendingOperation).toBeUndefined();
      expect(result.credentialZeroed).toBe(true);
    } finally {
      removeTreeWithRetry(opencodexHome);
    }
  });

  test("status removes a .prev orphan only when no rotation marker exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-client-orphan-"));
    const token = `ocx_data_${"3".repeat(40)}`;
    const fingerprint = createHash("sha256").update(token).digest("hex");
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 10100, providers: {}, defaultProvider: "openai", runtimeRole: "client",
      client: {
        serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test",
        managementTransport: "direct", selectedClients: ["claude"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
        apiKeyId: "client-key-1", tokenFingerprint: fingerprint, protocolVersion: 1,
        connectedAt: "2026-08-28T00:00:00.000Z",
      },
    }));
    writeFileSync(join(home, "service-api-token"), `${token}\n`, { mode: 0o600 });
    writeFileSync(join(home, "service-api-token.prev"), `${token}\n`, { mode: 0o600 });
    const previous = process.env.OPENCODEX_HOME;
    const previousDesktop = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    process.env.OPENCODEX_HOME = home;
    process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(home, "desktop");
    try {
      const errors: string[] = [];
      const spy = spyOn(console, "error").mockImplementation(value => errors.push(String(value)));
      try { expect(await handleConnectCommand(["status", "--json"], { lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") } })).toBe(0); }
      finally { spy.mockRestore(); }
      expect(existsSync(join(home, "service-api-token.prev"))).toBe(false);
      expect(readFileSync(join(home, "service-api-token"), "utf8").trim()).toBe(token);
      expect(errors.join(" ")).not.toContain(token);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      if (previousDesktop === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktop;
      removeTreeWithRetry(home);
    }
  });
});


/** Real per-process files and SQLite; only hub HTTP is substituted. Never return credential bytes. */
function runDesktopLifecycleScenario(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-lifecycle-client-"));
  const script = `
    const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
    const { Readable } = require("node:stream");
    const { spyOn } = require("bun:test");
    const configApi = require("./src/config");
    const connectApi = require("./src/client/connect");
    const stateApi = require("./src/client/state");
    const store = require("./src/claude/desktop-remote-store");
    const locks = require("./src/client/lifecycle-lock");
    const { handleConnectCommand } = require("./src/cli/connect");
    const { DEFAULT_CATALOG_PATH } = require("./src/codex/paths");
    const mode = ${JSON.stringify(mode)};
    const home = process.env.OPENCODEX_HOME, desktop = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    for (const dir of [home, desktop, process.env.CODEX_HOME]) fs.mkdirSync(dir, { recursive: true });
    const lockDeps = { lockPath: path.join(home, "fixture-lifecycle.sqlite") };
    const oldKey = "ocx_data_" + "1".repeat(40), newKey = "ocx_data_" + "2".repeat(40);
    const hash = value => crypto.createHash("sha256").update(value).digest("hex");
    const oldHash = hash(oldKey), newHash = hash(newKey);
    const owner = { serverUrl: "https://hub.example.test", apiKeyId: "fixture-key", connectedAt: "2026-09-06T00:00:00.000Z" };
    const catalog = '{"models":[{"slug":"hub/model"}]}', prior = '{"models":[{"slug":"prior/model"}]}';
    const config = { port: 10100,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      defaultProvider: "openai", runtimeRole: "client", client: {
      ...owner, managementUrl: owner.serverUrl, managementTransport: "direct", selectedClients: ["claude"],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN", tokenFingerprint: oldHash, protocolVersion: 1,
      catalogFingerprint: crypto.createHash("sha256").update(catalog).digest("base64url"),
      priorCatalog: Buffer.from(prior).toString("base64"),
    } };
    fixtureFailurePhase = "config_setup";
    configApi.saveConfig(config);
    if (configApi.readConfigDiagnostics().source !== "file" || stateApi.readClientConnectionState().kind !== "connected") {
      throw new Error("fixture_config_invalid");
    }
    const tokenPath = path.join(home, "service-api-token"), backupPath = tokenPath + ".prev";
    fs.writeFileSync(tokenPath, oldKey, { mode: 0o600 });
    fs.mkdirSync(path.dirname(DEFAULT_CATALOG_PATH), { recursive: true });
    fs.writeFileSync(DEFAULT_CATALOG_PATH, catalog);
    const profilePath = path.join(desktop, "fixture.json");
    const baselinePath = path.join(home, "desktop-remote", "baseline.json");
    const unused = mode.startsWith("status-") || mode === "disconnect-expected-owner";
    fixtureFailurePhase = "desktop_setup";
    if (!unused) {
      fs.writeFileSync(path.join(desktop, "_meta.json"), JSON.stringify({ appliedId: "fixture", entries: [{ id: "fixture", name: "opencodex" }], foreignMeta: "preserve" }));
      fs.writeFileSync(profilePath, JSON.stringify({
        inferenceProvider: "gateway", inferenceCredentialKind: "static",
        inferenceGatewayBaseUrl: mode === "disconnect-legacy" ? owner.serverUrl : "http://127.0.0.1:10100",
        inferenceGatewayApiKey: mode === "disconnect-legacy" ? oldKey : "fixture-local-key",
        modelDiscoveryEnabled: false, inferenceModels: [], foreignTheme: "preserve",
      }));
      if (mode !== "disconnect-legacy") {
        const applied = locks.withClientLifecycleSync(held => store.applyRemoteDesktopStore(held, {
          owner, expectedTokenFingerprint: oldHash, baseUrl: owner.serverUrl, apiKey: oldKey, mode: "static",
          models: [{ name: "claude-opus-4-8-20260101", labelOverride: "Fixture", anthropicFamilyTier: "opus" }],
        }), lockDeps);
        if (!applied.ok) throw new Error("fixture_desktop_apply_failed");
      }
    }
    const baselineBefore = fs.existsSync(baselinePath) ? hash(fs.readFileSync(baselinePath)) : null;
    const desktopValue = () => fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, "utf8")) : {};
    const saveClient = change => { const c = configApi.loadConfig(); change(c.client, c); configApi.saveConfig(c); };
    const pending = { kind: "rotate", rotationId: "fixture-rotation", newKeyIssuedAt: "2026-09-06T00:00:01.000Z", oldKeyBackupPath: backupPath };
    const prepared = () => locks.withClientLifecycleSync(held => store.writeDesktopDisconnectReceipt(held, null, {
      version: 1, owner, tokenFingerprint: oldHash, keepCatalog: false, phase: "prepared",
    }), lockDeps);
    const recovery = mode.startsWith("recover-") || mode.startsWith("same-old");
    if (recovery) {
      saveClient(client => { client.pendingOperation = pending; });
      fs.writeFileSync(backupPath, oldKey, { mode: 0o600 });
      fs.writeFileSync(tokenPath, mode.startsWith("same-old") ? oldKey : newKey, { mode: 0o600 });
    }
    let commits = 0, aborts = 0, desktopBeforeCommit = false, committed = mode === "recover-current", aborted = false;
    let guardSeen = false, writesAfterGuard = 0, codexSawPrepared = false, codexOutsideL = false;
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/api/keys/rotate") && init.method === "POST") return Response.json({
        id: owner.apiKeyId, name: "fixture", key: newKey, createdAt: pending.newKeyIssuedAt,
        rotationId: pending.rotationId, expiresAt: "2026-09-06T00:10:01.000Z",
      }, { status: 201 });
      if (url.endsWith("/api/keys/rotate/commit")) {
        commits++;
        desktopBeforeCommit = desktopValue().inferenceGatewayApiKey === newKey;
        committed = true;
        if (mode === "commit-lost" && commits === 1) throw new Error("dropped fixture response");
        return Response.json({ ok: true });
      }
      if (url.endsWith("/api/keys/rotate") && init.method === "DELETE") {
        aborts++;
        if (mode === "same-old-abort-failure") return Response.json({ error: "unavailable" }, { status: 503 });
        aborted = true;
        return Response.json({ ok: true });
      }
      if (url.endsWith("/v1/catalog")) {
        if (mode === "sync-claim") { prepared(); return Response.json({ models: [{ slug: "new/model" }] }); }
        if (mode === "sync-generation-change") {
          saveClient(client => { client.tokenFingerprint = newHash; }); fs.writeFileSync(tokenPath, newKey);
          return Response.json({ models: [{ slug: "new/model" }] });
        }
        if (mode === "sync-queued-guard") return Response.json({ models: [{ slug: "new/model" }] });
        if (mode === "recover-probe-error") throw new Error("fixture probe unavailable");
        const value = new Headers(init.headers).get("x-opencodex-api-key");
        const oldAdmitted = !committed;
        const newAdmitted = !aborted && !["recover-backup", "recover-backup-cli", "rollback"].includes(mode);
        const admitted = mode !== "recover-neither" && ((value === oldKey && oldAdmitted) || (value === newKey && newAdmitted));
        return admitted ? new Response(catalog, { headers: { "Content-Type": "application/json", "X-OpenCodex-Key-Id": owner.apiKeyId } })
          : Response.json({ error: "unauthorized" }, { status: 401 });
      }
      throw new Error("unexpected fixture request");
    };
    fixtureFailurePhase = "scenario";
    await (async () => {
      let result = null, error = null, second = null, statusInside = null, statusOutside = null, cliRotation = null;
      const credential = new TextEncoder().encode("ocx_admin_fixture");
      const deps = { fetchImpl, lifecycleLockDeps: lockDeps };
      try {
        if (mode.startsWith("disconnect")) {
          let journalSpy;
          if (mode === "disconnect-expected-owner") {
            saveClient(client => { client.apiKeyId = "new-fixture-key"; client.connectedAt = "2026-09-06T02:00:00.000Z"; client.tokenFingerprint = newHash; });
            fs.writeFileSync(tokenPath, newKey);
          }
          if (mode === "disconnect-order") {
            saveClient(client => { client.selectedClients = ["codex"]; });
            const journal = require("./src/codex/journal");
            fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), 'model_provider = "opencodex"');
            fs.writeFileSync(journal.JOURNAL_PATH, JSON.stringify({ version: 1,
              originalConfig: Buffer.from('model_provider = "openai"').toString("base64"), originalProfile: null,
              owner: { kind: "client", apiKeyId: owner.apiKeyId },
            }));
            const actualRestore = journal.restoreJournalState;
            journalSpy = spyOn(journal, "restoreJournalState").mockImplementation(() => {
              const r = store.readDesktopDisconnectReceipt();
              codexSawPrepared = r.kind === "valid" && r.value.phase === "prepared";
              codexOutsideL = locks.withClientLifecycleSync(() => true, lockDeps);
              return actualRestore();
            });
          }
          if (mode === "disconnect-foreign") {
            const v = desktopValue(); v.userAdded = "preserved"; fs.writeFileSync(profilePath, JSON.stringify(v));
          }
          if (mode === "disconnect-protected") {
            const v = desktopValue(); v.inferenceModels = []; fs.writeFileSync(profilePath, JSON.stringify(v));
          }
          if (mode === "disconnect-resume" || mode === "disconnect-after-clear") {
            locks.withClientLifecycleSync(held => {
              let r = { version: 1, owner, tokenFingerprint: oldHash, keepCatalog: false, phase: "prepared" };
              store.writeDesktopDisconnectReceipt(held, null, r);
              const restored = store.restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [oldHash] });
              if (!restored.ok) throw new Error("fixture_restore_failed");
              const advance = (phase, fields = {}) => { const next = { ...r, ...fields, phase }; store.writeDesktopDisconnectReceipt(held, r, next); r = next; };
              advance("desktop_restored", restored.fingerprint ? { desktopAfterFingerprint: restored.fingerprint } : {});
              fs.writeFileSync(DEFAULT_CATALOG_PATH, prior);
              advance("catalog_settled", { catalogAfter: { kind: "file", fingerprint: hash(prior) } });
              advance("removing_token"); fs.unlinkSync(tokenPath);
              if (mode === "disconnect-after-clear") { advance("token_removed"); advance("clearing_connection"); stateApi.clearClientConnection(owner); }
            }, lockDeps);
          }
          try {
            result = await connectApi.disconnectClient(mode === "disconnect-expected-owner" ? { expectedOwner: owner } : {}, deps);
            second = await connectApi.disconnectClient({}, deps);
          } finally { journalSpy?.mockRestore(); }
        } else if (mode === "sync-claim" || mode === "sync-queued-guard" || mode === "sync-generation-change") {
          let spy;
          if (mode === "sync-queued-guard") {
            saveClient(client => { client.selectedClients = ["codex"]; });
            const inject = require("./src/codex/inject");
            spy = spyOn(inject, "injectCodexConfig").mockImplementation(async (_port, _config, options) => {
              guardSeen = typeof options.beforeClientWrite === "function";
              prepared();
              options.beforeClientWrite?.();
              writesAfterGuard++;
              return { success: true, status: "applied", message: "fixture" };
            });
          }
          try { result = await connectApi.syncConnectedClient({}, deps); } finally { spy?.mockRestore(); }
        } else if (mode === "status-lock" || mode === "status-receipt") {
          fs.writeFileSync(backupPath, oldKey, { mode: 0o600 });
          if (mode === "status-receipt") prepared();
          statusInside = await locks.withClientLifecycle(async () => ({
            result: stateApi.inspectClientRotationRecoveryGate(stateApi.readClientConnectionState(), lockDeps),
            backupPresent: fs.existsSync(backupPath),
          }), lockDeps);
          statusOutside = stateApi.inspectClientRotationRecoveryGate(stateApi.readClientConnectionState(), lockDeps);
        } else if (mode === "clear-owner-change") {
          saveClient(client => { client.connectedAt = "2026-09-06T02:00:00.000Z"; });
          result = stateApi.clearClientConnection(owner);
        } else if (mode === "recover-backup-cli") {
          const logs = [], errors = [];
          const log = spyOn(console, "log").mockImplementation(value => logs.push(String(value)));
          const err = spyOn(console, "error").mockImplementation(value => errors.push(String(value)));
          try {
            const exitCode = await handleConnectCommand(["rotate", "--admin-token-stdin", "--json"], {
              ...deps, stdinImpl: Readable.from(["ocx_admin_fixture\\n"]),
            });
            cliRotation = { exitCode, value: logs.length ? JSON.parse(logs.at(-1)) : null, revokedClaim: logs.some(x => x.includes("previous key is no longer admitted")) };
          } finally { log.mockRestore(); err.mockRestore(); }
        } else if (recovery) result = await connectApi.recoverPendingClientRotation({ credential: { kind: "admin", value: credential } }, deps);
        else result = await connectApi.rotateConnectedClientKey({ credential: { kind: "admin", value: credential } }, deps);
      } catch (cause) { error = cause instanceof Error ? cause.message : "fixture operation failed"; }
      const d = desktopValue(), state = stateApi.readClientConnectionState();
      const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8").trim() : null;
      const r = store.readDesktopDisconnectReceipt();
      console.log(JSON.stringify({ fixtureResult: {
        result, error, second, commits, aborts, desktopBeforeCommit, guardSeen, writesAfterGuard, cliRotation, codexSawPrepared, codexOutsideL,
        stateKind: state.kind, pending: state.kind === "connected" && !!state.value.pendingOperation,
        persistedOutcome: state.kind === "connected" && Object.hasOwn(state.value, "rotationOutcome"),
        tokenIsOld: token === oldKey, tokenIsNew: token === newKey, tokenAbsent: token === null,
        desktopIsOld: d.inferenceGatewayApiKey === oldKey, desktopIsNew: d.inferenceGatewayApiKey === newKey,
        desktopIsLocal: d.inferenceGatewayApiKey === "fixture-local-key", desktopHasKey: Object.hasOwn(d, "inferenceGatewayApiKey"),
        foreignPreserved: unused || d.foreignTheme === "preserve", userAddedPreserved: d.userAdded === "preserved",
        backupPresent: fs.existsSync(backupPath),
        baselineUnchanged: baselineBefore !== null && fs.existsSync(baselinePath) && hash(fs.readFileSync(baselinePath)) === baselineBefore,
        catalogUnchanged: fs.existsSync(DEFAULT_CATALOG_PATH) && fs.readFileSync(DEFAULT_CATALOG_PATH, "utf8") === catalog,
        catalogPrior: fs.existsSync(DEFAULT_CATALOG_PATH) && fs.readFileSync(DEFAULT_CATALOG_PATH, "utf8") === prior,
        receiptPhase: r.kind === "valid" ? r.value.phase : r.kind,
        statusInside, statusOutside, credentialZeroed: credential.every(byte => byte === 0),
      }}));
    })();
  `;
  // spyOn is a test-runner API; execute this synthetic scenario as a real test,
  // not bare --eval. Resolve repository imports independently of its temporary path.
  const resolvedScript = script.replace(/require\("(\.\/src\/[^"\n]+)"\)/g,
    (_match, relative: string) => `require(${JSON.stringify(join(repoRoot, relative))})`);
  const fixturePath = join(root, "client-lifecycle-fixture.test.ts");
  writeFileSync(fixturePath, `import { test } from "bun:test";
    test("isolated client lifecycle scenario", async () => {
      let fixtureFailurePhase = "module_load";
      try {
        ${resolvedScript}
      } catch {
        console.log(JSON.stringify({ fixtureFailure: fixtureFailurePhase }));
        throw new Error("client_fixture_" + fixtureFailurePhase);
      }
    }, { timeout: ${INTERNAL_DEADLINE_MS} });
  `);
  // Keep the canonical guard/preload, but avoid the repository's root="tests"
  // discovery restriction for this generated temporary test file.
  const child = spawnSync(process.execPath, ["test", "--preload", join(repoRoot, "tests/preload.ts"), fixturePath], {
    cwd: root,
    env: { ...process.env, OPENCODEX_HOME: join(root, "ocx"), CODEX_HOME: join(root, "codex"), OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(root, "desktop") },
    encoding: "utf8", timeout: INTERNAL_DEADLINE_MS, killSignal: "SIGKILL",
  });
  try {
    const marker = child.stdout.trim().split("\n").reverse().find(line =>
      line.startsWith('{"fixtureResult":') || line.startsWith('{"fixtureFailure":'));
    let envelope: { fixtureFailure?: unknown; fixtureResult?: unknown } | undefined;
    try { if (marker) envelope = JSON.parse(marker); } catch { /* fixed category below */ }
    if (child.error || child.status !== 0 || child.signal || !envelope?.fixtureResult) {
      const category = CLIENT_FIXTURE_FAILURE_CATEGORIES.find(value => value === envelope?.fixtureFailure) ?? "child_failed";
      throw new ClientStateProbeError(child.pid, child.status, child.signal, (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT", category);
    }
    return envelope.fixtureResult as Record<string, any>;
  } finally { removeTreeWithRetry(root); }
}

describe("Desktop copy coherence across client lifecycle", () => {
  test.each(["rotate", "recover-both", "recover-current", "commit-lost"])("%s settles Desktop before reporting committed", mode => {
    const r = runDesktopLifecycleScenario(mode);
    expect(r.error).toBeNull();
    expect(r.result.rotationOutcome).toBe("committed");
    expect(r.tokenIsNew && r.desktopIsNew).toBe(true);
    expect(r.pending || r.backupPresent || r.persistedOutcome).toBe(false);
    expect(r.foreignPreserved && r.baselineUnchanged && r.credentialZeroed).toBe(true);
    if (r.commits > 0) expect(r.desktopBeforeCommit).toBe(true);
  });
  test.each(["recover-backup", "same-old"])("%s returns rolled_back without a false commit", mode => {
    const r = runDesktopLifecycleScenario(mode);
    expect(r.error).toBeNull();
    expect(r.result.rotationOutcome).toBe("rolled_back");
    expect(r.commits).toBe(0);
    expect(r.aborts).toBe(1);
    expect(r.tokenIsOld && r.desktopIsOld).toBe(true);
    expect(r.pending || r.backupPresent || r.persistedOutcome).toBe(false);
    expect(r.baselineUnchanged && r.credentialZeroed).toBe(true);
  });
  test("normal failed candidate rolls both local copies back before returning failure", () => {
    const r = runDesktopLifecycleScenario("rollback");
    expect(r.error).not.toBeNull();
    expect(r.commits).toBe(0);
    expect(r.tokenIsOld && r.desktopIsOld).toBe(true);
    expect(r.pending || r.backupPresent).toBe(false);
  });
  test.each(["same-old-abort-failure", "recover-neither", "recover-probe-error"])("%s preserves recovery evidence", mode => {
    const r = runDesktopLifecycleScenario(mode);
    expect(r.result).toBeNull();
    expect(r.error).not.toBeNull();
    expect(r.commits).toBe(0);
    expect(r.pending && r.backupPresent && r.credentialZeroed).toBe(true);
  });
  test("CLI reports a recovered rollback honestly", () => {
    const r = runDesktopLifecycleScenario("recover-backup-cli");
    expect(r.cliRotation.exitCode).toBe(0);
    expect(r.cliRotation.value.rotation).toBe("rolled_back");
    expect(r.cliRotation.revokedClaim).toBe(false);
    expect(r.desktopIsOld && r.tokenIsOld).toBe(true);
  });
  test.each(["disconnect", "disconnect-foreign", "disconnect-resume", "disconnect-after-clear"])("%s restores projection and retries idempotently", mode => {
    const r = runDesktopLifecycleScenario(mode);
    expect(r.error).toBeNull();
    expect(r.stateKind).toBe("disconnected");
    expect(r.tokenAbsent && r.desktopIsLocal && r.foreignPreserved && r.catalogPrior).toBe(true);
    expect(r.receiptPhase).toBe("complete");
    expect(r.second.tokenRemoved).toBe(false);
    if (mode === "disconnect-foreign") expect(r.userAddedPreserved).toBe(true);
  });
  test("legacy current-hub profile disconnects via labeled standard fallback", () => {
    const r = runDesktopLifecycleScenario("disconnect-legacy");
    expect(r.error).toBeNull();
    expect(r.result.desktopRestoration).toBe("standard_fallback");
    expect(r.desktopHasKey).toBe(false);
    expect(r.tokenAbsent && r.foreignPreserved).toBe(true);
  });
  test("protected Desktop edits block destructive disconnect", () => {
    const r = runDesktopLifecycleScenario("disconnect-protected");
    expect(r.error).not.toBeNull();
    expect(r.tokenIsOld && r.desktopIsOld).toBe(true);
    expect(r.stateKind).toBe("connected");
  });
  test("post-await sync cannot overwrite a prepared disconnect", () => {
    const r = runDesktopLifecycleScenario("sync-claim");
    expect(r.error).toBe("client_disconnect_pending");
    expect(r.catalogUnchanged).toBe(true);
    expect(r.receiptPhase).toBe("prepared");
  });
  test("disconnect expectedOwner refuses a newly connected owner before claiming or deleting state", () => {
    const r = runDesktopLifecycleScenario("disconnect-expected-owner");
    expect(r.result).toBeNull();
    expect(r.error).toBe("client_disconnect_expected_owner_changed");
    expect(r.stateKind).toBe("connected");
    expect(r.tokenIsNew && r.catalogUnchanged).toBe(true);
    expect(r.receiptPhase).toBe("absent");
  });
  test("disconnect claims its receipt before Codex-only restoration outside L", () => {
    const r = runDesktopLifecycleScenario("disconnect-order");
    expect(r.error).toBeNull();
    expect(r.codexSawPrepared && r.codexOutsideL).toBe(true);
    expect(r.receiptPhase).toBe("complete");
  });
  test("sync CAS preserves a newer token generation and leaves catalog bytes unchanged", () => {
    const r = runDesktopLifecycleScenario("sync-generation-change");
    expect(r.error).toBe("client_connection_changed");
    expect(r.tokenIsNew && r.catalogUnchanged).toBe(true);
  });
  test("full-owner clear cannot delete a newer connection with the same key id", () => {
    const r = runDesktopLifecycleScenario("clear-owner-change");
    expect(r.result).toBe("conflict");
    expect(r.stateKind).toBe("connected");
    expect(r.tokenIsOld).toBe(true);
  });
  test("sync supplies the read-only guard at the actual injection seam", () => {
    const r = runDesktopLifecycleScenario("sync-queued-guard");
    expect(r.guardSeen).toBe(true);
    expect(r.writesAfterGuard).toBe(0);
    expect(r.error).toBe("client_disconnect_pending");
  });
  test.each(["status-lock", "status-receipt"])("%s cannot discard another operation's backup", mode => {
    const r = runDesktopLifecycleScenario(mode);
    expect(r.error).toBeNull();
    expect(r.statusInside.result.kind).toBe("recovery-required");
    expect(r.statusInside.backupPresent).toBe(true);
    expect(r.statusOutside.kind).toBe(mode === "status-lock" ? "orphan-cleaned" : "recovery-required");
    expect(r.backupPresent).toBe(mode === "status-receipt");
  });
});
