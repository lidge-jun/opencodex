import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * O7: every desktop_lifecycle_unsafe refusal from ocx disconnect names the path or condition and
 * the fix, and keeps the code at the end. Before, all of these printed a bare
 * "could not be verified (conflict|unsafe)". Each case runs in its own homes and process.
 */

type Case = "store-invalid" | "owner-mismatch" | "profile-missing" | "profile-edited" | "library-unreadable";
type Outcome = { error: string | null; root: string; library: string; profile: string };

function run(kind: Case): Outcome {
  const root = mkdtempSync(join(tmpdir(), "ocx-disconnect-desktop-refusal-"));
  try {
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const crypto = require("node:crypto");
      const configApi = require("./src/config");
      const connectApi = require("./src/client/connect");
      const store = require("./src/claude/desktop-remote-store");
      const locks = require("./src/client/lifecycle-lock");
      const { DEFAULT_CATALOG_PATH } = require("./src/codex/paths");
      const kind = ${JSON.stringify(kind)};
      const home = process.env.OPENCODEX_HOME, desktop = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      for (const dir of [home, desktop, process.env.CODEX_HOME]) fs.mkdirSync(dir, { recursive: true });
      const hash = value => crypto.createHash("sha256").update(value).digest("hex");
      const key = "ocx_data_" + "1".repeat(40);
      const owner = { serverUrl: "https://hub.example.test", apiKeyId: "fixture-key", connectedAt: "2026-09-06T00:00:00.000Z" };
      const catalog = '{"models":[]}';
      configApi.saveConfig({ port: 10100, providers: {}, defaultProvider: "openai", runtimeRole: "client", client: {
        ...owner, managementUrl: owner.serverUrl, managementTransport: "direct", selectedClients: ["claude"],
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN", tokenFingerprint: hash(key), protocolVersion: 1,
        catalogFingerprint: crypto.createHash("sha256").update(catalog).digest("base64url"),
      } });
      fs.writeFileSync(path.join(home, "service-api-token"), key, { mode: 0o600 });
      fs.writeFileSync(DEFAULT_CATALOG_PATH, catalog);
      const profile = path.join(desktop, "fixture.json");
      const lockDeps = { lockPath: path.join(home, "lifecycle.sqlite") };
      if (kind === "library-unreadable") {
        fs.writeFileSync(path.join(desktop, "_meta.json"), "{ not json");
      } else if (kind === "store-invalid") {
        fs.mkdirSync(path.join(home, "desktop-remote"), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(home, "desktop-remote", "state.json"), "{ not json", { mode: 0o600 });
      } else {
        fs.writeFileSync(path.join(desktop, "_meta.json"), JSON.stringify({ appliedId: "fixture", entries: [{ id: "fixture", name: "opencodex" }] }));
        fs.writeFileSync(profile, JSON.stringify({ inferenceProvider: "gateway", inferenceCredentialKind: "static",
          inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "fixture-local-key",
          modelDiscoveryEnabled: false, inferenceModels: [] }));
        const applied = locks.withClientLifecycleSync(held => store.applyRemoteDesktopStore(held, {
          owner, expectedTokenFingerprint: hash(key), baseUrl: owner.serverUrl, apiKey: key, mode: "static",
          models: [{ name: "claude-opus-4-8-20260101", labelOverride: "Fixture", anthropicFamilyTier: "opus" }],
        }), lockDeps);
        if (!applied.ok) throw new Error("fixture_desktop_apply_failed " + JSON.stringify(applied));
        if (kind === "profile-edited") {
          const value = JSON.parse(fs.readFileSync(profile, "utf8"));
          value.inferenceModels = [];
          fs.writeFileSync(profile, JSON.stringify(value));
        }
        if (kind === "profile-missing") {
          fs.writeFileSync(path.join(desktop, "_meta.json"), JSON.stringify({ entries: [{ id: "fixture", name: "renamed by hand" }] }));
        }
        if (kind === "owner-mismatch") {
          // The store was written for an earlier connection to the same Home.
          const config = configApi.loadConfig();
          config.client.connectedAt = "2026-10-01T00:00:00.000Z";
          configApi.saveConfig(config);
        }
      }
      (async () => {
        let error = null;
        try { await connectApi.disconnectClient({}, { lifecycleLockDeps: lockDeps }); }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        console.log(JSON.stringify({
          error, root: fs.realpathSync.native(home) + "/desktop-remote",
          library: fs.realpathSync.native(desktop), profile: fs.realpathSync.native(desktop) + "/fixture.json",
        }));
      })();
    `;
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 1_000,
      env: { ...process.env, OPENCODEX_HOME: join(root, "home"), CODEX_HOME: join(root, "codex"),
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(root, "desktop") },
    });
    const line = child.stdout.trim().split("\n").at(-1) ?? "";
    if (child.status !== 0 || !line.startsWith("{")) throw new Error("scenario failed: " + child.status + "\n" + child.stdout + "\n" + child.stderr);
    return JSON.parse(line) as Outcome;
  } finally {
    removeTreeWithRetry(root);
  }
}

function expectNamedRefusal(out: Outcome, ...parts: string[]): void {
  expect(out.error).not.toBeNull();
  for (const part of parts) expect(out.error).toContain(part);
  expect(out.error).toContain("then run ocx disconnect again");
  expect(out.error!.endsWith("(code desktop_lifecycle_unsafe)")).toBe(true);
}

describe("desktop_lifecycle_unsafe names its cause and fix (O7)", () => {
  test("an unreadable store file", () => {
    const out = run("store-invalid");
    expectNamedRefusal(out, out.root, "cannot read safely");
  }, SPAWN_BUDGET_MS);

  test("a store written for another connection", () => {
    const out = run("owner-mismatch");
    expectNamedRefusal(out, out.root + "/state.json", "a different connection");
  }, SPAWN_BUDGET_MS);

  test("the OpenCodex profile removed or renamed in Claude Desktop", () => {
    const out = run("profile-missing");
    expectNamedRefusal(out, out.library, "removed or renamed");
  }, SPAWN_BUDGET_MS);

  test("the OpenCodex profile edited outside OpenCodex", () => {
    const out = run("profile-edited");
    expectNamedRefusal(out, out.profile, "edited outside OpenCodex");
  }, SPAWN_BUDGET_MS);

  test("an unreadable Claude Desktop profile list", () => {
    const out = run("library-unreadable");
    expectNamedRefusal(out, out.library, "profile list");
  }, SPAWN_BUDGET_MS);
});
