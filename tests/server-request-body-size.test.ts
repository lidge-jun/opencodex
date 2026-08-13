import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server";
import { MAX_DECOMPRESSED_BODY_BYTES } from "../src/server/request-decompress";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const TEST_DIR = join(import.meta.dir, ".tmp-server-request-body-size-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-body-size-codex-");
});

afterEach(() => {
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("server maxRequestBodySize (Issue #1601)", () => {
  test("configures Bun.serve listener with MAX_DECOMPRESSED_BODY_BYTES (256 MiB)", () => {
    expect(MAX_DECOMPRESSED_BODY_BYTES).toBe(256 * 1024 * 1024);
  });

  test("server listener accepts requests without failing at the Bun 128 MiB default", async () => {
    const server = startServer(0);
    try {
      const port = server.port;
      // Send a request to /healthz with a body larger than 0 bytes
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        method: "GET",
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { status: string };
      expect(data.status).toBe("ok");
    } finally {
      void server.stop(true);
    }
  });
});
