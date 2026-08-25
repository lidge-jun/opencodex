import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  createPackageTreeIntegrityGuard,
  type PackageTreeObservation,
} from "../src/lib/package-tree-integrity";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const TEST_DIR = join(import.meta.dir, ".tmp-package-tree-integrity");
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-package-tree-integrity-");
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("package tree integrity", () => {
  test("detects replacement even when the package version and file size are unchanged", () => {
    let observation: PackageTreeObservation = {
      device: 1n,
      inode: 10n,
      changeTimeNs: 100n,
      size: 500n,
    };
    const guard = createPackageTreeIntegrityGuard(() => observation);

    expect(guard.status()).toEqual({ ok: true });

    observation = { ...observation, inode: 11n, changeTimeNs: 200n };
    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
  });

  test("fails closed when the package manifest disappears", () => {
    let observation: PackageTreeObservation | null = {
      device: 1n,
      inode: 10n,
      changeTimeNs: 100n,
      size: 500n,
    };
    const guard = createPackageTreeIntegrityGuard(() => observation);
    observation = null;

    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_unreadable" });
  });

  test("degrades health and refuses Responses requests with a restart-required error", async () => {
    saveConfig(config());
    const packageTreeIntegrity = {
      status: () => ({ ok: false as const, reason: "package_tree_replaced" as const }),
    };
    const server = startServer(0, { packageTreeIntegrity });
    try {
      const health = await fetch(new URL("/healthz", server.url));
      expect(health.status).toBe(503);
      expect(health.headers.get("retry-after")).toBe("5");
      expect(await health.json()).toMatchObject({
        status: "restart_required",
        service: "opencodex",
        error: { code: "package_tree_changed" },
      });

      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test/gpt-test", input: "hello" }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toMatchObject({
        error: {
          type: "server_error",
          code: "package_tree_changed",
          message: expect.stringContaining("restart"),
        },
      });
    } finally {
      await server.stop(true);
    }
  });
});
