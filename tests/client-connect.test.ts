import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadClientCatalog,
  exchangeConnectPairingGrant,
  fetchHubReady,
  issueClientKey,
  normalizeHubOrigin,
} from "../src/client/hub-client";
import { handleConnectCommand } from "../src/cli/connect";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

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
  test("runtimeRole=hub without client state reads as disconnected so the hub can start", () => {
    // First clisu-oracle dogfood boot: the hub role refused 'ocx start' because the
    // client-state reader classified role=hub (no client block) as mismatched. A hub
    // is a server; without client state it is simply not a connected client.
    const readScript = `
      const { readClientConnectionState } = require("./src/client/state");
      console.log(JSON.stringify(readClientConnectionState()));
    `;
    const home = mkdtempSync(join(tmpdir(), "ocx-hub-role-"));
    const readState = () => {
      const child = spawnSync(process.execPath, ["--eval", readScript], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: home },
        encoding: "utf8",
      });
      return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}");
    };
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 10190, runtimeRole: "hub" }));
    expect(readState().kind).toBe("disconnected");
    // Hub role WITH a client block stays mismatched (the honest conflict).
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 10190, runtimeRole: "hub", client: { serverUrl: "https://hub.example.test" } }));
    expect(readState().kind).toBe("mismatched");
    removeTreeWithRetry(home);
  });
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

function runTransactionScenario(stage: "success" | "catalog" | "preflight" | "commit" | "prior-catalog") {
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
  if (stage === "commit") {
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
        }, { fetchImpl, now: () => new Date("2026-08-28T00:00:00.000Z") });
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      const beforeDisconnect = readClientConnectionState();
      const artifacts = {
        token: existsSync(serviceApiTokenFilePath()),
        catalog: existsSync(DEFAULT_CATALOG_PATH),
        credentialZeroed: credential.every(value => value === 0),
      };
      let disconnected = null;
      if ((stage === "success" || stage === "prior-catalog") && connected) disconnected = await disconnectClient();
      const catalogAfter = existsSync(DEFAULT_CATALOG_PATH) ? readFileSync(DEFAULT_CATALOG_PATH, "utf8") : null;
      console.log(JSON.stringify({ connected, error, beforeDisconnect, artifacts, disconnected, catalogAfter, after: readClientConnectionState(), calls }));
    })();
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome },
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
        if (mode === "disconnect-conflict" || mode === "disconnect-process-journal") result = await disconnectClient();
        else result = await syncConnectedClient({}, {
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
    env: { ...process.env, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome },
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
        const result = await rotateConnectedClientKey({ credential: { kind: "admin", value: credential } }, { fetchImpl });
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
      env: { ...process.env, OPENCODEX_HOME: opencodexHome },
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
    process.env.OPENCODEX_HOME = home;
    try {
      const errors: string[] = [];
      const spy = spyOn(console, "error").mockImplementation(value => errors.push(String(value)));
      try { expect(await handleConnectCommand(["status", "--json"])).toBe(0); }
      finally { spy.mockRestore(); }
      expect(existsSync(join(home, "service-api-token.prev"))).toBe(false);
      expect(readFileSync(join(home, "service-api-token"), "utf8").trim()).toBe(token);
      expect(errors.join(" ")).not.toContain(token);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(home);
    }
  });
});
