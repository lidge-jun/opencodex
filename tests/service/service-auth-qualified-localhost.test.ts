import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { assertServiceAuthEnvironment, writeServiceApiTokenFile } from "../../src/service";
import { serviceApiTokenFilePath } from "../../src/lib/service-secrets";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Fully-qualified `localhost.` is the same bind as `localhost`: the server canonicalizes both
 * to 127.0.0.1, so the service guards must classify it as loopback too. When the private copy
 * of that predicate in src/service/guards.ts did not strip the trailing dot, `localhost.` took
 * the remote-bind path — install demanded a usable data-plane token file for a listener that
 * requires no admission credential at all. Lives beside service.test.ts because that file is
 * at its committed size cap in tests/fixtures/file-size-baseline.json.
 */
const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-service-auth-qualified-localhost-"));
const previousOpenCodexHome = process.env.OPENCODEX_HOME;
const previousApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;

function installConfig(hostname: string): void {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  saveConfig({
    port: 10100,
    hostname,
    providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" } },
    defaultProvider: "openai",
  } as OcxConfig);
}

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiAuthToken;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("service install auth preflight", () => {
  test("a fully-qualified loopback bind needs no data-plane token and provisions none", () => {
    for (const hostname of ["localhost", "localhost."]) {
      installConfig(hostname);

      expect(() => assertServiceAuthEnvironment()).not.toThrow();
      // Loopback installs create no credential: admission is not required, and on a
      // hub-connected machine this file holds the hub's issued client key instead.
      expect(writeServiceApiTokenFile()).toBeNull();
      expect(existsSync(serviceApiTokenFilePath())).toBe(false);
    }
  });

  test("an unusable token file on a fully-qualified loopback bind does not block install", () => {
    for (const hostname of ["localhost", "localhost."]) {
      installConfig(hostname);
      // Empty-after-trim reads as "unsafe" — the state a remote bind refuses at preflight.
      writeFileSync(serviceApiTokenFilePath(), "\n", "utf8");

      expect(() => assertServiceAuthEnvironment()).not.toThrow();
      // The writer leaves the file for the operator rather than throwing or replacing it.
      expect(writeServiceApiTokenFile()).toBeNull();
      expect(readFileSync(serviceApiTokenFilePath(), "utf8")).toBe("\n");
    }
  });
});
