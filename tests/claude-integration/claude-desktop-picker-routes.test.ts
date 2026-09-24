import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDesktopPickerProfile, inspectDesktopPickerProfile } from "../../src/claude/desktop-picker-profile";
import { pickerCaCertPath, pickerCaFingerprints } from "../../src/claude/intercept/picker-ca";
import type { PickerListenerOptions } from "../../src/claude/intercept/picker-listener";
import { createPickerRuntime } from "../../src/claude/intercept/picker-runtime";
import type { SecurityRunner } from "../../src/claude/intercept/picker-trust";
import { getClaudePickerRuntime, startClaudeIntercept, type ClaudeInterceptHandle } from "../../src/claude/intercept/runtime";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// End to end over the management routes: a real picker runtime and controller behind the
// dedicated egress proxy, with the keychain, the claude.ai listener and discovery faked.

let root = "";
let handle: ClaudeInterceptHandle | null = null;
const previous: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENCODEX_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;
const LISTENER_PORT = 45_679;
const INTERCEPT = { kind: "intercept", port: LISTENER_PORT };
const BLIND = { kind: "blind" };

function config(extra: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...extra } as OcxConfig;
}

function persisted(): OcxConfig {
  return JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
}

const keychain = { trusted: false, calls: [] as string[] };
const security: SecurityRunner = async args => {
  keychain.calls.push(args[0]!);
  switch (args[0]) {
    case "find-certificate": {
      if (!keychain.trusted) return { code: 1, stdout: "", stderr: "" };
      const { sha1 } = pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8"));
      return { code: 0, stdout: `SHA-1 hash: ${sha1}\n`, stderr: "" };
    }
    case "verify-cert": return { code: keychain.trusted ? 0 : 1, stdout: "", stderr: "" };
    case "add-trusted-cert": keychain.trusted = true; return { code: 0, stdout: "", stderr: "" };
    case "remove-trusted-cert": keychain.trusted = false; return { code: 0, stdout: "", stderr: "" };
    default: return { code: 0, stdout: "", stderr: "" };
  }
};

async function canBind(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    if (await canBind(port) && await canBind(port + 1)) return port;
  }
  throw new Error("no free port pair");
}

/** Start the intercept pair with picker mode wired, as the server lifecycle does. */
async function startPicker(saved: OcxConfig): Promise<number> {
  writeFileSync(join(root, "config.json"), JSON.stringify(saved));
  const port = await freePortPair();
  handle = await startClaudeIntercept({
    config: config({ claudeCode: { intercept: { port } } }),
    publicPort: 10100,
    configDir: root,
    dispatch: async () => new Response("unused"),
    loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [{ provider: "xai", id: "grok-4.7", contextWindow: 256_000 }] }),
    pickerSecurity: security,
    pickerPlatform: "darwin",
    createPicker: options => createPickerRuntime({
      ...options,
      startListener: (async (_: PickerListenerOptions) => ({ port: LISTENER_PORT, close: async () => {} })) as never,
      trustTtlMs: 0,
      refreshIntervalMs: 3_600_000,
    }),
  });
  return port;
}

async function dispatch(path: string, init: RequestInit = {}, deps: Parameters<typeof handleManagementAPI>[3] = {}) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const response = await handleManagementAPI(new Request(url, {
    ...init,
    headers: { Host: url.host, "Content-Type": "application/json", ...(init.headers ?? {}) },
  }), url, persisted(), deps);
  return { status: response!.status, body: await response!.json() as Record<string, any> };
}

const put = (body: unknown) => dispatch("/api/claude-desktop/picker", { method: "PUT", body: JSON.stringify(body) });
const decision = () => getClaudePickerRuntime()!.selectTunnel("claude.ai", 443);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-picker-routes-"));
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  process.env.OPENCODEX_HOME = root;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop-library");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  keychain.trusted = false;
  keychain.calls = [];
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  removeTreeWithRetry(root);
});

describe("first-party turns picker mode on by default", () => {
  test("management first-party apply from an explicit gateway marker arms claude.ai, and gateway apply disarms it", async () => {
    const port = await startPicker(config({ claudeCode: { desktopMode: "gateway" } }));
    expect(decision()).toEqual(BLIND);

    const applied = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) });
    expect(applied.status).toBe(200);
    expect(applied.body.picker).toMatchObject({ effective: true, reason: "restart_required", trust: "trusted", profile: "applied" });
    expect(decision()).toEqual(INTERCEPT);
    expect(inspectDesktopPickerProfile()).toMatchObject({ kind: "applied", proxyUrl: `http://127.0.0.1:${port + 1}` });
    expect(keychain.trusted).toBe(true);
    expect(persisted().claudeCode?.intercept?.picker).toBeUndefined();

    const status = await dispatch("/api/claude-desktop/status");
    expect(status.body.firstParty.picker).toMatchObject({ effective: true, profile: "applied" });

    const gateway = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) }, { fetchAllModels: async () => [] });
    expect(gateway.status).toBe(200);
    expect(decision()).toEqual(BLIND);
    await getClaudePickerRuntime()!.refresh();
    expect(decision()).toEqual(BLIND);
    expect(inspectDesktopPickerProfile().kind).toBe("absent");
    expect(keychain.trusted).toBe(false);
    // Mode-transition cleanup never writes the preference: returning to first-party re-enables.
    expect(persisted().claudeCode?.intercept?.picker).toBeUndefined();
  });

  test("native OFF to ON on a server that started with the integration off arms claude.ai; native OFF disarms", async () => {
    await startPicker(config({ clientIntegrations: { "claude-desktop": false }, claudeCode: { desktopMode: "first-party" } }));
    expect(decision()).toEqual(BLIND);
    const on = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(200);
    expect(on.body.message).toContain("Picker mode is on");
    expect(decision()).toEqual(INTERCEPT);
    const off = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect(decision()).toEqual(BLIND);
    expect(inspectDesktopPickerProfile().kind).toBe("absent");
  });

  test("an explicit picker off is remembered, and picker on from it re-arms", async () => {
    await startPicker(config({ claudeCode: { desktopMode: "first-party" } }));
    expect((await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) })).status).toBe(200);
    expect(decision()).toEqual(INTERCEPT);

    const off = await put({ enabled: false, persist: true });
    expect(off.status).toBe(200);
    expect(off.body.picker.effective).toBe(false);
    expect(decision()).toEqual(BLIND);
    expect(persisted().claudeCode?.intercept?.picker).toBe(false);
    await getClaudePickerRuntime()!.refresh();
    expect(decision()).toEqual(BLIND);
    // A later first-party apply respects the remembered off.
    const again = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) });
    expect(again.body.picker.effective).toBe(false);
    expect(decision()).toEqual(BLIND);

    const on = await put({ enabled: true, persist: true });
    expect(on.status).toBe(200);
    expect(on.body.picker.effective).toBe(true);
    expect(persisted().claudeCode?.intercept?.picker).toBe(true);
    expect(decision()).toEqual(INTERCEPT);
    expect((await dispatch("/api/claude-desktop/picker")).body.picker).toMatchObject({ effective: true });
  });

  test("callerAddedTrust reaches the controller: a refused CLI enable has its trust removed under the lock", async () => {
    await startPicker(config({ claudeCode: { desktopMode: "gateway" } }));
    // The CLI's trust step already ran; the server refuses because Desktop is not first-party.
    await dispatch("/api/claude-desktop/picker");
    keychain.trusted = true;
    const refused = await put({ enabled: true, persist: false, trustedLocally: true, callerAddedTrust: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ ok: false, code: "picker_enable_refused", reason: "mode_not_committed" });
    expect(refused.body.picker.effective).toBe(false);
    expect(keychain.calls).toContain("remove-trusted-cert");
    expect(keychain.trusted).toBe(false);
  });
});

describe("without a running picker controller", () => {
  test("status is offline, enabling is refused, and off persists and cleans up locally", async () => {
    writeFileSync(join(root, "config.json"), JSON.stringify(config({ claudeCode: { desktopMode: "first-party" } })));
    const status = await dispatch("/api/claude-desktop/picker");
    // Off macOS the offline status says why first: picker mode is macOS-only.
    expect(status.body.picker).toMatchObject({
      effective: false,
      reason: process.platform === "darwin" ? "proxy_unavailable" : "unsupported_platform",
    });
    const on = await put({ enabled: true, persist: true });
    expect(on.status).toBe(503);
    expect(on.body.code).toBe("picker_proxy_unavailable");
    expect(persisted().claudeCode?.intercept?.picker).toBeUndefined();
    expect(applyDesktopPickerProfile({ proxyPort: 45_001 }).ok).toBe(true);
    const off = await put({ enabled: false, persist: true });
    expect(off.status).toBe(200);
    expect(persisted().claudeCode?.intercept?.picker).toBe(false);
    expect(inspectDesktopPickerProfile().kind).toBe("absent");
  });

  test("first-party apply still succeeds and reports the picker as unavailable", async () => {
    writeFileSync(join(root, "config.json"), JSON.stringify(config()));
    const applied = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ mode: "first-party", applied: true, picker: { effective: false, reason: "proxy_unavailable" } });
  });

  test("gateway apply and native disable remove a leftover picker row", async () => {
    writeFileSync(join(root, "config.json"), JSON.stringify(config({ claudeCode: { intercept: { enabled: false } } })));
    expect(applyDesktopPickerProfile({ proxyPort: 45_001 }).ok).toBe(true);
    const off = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect(inspectDesktopPickerProfile().kind).toBe("absent");

    expect(applyDesktopPickerProfile({ proxyPort: 45_001 }).ok).toBe(true);
    const gateway = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) }, { fetchAllModels: async () => [] });
    expect(gateway.status).toBe(200);
    expect(inspectDesktopPickerProfile().kind).toBe("absent");
  });

  test("the picker route rejects unknown fields and non-boolean values", async () => {
    writeFileSync(join(root, "config.json"), JSON.stringify(config()));
    expect((await put({ enabled: true, persist: true, extra: 1 })).status).toBe(400);
    expect((await put({ enabled: "yes", persist: true })).status).toBe(400);
    expect((await put({ enabled: true })).status).toBe(400);
    expect((await put({ enabled: false, persist: false, callerAddedTrust: "no" })).status).toBe(400);
  });
});
