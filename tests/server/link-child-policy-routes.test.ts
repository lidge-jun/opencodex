import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkStore } from "../../src/link/store";
import type { LinkSupervisor } from "../../src/link/supervisor";
import { childPolicyPath } from "../../src/link/child-policy";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const POLICY = "/api/link/children/policy";
const DEFAULTS = { catalogFanout: "auto", childCodexRestart: "never", updates: "auto-when-idle", idleAfterMs: 600_000 };

let temp = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ocx-child-policy-routes-"));
  for (const name of ["OPENCODEX_HOME", "CODEX_HOME"]) saved[name] = process.env[name];
  process.env.OPENCODEX_HOME = join(temp, "ocx");
  process.env.CODEX_HOME = join(temp, "codex");
  mkdirSync(join(temp, "ocx", "link"), { recursive: true });
  mkdirSync(join(temp, "codex"), { recursive: true });
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  removeTreeWithRetry(temp);
});

type Principal = "admin-token" | "gui-session" | null;
interface CallOptions {
  principal?: Principal; issuance?: "pairing" | "loopback" | "tailscale-identity" | null; trustedLoopback?: boolean;
  paired?: boolean; current?: boolean; origin?: string;
}

function harness(runtimeRole: OcxConfig["runtimeRole"] = "hub") {
  const store: LinkStore = { version: 1, listenerPort: 18181, links: [] };
  const supervisor: LinkSupervisor = { start() {}, ensureStarted: async () => {}, reload: async () => {}, stopLink: async () => {}, stop: async () => {}, status: () => [] };
  const listener = { ensureStarted: async () => {}, status: () => ({ state: "off" as const, port: null, reason: null }), close: async () => {}, onAuthenticatedCatalog: () => () => {} };
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole, defaultProvider: "mock", providers: {}, apiKeys: [] } as OcxConfig;
  const deps: ManagementApiDeps = { readLinkStore: () => store, writeLinkStore: () => {}, linkSupervisor: () => supervisor, linkListener: () => listener,
    linkKnownHostsPath: () => join(temp, "known_hosts"), now: () => 1_762_819_200_000 };
  return async (method: string, body?: unknown, options: CallOptions = {}) => {
    const url = new URL(`http://127.0.0.1${POLICY}`);
    const headers: Record<string, string> = { host: "127.0.0.1", "content-type": "application/json", ...(options.origin ? { origin: options.origin } : {}) };
    const req = new Request(url, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const principal = options.principal === undefined ? "admin-token" : options.principal;
    const response = await handleManagementAPI(req, url, config, deps, principal ?? undefined,
      { isPaired: () => options.paired ?? true, isCurrent: () => options.current ?? true, revokeCurrent: () => true },
      { trustedLoopback: options.trustedLoopback ?? true, guiSessionIssuance: options.issuance ?? null });
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
}
const policyFile = () => existsSync(childPolicyPath()) ? readFileSync(childPolicyPath(), "utf8") : null;

describe("GET/PUT /api/link/children/policy", () => {
  test("a fresh Home answers the defaults; PUT changes one knob and the next GET shows it", async () => {
    const call = harness();
    expect(await call("GET")).toEqual({ status: 200, body: { policy: DEFAULTS, warning: null } });
    expect(await call("PUT", { updates: "off" })).toEqual({ status: 200, body: { policy: { ...DEFAULTS, updates: "off" }, warning: null } });
    expect(await call("GET")).toEqual({ status: 200, body: { policy: { ...DEFAULTS, updates: "off" }, warning: null } });
    expect(JSON.parse(policyFile()!)).toEqual({ schema: "ocx.link.child-policy/1", ...DEFAULTS, updates: "off" });
  });

  test("an invalid file is reported fail-closed until a save", async () => {
    const call = harness();
    writeFileSync(childPolicyPath(), "{");
    expect(await call("GET")).toEqual({ status: 200, body: { policy: { ...DEFAULTS, catalogFanout: "manual", updates: "off" }, warning: "policy-file-invalid" } });
    expect((await call("PUT", { catalogFanout: "auto" })).body).toEqual({ policy: { ...DEFAULTS, updates: "off" }, warning: null });
  });

  test("bodies: empty, unknown key, bad value, non-object ⇒ 400 and the file unchanged", async () => {
    const call = harness();
    for (const body of [{}, { updates: "off", extra: 1 }, { idleAfterMs: 59_999 }, { catalogFanout: "sometimes" }, [], "null", "{"]) {
      const response = await call("PUT", body);
      expect(response.status).toBe(400);
      expect((response.body.error as { code: string }).code).toBe("invalid_body");
    }
    expect(policyFile()).toBeNull();
  });

  test("other methods on the path are 404", async () => {
    const call = harness();
    for (const method of ["POST", "DELETE"]) expect((await call(method, { updates: "off" })).status).toBe(404);
    expect(policyFile()).toBeNull();
  });

  test("a write failure is 503 policy_write_failed", async () => {
    const call = harness();
    mkdirSync(join(childPolicyPath(), "blocker"), { recursive: true });   // a directory where the file goes
    const response = await call("PUT", { updates: "off" });
    expect(response.status).toBe(503);
    expect((response.body.error as { code: string }).code).toBe("policy_write_failed");
  });
});

describe("authorization", () => {
  const refuse = async (call: ReturnType<typeof harness>, options: CallOptions, status: number, code: string | null) => {
    const response = await call("PUT", { updates: "off" }, options);
    expect(response.status).toBe(status);
    if (code) expect((response.body.error as { code: string }).code).toBe(code);
    expect(policyFile()).toBeNull();
  };

  test("admitted: admin token on loopback, a paired dashboard session, a current loopback session on a standalone runtime", async () => {
    expect((await harness()("PUT", { updates: "notify" })).status).toBe(200);
    expect((await harness()("PUT", { updates: "off" }, { principal: "gui-session", issuance: "pairing" })).status).toBe(200);
    expect((await harness("standalone")("PUT", { updates: "auto-when-idle" }, { principal: "gui-session", issuance: "loopback", paired: false })).status).toBe(200);
  });

  test("refused with the file unchanged", async () => {
    await refuse(harness(), { principal: "gui-session", issuance: "tailscale-identity" }, 403, "tailscale_session_refused");
    await refuse(harness(), { principal: "admin-token", trustedLoopback: false }, 403, "forbidden");
    // A session the dashboard session control does not accept as current (a PUT without the CSRF token).
    await refuse(harness("standalone"), { principal: "gui-session", issuance: "loopback", paired: false, current: false }, 403, "forbidden");
    // An unpaired session on a Home is never a dashboard session.
    await refuse(harness(), { principal: "gui-session", issuance: "loopback", paired: false }, 403, "forbidden");
    await refuse(harness("standalone"), { principal: "gui-session", issuance: "loopback", paired: false, origin: "https://attacker.example" }, 403, null);
    await refuse(harness(), { principal: null }, 403, "forbidden");
  });

  test("a Child runtime refuses PUT with runtime_role_client and still answers GET", async () => {
    const call = harness("client");
    await refuse(call, {}, 409, "runtime_role_client");
    expect(await call("GET")).toEqual({ status: 200, body: { policy: DEFAULTS, warning: null } });
  });
});
