import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

/**
 * Every subprocess in this file runs against a private temp OPENCODEX_HOME so no
 * check can ever discover/inspect/mutate the operator's real proxy state. The
 * ready describe keeps ONLY the help-routing subprocess checks: the
 * network/no-proxy/argument-validation ready tests live as injected tests in
 * tests/cli-ready.test.ts (no real loopback/home).
 */
function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10000,
  });
}

function isolatedHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeIsolatedConfig(dir: string): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    port: 19999,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    defaultProvider: "openai",
    codexAutoStart: false,
  }), "utf8");
}

describe("ocx restart", () => {
  test("restart --help prints usage", () => {
    const dir = isolatedHome("ocx-restart-help-");
    try {
      const result = runCli(["restart", "--help"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ocx restart");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("help restart shows restart help entry", () => {
    const dir = isolatedHome("ocx-restart-help-entry-");
    try {
      const result = runCli(["help", "restart"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Stop the proxy and restart");
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});

describe("ocx health", () => {
  test("health --help prints usage", () => {
    const dir = isolatedHome("ocx-health-help-");
    try {
      const result = runCli(["health", "--help"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ocx health");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("help health shows health help entry", () => {
    const dir = isolatedHome("ocx-health-help-entry-");
    try {
      const result = runCli(["help", "health"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Check proxy health");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("health exits 1 with no proxy running (isolated home)", () => {
    const dir = isolatedHome("ocx-health-");
    writeIsolatedConfig(dir);
    try {
      const result = runCli(["health"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("not healthy");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("health --json exits 1 with valid JSON when no proxy", () => {
    const dir = isolatedHome("ocx-health-json-");
    writeIsolatedConfig(dir);
    try {
      const result = runCli(["health", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.pid).toBeNull();
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});

describe("ocx ready", () => {
  // Only the help-routing subprocess checks live here. The default-probe,
  // --json, --wait, --timeout, and argument-validation cases are injected tests
  // in tests/cli-ready.test.ts (no real loopback/home).
  test("ready --help prints usage (exit 0)", () => {
    const dir = isolatedHome("ocx-ready-help-");
    try {
      const result = runCli(["ready", "--help"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ocx ready");
      expect(result.stdout).toContain("--wait");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("help ready shows the ready help entry", () => {
    const dir = isolatedHome("ocx-ready-help-entry-");
    try {
      const result = runCli(["help", "ready"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("post-sync readiness");
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});
