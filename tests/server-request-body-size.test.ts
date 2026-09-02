import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync} from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server";
import { MAX_DECOMPRESSED_BODY_BYTES } from "../src/server/request-decompress";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-server-request-body-size-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-body-size-codex-");
});

afterEach(() => {
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("server maxRequestBodySize (Issue #1601)", () => {
  test("configures Bun.serve listener with MAX_DECOMPRESSED_BODY_BYTES (256 MiB)", () => {
    expect(MAX_DECOMPRESSED_BODY_BYTES).toBe(256 * 1024 * 1024);
  });

  test("server listener accepts requests without failing at the Bun 128 MiB default", async () => {
    const server = startServer(0);
    try {
      const port = server.port;
      // Send a POST with a body above Bun's 128 MiB default but below our 256 MiB limit.
      // Use a 129 MiB body to prove the raised maxRequestBodySize is effective.
      const bodySize = 129 * 1024 * 1024;
      const body = Buffer.alloc(bodySize, 0x20); // ASCII spaces
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      // The request should NOT get an empty 413 from Bun's default limit.
      // It will get a 4xx from our handler (bad JSON, missing auth, etc.) — that's fine,
      // the point is that Bun accepted the body instead of rejecting at 128 MiB.
      expect(res.status).not.toBe(413);
      // Drain the response so the connection closes cleanly.
      await res.text();
    } finally {
      void server.stop(true);
    }
  });
});
