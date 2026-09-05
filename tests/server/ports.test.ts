import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { pathToFileURL } from "node:url";
import { findAvailablePort, isAddrInUse, isPortAvailable, PortUnavailableError, shouldPersistSelectedPort, waitForPortAvailable } from "../../src/server/ports";
import { repoPath, repoRoot } from "../helpers/repo-root";

// Prototype overrides exist only inside the disposable child process.
const PORT_PROBE_PEER_DISPOSAL_CHILD = `
  import assert from "node:assert/strict";
  import { EventEmitter } from "node:events";
  import { Server } from "node:net";

  const [operation, portsUrl] = process.argv.slice(-2);
  const peers = Array.from({ length: 2 }, () => {
    const peer = new EventEmitter();
    peer.destroyed = false;
    peer.destroyCalls = 0;
    peer.destroy = () => {
      peer.destroyCalls++;
      peer.destroyed = true;
      return peer;
    };
    return peer;
  });
  let bindOptions;
  let completeClose;
  let closeCompleted = false;
  let probeCalls = 0;
  // Native createServer stays real, including its connection-listener registration.
  Server.prototype.address = function () {
    return { address: "127.0.0.1", family: "IPv4", port: 43219 };
  };
  Server.prototype.close = function (callback) {
    completeClose = () => {
      if (peers.some(peer => !peer.destroyed)) return false;
      closeCompleted = true;
      callback();
      return true;
    };
    return this;
  };
  Server.prototype.listen = function (options) {
    probeCalls++;
    bindOptions = options;
    for (const peer of peers) this.emit("connection", peer);
    this.emit("listening");
    return this;
  };

  const ports = await import(portsUrl);
  let settled = false;
  let rejection;
  const pending = (operation === "isPortAvailable"
    ? ports.isPortAvailable(43117, "127.0.0.1")
    : ports.findAvailablePort(0, "127.0.0.1")).then(value => {
      settled = true;
      return value;
    }, error => {
      settled = true;
      rejection = error;
    });
  // One event-loop turn drains promise reactions without time-based polling.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(probeCalls, 1, "must intercept the real temporary Server instance");
  assert.deepEqual(bindOptions, {
    port: operation === "isPortAvailable" ? 43117 : 0, host: "127.0.0.1",
  });
  assert.equal(rejection, undefined, "probe must not reject before disposal assertions");
  assert.equal(typeof completeClose, "function", "server.close callback must be registered");
  assert.deepEqual(peers.map(peer => peer.destroyed), [true, true],
    "probe must destroy both accepted peers");
  for (const peer of peers) {
    const beforeError = peer.destroyCalls;
    assert.doesNotThrow(() => peer.emit("error", new Error("peer reset")));
    assert.ok(peer.destroyCalls > beforeError, "socket errors must dispose the peer");
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "destroying peers must not resolve before close callback");
  assert.equal(closeCompleted, false);
  assert.equal(completeClose(), true);
  const value = await pending;
  console.log(JSON.stringify({ value, closeCompleted }));
`;

const servers: Server[] = [];

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function listen(port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("unexpected server address"));
        return;
      }
      servers.push(server);
      resolve({ server, port: address.port });
    });
    server.listen({ port, host: "127.0.0.1" });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe("port selection", () => {
  test.each(["isPortAvailable", "findAvailablePort"] as const)(
    "%s disposes accepted peers and waits for probe close completion",
    (operation) => {
      // Keep Server.prototype overrides out of this process and its real-socket tests.
      const portsUrl = pathToFileURL(repoPath("src", "server", "ports.ts")).href;
      const child = Bun.spawnSync([process.execPath, "--eval", PORT_PROBE_PEER_DISPOSAL_CHILD, "--", operation, portsUrl], {
        cwd: repoRoot(),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({
        value: operation === "isPortAvailable" ? true : 43219,
        closeCompleted: true,
      });
    },
    10000,
  );

  test("resolves port 0 to a concrete ephemeral port", async () => {
    const selected = await findAvailablePort(0);

    expect(selected).toBeGreaterThan(0);
    expect(selected).toBeLessThanOrEqual(65535);
    expect(await isPortAvailable(selected)).toBe(true);
  });

  test("keeps the preferred port when it is free", async () => {
    const { port } = await listen();
    const server = servers.pop();
    if (server) await close(server);

    expect(await isPortAvailable(port)).toBe(true);
    expect(await findAvailablePort(port)).toBe(port);
  });

  test("falls back to another available port when the preferred port is busy", async () => {
    const { port } = await listen();

    expect(await isPortAvailable(port)).toBe(false);
    const selected = await findAvailablePort(port);
    expect(selected).not.toBe(port);
    expect(await isPortAvailable(selected)).toBe(true);
  });

  test("persists only the preferred port, not a transient fallback", () => {
    expect(shouldPersistSelectedPort(58195, 10100, 10100)).toBe(true);
    expect(shouldPersistSelectedPort(10100, 58195, 10100)).toBe(false);
    expect(shouldPersistSelectedPort(10100, 10100, 10100)).toBe(false);
  });

  test("a sibling start never persists its explicit port over the configured one", () => {
    // `ocx start --port 10198` beside a live proxy on 10100: the sibling gets its port,
    // but config.port stays 10100 so the next `ocx service` install is not re-pinned.
    expect(shouldPersistSelectedPort(10100, 10198, 10198, { sibling: true })).toBe(false);
    // The same arguments without the sibling flag are the ordinary first-start persist.
    expect(shouldPersistSelectedPort(10100, 10198, 10198)).toBe(true);
    expect(shouldPersistSelectedPort(10100, 10198, 10198, { sibling: false })).toBe(true);
  });

  test("waitForPortAvailable resolves once a busy port is released", async () => {
    const { server, port } = await listen();
    expect(await isPortAvailable(port)).toBe(false);

    const waiting = waitForPortAvailable(port, "127.0.0.1", { timeoutMs: 2000, intervalMs: 25 });
    await close(server);
    const idx = servers.indexOf(server);
    if (idx >= 0) servers.splice(idx, 1);

    await expect(waiting).resolves.toBe(true);
    expect(await isPortAvailable(port)).toBe(true);
  });

  test("waitForPortAvailable returns false when the port stays busy past the timeout", async () => {
    const { port } = await listen();
    await expect(waitForPortAvailable(port, "127.0.0.1", { timeoutMs: 80, intervalMs: 20 })).resolves.toBe(false);
    expect(await isPortAvailable(port)).toBe(false);
  });

  test("findAvailablePort retries the preferred port briefly before falling back", async () => {
    const { server, port } = await listen();
    expect(await isPortAvailable(port)).toBe(false);

    const pending = findAvailablePort(port, "127.0.0.1", { preferRetryMs: 500, preferRetryIntervalMs: 25 });
    // Free the preferred port during the retry window.
    setTimeout(() => {
      void close(server).then(() => {
        const idx = servers.indexOf(server);
        if (idx >= 0) servers.splice(idx, 1);
      });
    }, 60);

    expect(await pending).toBe(port);
  });

  test("refuses ephemeral hop when allowEphemeralFallback is false", async () => {
    const { port } = await listen();
    expect(await isPortAvailable(port)).toBe(false);
    await expect(
      findAvailablePort(port, "127.0.0.1", {
        preferRetryMs: 80,
        preferRetryIntervalMs: 20,
        allowEphemeralFallback: false,
      }),
    ).rejects.toBeInstanceOf(PortUnavailableError);
  });

  test("isAddrInUse recognizes bind conflicts by code or message and rejects everything else", () => {
    expect(isAddrInUse(Object.assign(new Error("listen failed"), { code: "EADDRINUSE" }))).toBe(true);
    expect(isAddrInUse(new Error("listen EADDRINUSE: address already in use ::1:8123"))).toBe(true);
    expect(isAddrInUse(new Error("Failed to start server. Is port 8123 in use?"))).toBe(true);
    expect(isAddrInUse(Object.assign(new Error("no ipv6"), { code: "EAFNOSUPPORT" }))).toBe(false);
    expect(isAddrInUse(new Error("permission denied"))).toBe(false);
    expect(isAddrInUse(null)).toBe(false);
    expect(isAddrInUse("EADDRINUSE")).toBe(false);
  });

  test("isPortAvailable is false for non-EADDRINUSE listen errors (fail closed)", async () => {
    // 192.0.2.1 is TEST-NET-1 — typically EADDRNOTAVAIL / not assignable on desktop stacks.
    expect(await isPortAvailable(54321, "192.0.2.1")).toBe(false);
  });
});
