import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import {
  claudeInterceptCaCertPath, createLocalInterceptCa, issueLocalInterceptLeaf, mintAuthorityWithExtensionsForTests,
  type PemKeyPair,
} from "../../src/claude/intercept/local-ca";
import { startChatgptUnblockEntryProxy } from "../../src/chatgpt/desktop-unblock/entry-proxy";
import { buildChatgptUnblockWatcherScript, probeChatgptUnblockListener } from "../../src/chatgpt/desktop-unblock/launch-watcher";
import { CHATGPT_UNBLOCK_IDENTITY_PATH, CHATGPT_UNBLOCK_SERVICE_ID, startChatgptUnblockListener } from "../../src/chatgpt/desktop-unblock/listener";

const trustedCa = createLocalInterceptCa();
const trustedLeaf = issueLocalInterceptLeaf(trustedCa, ["chatgpt.com"]);
const unrelatedCa = createLocalInterceptCa();
const blocks = [{ name: "tpp_send", reason: "work_subscription_required", lastSeen: "2026-10-01T00:00:00.000Z" }];
const identity = { service: CHATGPT_UNBLOCK_SERVICE_ID, preservedSendBlocks: blocks };
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function configWithCa(ca: string | null = trustedCa.certPem): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-readiness-auth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  if (ca !== null) {
    const path = claudeInterceptCaCertPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ca);
  }
  return dir;
}

function identityPeer(leaf: PemKeyPair = trustedLeaf, body: unknown = identity) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, tls: { cert: leaf.certPem, key: leaf.keyPem },
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      return Response.json(body);
    },
  });
  cleanups.push(async () => { await server.stop(true); });
  return { port: server.port!, requests };
}

const rejected = [
  { label: "another CA's chatgpt.com certificate", leaf: issueLocalInterceptLeaf(unrelatedCa, ["chatgpt.com"]), ca: trustedCa.certPem },
  { label: "a trusted certificate for a different hostname", leaf: issueLocalInterceptLeaf(trustedCa, ["other.example"]), ca: trustedCa.certPem },
  { label: "a self-signed chatgpt.com certificate", leaf: mintAuthorityWithExtensionsForTests("chatgpt.com", []), ca: trustedCa.certPem },
  { label: "a missing published CA", leaf: trustedLeaf, ca: null },
  { label: "a malformed published CA", leaf: trustedLeaf, ca: "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n" },
  { label: "an empty published CA", leaf: trustedLeaf, ca: "" },
  { label: "a leaf published instead of a CA", leaf: trustedLeaf, ca: trustedLeaf.certPem },
];

describe("authenticated ChatGPT listener readiness", () => {
  test("a real loopback peer signed by this config directory's CA reports preserved blocks", async () => {
    const dir = configWithCa();
    const peer = identityPeer();
    expect(await probeChatgptUnblockListener(peer.port, undefined, undefined, dir)).toEqual({ state: "ours", preservedSendBlocks: blocks });
    expect(peer.requests).toEqual([CHATGPT_UNBLOCK_IDENTITY_PATH]);
  });

  for (const scenario of rejected) {
    test(`rejects a copied service identity with ${scenario.label}`, async () => {
      const dir = configWithCa(scenario.ca);
      const peer = identityPeer(scenario.leaf);
      expect(await probeChatgptUnblockListener(peer.port, undefined, undefined, dir)).toEqual({ state: "foreign" });
      expect(peer.requests).toEqual([]);
    });
  }

  test("a verified TLS peer must still return the expected service identity", async () => {
    const dir = configWithCa();
    const peer = identityPeer(trustedLeaf, { service: "another-local-service" });
    expect(await probeChatgptUnblockListener(peer.port, undefined, undefined, dir)).toEqual({ state: "foreign" });
    expect(peer.requests).toEqual([CHATGPT_UNBLOCK_IDENTITY_PATH]);
  });

  test("reads the current published CA on each probe without repairing missing trust", async () => {
    const dir = configWithCa();
    const peer = identityPeer();
    expect((await probeChatgptUnblockListener(peer.port, undefined, undefined, dir)).state).toBe("ours");
    writeFileSync(claudeInterceptCaCertPath(dir), unrelatedCa.certPem);
    expect((await probeChatgptUnblockListener(peer.port, undefined, undefined, dir)).state).toBe("foreign");
    expect(readFileSync(claudeInterceptCaCertPath(dir), "utf8")).toBe(unrelatedCa.certPem);
    expect(peer.requests).toEqual([CHATGPT_UNBLOCK_IDENTITY_PATH]);
  });
});

test("readiness gates identity, HTTP and WebSocket traffic during startup and shutdown", async () => {
  const dir = configWithCa();
  const upstream = identityPeer();
  let ready = false;
  let forwarded = 0;
  const listener = startChatgptUnblockListener({
    leaf: trustedLeaf,
    isReady: () => ready,
    fetchImpl: (async () => { forwarded++; return new Response("fixture"); }) as typeof fetch,
    wsUpstream: { proxy: null, target: { host: "127.0.0.1", port: upstream.port }, ca: trustedCa.certPem },
  });
  cleanups.push(async () => { await listener.stop(true); });
  const requestStatus = (headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
    const request = httpsGet({ hostname: "127.0.0.1", port: listener.port!, servername: "chatgpt.com", path: "/fixture", ca: trustedCa.certPem, headers }, response => {
      response.resume(); resolve(response.statusCode!);
    });
    request.on("error", reject);
    request.setTimeout(1000, () => request.destroy(new Error("fixture request timeout")));
  });
  for (const phase of ["starting", "active", "stopping"]) {
    ready = phase === "active";
    expect((await probeChatgptUnblockListener(listener.port!, undefined, undefined, dir)).state).toBe(ready ? "ours" : "foreign");
    expect(await requestStatus()).toBe(ready ? 200 : 503);
    if (!ready) {
      expect(await requestStatus({ connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" })).toBe(503);
    }
  }
  expect(forwarded).toBe(1);
  expect(upstream.requests).toEqual([]);
});

/** Execute only the generated probe definitions, never app discovery, quit, or launch. */
async function shellProbe(name: "listener_ours" | "entry_ours", port: number, dir: string, entryPort?: number): Promise<number> {
  const script = buildChatgptUnblockWatcherScript(port, dir, false, entryPort === undefined ? undefined : { entryPort });
  const boundary = script.indexOf('\nif [ "$MODE" != native ]');
  expect(boundary).toBeGreaterThan(0);
  const child = Bun.spawn(["/bin/bash", "-c", `${script.slice(0, boundary)}\n${name}`], {
    env: {
      ...process.env,
      CURL_HOME: dir,
      // Direct probes must bypass these; proxy probes must override NO_PROXY='*'.
      HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", all_proxy: "http://127.0.0.1:9",
      NO_PROXY: "*", no_proxy: "*",
    },
    stdout: "ignore", stderr: "ignore",
  });
  return child.exited;
}

describe.skipIf(process.platform === "win32")("authenticated generated readiness probes", () => {
  test("direct and CONNECT probes authenticate the local CA and reach only the identity endpoint", async () => {
    const dir = configWithCa();
    const peer = identityPeer();
    const entry = await startChatgptUnblockEntryProxy({ originPort: peer.port });
    cleanups.push(() => entry.stop());
    expect(await shellProbe("listener_ours", peer.port, dir)).toBe(0);
    expect(await shellProbe("entry_ours", peer.port, dir, entry.port)).toBe(0);
    expect(peer.requests).toEqual([CHATGPT_UNBLOCK_IDENTITY_PATH, CHATGPT_UNBLOCK_IDENTITY_PATH]);
  });

  for (const scenario of rejected.filter(scenario => !scenario.label.includes("leaf published"))) {
    test(`direct and CONNECT probes reject ${scenario.label}`, async () => {
      const dir = configWithCa(scenario.ca);
      const peer = identityPeer(scenario.leaf);
      const entry = await startChatgptUnblockEntryProxy({ originPort: peer.port });
      cleanups.push(() => entry.stop());
      expect(await shellProbe("listener_ours", peer.port, dir)).not.toBe(0);
      expect(await shellProbe("entry_ours", peer.port, dir, entry.port)).not.toBe(0);
      expect(peer.requests).toEqual([]);
    });
  }

  test("a plaintext entry that copies the identity body cannot satisfy a CONNECT probe", async () => {
    const dir = configWithCa();
    const peer = identityPeer();
    const entry = Bun.listen({
      hostname: "127.0.0.1", port: 0,
      socket: { data(socket) {
        const body = JSON.stringify(identity);
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      } },
    });
    cleanups.push(() => entry.stop(true));
    expect(await shellProbe("entry_ours", peer.port, dir, entry.port)).not.toBe(0);
    expect(peer.requests).toEqual([]);
  });

  test("curlrc cannot disable authentication for direct or CONNECT probes", async () => {
    const dir = configWithCa();
    writeFileSync(join(dir, ".curlrc"), "insecure\n");
    const peer = identityPeer(issueLocalInterceptLeaf(unrelatedCa, ["chatgpt.com"]));
    const entry = await startChatgptUnblockEntryProxy({ originPort: peer.port });
    cleanups.push(() => entry.stop());
    expect(await shellProbe("listener_ours", peer.port, dir)).not.toBe(0);
    expect(await shellProbe("entry_ours", peer.port, dir, entry.port)).not.toBe(0);
    expect(peer.requests).toEqual([]);
  });

  test("direct and CONNECT probes also require the expected service identity over verified TLS", async () => {
    const dir = configWithCa();
    const peer = identityPeer(trustedLeaf, { service: "another-local-service" });
    const entry = await startChatgptUnblockEntryProxy({ originPort: peer.port });
    cleanups.push(() => entry.stop());
    expect(await shellProbe("listener_ours", peer.port, dir)).not.toBe(0);
    expect(await shellProbe("entry_ours", peer.port, dir, entry.port)).not.toBe(0);
    expect(peer.requests).toEqual([CHATGPT_UNBLOCK_IDENTITY_PATH, CHATGPT_UNBLOCK_IDENTITY_PATH]);
  });

  test("a listening entry that closes connections without a TLS peer is not ready", async () => {
    const dir = configWithCa();
    const peer = identityPeer();
    const entry = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) { socket.end(); } } });
    cleanups.push(() => entry.stop(true));
    expect(await shellProbe("entry_ours", peer.port, dir, entry.port)).not.toBe(0);
  });
});
