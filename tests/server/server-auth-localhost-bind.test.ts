import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer, waitForFailedStartRollback } from "../../src/server";
import { stopServerListener } from "../../src/server/lifecycle";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { serverAuthConfig as config } from "../helpers/server-auth-config";
import { currentServerFixtureConfig, settleServerAuthFixture } from "../helpers/server-auth-fixture";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-server-auth-localhost-"));
let isolatedCodexHome: IsolatedCodexHome | null = null;
let server: ReturnType<typeof startServer> | null = null;

beforeEach(async () => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-auth-codex-");
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  // Binding a hostname does not exercise native client synchronization. Keep real
  // listener/auth/ACL setup while excluding the host's installed service identity.
  saveConfig(currentServerFixtureConfig({ ...config("localhost."), clientIntegrations: { codex: false } }));
  try {
    server = startServer(0, {
      inspectNativeCodexOwnership: ownedServiceHomeInspection("localhost bind sandbox"),
    });
  } catch (error) {
    await waitForFailedStartRollback(error);
    throw error;
  }
});

afterEach(async () => {
  if (server) await stopServerListener(server);
  server = null;
  await settleServerAuthFixture(TEST_DIR, isolatedCodexHome?.path);
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
    expect(server!.hostname).toBe("127.0.0.1");
  });
});
