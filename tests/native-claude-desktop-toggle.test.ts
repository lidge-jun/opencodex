import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { setIntegrationEnabled } from "../src/codex/desired-state";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../src/server/management/body";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let root = "";
let library = "";
let previousHome: string | undefined;
let previousLibrary: string | undefined;

function config(): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
  } as OcxConfig;
}

function persistedIntent(): unknown {
  const raw = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as { clientIntegrations?: Record<string, unknown> };
  return raw.clientIntegrations?.["claude-desktop"];
}

async function dispatch(path: string, init?: RequestInit, deps: ManagementApiDeps = {}, inputConfig: OcxConfig = config()) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return handleManagementAPI(new Request(url, {
    ...init,
    headers: { Host: url.host, ...(init?.headers ?? {}) },
  }), url, inputConfig, deps);
}

async function toggle(enabled: boolean, deps: ManagementApiDeps = {}) {
  const response = await dispatch("/api/native-integrations/claude-desktop", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  }, deps);
  return { status: response!.status, body: await response!.json() as Record<string, unknown> };
}

function oversizedTrackedBody(): {
  body: ReadableStream<Uint8Array>;
  stats: { pulls: number; cancelled: number; sentinelPulled: boolean };
} {
  const sentinel = Uint8Array.of(0x7f);
  const chunks = [
    new Uint8Array(MANAGEMENT_JSON_BODY_MAX_BYTES / 2),
    new Uint8Array(MANAGEMENT_JSON_BODY_MAX_BYTES / 2 + 1),
    sentinel,
  ];
  const stats = { pulls: 0, cancelled: 0, sentinelPulled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.pulls += 1;
      const chunk = chunks.shift();
      if (!chunk) {
        controller.close();
        return;
      }
      if (chunk === sentinel) stats.sentinelPulled = true;
      controller.enqueue(chunk);
    },
    cancel() {
      stats.cancelled += 1;
    },
  }, { highWaterMark: 0 });
  return { body, stats };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-desktop-toggle-"));
  library = join(root, "desktop-library");
  previousHome = process.env.OPENCODEX_HOME;
  previousLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_HOME = root;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
  writeFileSync(join(root, "config.json"), JSON.stringify(config()));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousLibrary;
  removeTreeWithRetry(root);
});

test("the native route advertises Claude Desktop and OFF persists intent before removal", async () => {
  let sawPersistedOff = false;
  const result = await toggle(false, {
    removeDesktop3pStandardPivot: () => {
      sawPersistedOff = persistedIntent() === false;
      return { ok: true, changed: false, kind: "noop", libraryPath: library };
    },
  });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ clientId: "claude-desktop", desiredEnabled: false });
  expect(sawPersistedOff).toBe(true);
  expect(persistedIntent()).toBe(false);

  const status = await dispatch("/api/native-integrations");
  const clients = (await status!.json() as { clients: Array<{ clientId: string }> }).clients;
  expect(clients.map(client => client.clientId)).toEqual(expect.arrayContaining(["claude", "grok", "codex", "claude-desktop"]));
});

test("OFF on a missing or empty library is an idempotent no-op with no footprint", async () => {
  const missing = await toggle(false);
  expect(missing.body).toMatchObject({ ok: true, changed: false, desiredEnabled: false });
  expect(existsSync(library)).toBe(false);

  // A present-but-empty directory has no owned state and stays untouched too.
  const empty = join(root, "empty-library");
  mkdirSync(empty);
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = empty;
  const again = await toggle(false);
  expect(again.body).toMatchObject({ ok: true, changed: false, desiredEnabled: false });
  expect(existsSync(empty)).toBe(true);
  expect(existsSync(join(empty, "_meta.json"))).toBe(false);
});

test("OFF removes an owned drifted gateway even without a saved fingerprint", async () => {
  mkdirSync(library);
  const id = "drifted-owned";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100",
    inferenceGatewayApiKey: "not-a-secret",
  }));

  const result = await toggle(false);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ ok: true, changed: true, desiredEnabled: false, state: "absent" });
  expect(existsSync(join(library, `${id}.json`))).toBe(false);
  expect(persistedIntent()).toBe(false);

  const status = await dispatch("/api/claude-desktop/status");
  const body = await status!.json() as { desiredEnabled: boolean; applied: boolean; stale: boolean; observedKind: string };
  expect(body).toMatchObject({ desiredEnabled: false, applied: false, stale: false });
  expect(body.observedKind).not.toBe("gateway_drifted");
  expect(body.observedKind).not.toBe("gateway_ours");
});

test("status reports leftover owned drift as not stale when the durable switch is OFF", async () => {
  mkdirSync(library);
  const id = "drifted-owned";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100",
    inferenceGatewayApiKey: "not-a-secret",
  }));

  // Persist OFF without the native teardown path, so the leftover gateway stays selected.
  expect(setIntegrationEnabled("claude-desktop", false).ok).toBe(true);
  expect(persistedIntent()).toBe(false);
  expect(existsSync(join(library, `${id}.json`))).toBe(true);

  const status = await dispatch("/api/claude-desktop/status");
  const body = await status!.json() as {
    desiredEnabled: boolean;
    applied: boolean;
    stale: boolean;
    drift: boolean;
    driftReason: string | null;
    observedKind: string;
  };
  expect(body.observedKind).toBe("gateway_drifted");
  expect(body).toMatchObject({
    desiredEnabled: false,
    stale: false,
    drift: true,
    driftReason: "desired_off_gateway_selected",
  });
});

test("status reports a managed policy conflict as warning health and drift", async () => {
  const response = await dispatch("/api/claude-desktop/status", undefined, {
    probeClaudeDesktopPolicy: () => "present",
  });
  const body = await response!.json() as {
    drift: boolean;
    driftReason: string | null;
    health: { ok: boolean; status: string; policy: { state: string; action: string } };
  };

  expect(body.health).toMatchObject({
    ok: false,
    status: "warning",
    policy: { state: "present" },
  });
  expect(body.health.policy.action.length).toBeGreaterThan(0);
  expect(body.drift).toBe(true);
  expect(body.driftReason).toBe("managed_policy_present");
});

test("post-commit unsafe and incomplete refusals disclose desired OFF without contents", async () => {
  writeFileSync(join(root, "config.json"), JSON.stringify(config()));
  writeFileSync(join(root, "metadata-marker"), "");
  const unsafe = await toggle(false, {
    removeDesktop3pStandardPivot: () => ({ ok: false, changed: false, kind: "unsafe", libraryPath: library, reason: "metadata_unreadable" }),
  });
  expect(unsafe.status).toBe(409);
  expect(unsafe.body).toMatchObject({ reason: "metadata_unreadable", desiredEnabled: false });

  writeFileSync(join(root, "config.json"), JSON.stringify(config()));
  const incomplete = await toggle(false, {
    removeDesktop3pStandardPivot: () => ({
      ok: false, changed: true, kind: "cleanup_incomplete", libraryPath: library, residualPaths: [join(library, "owned.json.bak")],
    }),
  });
  expect(incomplete.status).toBe(500);
  expect(incomplete.body).toMatchObject({
    reason: "cleanup_incomplete",
    desiredEnabled: false,
    residualPaths: [join(library, "owned.json.bak")],
  });
});

test("auto-apply re-reads desired state after catalog fetch and skips a concurrent OFF", async () => {
  const profile = {
    version: 1 as const,
    assignments: {},
    defaults: { opus: null, fable: null, sonnet: null, haiku: null },
  };
  const persisted = { ...config(), claudeCode: { desktopProfile: profile, injectAgents: false } };
  writeFileSync(join(root, "config.json"), JSON.stringify(persisted));
  writeFileSync(join(root, "config.json.bak"), JSON.stringify(persisted));
  writeFileSync(join(root, "config.json"), JSON.stringify(persisted));
  const id = "selected-owned";
  const { mkdirSync } = await import("node:fs");
  mkdirSync(library);
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    // Shape-only value: deliberately inert; never a credential.
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));
  let release!: () => void;
  let started!: () => void;
  const fetched = new Promise<never[]>(resolve => { release = () => resolve([]); });
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  let writes = 0;
  const request = dispatch("/api/subagent-models", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models: [] }),
  }, {
    fetchAllModels: () => {
      started();
      return fetched;
    },
    writeDesktop3pConfig: () => {
      writes++;
      return { written: true, path: join(library, "new.json"), fingerprint: "fingerprint" };
    },
  }, persisted);
  await fetchStarted;
  expect(setIntegrationEnabled("claude-desktop", false).ok).toBe(true);
  release();
  expect((await request)!.status).toBe(200);
  expect(writes).toBe(0);
});

test("explicit enable re-reads desired state after catalog fetch and skips a concurrent OFF", async () => {
  let release!: () => void;
  let started!: () => void;
  const fetched = new Promise<never[]>(resolve => { release = () => resolve([]); });
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  let writes = 0;
  const request = toggle(true, {
    fetchAllModels: () => {
      started();
      return fetched;
    },
    writeDesktop3pConfig: () => {
      writes++;
      return { written: true, path: join(library, "new.json"), fingerprint: "fingerprint" };
    },
  });
  await fetchStarted;
  expect(setIntegrationEnabled("claude-desktop", false).ok).toBe(true);
  release();
  const result = await request;
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ reason: "desired_state_changed", desiredEnabled: false });
  expect(writes).toBe(0);
});

test("explicit enable honors the Claude Desktop native-model opt-out", async () => {
  const persisted = { ...config(), claudeCode: { desktopNativeModels: false } };
  writeFileSync(join(root, "config.json"), JSON.stringify(persisted));
  let nativeSlugs: string[] | undefined;

  const result = await toggle(true, {
    fetchAllModels: async () => [],
    writeDesktop3pConfig: (_port, slugs) => {
      nativeSlugs = slugs;
      return { written: true, path: join(library, "new.json"), fingerprint: "fingerprint" };
    },
  });

  expect(result.status).toBe(200);
  expect(nativeSlugs).toEqual([]);
});

test("POST /apply enables from a stale OFF server snapshot instead of cancelling itself", async () => {
  // The regression: /apply persisted ON, then saved the WHOLE long-lived server
  // config — whose snapshot still said OFF — over that write, so its own
  // post-await guard read OFF and refused the apply it had just been asked for.
  expect(setIntegrationEnabled("claude-desktop", false).ok).toBe(true);
  expect(persistedIntent()).toBe(false);
  // The server object captured at startup, still carrying the OFF it booted with.
  const staleSnapshot = { ...config(), clientIntegrations: { "claude-desktop": false } } as OcxConfig;

  let writes = 0;
  const response = await dispatch("/api/claude-desktop/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "static" }),
  }, {
    fetchAllModels: async () => [],
    writeDesktop3pConfig: () => {
      writes++;
      return { written: true, path: join(library, "applied.json"), fingerprint: "fingerprint" };
    },
  }, staleSnapshot);

  expect(response!.status).toBe(200);
  expect(writes).toBe(1);
  // Desired ON survives the profile/fingerprint saves that follow it.
  expect(persistedIntent()).toBeUndefined();
});

for (const [label, declaration] of [
  ["missing Content-Length", undefined],
  ["a lying low Content-Length", "1"],
] as const) {
  test(`POST /apply stops an oversized stream with ${label} before any mutation`, async () => {
    const inputConfig = config();
    const beforeInputConfig = structuredClone(inputConfig);
    const beforePersistedConfig = readFileSync(join(root, "config.json"), "utf8");
    const { body, stats } = oversizedTrackedBody();
    let writes = 0;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (declaration !== undefined) headers["Content-Length"] = declaration;

    const response = await dispatch("/api/claude-desktop/apply", {
      method: "POST",
      headers,
      body,
    }, {
      writeDesktop3pConfig: () => {
        writes += 1;
        return { written: true, path: join(library, "unexpected.json"), fingerprint: "unexpected" };
      },
    }, inputConfig);

    expect(response!.status).toBe(413);
    expect(await response!.json()).toEqual({ error: "request body too large" });
    expect(stats).toEqual({ pulls: 2, cancelled: 1, sentinelPulled: false });
    expect(writes).toBe(0);
    expect(inputConfig).toEqual(beforeInputConfig);
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(beforePersistedConfig);
    expect(existsSync(library)).toBe(false);
  });
}

test("POST /apply leaves the reused server snapshot agreeing with disk", async () => {
  // Disk-only repair is not enough: the server reuses ONE config object per
  // request, so a stale snapshot makes the native GET report the opposite of
  // what was persisted, and lets a later whole-snapshot save undo the enable.
  expect(setIntegrationEnabled("claude-desktop", false).ok).toBe(true);
  const staleSnapshot = { ...config(), clientIntegrations: { "claude-desktop": false } } as OcxConfig;
  const deps: ManagementApiDeps = {
    fetchAllModels: async () => [],
    writeDesktop3pConfig: () => ({ written: true, path: join(library, "applied.json"), fingerprint: "fingerprint" }),
  };

  expect((await dispatch("/api/claude-desktop/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "static" }),
  }, deps, staleSnapshot))!.status).toBe(200);

  // (1) the SAME snapshot object now reports ON through the native GET
  const status = await dispatch("/api/native-integrations", undefined, deps, staleSnapshot);
  const clients = (await status!.json() as { clients: Array<{ clientId: string; desiredEnabled: boolean }> }).clients;
  expect(clients.find(client => client.clientId === "claude-desktop")?.desiredEnabled).toBe(true);

  // (2) a later whole-snapshot save (the Desktop profile PUT) cannot write OFF back
  await dispatch("/api/claude-desktop", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile: { mode: "static" } }),
  }, deps, staleSnapshot);
  expect(persistedIntent()).toBeUndefined();
});
