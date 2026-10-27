/**
 * OCX-2 (goat-si/goat #684 P4, #696): the serving Home's opaque instance id on `GET /healthz`
 * (`instanceId`) and on every `GET /v1/models` response (`x-opencodex-served-by`), whichever
 * path the request took: the Home or Hub data listener (a Hub-mode client's Codex calls it directly),
 * a Remote Link Child's relay to the Home's link listener, or a standalone proxy. The id is the
 * install's random `homeId`, stable across restarts, never a hostname, and absent (never empty)
 * while the identity is unavailable.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir, saveConfig } from "../../src/config";
import { HOME_INITIATED_LINK_TUNNEL, relayLinkDataRequest } from "../../src/client/link-relay";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore } from "../../src/link/store";
import {
  ensureQuotaPoolIdentity, quotaPoolIdentityPath, readQuotaPoolIdentity, resetQuotaPoolIdentityMemoForTests,
} from "../../src/quota-pool/identity";
import { SERVED_BY_HEADER } from "../../src/remote/served-by";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SERVER_BUDGET_MS);

const API_KEY = "served-by-env-admission";
const LINKED_KEY = "served-by-linked-admission";
const INSTANCE_ID = /^home_[0-9a-f]{32}$/;
const previous = { home: process.env.OPENCODEX_HOME, apiToken: process.env.OPENCODEX_API_AUTH_TOKEN };
let testHome = "";
let codexHome: IsolatedCodexHome | null = null;
let server: ReturnType<typeof startServer> | null = null;

function config(role: "hub" | "standalone"): OcxConfig {
  return {
    port: 0,
    hostname: role === "hub" ? "0.0.0.0" : "127.0.0.1",
    ...(role === "hub" ? { runtimeRole: "hub" } : {}),
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, liveModels: false, models: ["m"] } },
    apiKeys: [{ id: "linked-key", name: "linked-key", key: LINKED_KEY, createdAt: "2026-10-22T00:00:00.000Z" }],
    clientIntegrations: { codex: false },
    webSearchSidecar: { enabled: false },
  } as OcxConfig;
}

function start(role: "hub" | "standalone") {
  saveConfig(config(role));
  server = startServer(0);
  return server;
}

const auth = { "x-opencodex-api-key": API_KEY };

async function health(): Promise<Record<string, unknown>> {
  return await (await fetch(new URL("/healthz", server!.url))).json() as Record<string, unknown>;
}

/** The server mints the identity in the background after it listens; wait for /healthz to carry it. */
async function instanceIdFromHealth(): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const id = (await health()).instanceId;
    if (id !== undefined) {
      expect(id).toMatch(INSTANCE_ID);
      return id as string;
    }
    await Bun.sleep(10);
  }
  throw new Error("instanceId never appeared on /healthz");
}

function expectOpaque(id: string): void {
  expect(id).toMatch(INSTANCE_ID);
  // Only the random body can carry anything, and a short or hex-only label can occur in random hex
  // by chance; check labels long enough for a match to mean derivation.
  const body = id.slice("home_".length);
  const label = hostname().toLowerCase().split(".")[0] ?? "";
  if (label.length >= 8) {
    expect(body).not.toContain(label);
    expect(body).not.toContain(Buffer.from(label).toString("hex").slice(0, 16));
  }
}

async function stopServer(): Promise<void> {
  if (server) await server.stop(true);
  server = null;
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-served-by-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = API_KEY;
  resetQuotaPoolIdentityMemoForTests();
  codexHome = installIsolatedCodexHome("ocx-served-by-codex-");
});

afterEach(async () => {
  await stopServer();
  codexHome?.restore();
  codexHome = null;
  resetQuotaPoolIdentityMemoForTests();
  for (const [key, value] of [["OPENCODEX_HOME", previous.home], ["OPENCODEX_API_AUTH_TOKEN", previous.apiToken]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (testHome) await removeTreeAfterBackgroundWork(testHome);
  testHome = "";
});

describe("GET /healthz instanceId", () => {
  test("is the install's opaque homeId, stable across restarts", async () => {
    start("standalone");
    const first = await instanceIdFromHealth();
    expect(first).toBe(readQuotaPoolIdentity()!.homeId);
    expectOpaque(first);
    await stopServer();
    resetQuotaPoolIdentityMemoForTests();
    start("standalone");
    expect(await instanceIdFromHealth()).toBe(first);
    const models = await fetch(new URL("/v1/models", server!.url), { headers: auth });
    expect(models.headers.get(SERVED_BY_HEADER)).toBe(first);
  });

  test("a fresh install gets a different id: nothing machine-derived", async () => {
    start("standalone");
    const first = await instanceIdFromHealth();
    await stopServer();
    process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-served-by-other-"));
    const other = process.env.OPENCODEX_HOME;
    try {
      resetQuotaPoolIdentityMemoForTests();
      start("standalone");
      const second = await instanceIdFromHealth();
      expectOpaque(second);
      expect(second).not.toBe(first);
    } finally {
      await stopServer();
      process.env.OPENCODEX_HOME = testHome;
      await removeTreeAfterBackgroundWork(other);
    }
  });

  test("an unavailable identity omits the field and the header instead of sending an empty value", async () => {
    // A malformed file is refused and never overwritten, so the identity stays unavailable.
    writeFileSync(quotaPoolIdentityPath(getConfigDir()), JSON.stringify({ version: 1, homeId: "", secret: "" }), { mode: 0o600 });
    start("standalone");
    await Bun.sleep(200);
    const body = await health();
    expect(body.status).toBe("ok");
    expect("instanceId" in body).toBe(false);
    const models = await fetch(new URL("/v1/models", server!.url), { headers: auth });
    expect(models.status).toBe(200);
    expect(models.headers.has(SERVED_BY_HEADER)).toBe(false);
  });

  test("a package-tree fence keeps the id on /healthz and the header on /v1/models", async () => {
    const homeId = ensureQuotaPoolIdentity().homeId;
    saveConfig(config("standalone"));
    server = startServer(0, {
      packageTreeIntegrity: { status: () => ({ ok: false as const, reason: "package_tree_replaced" as const }), dispose: () => {} },
    });
    const health = await fetch(new URL("/healthz", server.url));
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: "restart_required", instanceId: homeId });
    const models = await fetch(new URL("/v1/models", server.url), { headers: auth });
    expect(models.status).toBe(503);
    expect(models.headers.get(SERVED_BY_HEADER)).toBe(homeId);
  });
});

describe("x-opencodex-served-by on GET /v1/models", () => {
  test("standalone: the proxy names itself", async () => {
    start("standalone");
    const id = await instanceIdFromHealth();
    for (const query of ["", "?client_version=0.130.0"]) {
      const response = await fetch(new URL(`/v1/models${query}`, server!.url), { headers: auth });
      expect(response.status).toBe(200);
      expect(response.headers.get(SERVED_BY_HEADER)).toBe(id);
    }
    // Refusals from the same route name the same Home; other routes carry no header.
    const refusal = await fetch(new URL("/v1/models", server!.url), { headers: { origin: "https://elsewhere.example" } });
    // Loopback admits the keyless call; the foreign Origin is what refuses it.
    expect(refusal.status).toBe(403);
    expect(await refusal.text()).toContain("origin_rejected");
    expect(refusal.headers.get(SERVED_BY_HEADER)).toBe(id);
    expect((await fetch(new URL("/healthz", server!.url))).headers.has(SERVED_BY_HEADER)).toBe(false);
  });

  test("Hub data listener: the response a Hub-mode client's Codex reads names the Hub", async () => {
    start("hub");
    const id = await instanceIdFromHealth();
    const response = await fetch(new URL("/v1/models", server!.url), { headers: { authorization: `Bearer ${LINKED_KEY}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get(SERVED_BY_HEADER)).toBe(id);
  });

  test("Remote Link Child relay: the Child returns the Home's id unchanged", async () => {
    writeLinkStore(linkStorePath(), {
      version: 1,
      listenerPort: null,
      links: [{
        id: "lnk_00000000000000ab", alias: "served-by-test", direction: "client-initiated",
        hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: "linked-key", createdAt: "2026-10-22T00:00:00.000Z",
      }],
    });
    start("hub");
    const homeId = await instanceIdFromHealth();
    const linkPort = JSON.parse(await Bun.file(linkStorePath()).text()).listenerPort as number;
    const relay = (fetchImpl: typeof fetch) => relayLinkDataRequest(
      new Request("http://127.0.0.1:10100/v1/models", { headers: { authorization: "Bearer child-local-caller" } }),
      { tunnelPort: linkPort, admissionKey: LINKED_KEY },
      { fetchImpl, tunnel: HOME_INITIATED_LINK_TUNNEL },
    );
    const relayed = await relay(fetch);
    expect(relayed.status).toBe(200);
    expect(relayed.headers.get(SERVED_BY_HEADER)).toBe(homeId);
    // A Child never substitutes its own id: whatever the Home names passes through as is.
    const otherHome = `home_${"a".repeat(32)}`;
    const passed = await relay((async () => Response.json({ data: [] }, { headers: { [SERVED_BY_HEADER]: otherHome } })) as typeof fetch);
    expect(passed.headers.get(SERVED_BY_HEADER)).toBe(otherHome);
    const unstamped = await relay((async () => Response.json({ data: [] })) as typeof fetch);
    expect(unstamped.headers.has(SERVED_BY_HEADER)).toBe(false);
  });
});
