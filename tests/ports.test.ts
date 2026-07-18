import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { findAvailablePort, isAddrInUse, isPortAvailable, shouldPersistSelectedPort, waitForPortAvailable } from "../src/server/ports";

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

  test("isAddrInUse recognizes bind conflicts by code or message and rejects everything else", () => {
    expect(isAddrInUse(Object.assign(new Error("listen failed"), { code: "EADDRINUSE" }))).toBe(true);
    expect(isAddrInUse(new Error("listen EADDRINUSE: address already in use ::1:8123"))).toBe(true);
    expect(isAddrInUse(new Error("Failed to start server. Is port 8123 in use?"))).toBe(true);
    expect(isAddrInUse(Object.assign(new Error("no ipv6"), { code: "EAFNOSUPPORT" }))).toBe(false);
    expect(isAddrInUse(new Error("permission denied"))).toBe(false);
    expect(isAddrInUse(null)).toBe(false);
    expect(isAddrInUse("EADDRINUSE")).toBe(false);
  });
});
