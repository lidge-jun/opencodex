import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { persistCommittedDesktopGateway } from "../../src/claude/desktop-gateway-state";
import { armClaudeCodeBaseline, saveConfigPreservingClaudeCode } from "../../src/config";
import { ensureClaudeDesktopMatchesDesired } from "../../src/cli/ensure-desired-integrations";
import { claudeInterceptCaCertPath } from "../../src/claude/intercept/local-ca";
import { claudeInterceptProxyTokenPath, readClaudeInterceptProxyToken } from "../../src/claude/intercept/proxy-auth";
import { claudeInterceptProxyUrl } from "../../src/claude/intercept/settings";
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

function expectedProxyUrl(port: number): string {
  const token = readClaudeInterceptProxyToken(root);
  if (token === null) throw new Error("expected the proxy token to exist");
  return claudeInterceptProxyUrl(port, token);
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

test("mode resolution: explicit wins, owned disk state keeps what runs, otherwise gateway", () => {
  expect(resolveClaudeDesktopMode(config())).toBe("gateway");
  expect(resolveClaudeDesktopMode(config({ claudeCode: { desktopMode: "first-party" } }))).toBe("first-party");
  expect(resolveClaudeDesktopMode(config({ claudeCode: { desktopMode: "gateway" } }))).toBe("gateway");
  // An install that predates the field keeps the first-party env opencodex wrote for it...
  expect(resolveClaudeDesktopMode(config(), { ownedFirstPartySettings: true })).toBe("first-party");
  // ...unless Desktop has our gateway row selected, which is what the app actually runs.
  expect(resolveClaudeDesktopMode(config(), { ownedGatewaySelected: true, ownedFirstPartySettings: true })).toBe("gateway");
  expect(resolveClaudeDesktopMode(config({ claudeCode: { desktopMode: "gateway" } }), { ownedFirstPartySettings: true })).toBe("gateway");
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

test("implied apply mode is gateway and never rewrites an explicit or observed first-party choice", () => {
  expect(resolveClaudeDesktopApplyMode(config())).toBe("gateway");
  expect(resolveClaudeDesktopApplyMode(config({ runtimeRole: "client" }))).toBe("gateway");
  expect(resolveClaudeDesktopApplyMode(config({ claudeCode: { intercept: { enabled: false } } }))).toBe("gateway");
  // An explicit choice is never silently rewritten.
  expect(resolveClaudeDesktopApplyMode(config({ runtimeRole: "client", claudeCode: { desktopMode: "first-party" } }))).toBe("first-party");
  expect(resolveClaudeDesktopApplyMode(config({ claudeCode: { intercept: { enabled: false } } }), { ownedFirstPartySettings: true })).toBe("first-party");
});

test("CLI apply flags: default gateway, legacy shape flags imply gateway, conflicts rejected", () => {
  expect(parseDesktopApplyArgs([], config())).toEqual({ target: { kind: "gateway", mode: "static" } });
  expect(parseDesktopApplyArgs([], config({ claudeCode: { desktopMode: "first-party" } }))).toEqual({ target: { kind: "first-party" } });
  expect(parseDesktopApplyArgs([], config(), { ownedFirstPartySettings: true })).toEqual({ target: { kind: "first-party" } });
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
    HTTPS_PROXY: expectedProxyUrl(10200),
    NODE_EXTRA_CA_CERTS: applied.env.NODE_EXTRA_CA_CERTS,
  });
  expect(inspectDesktopFirstParty(config()).applied).toBe(true);
  // Desktop's own library is untouched: first-party never installs a gateway profile.
  expect(existsSync(library)).toBe(false);

  // A port change makes the env stale; re-apply refreshes it.
  expect(inspectDesktopFirstParty(config({ port: 10300 })).stale).toBe(true);
  const refreshed = applyDesktopFirstParty(config({ port: 10300 }));
  expect(refreshed.ok && refreshed.changed).toBe(true);
  expect(settings().env?.HTTPS_PROXY).toBe(expectedProxyUrl(10400));

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

test("POST /api/claude-desktop/apply defaults to gateway; first-party is explicit and carries the account-risk notice", async () => {
  const byDefault = await dispatch("/api/claude-desktop/apply", { method: "POST" });
  expect(byDefault.status).toBe(200);
  expect(byDefault.body.riskWarning).toBeUndefined();
  expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);
  const afterDefault = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(afterDefault.claudeCode?.desktopMode).toBe("gateway");
  expect(afterDefault.claudeCode?.desktopProfile?.appliedFingerprint).toBeTruthy();
  const gatewayStatus = await dispatch("/api/claude-desktop/status", {}, afterDefault);
  expect(gatewayStatus.body.mode).toBe("gateway");
  expect(gatewayStatus.body.riskWarning).toBeNull();

  const first = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) }, afterDefault);
  expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      mode: "first-party",
      applied: true,
      changed: true,
      proxyPort: 10200,
      gatewayRemoved: true,
      riskWarning: { code: "first_party_account_suspension_risk" },
    });
    expect(first.body.riskWarning.message).toContain("suspend the account");
    expect(settings().env?.HTTPS_PROXY).toBe(expectedProxyUrl(10200));
  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(saved.claudeCode?.desktopMode).toBe("first-party");
  expect(saved.clientIntegrations?.["claude-desktop"]).not.toBe(false);

  const status = await dispatch("/api/claude-desktop/status", {}, saved);
  expect(status.body).toMatchObject({
    mode: "first-party",
    applied: true,
    stale: false,
    drift: false,
    firstParty: { applied: true, interceptEnabled: true, proxyPort: 10200 },
    riskWarning: { code: "first_party_account_suspension_risk" },
  });
  expect(status.body.health.ok).toBe(true);

  const gateway = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) }, saved);
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
  expect(settings().env?.HTTPS_PROXY).toBe(expectedProxyUrl(10200));
  const afterBack = await dispatch("/api/claude-desktop/status", {}, afterGateway);
  expect(afterBack.body).toMatchObject({ mode: "first-party", applied: true, stale: false, drift: false, desiredEnabled: true });
  expect(["not_installed", "no_owned_state", "standard"]).toContain(afterBack.body.observedKind);
  // The gateway apply marker goes with the profile: without the explicit mode field the
  // saved config must still resolve to first-party, not to the gateway it just replaced.
  const savedBack = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(savedBack.claudeCode?.desktopProfile?.appliedFingerprint).toBeUndefined();
  expect(savedBack.claudeCode?.desktopProfile?.appliedAt).toBeUndefined();
  expect(savedBack.claudeCode?.desktopProfile?.assignments).toBeDefined();
  // With the gateway default, only the owned first-party env on disk keeps it first-party.
  expect(resolveClaudeDesktopMode({ claudeCode: { ...savedBack.claudeCode, desktopMode: undefined } })).toBe("gateway");
  expect(resolveClaudeDesktopMode({ claudeCode: { ...savedBack.claudeCode, desktopMode: undefined } }, { ownedFirstPartySettings: true })).toBe("first-party");
});

test("native toggle: enable applies gateway by default and never writes first-party env", async () => {
  const enabled = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  expect(enabled.status).toBe(200);
  expect(enabled.body).toMatchObject({ ok: true, state: "current", desiredEnabled: true });
  expect(enabled.body.message).not.toContain("suspend");
  expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);
  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(saved.claudeCode?.desktopMode).toBe("gateway");
});

test("native toggle: explicit first-party enable warns about the account risk and disable removes the env", async () => {
  const chosen = config({ claudeCode: { desktopMode: "first-party" } });
  writeFileSync(join(root, "config.json"), JSON.stringify(chosen));
  const enabled = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: true }) }, chosen);
  expect(enabled.status).toBe(200);
  expect(enabled.body).toMatchObject({ ok: true, changed: true, state: "current", desiredEnabled: true });
  expect(enabled.body.message).toContain("suspend the account");
  expect(settings().env?.HTTPS_PROXY).toBe(expectedProxyUrl(10200));

  const list = await dispatch("/api/native-integrations", {}, chosen);
  const desktop = (list.body.clients as Array<{ clientId: string; state: string }>).find(client => client.clientId === "claude-desktop");
  expect(desktop?.state).toBe("current");

  const disabled = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: false }) }, chosen);
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
  expect(settings().env?.HTTPS_PROXY).toBe(expectedProxyUrl(10200));
  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(saved.claudeCode?.desktopMode).toBe("first-party");
  expect(saved.claudeCode?.desktopProfile?.appliedFingerprint).toBeUndefined();
  const status = await dispatch("/api/claude-desktop/status", {}, chosen);
  expect(status.body).toMatchObject({ mode: "first-party", applied: true, drift: false });
  expect(["not_installed", "no_owned_state", "standard"]).toContain(status.body.observedKind);
});

test("native toggle: enabling into gateway saves the gateway mode marker like the apply route", async () => {
  // No explicit mode: gateway is the default, so the saved marker can only come from the
  // toggle itself.
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

test("ensure warns instead of touching a gateway profile that contradicts an explicit first-party marker", async () => {
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
  await ensureClaudeDesktopMatchesDesired(deps as unknown as Parameters<typeof ensureClaudeDesktopMatchesDesired>[0]);
  expect(logs.some(line => line.includes("gateway profile is still applied"))).toBe(true);
});

test("first-party apply rebases the Claude hand-edit guard after its scoped mode save", async () => {
  // First-party apply ends at the mode-marker write — no profile-marker save
  // follows — so unless that write adopts its committed subtree, live diverges
  // from the armed baseline and the next whole-config save stomps a hand edit.
  const snapshot = config({ claudeCode: { authMode: "subscription" } });
  writeFileSync(join(root, "config.json"), JSON.stringify(snapshot));
  armClaudeCodeBaseline(snapshot);

  const applied = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "first-party" }) }, snapshot);
  expect(applied.status).toBe(200);
  expect(applied.body).toMatchObject({ mode: "first-party", saved: true });

  const handEdited = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  handEdited.claudeCode = {
    ...handEdited.claudeCode,
    authMode: "proxy",
    anthropicBaseUrl: "http://127.0.0.1:19999",
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(handEdited));

  snapshot.disabledModels = ["unrelated/model"];
  saveConfigPreservingClaudeCode(snapshot);

  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(saved.claudeCode).toMatchObject({
    authMode: "proxy",
    anthropicBaseUrl: "http://127.0.0.1:19999",
    desktopMode: "first-party",
  });
  expect(saved.disabledModels).toEqual(["unrelated/model"]);
});

test("gateway apply rebases its committed subtree before a later hand edit", async () => {
  const snapshot = config({ claudeCode: { authMode: "subscription", nativePassthrough: true } });
  writeFileSync(join(root, "config.json"), JSON.stringify(snapshot));
  armClaudeCodeBaseline(snapshot);

  const applied = await dispatch("/api/claude-desktop/apply", {
    method: "POST",
    body: JSON.stringify({ mode: "gateway" }),
  }, snapshot, {
    fetchAllModels: async () => [],
    writeDesktop3pConfig: () => ({ written: true, path: join(library, "applied.json"), fingerprint: "gateway-fingerprint" }),
  });
  expect(applied).toMatchObject({ status: 200, body: { saved: true, fingerprint: "gateway-fingerprint" } });

  const handEdited = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  handEdited.claudeCode = {
    ...handEdited.claudeCode,
    authMode: "proxy",
    anthropicBaseUrl: "http://127.0.0.1:19999",
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(handEdited));

  snapshot.disabledModels = ["unrelated/model"];
  saveConfigPreservingClaudeCode(snapshot);

  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(saved.claudeCode).toMatchObject({
    authMode: "proxy",
    anthropicBaseUrl: "http://127.0.0.1:19999",
    desktopMode: "gateway",
    desktopProfile: { appliedFingerprint: "gateway-fingerprint" },
  });
  expect(saved.disabledModels).toEqual(["unrelated/model"]);
});

test("a deferred policy probe cannot restore an older gateway marker after a first-party apply", async () => {
  const snapshot = config({ claudeCode: { authMode: "subscription" } });
  writeFileSync(join(root, "config.json"), JSON.stringify(snapshot));
  armClaudeCodeBaseline(snapshot);
  let releaseProbe!: (state: "absent") => void;
  let enteredProbe!: () => void;
  const probeEntered = new Promise<void>(resolve => { enteredProbe = resolve; });
  const deferredProbe = new Promise<"absent">(resolve => { releaseProbe = resolve; });

  const gateway = dispatch("/api/claude-desktop/apply", {
    method: "POST",
    body: JSON.stringify({ mode: "gateway" }),
  }, snapshot, {
    fetchAllModels: async () => [],
    writeDesktop3pConfig: () => ({ written: true, path: join(library, "gateway.json"), fingerprint: "older-gateway" }),
    probeClaudeDesktopPolicy: async () => {
      enteredProbe();
      return deferredProbe;
    },
  });
  let released = false;
  try {
    await probeEntered;
    expect((JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig)
      .claudeCode?.desktopProfile?.appliedFingerprint).toBe("older-gateway");

    const firstParty = await dispatch("/api/claude-desktop/apply", {
      method: "POST",
      body: JSON.stringify({ mode: "first-party" }),
    }, snapshot);
    expect(firstParty).toMatchObject({ status: 200, body: { mode: "first-party", saved: true } });

    releaseProbe("absent");
    released = true;
    expect(await gateway).toMatchObject({ status: 200, body: { fingerprint: "older-gateway" } });
    const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
    expect(saved.claudeCode?.desktopMode).toBe("first-party");
    expect(saved.claudeCode?.desktopProfile?.appliedFingerprint).toBeUndefined();
  } finally {
    if (!released) releaseProbe("absent");
    await gateway;
  }
});

test("committed gateway adoption preserves a pending disjoint live Claude leaf", () => {
  const snapshot = config({ claudeCode: { authMode: "subscription", nativePassthrough: true } });
  writeFileSync(join(root, "config.json"), JSON.stringify(snapshot));
  armClaudeCodeBaseline(snapshot);
  snapshot.claudeCode!.nativePassthrough = false;

  const committed = persistCommittedDesktopGateway(snapshot, undefined, "gateway-fingerprint");

  expect(committed).toEqual({ ok: true });
  expect(snapshot.claudeCode).toMatchObject({
    authMode: "subscription",
    nativePassthrough: false,
    desktopMode: "gateway",
    desktopProfile: { appliedFingerprint: "gateway-fingerprint" },
  });
  const persisted = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
  expect(persisted.claudeCode?.nativePassthrough).toBe(true);
});

test("failed committed gateway persistence does not adopt into the live snapshot", () => {
  const snapshot = config({ claudeCode: { authMode: "subscription", nativePassthrough: true } });
  writeFileSync(join(root, "config.json"), "{ malformed");
  armClaudeCodeBaseline(snapshot);
  const before = structuredClone(snapshot);

  const committed = persistCommittedDesktopGateway(snapshot, undefined, "gateway-fingerprint");

  expect(committed).toEqual({ ok: false, reason: "invalid" });
  expect(snapshot).toEqual(before);
});

test("ensure reconciles first-party env: refreshes when ON and stale, removes when OFF", async () => {
  const applied = applyDesktopFirstParty(config({ port: 10300 }));
  expect(applied.ok).toBe(true);
  expect(settings().env?.HTTPS_PROXY).toBe(expectedProxyUrl(10400));

  const logs: string[] = [];
  const deps = {
    loadConfig: () => config(),
    stripGrokConfig: () => ({ ok: true, changed: false, message: "" }),
    syncGrokConfig: async () => ({ ok: true, changed: false, message: "" }),
    removeDesktop3pStandardPivot: () => ({ ok: true as const, changed: false, kind: "noop" as const, libraryPath: library }),
    log: (message: string) => { logs.push(message); },
    error: (message: string) => { logs.push(message); },
  };
  await ensureClaudeDesktopMatchesDesired(deps);
  expect(settings().env?.HTTPS_PROXY).toBe(expectedProxyUrl(10200));
  expect(logs.some(line => line.includes("first-party env refreshed"))).toBe(true);

  expect(setIntegrationEnabled("claude-desktop", false).ok).toBe(true);
  await ensureClaudeDesktopMatchesDesired({ ...deps, loadConfig: () => config({ clientIntegrations: { "claude-desktop": false } }) });
  expect(settings().env?.HTTPS_PROXY).toBeUndefined();
  expect(settings().env?.NODE_EXTRA_CA_CERTS).toBeUndefined();
});

test("ensure durable OFF disables the picker through the live proxy", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  await ensureClaudeDesktopMatchesDesired({
    loadConfig: () => config({ clientIntegrations: { "claude-desktop": false } }),
    stripGrokConfig: () => ({ ok: true, changed: false, message: "" }),
    syncGrokConfig: async () => ({ ok: true, changed: false, message: "" }),
    removeDesktop3pStandardPivot: () => ({ ok: true as const, changed: false, kind: "noop" as const, libraryPath: library }),
    findLiveProxyImpl: async () => ({ pid: 42, port: 10100, hostname: "127.0.0.1", source: "runtime" }),
    runtimeRequestImpl: async (path, init) => {
      requests.push({ path, body: JSON.parse(String(init.body)) });
      return { ok: true };
    },
    removeDesktopFirstParty: () => ({ ok: true, changed: false, path: "" }),
  });
  expect(requests).toEqual([{ path: "/api/claude-desktop/picker", body: { enabled: false, persist: false } }]);
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
        expect(await applyDesktop(undefined, { kind: "first-party" }, { findLiveProxyImpl: async () => null })).toMatchObject({ ok: false, reason: failure });
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

for (const surface of ["api", "native", "cli"] as const) {
  test(`${surface}: committed gateway state survives unreadable first-party cleanup`, async () => {
    expect(applyDesktopFirstParty(config()).ok).toBe(true);
    const initial = surface === "native"
      ? config({ claudeCode: { intercept: { enabled: false } } })
      : config({ claudeCode: { desktopMode: "first-party" } });
    writeFileSync(join(root, "config.json"), JSON.stringify(initial));
    writeFileSync(join(claudeDir, "settings.json"), "{ malformed first-party settings");
    if (surface === "cli") {
      const result = await applyDesktop(undefined, { kind: "gateway", mode: "static" }, {
        findLiveProxyImpl: async () => null,
      });
      expect(result).toMatchObject({ ok: false, reason: "first_party_settings_unreadable" });
      expect(result.warning).toContain("gateway applied");
    } else {
      const result = surface === "api"
        ? await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) }, initial)
        : await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: true }) }, initial);
      expect(result.status).toBe(500);
      if (surface === "api") expect(result.body).toMatchObject({ applied: true, saved: true, mode: "gateway" });
      else expect(result.body.message).toContain("Gateway applied");
    }
    const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
    const fingerprint = saved.claudeCode?.desktopProfile?.appliedFingerprint;
    expect(saved.claudeCode?.desktopMode).toBe("gateway");
    if (surface !== "cli") {
      expect(initial.claudeCode?.desktopMode).toBe("gateway");
      expect(initial.claudeCode?.desktopProfile?.appliedFingerprint).toBe(fingerprint);
    }
    expect(fingerprint).toBeTruthy();
    expect(inspectDesktop3pConfigLibrary({ appliedFingerprint: fingerprint })).toMatchObject({ kind: "gateway_ours", fingerprint });
    expect(saved.claudeCode?.desktopProfile?.appliedAt).toEqual(expect.any(String));
    expect(resolveClaudeDesktopApplyMode({ ...saved, claudeCode: { ...saved.claudeCode, intercept: { enabled: true } } })).toBe("gateway");
    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe("{ malformed first-party settings");
    const status = await dispatch("/api/claude-desktop/status", {}, saved);
    expect(status.body.mode).toBe("gateway");
    expect(status.body.observedKind).toBe("gateway_ours");
  });
}

test("first-party inspection is read-only: an owned legacy env reads stale, no token is minted", () => {
  // A pre-auth apply left a bare loopback URL anchored on our CA. Status must classify it
  // stale without writing the credential file — inspection runs on read-only paths too.
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
    env: { HTTPS_PROXY: "http://127.0.0.1:10200", NODE_EXTRA_CA_CERTS: claudeInterceptCaCertPath(root) },
  }));
  const seen = inspectDesktopFirstParty(config());
  expect(seen.applied).toBe(false);
  expect(seen.stale).toBe(true);
  expect(existsSync(claudeInterceptProxyTokenPath(root))).toBe(false);
});

test("a deleted token flips an applied env to stale and inspection does not recreate it", () => {
  const applied = applyDesktopFirstParty(config());
  expect(applied.ok).toBe(true);
  expect(inspectDesktopFirstParty(config()).applied).toBe(true);
  rmSync(claudeInterceptProxyTokenPath(root));
  const seen = inspectDesktopFirstParty(config());
  expect(seen.applied).toBe(false);
  expect(seen.stale).toBe(true);
  expect(existsSync(claudeInterceptProxyTokenPath(root))).toBe(false);
});

test("the status routes never mint the proxy token", async () => {
  const status = await dispatch("/api/claude-desktop/status");
  expect(status.status).toBe(200);
  const list = await dispatch("/api/native-integrations");
  expect(list.status).toBe(200);
  expect(existsSync(claudeInterceptProxyTokenPath(root))).toBe(false);
});
