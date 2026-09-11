import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync} from "node:fs";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { MAX_DECOMPRESSED_BODY_BYTES } from "../../src/server/request-decompress";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

describe("configurable listener body size (Issue #3573)", () => {
  const BODY_BYTES = 2 * 1024 * 1024;

  // Bun refuses an oversized body BEFORE fetch() runs, so a listener pinned to the 256 MiB
  // default would silently cap the opt-in no matter what the handlers do with it. Proving the
  // listener moved is cheaper downward than upward: the same 2 MiB body is admitted under the
  // default and refused under a 1 MiB configured limit.
  async function postFixedBody(port: number): Promise<{ refused: boolean; status: number | null }> {
    // Bun answers 413 and stops reading while the client is still uploading, so the write side
    // can surface the refusal as a transport error instead of a response. Both shapes mean the
    // listener refused the body; neither can be produced by admitting it.
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Buffer.alloc(BODY_BYTES, 0x20),
    }).catch(() => null);
    if (!res) return { refused: true, status: null };
    const status = res.status;
    await res.text().catch(() => "");
    return { refused: status === 413, status };
  }

  test("a body under the configured limit still reaches the handler", async () => {
    saveConfig({ ...getDefaultConfig(), maxInboundBodyBytes: 8 * 1024 * 1024 });
    const server = startServer(0);
    try {
      const result = await postFixedBody(server.port);
      // Unparseable JSON, so the handler answers 4xx — the point is that it answered at all.
      expect(result.refused).toBe(false);
      expect(result.status).not.toBeNull();
    } finally {
      void server.stop(true);
    }
  });

  test("the listener refuses above maxInboundBodyBytes instead of the fixed default", async () => {
    // The old listener was pinned to MAX_DECOMPRESSED_BODY_BYTES, so this body reached the
    // handler regardless of config. It must now be refused before the handler runs.
    saveConfig({ ...getDefaultConfig(), maxInboundBodyBytes: 1024 * 1024 });
    expect(1024 * 1024).toBeLessThan(BODY_BYTES);
    const server = startServer(0);
    try {
      expect((await postFixedBody(server.port)).refused).toBe(true);
    } finally {
      void server.stop(true);
    }
  });
});
