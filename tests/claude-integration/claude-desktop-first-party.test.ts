import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDesktopFirstParty,
  inspectDesktopFirstParty,
  removeDesktopFirstParty,
  resolveClaudeDesktopApplyMode,
  resolveClaudeDesktopMode,
} from "../../src/claude/desktop-first-party";
import { applyDesktop, parseDesktopApplyArgs } from "../../src/cli/claude-desktop";
import { inspectDesktop3pConfigLibrary, removeDesktop3pStandardPivot } from "../../src/claude/desktop-3p";
import { ensureClaudeDesktopMatchesDesired } from "../../src/cli/ensure-desired-integrations";
import { handleManagementAPI } from "../../src/server/management-api";
import { setIntegrationEnabled } from "../../src/codex/desired-state";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let library = "";
let claudeDir = "";
const previous: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENCODEX_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;

function config(extra: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...extra } as OcxConfig;
}

function settings(): { env?: Record<string, string>; [key: string]: unknown } {
  return JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as { env?: Record<string, string> };
}

async function dispatch(path: string, init?: RequestInit, inputConfig: OcxConfig = config(), deps: Parameters<typeof handleManagementAPI>[3] = {}) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const response = await handleManagementAPI(new Request(url, {
    ...init,
    headers: { Host: url.host, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  }), url, inputConfig, deps);
  return { status: response!.status, body: await response!.json() as Record<string, any> };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-desktop-1p-"));
  library = join(root, "desktop-library");
  claudeDir = join(root, "claude");
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  process.env.OPENCODEX_HOME = root;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  writeFileSync(join(root, "config.json"), JSON.stringify(config()));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  removeTreeWithRetry(root);
});

test("mode resolution: explicit wins, applied gateway fingerprint keeps gateway, otherwise first-party", () => {
  expect(resolveClaudeDesktopMode(config())).toBe("first-party");
  expect(resolveClaudeDesktopMode(config({ claudeCode: { desktopMode: "gateway" } }))).toBe("gateway");
  expect(resolveClaudeDesktopMode(config({
    claudeCode: { desktopProfile: { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null }, appliedFingerprint: "abc" } },
  }))).toBe("gateway");
  expect(resolveClaudeDesktopMode(config({
    claudeCode: {
      desktopMode: "first-party",
      desktopProfile: { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null }, appliedFingerprint: "abc" },
    },
  }))).toBe("first-party");
});

test("implied apply mode falls back to gateway where the intercept proxy cannot run", () => {
  expect(resolveClaudeDesktopApplyMode(config())).toBe("first-party");
  expect(resolveClaudeDesktopApplyMode(config({ runtimeRole: "client" }))).toBe("gateway");
  expect(resolveClaudeDesktopApplyMode(config({ claudeCode: { intercept: { enabled: false } } }))).toBe("gateway");
  // An explicit choice is never silently rewritten.
  expect(resolveClaudeDesktopApplyMode(config({ runtimeRole: "client", claudeCode: { desktopMode: "first-party" } }))).toBe("first-party");
});

test("CLI apply flags: default first-party, legacy shape flags imply gateway, conflicts rejected", () => {
  expect(parseDesktopApplyArgs([], config())).toEqual({ target: { kind: "first-party" } });
  expect(parseDesktopApplyArgs(["--first-party"], config())).toEqual({ target: { kind: "first-party" } });
  expect(parseDesktopApplyArgs(["--gateway"], config())).toEqual({ target: { kind: "gateway", mode: "static" } });
  expect(parseDesktopApplyArgs(["--hybrid"], config())).toEqual({ target: { kind: "gateway", mode: "hybrid" } });
  expect(parseDesktopApplyArgs(["--gateway", "--discovery-only"], config())).toEqual({ target: { kind: "gateway", mode: "discovery" } });
  expect(parseDesktopApplyArgs([], config({ claudeCode: { desktopMode: "gateway" } }))).toEqual({ target: { kind: "gateway", mode: "static" } });
  expect("error" in parseDesktopApplyArgs(["--first-party", "--gateway"], config())).toBe(true);
  expect("error" in parseDesktopApplyArgs(["--first-party", "--static"], config())).toBe(true);
  expect("error" in parseDesktopApplyArgs(["--bogus"], config())).toBe(true);
});

test("first-party apply writes only the proxy env, creates the CA, and removes cleanly", () => {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ theme: "dark", env: { FOO: "bar" } }));
  const applied = applyDesktopFirstParty(config());
  expect(applied.ok).toBe(true);
  if (!applied.ok) return;
  expect(applied.proxyPort).toBe(10200);
  expect(existsSync(applied.env.NODE_EXTRA_CA_CERTS)).toBe(true);
  expect(applied.env.NODE_EXTRA_CA_CERTS.startsWith(root)).toBe(true);
  const written = settings();
  expect(written.theme).toBe("dark");
  expect(written.env).toEqual({
    FOO: "bar",
    HTTPS_PROXY: "http://127.0.0.1:10200",
    NODE_EXTRA_CA_CERTS: applied.env.NODE_EXTRA_CA_CERTS,
  });
  expect(inspectDesktopFirstParty(config()).applied).toBe(true);
  // Desktop's own library is untouched: first-party never installs a gateway profile.
  expect(existsSync(library)).toBe(false);

  // A port change makes the env stale; re-apply refreshes it.
  expect(inspectDesktopFirstParty(config({ port: 10300 })).stale).toBe(true);
  const refreshed = applyDesktopFirstParty(config({ port: 10300 }));
  expect(refreshed.ok && refreshed.changed).toBe(true);
  expect(settings().env?.HTTPS_PROXY).toBe("http://127.0.0.1:10400");

  const removed = removeDesktopFirstParty();
  expect(removed).toMatchObject({ ok: true, changed: true });
  expect(settings()).toEqual({ theme: "dark", env: { FOO: "bar" } });
});

test("first-party apply refuses foreign proxy env and disabled intercept", () => {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } }));
  expect(applyDesktopFirstParty(config())).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(settings().env).toEqual({ HTTPS_PROXY: "http://corp-proxy:3128" });
  expect(removeDesktopFirstParty()).toMatchObject({ ok: true, changed: false });
  expect(applyDesktopFirstParty(config({ runtimeRole: "client" }))).toMatchObject({ ok: false, reason: "intercept_disabled" });
});

test("POST /api/claude-desktop/apply defaults to first-party and gateway mode replaces it", async () => {
  const first = await dispatch("/api/claude-desktop/apply", { method: "POST" });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ ok: true, mode: "first-party", applied: true, changed: true, proxyPort: 10200 });
  expect(settings().env?.HTTPS_PROXY).toBe("http://127.0.0.1:10200");
  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(saved.claudeCode?.desktopMode).toBe("first-party");
  expect(saved.clientIntegrations?.["claude-desktop"]).not.toBe(false);

  const status = await dispatch("/api/claude-desktop/status");
  expect(status.body).toMatchObject({
    mode: "first-party",
    applied: true,
    stale: false,
    drift: false,
    firstParty: { applied: true, interceptEnabled: true, proxyPort: 10200 },
  });
  expect(status.body.health.ok).toBe(true);

  const gateway = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) });
  expect(gateway.status).toBe(200);
  expect(settings().env?.HTTPS_PROXY).toBeUndefined();
  expect(settings().env?.NODE_EXTRA_CA_CERTS).toBeUndefined();
  const afterGateway = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(afterGateway.claudeCode?.desktopMode).toBe("gateway");
  expect(afterGateway.claudeCode?.desktopProfile?.appliedFingerprint).toBeTruthy();

  // Switching back replaces the gateway profile with the first-party env in one apply.
  const back = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) }, afterGateway);
  expect(back.status).toBe(200);
  expect(back.body).toMatchObject({ ok: true, mode: "first-party", applied: true, gatewayRemoved: true });
  expect(settings().env?.HTTPS_PROXY).toBe("http://127.0.0.1:10200");
  const afterBack = await dispatch("/api/claude-desktop/status", {}, afterGateway);
  expect(afterBack.body).toMatchObject({ mode: "first-party", applied: true, stale: false, drift: false, desiredEnabled: true });
  expect(["not_installed", "no_owned_state", "standard"]).toContain(afterBack.body.observedKind);
  // The gateway apply marker goes with the profile: without the explicit mode field the
  // saved config must still resolve to first-party, not to the gateway it just replaced.
  const savedBack = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(savedBack.claudeCode?.desktopProfile?.appliedFingerprint).toBeUndefined();
  expect(savedBack.claudeCode?.desktopProfile?.appliedAt).toBeUndefined();
  expect(savedBack.claudeCode?.desktopProfile?.assignments).toBeDefined();
  expect(resolveClaudeDesktopMode({ claudeCode: { ...savedBack.claudeCode, desktopMode: undefined } })).toBe("first-party");
});

test("native toggle: enable applies first-party by default and disable removes the env", async () => {
  const enabled = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  expect(enabled.status).toBe(200);
  expect(enabled.body).toMatchObject({ ok: true, changed: true, state: "current", desiredEnabled: true });
  expect(settings().env?.HTTPS_PROXY).toBe("http://127.0.0.1:10200");

  const list = await dispatch("/api/native-integrations");
  const desktop = (list.body.clients as Array<{ clientId: string; state: string }>).find(client => client.clientId === "claude-desktop");
  expect(desktop?.state).toBe("current");

  const disabled = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  expect(disabled.status).toBe(200);
  expect(disabled.body).toMatchObject({ ok: true, changed: true, state: "absent", desiredEnabled: false });
  expect(settings().env?.HTTPS_PROXY).toBeUndefined();
});

test("native toggle: enabling into explicit first-party pivots an applied gateway profile and saves the mode marker", async () => {
  const gateway = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) });
  expect(gateway.status).toBe(200);
  const afterGateway = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(afterGateway.claudeCode?.desktopProfile?.appliedFingerprint).toBeTruthy();
  // The operator chose first-party in config while the gateway profile is still on disk.
  const chosen = { ...afterGateway, claudeCode: { ...afterGateway.claudeCode, desktopMode: "first-party" as const } };
  writeFileSync(join(root, "config.json"), JSON.stringify(chosen));

  const enabled = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: true }) }, chosen);
  expect(enabled.status).toBe(200);
  expect(enabled.body).toMatchObject({ ok: true, changed: true, state: "current", desiredEnabled: true });
  expect(settings().env?.HTTPS_PROXY).toBe("http://127.0.0.1:10200");
  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(saved.claudeCode?.desktopMode).toBe("first-party");
  expect(saved.claudeCode?.desktopProfile?.appliedFingerprint).toBeUndefined();
  const status = await dispatch("/api/claude-desktop/status", {}, chosen);
  expect(status.body).toMatchObject({ mode: "first-party", applied: true, drift: false });
  expect(["not_installed", "no_owned_state", "standard"]).toContain(status.body.observedKind);
});

test("native toggle: enabling into gateway saves the gateway mode marker like the apply route", async () => {
  // No explicit mode: the disabled intercept is what implies gateway, so the saved marker
  // can only come from the toggle itself.
  const chosen = config({ claudeCode: { intercept: { enabled: false } } });
  writeFileSync(join(root, "config.json"), JSON.stringify(chosen));
  const enabled = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: true }) }, chosen);
  expect(enabled.status).toBe(200);
  expect(enabled.body).toMatchObject({ ok: true, state: "current", message: "Claude Desktop integration enabled." });
  expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);
  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(saved.claudeCode?.desktopMode).toBe("gateway");
  expect(resolveClaudeDesktopMode(saved)).toBe("gateway");
});

test("ensure warns instead of touching a gateway profile that contradicts an explicit first-party marker", () => {
  const logs: string[] = [];
  const deps = {
    loadConfig: () => config({ claudeCode: { desktopMode: "first-party" } }),
    stripGrokConfig: () => ({ ok: true, changed: false, message: "" }),
    syncGrokConfig: async () => ({ ok: true, changed: false, message: "" }),
    removeDesktop3pStandardPivot: () => { throw new Error("must not pivot from ensure"); },
    inspectDesktop3pConfigLibrary: () => ({ kind: "gateway_ours" as const, libraryPath: library, activeProfilePath: null, ownedFiles: [] }),
    applyDesktopFirstParty: () => { throw new Error("must not apply over a live gateway"); },
    log: (message: string) => { logs.push(message); },
    error: (message: string) => { logs.push(message); },
  };
  ensureClaudeDesktopMatchesDesired(deps as unknown as Parameters<typeof ensureClaudeDesktopMatchesDesired>[0]);
  expect(logs.some(line => line.includes("gateway profile is still applied"))).toBe(true);
});

test("ensure reconciles first-party env: refreshes when ON and stale, removes when OFF", () => {
  const applied = applyDesktopFirstParty(config({ port: 10300 }));
  expect(applied.ok).toBe(true);
  expect(settings().env?.HTTPS_PROXY).toBe("http://127.0.0.1:10400");

  const logs: string[] = [];
  const deps = {
    loadConfig: () => config(),
    stripGrokConfig: () => ({ ok: true, changed: false, message: "" }),
    syncGrokConfig: async () => ({ ok: true, changed: false, message: "" }),
    removeDesktop3pStandardPivot: () => ({ ok: true as const, changed: false, kind: "noop" as const, libraryPath: library }),
    log: (message: string) => { logs.push(message); },
    error: (message: string) => { logs.push(message); },
  };
  ensureClaudeDesktopMatchesDesired(deps);
  expect(settings().env?.HTTPS_PROXY).toBe("http://127.0.0.1:10200");
  expect(logs.some(line => line.includes("first-party env refreshed"))).toBe(true);

  expect(setIntegrationEnabled("claude-desktop", false).ok).toBe(true);
  ensureClaudeDesktopMatchesDesired({ ...deps, loadConfig: () => config({ clientIntegrations: { "claude-desktop": false } }) });
  expect(settings().env?.HTTPS_PROXY).toBeUndefined();
  expect(settings().env?.NODE_EXTRA_CA_CERTS).toBeUndefined();
});

for (const surface of ["cli", "api"] as const) {
  for (const failure of ["intercept_disabled", "foreign_env", "unreadable", "ca_unavailable"] as const) {
    test(`${surface} failed first-party ${failure} leaves the gateway profile active`, async () => {
      const gateway = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) });
      expect(gateway.status).toBe(200);
      const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
      const appliedFingerprint = saved.claudeCode!.desktopProfile!.appliedFingerprint!;
      const before = inspectDesktop3pConfigLibrary({ appliedFingerprint });
      expect(before.kind).toBe("gateway_ours");
      if (failure === "intercept_disabled") {
        saved.claudeCode = { ...saved.claudeCode, intercept: { enabled: false } };
        writeFileSync(join(root, "config.json"), JSON.stringify(saved));
      } else if (failure === "ca_unavailable") {
        writeFileSync(join(root, "claude-intercept"), "not a directory");
      } else {
        mkdirSync(claudeDir, { recursive: true });
        writeFileSync(join(claudeDir, "settings.json"), failure === "unreadable"
          ? "{broken" : JSON.stringify({ env: { HTTPS_PROXY: "http://corporate.example:3128" } }));
      }
      if (surface === "cli") {
        expect(await applyDesktop(undefined, { kind: "first-party" })).toMatchObject({ ok: false, reason: failure });
      } else {
        const reply = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) }, saved);
        expect(reply.body.reason).toBe(failure);
      }
      expect(inspectDesktop3pConfigLibrary({ appliedFingerprint })).toEqual(before);
    });
  }
}

test("CLI gateway apply refusal leaves the first-party connection intact", async () => {
  expect(applyDesktopFirstParty(config()).ok).toBe(true);
  const before = settings();
  const result = await applyDesktop(undefined, { kind: "gateway", mode: "static" }, {
    findLiveProxyImpl: async () => ({ pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime" }),
    postApplyImpl: async () => ({ ok: false, error: "replacement_refused" }),
  });
  expect(result).toMatchObject({ ok: false, reason: "replacement_refused" });
  expect(settings()).toEqual(before);
});

test("a refused gateway cleanup restores the previous settings env", async () => {
  expect((await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) })).status).toBe(200);
  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  mkdirSync(claudeDir, { recursive: true });
  const before = { theme: "dark", env: { FOO: "keep" } };
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(before));
  const result = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) }, saved, {
    removeDesktop3pStandardPivot: () => ({ ok: false, changed: false, kind: "unsafe", libraryPath: library, reason: "metadata_unreadable" }),
  });
  expect(result.status).toBe(409);
  expect(result.body.code).toBe("claude_desktop_gateway_removal_failed");
  expect(settings()).toEqual(before);
  expect(inspectDesktop3pConfigLibrary({ appliedFingerprint: saved.claudeCode!.desktopProfile!.appliedFingerprint }).kind).toBe("gateway_ours");
});

test("a completed standard pivot keeps first-party active when credential cleanup is incomplete", async () => {
  expect((await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) })).status).toBe(200);
  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  const result = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) }, saved, {
    removeDesktop3pStandardPivot: options => {
      const pivot = removeDesktop3pStandardPivot(options);
      expect(pivot.ok && pivot.changed).toBe(true);
      return { ok: false, changed: true, kind: "cleanup_incomplete", libraryPath: library, residualPaths: ["fixture-residue"] };
    },
  });
  expect(result.status).toBe(500);
  expect(result.body.reason).toBe("cleanup_incomplete");
  expect(inspectDesktopFirstParty(config()).applied).toBe(true);
  const after = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(after.claudeCode?.desktopMode).toBe("first-party");
  expect(after.claudeCode?.desktopProfile?.appliedFingerprint).toBeUndefined();
});
