import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { serverAuthConfig as config } from "../helpers/server-auth-config";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-server-auth-localhost-"));
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-auth-codex-");
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("server local API auth", () => {
  test("fully-qualified localhost binds to the same IPv4 target generated for clients", async () => {
    saveConfig(config("localhost."));
    const server = startServer(0);
    try {
      expect(server.hostname).toBe("127.0.0.1");
    } finally {
      await server.stop(true);
    }
  });
});
