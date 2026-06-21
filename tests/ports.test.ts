import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { findAvailablePort, isPortAvailable } from "../src/ports";

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
});
