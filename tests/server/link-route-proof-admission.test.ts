import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore } from "../../src/link/store";
import { LINK_ROUTE_PROOF_HEADER, takeRouteProof } from "../../src/link/route-proof";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINKED_KEY = "link-linked-route-proof";
const LINKED_ID = "linked-key";
const PROOF = "0123456789abcdef0123456789abcdef";

const previous = { home: process.env.OPENCODEX_HOME, codexHome: process.env.CODEX_HOME };
let testHome = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(closeActiveConnections?: boolean): Promise<void> } | null = null;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-link-route-proof-"));
  process.env.OPENCODEX_HOME = testHome;
  codexHome = installIsolatedCodexHome("ocx-link-route-proof-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "mock/test-model" }] }));
});

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  codexHome?.restore();
  codexHome = null;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous.home;
  if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous.codexHome;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

test("takeRouteProof hands back the proof id and leaves the request without the header", () => {
  const req = new Request("http://127.0.0.1/v1/catalog", { headers: { [LINK_ROUTE_PROOF_HEADER]: PROOF, "x-opencodex-api-key": LINKED_KEY } });
  expect(takeRouteProof(req)).toBe(PROOF);
  // Whatever handles the request next cannot see it.
  expect(req.headers.has(LINK_ROUTE_PROOF_HEADER)).toBe(false);
  expect(req.headers.get("x-opencodex-api-key")).toBe(LINKED_KEY);
  expect(takeRouteProof(req)).toBeUndefined();
  expect(takeRouteProof(new Request("http://127.0.0.1/v1/catalog"))).toBeUndefined();
});

test("a proof header that cannot be taken off the request is not reported", () => {
  const headers = new Headers({ [LINK_ROUTE_PROOF_HEADER]: PROOF });
  const req = { headers: { get: (name: string) => headers.get(name), delete: () => { throw new TypeError("immutable"); } } } as unknown as Request;
  expect(takeRouteProof(req)).toBeUndefined();
});

test("the link listener passes a proof id to every subscriber and leaves it out when absent", () => {
  const listener = createLinkListenerLifecycle({ storePath: join(testHome, "link", "links.json") });
  const seen: Array<[string, string | undefined]> = [];
  const unsubscribe = listener.onAuthenticatedCatalog((apiKeyId, routeProofId) => { seen.push([apiKeyId, routeProofId]); });
  listener.notifyAuthenticatedCatalog("key-a", PROOF);
  listener.notifyAuthenticatedCatalog("key-a");
  unsubscribe();
  listener.notifyAuthenticatedCatalog("key-a", PROOF);
  expect(seen).toEqual([["key-a", PROOF], ["key-a", undefined]]);
});

test("a key-admitted catalog request carrying a proof id is still served normally on the hub-link listener", async () => {
  const { saveConfig } = await import("../../src/config");
  writeLinkStore(linkStorePath(), {
    version: 1,
    listenerPort: null,
    links: [{
      id: "lnk_0123456789abcdef", alias: "route-proof-test", direction: "client-initiated", hostKeyFingerprint: null,
      tunnelPort: 2222, apiKeyId: LINKED_ID, createdAt: "2026-11-01T00:00:00.000Z",
    }],
  });
  saveConfig({
    port: 0, hostname: "127.0.0.1", runtimeRole: "hub", defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, models: ["test-model"] } },
    apiKeys: [{ id: LINKED_ID, name: LINKED_ID, key: LINKED_KEY, createdAt: "2026-11-01T00:00:00.000Z" }],
    clientIntegrations: { codex: false },
  } as OcxConfig);
  const { startServer } = await import("../../src/server");
  // What the hub-link admission reports to the link listener, and through it to the proof registry.
  const reported: Array<[string, string | undefined]> = [];
  server = startServer(0, { observeAuthenticatedCatalog: (apiKeyId, routeProofId) => { reported.push([apiKeyId, routeProofId]); } });
  const linkPort = JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
  const response = await fetch("http://127.0.0.1:" + linkPort + "/v1/catalog", {
    headers: { "x-opencodex-api-key": LINKED_KEY, [LINK_ROUTE_PROOF_HEADER]: PROOF },
  });
  expect(response.status).toBe(200);
  expect(Array.isArray((await response.json() as { models?: unknown }).models)).toBe(true);
  expect(reported).toEqual([[LINKED_ID, PROOF]]);
  // Without the key, the header admits nothing.
  expect((await fetch("http://127.0.0.1:" + linkPort + "/v1/catalog", { headers: { [LINK_ROUTE_PROOF_HEADER]: PROOF } })).status).toBe(401);
  expect(reported).toEqual([[LINKED_ID, PROOF]]);
  // A key-admitted catalog request without the header is reported without a proof id.
  await fetch("http://127.0.0.1:" + linkPort + "/v1/catalog", { headers: { "x-opencodex-api-key": LINKED_KEY } });
  expect(reported).toEqual([[LINKED_ID, PROOF], [LINKED_ID, undefined]]);
});
