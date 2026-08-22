import http2 from "node:http2";
import { afterEach, describe, expect, test } from "bun:test";
import { CursorH2SessionPool } from "../src/adapters/cursor/h2-pool";
import {
  resetOptionalShutdownHooksForTests,
  runOptionalShutdownHooks,
} from "../src/lib/optional-shutdown-hooks";

afterEach(() => {
  resetOptionalShutdownHooksForTests();
});

async function withH2Server<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http2.createServer();
  server.on("stream", stream => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200 });
    // hold the stream open; shutdown must not depend on server cooperation
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP/2 fixture did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("CursorH2SessionPool shutdown hook (devlog 120b)", () => {
  test("first request() registers a shutdown hook that closes pooled sessions", async () => {
    await withH2Server(async baseUrl => {
      const pool = new CursorH2SessionPool();
      const stream = pool.request(baseUrl, { ":method": "POST", ":path": "/x" });
      expect(pool.size).toBe(1);
      runOptionalShutdownHooks();
      // shutdown() is fire-and-forget in the sync seam; give it a beat to settle.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(pool.size).toBe(0);
      expect(() => pool.request(baseUrl, { ":method": "POST", ":path": "/x" })).toThrow(/closed/);
      stream.destroy();
    });
  });

  test("running the hooks twice is safe (idempotent shutdown)", async () => {
    await withH2Server(async baseUrl => {
      const pool = new CursorH2SessionPool();
      pool.request(baseUrl, { ":method": "POST", ":path": "/x" }).destroy();
      runOptionalShutdownHooks();
      runOptionalShutdownHooks();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(pool.size).toBe(0);
    });
  });
});
