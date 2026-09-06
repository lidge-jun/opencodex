import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { managementPrincipal, requireManagementAuth, type ManagementAuthState, type LocalManagementAuthContext } from "../src/server/management-auth";
import { authorizeGuiSessionRequest, type GuiSessionState, type GuiSessionRecord, type GuiPairingGrantRecord } from "../src/server/gui-session";
import { createLocalManagementReadCapability, LOCAL_MANAGEMENT_READ_PATHS } from "../src/lib/local-management-capability";
import { createSystemRestartCapability, SYSTEM_RESTART_PATH } from "../src/lib/system-restart-contract";
import { createLocalProviderReloadCapability, LOCAL_PROVIDER_RELOAD_PATH } from "../src/lib/local-provider-reload-contract";
import { createGuiPairCapability, GUI_PAIR_PATH } from "../src/lib/gui-pair-capability";
import type { OcxConfig } from "../src/types";

/**
 * Differential oracle for the Go management auth/session model (ADR-0008,
 * ticket #18).
 *
 * The acceptance criterion is that Go validates the admin token, dashboard
 * session, and capability principals with under-privileged requests rejected
 * identically to TypeScript. This harness feeds the same ordered arrays of
 * request vectors through src/server/management-auth.ts (in-process) and
 * through the `ocx-sidecar authcheck` subcommand (one Go process per array, so
 * the capability replay stores persist across the array exactly like the TS
 * module-level stores), then compares the admission decisions byte for byte:
 * the principal when admitted, and the exact status + JSON body when rejected.
 *
 * The vectors exercise every principal and every rejection shape: valid and
 * tampered capabilities for all four capability contracts, wrong pid/expiry/
 * method/query/body-shape variants, admin-token equality through both header
 * spellings, dashboard sessions with origin/CSRF/expiry outcomes (the
 * session-level admission reason is probed too), and the 503 unavailable path.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function goToolchainAvailable(): boolean {
  return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
}

function buildSidecarBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-auth-"));
  const binPath = join(dir, process.platform === "win32" ? "ocx-sidecar.exe" : "ocx-sidecar");
  const build = Bun.spawnSync(["go", "build", "-o", binPath, "./cmd/ocx-sidecar"], {
    cwd: join(repoRoot, "go"),
    env: { ...process.env, CGO_ENABLED: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(`go build ./cmd/ocx-sidecar failed (${build.exitCode}):\n${new TextDecoder().decode(build.stderr)}`);
  }
  return binPath;
}

const goAvailable = goToolchainAvailable();
const sidecarBinary: string | null = goAvailable ? buildSidecarBinary() : null;

const describeGo = goAvailable ? describe : describe.skip;

// Fixed process identity for the vectors: the values are arbitrary numbers the
// capability HMACs bind to; both sides see the same ones.
const PID = 4242;
const PORT = 10100;
const SECRET = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43-char base64url
const ADMIN_TOKEN = "ocx_admin_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function b64url43(): string {
  return randomBytes(32).toString("base64url");
}

const LOOPBACK_URL = `http://127.0.0.1:${PORT}`;

interface Vector {
  request: { url: string; method: string; headers: Record<string, string> };
  sessionProbe?: boolean;
}

interface CaseInput {
  state: {
    available: boolean;
    token?: string;
    source?: string;
    reason?: string;
    sessions?: { token: string; serverOrigin: string; browserOrigin: string; csrf: string; expiresAt: number; issuance: string }[];
  };
  config: { hostname: string; runtimeRole?: string; hubManagementPublicOrigin?: string };
  local: { attestationSecret: string; pid: number; port: number };
  vectors: Vector[];
}

interface GoDecision {
  admitted: boolean;
  principal: string | null;
  rejection: { status: number; body: string } | null;
  sessionState?: string;
}

function toTSConfig(view: CaseInput["config"]): OcxConfig {
  return {
    hostname: view.hostname,
    runtimeRole: view.runtimeRole,
    hub: view.hubManagementPublicOrigin !== undefined ? { managementPublicOrigin: view.hubManagementPublicOrigin } : undefined,
  } as unknown as OcxConfig;
}

function tsState(input: CaseInput): { state: ManagementAuthState; guiState: GuiSessionState } {
  if (!input.state.available) {
    return { state: { available: false, reason: input.state.reason ?? "" }, guiState: { sessions: new Map(), pairingGrants: new Map() } };
  }
  const sessions = new Map<string, GuiSessionRecord>();
  for (const entry of input.state.sessions ?? []) {
    sessions.set(entry.token, {
      serverOrigin: entry.serverOrigin,
      browserOrigin: entry.browserOrigin,
      csrfToken: entry.csrf,
      expiresAt: entry.expiresAt,
      issuance: entry.issuance,
    });
  }
  const pairingGrants = new Map<string, GuiPairingGrantRecord>();
  const state: ManagementAuthState = {
    available: true,
    token: input.state.token ?? "",
    source: (input.state.source as "environment" | "file") ?? "environment",
    sessions,
    pairingGrants,
  };
  // The gate mutates the session table (expiry deletion, remote sliding); the
  // probe must observe the same table, so wrap the same Map instances.
  return { state, guiState: { sessions, pairingGrants } };
}

async function tsDecisions(input: CaseInput): Promise<GoDecision[]> {
  const config = toTSConfig(input.config);
  const local: LocalManagementAuthContext = { attestationSecret: input.local.attestationSecret, pid: input.local.pid, port: input.local.port };
  const { state, guiState } = tsState(input);
  const decisions: GoDecision[] = [];
  for (const vector of input.vectors) {
    const req = new Request(vector.request.url, { method: vector.request.method, headers: vector.request.headers });
    const principal = managementPrincipal(req, state, config, local);
    const probe = (out: GoDecision): void => {
      if (vector.sessionProbe) {
        const admission = authorizeGuiSessionRequest(req, config, guiState, Date.now());
        out.sessionState = admission.ok ? "ok" : admission.reason;
      }
    };
    if (principal) {
      const out: GoDecision = { admitted: true, principal, rejection: null };
      probe(out);
      decisions.push(out);
      continue;
    }
    const gate = requireManagementAuth(req, state, config, local);
    const out: GoDecision = { admitted: false, principal: null, rejection: { status: gate!.status, body: await gate!.text() } };
    probe(out);
    decisions.push(out);
  }
  return decisions;
}

function goDecisions(input: CaseInput): GoDecision[] {
  // Each vector carries the case's state/config/local so the Go subcommand can
  // build one Gate for the whole array (the replay stores persist across the
  // vectors exactly like the TS module-level stores).
  const flat = input.vectors.map((vector) => ({
    request: vector.request,
    state: input.state,
    config: input.config,
    local: input.local,
    sessionProbe: vector.sessionProbe,
  }));
  const result = Bun.spawnSync([sidecarBinary!, "authcheck", JSON.stringify(flat)], {
    env: { ...process.env, CGO_ENABLED: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`ocx-sidecar authcheck failed (${result.exitCode}):\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as GoDecision[];
  return parsed;
}

async function runCase(input: CaseInput): Promise<void> {
  const ts = await tsDecisions(input);
  const go = goDecisions(input);
  expect(go.length).toBe(ts.length);
  for (let i = 0; i < ts.length; i++) {
    expect(go[i], `vector ${i} divergence`).toEqual(ts[i]);
  }
}

function vector(method: string, pathOrUrl: string, headers: Record<string, string>, probe = false): Vector {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${LOOPBACK_URL}${pathOrUrl}`;
  return { request: { url, method, headers }, ...(probe ? { sessionProbe: true } : {}) };
}

// now within the TTL window for capability vectors (minted just-in-time).
const ttl = () => Date.now() + 6_000;

describeGo("Go management auth/session differential oracle (ticket #18)", () => {
  test("admin token and 401/503 rejection bodies are identical", async () => {
    await runCase({
      state: { available: true, token: ADMIN_TOKEN, source: "environment" },
      config: { hostname: "127.0.0.1" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors: [
        // x-opencodex-api-key header admits as admin-token.
        vector("GET", "/api/config", { host: `127.0.0.1:${PORT}`, "x-opencodex-api-key": ADMIN_TOKEN }),
        // Authorization: Bearer (case-insensitive prefix, trimmed) admits too.
        vector("GET", "/api/config", { host: `127.0.0.1:${PORT}`, authorization: `bearer  ${ADMIN_TOKEN}  ` }),
        // Wrong token, state available: exact 401 body.
        vector("GET", "/api/config", { host: `127.0.0.1:${PORT}`, "x-opencodex-api-key": "ocx_admin_wrongtokenwrongtokenwrongtokenwrongtokenwrongto" }),
        // No credential at all: exact 401 body.
        vector("GET", "/api/config", { host: `127.0.0.1:${PORT}` }),
        // A credential that is a valid session token but no such session exists.
        vector("GET", "/api/config", { host: `127.0.0.1:${PORT}`, "x-opencodex-api-key": "ocx_session_nosuchsessionsnosuchsessionsnosuchsessionsno" }),
      ],
    });

    await runCase({
      state: { available: false, reason: "management token initialization failed" },
      config: { hostname: "127.0.0.1" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors: [
        // Unavailable state: exact 503 body with reason + hint.
        vector("GET", "/api/config", { host: `127.0.0.1:${PORT}` }),
        vector("POST", "/api/config", { host: `127.0.0.1:${PORT}`, "x-opencodex-api-key": ADMIN_TOKEN }),
      ],
    });
  });

  test("system-restart capability principal and rejection paths", async () => {
    const nonce = b64url43();
    const cap = createSystemRestartCapability(SECRET, nonce, "POST", SYSTEM_RESTART_PATH, PID, PORT)!;
    const headers = (over: Record<string, string> = {}) => ({
      host: `127.0.0.1:${PORT}`,
      "x-opencodex-restart-expected-pid": String(PID),
      "x-opencodex-restart-nonce": nonce,
      "x-opencodex-restart-capability": cap,
      ...over,
    });
    await runCase({
      state: { available: true, token: ADMIN_TOKEN, source: "environment" },
      config: { hostname: "127.0.0.1" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors: [
        vector("POST", "/api/system/restart", headers()), // admits as the capability principal (not admin-token)
        vector("POST", "/api/system/restart", headers({ "x-opencodex-restart-expected-pid": "9999" })), // wrong pid
        vector("POST", "/api/system/restart", headers({ "x-opencodex-restart-capability": cap.slice(0, 42) + "A" })), // tampered
        vector("GET", "/api/system/restart", headers()), // wrong method
        vector("POST", "/api/config", headers()), // wrong path
      ],
    });
  });

  test("local-read capability: narrow grant, replay rejected identically", async () => {
    const nonce = b64url43();
    const expires = ttl();
    const cap = createLocalManagementReadCapability(SECRET, nonce, "GET", LOCAL_MANAGEMENT_READ_PATHS.codexAccounts, PID, PORT, expires)!;
    const base = {
      host: `127.0.0.1:${PORT}`,
      "x-opencodex-local-expected-pid": String(PID),
      "x-opencodex-local-nonce": nonce,
      "x-opencodex-local-expires-at": String(expires),
      "x-opencodex-local-capability": cap,
    };
    await runCase({
      state: { available: true, token: ADMIN_TOKEN, source: "environment" },
      config: { hostname: "127.0.0.1" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors: [
        vector("GET", "/api/codex-auth/accounts", base), // admits as local-read-capability
        vector("GET", "/api/codex-auth/accounts", base), // replay of the same capability is rejected
        vector("GET", "/api/codex-auth/accounts?x=1", base), // query string disqualifies the narrow grant
        vector("GET", "/api/system/health", base), // path not in the allowlist
        vector("PUT", "/api/codex-auth/accounts", base), // method not GET
        vector("GET", "/api/codex-auth/accounts", { ...base, "x-opencodex-local-expires-at": String(Date.now() - 1) }), // expired
        vector("GET", "/api/codex-auth/accounts", { ...base, "x-opencodex-local-capability": "not-a-capability-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }),
      ],
    });
  });

  test("provider-reload capability binds name/pid/expiry and empty-body shape", async () => {
    const nonce = b64url43();
    const expires = ttl();
    const cap = createLocalProviderReloadCapability(SECRET, nonce, "POST", LOCAL_PROVIDER_RELOAD_PATH, "openai", PID, PORT, expires)!;
    const base = {
      host: `127.0.0.1:${PORT}`,
      "content-length": "0",
      "x-opencodex-provider-reload-expected-pid": String(PID),
      "x-opencodex-provider-reload-nonce": nonce,
      "x-opencodex-provider-reload-expires-at": String(expires),
      "x-opencodex-provider-reload-name": "openai",
      "x-opencodex-provider-reload-capability": cap,
    };
    await runCase({
      state: { available: true, token: ADMIN_TOKEN, source: "environment" },
      config: { hostname: "127.0.0.1" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors: [
        vector("POST", "/api/providers/reload", base), // admits as local-provider-reload-capability
        vector("POST", "/api/providers/reload", base), // replay rejected
        vector("POST", "/api/providers/reload", { ...base, "content-length": "5" }), // non-empty body shape
        vector("POST", "/api/providers/reload", { ...base, "x-opencodex-provider-reload-name": "other provider!" }), // invalid name shape
        vector("POST", "/api/providers/reload", { ...base, "transfer-encoding": "chunked" }), // body via chunked
        vector("POST", "/api/providers/reload?x=1", base), // query disqualifies
      ],
    });
  });

  test("gui-pair capability binds canonical browser origin", async () => {
    const nonce = b64url43();
    const expires = ttl();
    const browserOrigin = "http://localhost:5173";
    const cap = createGuiPairCapability(SECRET, nonce, "POST", GUI_PAIR_PATH, browserOrigin, PID, PORT, expires)!;
    const base = {
      host: `127.0.0.1:${PORT}`,
      "content-length": "0",
      "x-opencodex-gui-pair-expected-pid": String(PID),
      "x-opencodex-gui-pair-nonce": nonce,
      "x-opencodex-gui-pair-expires-at": String(expires),
      "x-opencodex-gui-pair-origin": browserOrigin,
      "x-opencodex-gui-pair-capability": cap,
    };
    await runCase({
      state: { available: true, token: ADMIN_TOKEN, source: "environment" },
      config: { hostname: "127.0.0.1" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors: [
        vector("POST", "/api/gui/pairing-grants", base), // admits as gui-pair-capability
        vector("POST", "/api/gui/pairing-grants", base), // replay rejected (sha256 digest key)
        vector("POST", "/api/gui/pairing-grants", { ...base, "x-opencodex-gui-pair-origin": "HTTP://LOCALHOST:5173" }), // non-canonical origin spelling never verifies
        vector("POST", "/api/gui/pairing-grants", { ...base, "x-opencodex-gui-pair-expires-at": "0" }), // malformed expiry
      ],
    });
  });

  test("dashboard sessions: origin/CSRF/expiry outcomes match", async () => {
    const serverOrigin = `http://127.0.0.1:${PORT}`;
    const session = {
      token: `ocx_session_${b64url43()}`,
      serverOrigin,
      browserOrigin: serverOrigin,
      csrf: b64url43(),
      expiresAt: Date.now() + 5 * 60_000,
      issuance: "loopback",
    };
    const stale = {
      token: `ocx_session_${b64url43()}`,
      serverOrigin,
      browserOrigin: serverOrigin,
      csrf: b64url43(),
      expiresAt: Date.now() - 1,
      issuance: "loopback",
    };
    await runCase({
      state: { available: true, token: ADMIN_TOKEN, source: "environment", sessions: [session, stale] },
      config: { hostname: "127.0.0.1" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors: [
        // Safe GET with session token and matching gui-origin admits.
        vector("GET", "/api/config", {
          host: `127.0.0.1:${PORT}`,
          "x-opencodex-api-key": session.token,
          "x-opencodex-gui-origin": serverOrigin,
        }, true),
        // Unsafe POST needs Origin + CSRF.
        vector("POST", "/api/config", {
          host: `127.0.0.1:${PORT}`,
          "x-opencodex-api-key": session.token,
          origin: serverOrigin,
          "x-opencodex-gui-origin": serverOrigin,
          "x-opencodex-csrf-token": session.csrf,
        }, true),
        // Missing CSRF on a mutation rejects at the gate and with the csrf reason.
        vector("POST", "/api/config", {
          host: `127.0.0.1:${PORT}`,
          "x-opencodex-api-key": session.token,
          origin: serverOrigin,
          "x-opencodex-gui-origin": serverOrigin,
        }, true),
        // Browser-origin mismatch (claimed gui-origin) rejects.
        vector("GET", "/api/config", {
          host: `127.0.0.1:${PORT}`,
          "x-opencodex-api-key": session.token,
          "x-opencodex-gui-origin": "http://evil.example",
        }, true),
        // Server-origin mismatch: Host derives a different origin.
        vector("GET", "/api/config", {
          host: `127.0.0.1:9999`,
          "x-opencodex-api-key": session.token,
          "x-opencodex-gui-origin": serverOrigin,
        }, true),
        // Expired session: gate rejects, probe reports expired, entry deleted.
        vector("GET", "/api/config", {
          host: `127.0.0.1:${PORT}`,
          "x-opencodex-api-key": stale.token,
        }, true),
        // Unknown session token behaves like no credential at the gate.
        vector("GET", "/api/config", {
          host: `127.0.0.1:${PORT}`,
          "x-opencodex-api-key": `ocx_session_${b64url43()}`,
        }, true),
      ],
    });
  });

  test("remote and hub server-origin derivation matches", async () => {
    const remote = `http://mynode.lan:${PORT}`;
    const session = {
      token: `ocx_session_${b64url43()}`,
      serverOrigin: remote,
      browserOrigin: remote,
      csrf: b64url43(),
      expiresAt: Date.now() + 5 * 60_000,
      issuance: "remote",
    };
    await runCase({
      state: { available: true, token: ADMIN_TOKEN, source: "environment", sessions: [session] },
      config: { hostname: "0.0.0.0" }, // auth required for non-loopback
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors: [
        // Non-loopback observed origin admits when api auth is required.
        vector("GET", "/api/config", {
          host: `mynode.lan:${PORT}`,
          "x-opencodex-api-key": session.token,
          "x-opencodex-gui-origin": remote,
        }, true),
        // Host mismatch rejects under the derived-origin rule.
        vector("GET", "/api/config", {
          host: `other.lan:${PORT}`,
          "x-opencodex-api-key": session.token,
          "x-opencodex-gui-origin": remote,
        }, true),
      ],
    });

    const hub = {
      token: `ocx_session_${b64url43()}`,
      serverOrigin: "https://ocx.example",
      browserOrigin: "https://ocx.example",
      csrf: b64url43(),
      expiresAt: Date.now() + 5 * 60_000,
      issuance: "remote",
    };
    await runCase({
      state: { available: true, token: ADMIN_TOKEN, source: "environment", sessions: [hub] },
      config: { hostname: "0.0.0.0", runtimeRole: "hub", hubManagementPublicOrigin: "https://ocx.example" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors: [
        // A hub request derives the configured public origin, matching the session.
        vector("GET", "/api/config", {
          host: `10.0.0.5:${PORT}`,
          "x-opencodex-api-key": hub.token,
          "x-opencodex-gui-origin": "https://ocx.example",
        }, true),
      ],
    });
  });
});
