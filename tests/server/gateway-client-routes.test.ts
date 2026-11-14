import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { GatewayClientContext } from "../../src/integrations/gateway-clients";
import type { OcxConfig } from "../../src/types";

let root: string;
let gateway: GatewayClientContext;
const settings = () => join(gateway.home, ".antigravity", "settings.json");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-gw-routes-"));
  mkdirSync(join(root, "home"));
  gateway = { home: join(root, "home"), platform: "linux", env: { SHELL: "/bin/bash" }, stateDir: join(root, "state"), adminSettingsPath: join(root, "admin_settings.json") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = (extra: Partial<OcxConfig> = {}): OcxConfig => ({ port: 10100, defaultProvider: "alpha", providers: {}, ...extra } as OcxConfig);

async function call(method: string, path: string, body?: unknown, c: OcxConfig = config(), headers: Record<string, string> = {}) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { host: "localhost", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, new URL(req.url), c, { gatewayClientContext: () => gateway, liveListenPort: () => 10100 });
  return { status: response?.status, json: (await response?.json()) as any };
}

describe("gateway client management routes", () => {
  test("status lists both clients, connect writes the fake home, disconnect restores it", async () => {
    const initial = await call("GET", "/api/gateway-clients");
    expect(initial.status).toBe(200);
    expect(initial.json.clients.map((c: { id: string; state: string }) => `${c.id}:${c.state}`)).toEqual(["antigravity:disconnected", "agy:disconnected"]);

    const connected = await call("POST", "/api/gateway-clients/antigravity/connect", { model: "gemini-3" });
    expect(connected).toMatchObject({ status: 200, json: { ok: true, id: "antigravity", action: "connect", changed: true, changedFiles: [settings()], status: { state: "connected" } } });
    expect(JSON.parse(readFileSync(settings(), "utf8")).gateway.url).toBe("http://127.0.0.1:10100");

    const viaAgy = await call("POST", "/api/gateway-clients/agy/connect", {});
    expect(viaAgy.json).toMatchObject({ ok: true, id: "agy", status: { state: "connected" } });
    expect(readFileSync(join(gateway.home, ".bashrc"), "utf8")).toContain("agy() {");

    const status = await call("GET", "/api/gateway-clients");
    expect(status.json.clients.map((c: { state: string }) => c.state)).toEqual(["connected", "connected"]);

    const off = await call("POST", "/api/gateway-clients/antigravity/disconnect");
    expect(off).toMatchObject({ status: 200, json: { ok: true, action: "disconnect", restore: "exact", status: { state: "disconnected" } } });
    expect(existsSync(join(gateway.home, ".antigravity"))).toBe(false);
    expect((await call("POST", "/api/gateway-clients/agy/disconnect")).json.restore).toBe("exact");
    expect(existsSync(join(gateway.home, ".bashrc"))).toBe(false);
  });

  test("refusals are 409 with a code and write nothing", async () => {
    const lan = config({ hostname: "100.64.0.9" });
    const admission = await call("POST", "/api/gateway-clients/antigravity/connect", {}, lan);
    expect(admission).toMatchObject({ status: 409, json: { ok: false, code: "requires-admission-token" } });
    const model = await call("POST", "/api/gateway-clients/antigravity/connect", { model: "a\nb" });
    expect(model).toMatchObject({ status: 409, json: { ok: false, code: "invalid-model" } });
    mkdirSync(join(gateway.home, ".antigravity"));
    writeFileSync(settings(), '{\n  // note\n}\n');
    const unsupported = await call("POST", "/api/gateway-clients/antigravity/connect", {});
    expect(unsupported).toMatchObject({ status: 409, json: { ok: false, code: "unsupported-file" } });
    expect(readFileSync(settings(), "utf8")).toBe('{\n  // note\n}\n');
  });

  test("unknown ids are 404 and malformed bodies 400", async () => {
    expect(await call("POST", "/api/gateway-clients/nope/connect", {})).toMatchObject({ status: 404, json: { ok: false, code: "unknown-client" } });
    expect(await call("POST", "/api/gateway-clients/antigravity/connect", { model: 7 })).toMatchObject({ status: 400, json: { code: "invalid-body" } });
    expect(await call("POST", "/api/gateway-clients/antigravity/connect", [1])).toMatchObject({ status: 400 });
  });

  test("a cross-origin mutation is blocked before the handler runs", async () => {
    const blocked = await call("POST", "/api/gateway-clients/antigravity/connect", {}, config(), { origin: "https://evil.example" });
    expect(blocked.status).toBe(403);
    expect(existsSync(join(gateway.home, ".antigravity"))).toBe(false);
  });
});
