import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshAsideProfilesThroughServer } from "../../src/cli/aside-profiles";
import { saveConfig } from "../../src/config";
import { writeRuntimePort } from "../../src/config/process-state";
import {
  LOCAL_ASIDE_SYNC_CAPABILITY_HEADER,
  LOCAL_ASIDE_SYNC_EXPECTED_PID_HEADER,
  LOCAL_ASIDE_SYNC_EXPIRES_AT_HEADER,
  LOCAL_ASIDE_SYNC_METHOD,
  LOCAL_ASIDE_SYNC_NONCE_HEADER,
  LOCAL_ASIDE_SYNC_PATH,
  createLocalAsideSyncCapability,
} from "../../src/lib/local-aside-sync-contract";
import { createLocalAttestationChallenge, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER } from "../../src/lib/local-management-attestation";
import { directLocalHttpFetch } from "../../src/server/direct-local-http";
import { startServer } from "../../src/server";
import { stopServerListener } from "../../src/server/lifecycle";
import { setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import { currentServerFixtureConfig, settleServerAuthFixture } from "../helpers/server-auth-fixture";
import { serverAuthConfig } from "../helpers/server-auth-config";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const secret = "A".repeat(43);
const previousHome = process.env.OPENCODEX_HOME;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let home = "";
let codexHome: IsolatedCodexHome | null = null;
let server: ReturnType<typeof startServer> | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-aside-sync-capability-"));
  codexHome = installIsolatedCodexHome("ocx-aside-sync-codex-");
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = `ocx_admin_${"D".repeat(43)}`;
  setIntegrationPathTestHooks({
    home,
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
  saveConfig(currentServerFixtureConfig({
    ...serverAuthConfig("127.0.0.1"),
    clientIntegrations: { codex: false },
    asideProfileSync: { allProfiles: false },
  }));
  server = startServer(0, {
    localAttestationSecret: secret,
    inspectNativeCodexOwnership: ownedServiceHomeInspection("Aside sync capability fixture"),
  });
  writeRuntimePort({ pid: process.pid, port: server.port, hostname: "127.0.0.1", attestationSecret: secret });
});

afterEach(async () => {
  if (server) await stopServerListener(server);
  server = null;
  setIntegrationPathTestHooks(null);
  await settleServerAuthFixture(home, codexHome?.path);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  codexHome?.restore();
  codexHome = null;
  removeTreeWithRetry(home);
  home = "";
});

function signedHeaders(options: { pid?: number; port?: number; expiresAt?: number } = {}): Headers {
  if (!server) throw new Error("listener is not running");
  const nonce = createLocalAttestationChallenge();
  const pid = options.pid ?? process.pid;
  const port = options.port ?? server.port;
  const expiresAt = options.expiresAt ?? Date.now() + 5_000;
  const capability = createLocalAsideSyncCapability(secret, nonce, LOCAL_ASIDE_SYNC_METHOD, LOCAL_ASIDE_SYNC_PATH, pid, port, expiresAt);
  if (!capability) throw new Error("capability fixture could not be signed");
  return new Headers({
    [LOCAL_ASIDE_SYNC_EXPECTED_PID_HEADER]: String(pid),
    [LOCAL_ASIDE_SYNC_NONCE_HEADER]: nonce,
    [LOCAL_ASIDE_SYNC_EXPIRES_AT_HEADER]: String(expiresAt),
    [LOCAL_ASIDE_SYNC_CAPABILITY_HEADER]: capability,
  });
}

async function send(path: string, headers: Headers, method = "POST"): Promise<Response> {
  if (!server) throw new Error("listener is not running");
  return fetch(new URL(path, server.url), { method, headers });
}

test("Aside sync capability admits one exact request and refuses replay or altered bindings", async () => {
  if (!server) throw new Error("listener is not running");
  const headers = signedHeaders();
  const accepted = await send(LOCAL_ASIDE_SYNC_PATH, headers);
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).results).toEqual([]);
  expect((await send(LOCAL_ASIDE_SYNC_PATH, headers)).status).toBe(401);

  const wrongPort = server.port === 65_535 ? server.port - 1 : server.port + 1;
  const badHmac = signedHeaders();
  const original = badHmac.get(LOCAL_ASIDE_SYNC_CAPABILITY_HEADER)!;
  badHmac.set(LOCAL_ASIDE_SYNC_CAPABILITY_HEADER, `${original[0] === "A" ? "B" : "A"}${original.slice(1)}`);
  for (const [path, method, candidate] of [
    ["/api/client-integrations/aside/profiles", "POST", signedHeaders()],
    [`${LOCAL_ASIDE_SYNC_PATH}?extra=1`, "POST", signedHeaders()],
    [LOCAL_ASIDE_SYNC_PATH, "GET", signedHeaders()],
    [LOCAL_ASIDE_SYNC_PATH, "POST", signedHeaders({ pid: process.pid + 1 })],
    [LOCAL_ASIDE_SYNC_PATH, "POST", signedHeaders({ port: wrongPort })],
    [LOCAL_ASIDE_SYNC_PATH, "POST", signedHeaders({ expiresAt: Date.now() - 1 })],
    [LOCAL_ASIDE_SYNC_PATH, "POST", badHmac],
  ] as const) {
    expect((await send(path, candidate, method)).status).toBe(401);
  }
});

test("CLI default Aside sync attests the listener and sends a bodyless POST", async () => {
  if (!server) throw new Error("listener is not running");
  const requests: Array<{ path: string; method: string; body: BodyInit | null | undefined; headers: Headers }> = [];
  const live = { pid: process.pid, port: server.port, hostname: "127.0.0.1", source: "runtime" as const };
  const results = await refreshAsideProfilesThroughServer({
    findLiveProxy: async () => live,
    directLocalFetch: (input, init = {}) => {
      requests.push({
        path: new URL(input instanceof Request ? input.url : String(input)).pathname,
        method: init.method ?? "GET",
        body: init.body,
        headers: new Headers(init.headers),
      });
      return directLocalHttpFetch(input, init);
    },
  });
  expect(results).toEqual([]);
  expect(requests.map(({ path, method }) => [method, path])).toEqual([
    ["GET", "/healthz"], ["POST", LOCAL_ASIDE_SYNC_PATH],
  ]);
  expect(requests[0].headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(requests[1].body).toBeUndefined();
  expect(requests[1].headers.get(LOCAL_ASIDE_SYNC_CAPABILITY_HEADER)).toMatch(/^[A-Za-z0-9_-]{43}$/);

  let posted = false;
  await expect(refreshAsideProfilesThroughServer({
    findLiveProxy: async () => live,
    directLocalFetch: async (input, init = {}) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname !== "/healthz") {
        posted = true;
        return directLocalHttpFetch(input, init);
      }
      const response = await directLocalHttpFetch(input, init);
      const tampered = new Headers(response.headers);
      tampered.set(LOCAL_ATTESTATION_PROOF_HEADER, "C".repeat(43));
      return new Response(await response.text(), { status: response.status, headers: tampered });
    },
  })).rejects.toMatchObject({ status: 503 });
  expect(posted).toBe(false);
});

test("CLI Aside sync applies one absolute deadline across attestation and POST", async () => {
  if (!server) throw new Error("listener is not running");
  const live = { pid: process.pid, port: server.port, hostname: "127.0.0.1", source: "runtime" as const };
  let healthSignal: AbortSignal | undefined;
  let postSignal: AbortSignal | undefined;
  await expect(refreshAsideProfilesThroughServer({
    findLiveProxy: async () => live,
    exchangeDeadlineMs: 50,
    directLocalFetch: async (input, init = {}) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/healthz") {
        healthSignal = init.signal ?? undefined;
        return directLocalHttpFetch(input, init);
      }
      postSignal = init.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    },
  })).rejects.toBeDefined();
  expect(healthSignal).toBe(postSignal);
  expect(postSignal?.aborted).toBe(true);
});
