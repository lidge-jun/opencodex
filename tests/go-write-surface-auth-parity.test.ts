import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { managementPrincipal, requireManagementAuth, type ManagementAuthState, type LocalManagementAuthContext } from "../src/server/management-auth";
import type { GuiSessionState, GuiSessionRecord } from "../src/server/gui-session";
import { createSystemRestartCapability, SYSTEM_RESTART_PATH } from "../src/lib/system-restart-contract";
import { GO_OWNED_MANAGEMENT_ROUTES } from "../src/server/management/route-registry";
import type { OcxConfig } from "../src/types";

/**
 * Write-surface authorization differential oracle (ticket #26, seam 3 — devlog 035).
 *
 * Spec #3 story 4: a write route must never be Go-owned before its
 * authorization is proven. The batch tests prove the relay happy path and the
 * claim machinery; ticket #18 proves the Go gate on generic vectors. Neither
 * proves that the *migrated write surface's own* method/path pairs reject and
 * admit identically — which is the contract the flip consumes when the Go gate
 * becomes the front door for exactly these routes.
 *
 * This oracle feeds the same vectors through `src/server/management-auth.ts`
 * (in-process) and through `ocx-sidecar authcheck` (one Go process per case,
 * exactly like go-auth-parity), over every declared Go-owned write route:
 *
 *  - no credential  -> rejected, bytes identical
 *  - wrong token    -> rejected, bytes identical
 *  - admin token    -> admitted as the same principal
 *  - a valid system-restart capability aimed at the write route's own
 *    method/path (not /api/system/restart) -> rejected identically, proving a
 *    capability principal minted elsewhere cannot cross onto the write surface
 *
 * The declared route set drives the loop (plus the existing 12-route pin), so
 * adding a Go-owned write route without an authorization vector fails here.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function goToolchainAvailable(): boolean {
  return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
}

function buildSidecarBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-write-auth-"));
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

const PID = 4242;
const PORT = 10100;
const SECRET = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const ADMIN_TOKEN = "ocx_admin_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function b64url43(): string {
  return randomBytes(32).toString("base64url");
}

const LOOPBACK_URL = `http://127.0.0.1:${PORT}`;

interface Vector {
  request: { url: string; method: string; headers: Record<string, string> };
}

interface CaseInput {
  state: { available: boolean; token?: string; source?: string; reason?: string };
  config: { hostname: string };
  local: { attestationSecret: string; pid: number; port: number };
  vectors: Vector[];
}

interface Decision {
  admitted: boolean;
  principal: string | null;
  rejection: { status: number; body: string } | null;
}

function toTSConfig(view: CaseInput["config"]): OcxConfig {
  return { hostname: view.hostname } as unknown as OcxConfig;
}

function tsState(input: CaseInput): { state: ManagementAuthState; guiState: GuiSessionState } {
  const sessions = new Map<string, GuiSessionRecord>();
  return {
    state: {
      available: input.state.available,
      token: input.state.token ?? "",
      source: (input.state.source as "environment" | "file") ?? "environment",
      ...(input.state.reason !== undefined ? { reason: input.state.reason } : {}),
      sessions,
    },
    guiState: { sessions, pairingGrants: new Map() },
  };
}

async function tsDecisions(input: CaseInput): Promise<Decision[]> {
  const config = toTSConfig(input.config);
  const local: LocalManagementAuthContext = { attestationSecret: input.local.attestationSecret, pid: input.local.pid, port: input.local.port };
  const { state } = tsState(input);
  const decisions: Decision[] = [];
  for (const vector of input.vectors) {
    const req = new Request(vector.request.url, { method: vector.request.method, headers: vector.request.headers });
    const principal = managementPrincipal(req, state, config, local);
    if (principal) {
      decisions.push({ admitted: true, principal, rejection: null });
      continue;
    }
    const gate = requireManagementAuth(req, state, config, local);
    decisions.push({ admitted: false, principal: null, rejection: { status: gate!.status, body: await gate!.text() } });
  }
  return decisions;
}

function goDecisions(input: CaseInput): Decision[] {
  const flat = input.vectors.map((vector) => ({
    request: vector.request,
    state: input.state,
    config: input.config,
    local: input.local,
  }));
  const result = Bun.spawnSync([sidecarBinary!, "authcheck", JSON.stringify(flat)], {
    env: { ...process.env, CGO_ENABLED: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`ocx-sidecar authcheck failed (${result.exitCode}):\n${new TextDecoder().decode(result.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as Decision[];
}

async function runCase(input: CaseInput): Promise<void> {
  const ts = await tsDecisions(input);
  const go = goDecisions(input);
  expect(go.length).toBe(ts.length);
  for (let i = 0; i < ts.length; i++) {
    expect(go[i], `vector ${i} divergence`).toEqual(ts[i]);
  }
}

function vector(method: string, path: string, headers: Record<string, string>): Vector {
  return { request: { url: `${LOOPBACK_URL}${path}`, method, headers } };
}

function vectorSetFor(method: string, path: string, nonce: string): Vector[] {
  // A capability minted for POST /api/system/restart, aimed at this write route:
  // it must NOT admit (a capability principal never crosses onto the write surface).
  const cap = createSystemRestartCapability(SECRET, nonce, "POST", SYSTEM_RESTART_PATH, PID, PORT)!;
  const restartHeaders = {
    host: `127.0.0.1:${PORT}`,
    "x-opencodex-restart-expected-pid": String(PID),
    "x-opencodex-restart-nonce": nonce,
    "x-opencodex-restart-capability": cap,
  };
  return [
    vector(method, path, { host: `127.0.0.1:${PORT}` }), // no credential
    vector(method, path, { host: `127.0.0.1:${PORT}`, "x-opencodex-api-key": "ocx_admin_wrongtokenwrongtokenwrongtokenwrongtokenwrongto" }), // wrong token
    vector(method, path, { host: `127.0.0.1:${PORT}`, "x-opencodex-api-key": ADMIN_TOKEN }), // admin token admits
    vector(method, path, restartHeaders), // capability for another route must not cross
  ];
}

describeGo("write-surface authorization differential oracle (ticket #26, seam 3)", () => {
  test("every declared Go-owned write route admits and rejects byte-identically to TypeScript", async () => {
    const writes = GO_OWNED_MANAGEMENT_ROUTES.filter(route => route.mutates);
    // The 12-route pin (go-ownership-plumbing) owns the exact set; this test loops
    // over whatever is declared so a new write route cannot land without vectors.
    expect(writes.length).toBe(12);

    const vectors: Vector[] = [];
    for (const route of writes) {
      vectors.push(...vectorSetFor(route.method, route.path, b64url43()));
    }

    await runCase({
      state: { available: true, token: ADMIN_TOKEN, source: "environment" },
      config: { hostname: "127.0.0.1" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors,
    });
  });

  test("the write surface is still gated when auth state is unavailable (503 bytes identical)", async () => {
    const writes = GO_OWNED_MANAGEMENT_ROUTES.filter(route => route.mutates);
    const vectors: Vector[] = writes.flatMap(route =>
      [
        vector(route.method, route.path, { host: `127.0.0.1:${PORT}` }),
        vector(route.method, route.path, { host: `127.0.0.1:${PORT}`, "x-opencodex-api-key": ADMIN_TOKEN }),
      ],
    );
    await runCase({
      state: { available: false, reason: "management token initialization failed" },
      config: { hostname: "127.0.0.1" },
      local: { attestationSecret: SECRET, pid: PID, port: PORT },
      vectors,
    });
  });
});
