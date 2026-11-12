import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore } from "../../src/link/store";
import { LINK_ROUTE_PROOF_HEADER } from "../../src/link/route-proof";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

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

test("the hub-link catalog admission reports the route proof id it carried, on the same line as the admission", () => {
  const source = readFileSync(repoPath("src/server/index/serve-options.ts"), "utf8");
  const line = source.split("\n").find(text => text.includes("onAuthenticatedCatalog(admission.keyId"));
  expect(line).toContain('&& admission.kind === "configured") onAuthenticatedCatalog(admission.keyId, req.headers.get("' + LINK_ROUTE_PROOF_HEADER + '") ?? undefined);');
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
  server = startServer(0);
  const linkPort = JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
  const response = await fetch("http://127.0.0.1:" + linkPort + "/v1/catalog", {
    headers: { "x-opencodex-api-key": LINKED_KEY, [LINK_ROUTE_PROOF_HEADER]: PROOF },
  });
  expect(response.status).toBe(200);
  expect(Array.isArray((await response.json() as { models?: unknown }).models)).toBe(true);
  // Without the key, the header admits nothing.
  expect((await fetch("http://127.0.0.1:" + linkPort + "/v1/catalog", { headers: { [LINK_ROUTE_PROOF_HEADER]: PROOF } })).status).toBe(401);
});

