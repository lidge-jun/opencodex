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
 * "could not be verified (conflict|unsafe)". Where a refusal names a fix, the retry case applies
 * exactly that fix and proves the next disconnect gets through. Each case runs in its own homes.
 */

type Case =
  | "store-invalid" | "owner-mismatch" | "profile-missing" | "profile-edited" | "library-unreadable"
  | "token-backup-unsafe" | "profile-foreign" | "desktop-restore-started";
type Outcome = {
  error: string | null; retryError: string | null; receipt: string;
  root: string; library: string; profile: string; backup: string;
};

function run(kind: Case, retry = false): Outcome {
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
      const retry = ${JSON.stringify(retry)};
      const home = process.env.OPENCODEX_HOME, desktop = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      for (const dir of [home, desktop, process.env.CODEX_HOME]) fs.mkdirSync(dir, { recursive: true });
      const hash = value => crypto.createHash("sha256").update(value).digest("hex");
      const key = "ocx_data_" + "1".repeat(40);
      const owner = { serverUrl: "https://hub.example.test", apiKeyId: "fixture-key", connectedAt: "2026-09-06T00:00:00.000Z" };
      const catalog = '{"models":[]}';
      const withCodex = kind === "desktop-restore-started";
      configApi.saveConfig({ port: 10100, providers: {}, defaultProvider: "openai", runtimeRole: "client", client: {
        ...owner, managementUrl: owner.serverUrl, managementTransport: "direct", selectedClients: withCodex ? ["claude", "codex"] : ["claude"],
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN", tokenFingerprint: hash(key), protocolVersion: 1,
        catalogFingerprint: crypto.createHash("sha256").update(catalog).digest("base64url"),
      } });
      fs.writeFileSync(path.join(home, "service-api-token"), key, { mode: 0o600 });
      fs.writeFileSync(DEFAULT_CATALOG_PATH, catalog);
      const profile = path.join(desktop, "fixture.json");
      const meta = path.join(desktop, "_meta.json");
      const remote = path.join(home, "desktop-remote");
      const lockDeps = { lockPath: path.join(home, "lifecycle.sqlite") };
      const writeProfile = (name, value) => {
        fs.writeFileSync(meta, JSON.stringify({ appliedId: "fixture", entries: [{ id: "fixture", name }] }));
        fs.writeFileSync(profile, JSON.stringify(value));
      };
      const removeProfile = () => { fs.unlinkSync(profile); fs.writeFileSync(meta, JSON.stringify({ entries: [] })); };
      let fix = null;
      if (kind === "library-unreadable") {
        fs.writeFileSync(meta, "{ not json");
      } else if (kind === "store-invalid") {
        fs.mkdirSync(remote, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(remote, "state.json"), "{ not json", { mode: 0o600 });
      } else if (kind === "token-backup-unsafe") {
        fs.mkdirSync(path.join(home, "service-api-token.prev"));
      } else if (kind === "profile-foreign") {
        // One profile reaches this Home with the current key but is not named opencodex.
        writeProfile("mine", { inferenceProvider: "gateway", inferenceCredentialKind: "static",
          inferenceGatewayBaseUrl: owner.serverUrl, inferenceGatewayApiKey: key, modelDiscoveryEnabled: true });
        fix = removeProfile;
      } else {
        writeProfile("opencodex", { inferenceProvider: "gateway", inferenceCredentialKind: "static",
          inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "fixture-local-key",
          modelDiscoveryEnabled: false, inferenceModels: [] });
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
          fs.writeFileSync(meta, JSON.stringify({ entries: [{ id: "fixture", name: "renamed by hand" }] }));
          fix = () => fs.writeFileSync(meta, JSON.stringify({ appliedId: "fixture", entries: [{ id: "fixture", name: "opencodex" }] }));
        }
        if (kind === "owner-mismatch") {
          // The store was written for an earlier connection to the same Home.
          const config = configApi.loadConfig();
          config.client.connectedAt = "2026-10-01T00:00:00.000Z";
          configApi.saveConfig(config);
          // The fix the refusal names: remove that connection's profile, then move the folder aside.
          fix = () => { removeProfile(); fs.renameSync(remote, remote + ".aside"); };
        }
        if (kind === "desktop-restore-started") {
          // An earlier run restored Claude Desktop and stopped before recording desktop_restored;
          // this run's Codex restore is refused (an OpenCodex line Codex kept without its marker).
          const original = 'model_provider = "openai"\\n';
          const url = "http://127.0.0.1:10100/v1";
          const injected = original + '# Auto-injected by opencodex (undo: ocx restore)\\nopenai_base_url = "' + url + '"\\n';
          fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), original + 'openai_base_url = "' + url + '"\\n[notice]\\nhide = true\\n');
          fs.writeFileSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"), JSON.stringify({
            version: 1, originalConfig: Buffer.from(original).toString("base64"), originalProfile: null,
            injectedConfigHash: hash(injected), injectedProfileHash: null, injectedOpenaiBaseUrl: url,
            owner: { kind: "client", apiKeyId: owner.apiKeyId }, pid: 999999, timestamp: "2026-09-06T00:00:00.000Z" }));
          locks.withClientLifecycleSync(held => {
            store.writeDesktopDisconnectReceipt(held, null, { version: 1, owner, tokenFingerprint: hash(key), keepCatalog: false, phase: "prepared" });
            const restored = store.restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [hash(key)] });
            if (!restored.ok) throw new Error("fixture_restore_failed");
          }, lockDeps);
        }
      }
      (async () => {
        const attempt = async () => {
          try { await connectApi.disconnectClient({}, { lifecycleLockDeps: lockDeps }); return null; }
          catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
        };
        const error = await attempt();
        let retryError = null;
        if (retry) { if (!fix) throw new Error("no fix for " + kind); fix(); retryError = await attempt(); }
        const receipt = store.readDesktopDisconnectReceipt();
        const real = p => fs.realpathSync.native(p);
        console.log(JSON.stringify({
          error, retryError, receipt: receipt.kind === "valid" ? receipt.value.phase : receipt.kind,
          root: real(home) + "/desktop-remote", library: real(desktop), profile: real(desktop) + "/fixture.json",
          backup: path.join(home, "service-api-token.prev"),
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

  test("a store written for another connection; removing that profile and moving the folder aside clears it", () => {
    const out = run("owner-mismatch", true);
    expectNamedRefusal(out, out.root + "/state.json", "a different connection", "remove that connection's OpenCodex profile");
    expect(out.retryError).toBeNull();
  }, SPAWN_BUDGET_MS);

  test("the OpenCodex profile renamed in Claude Desktop; renaming it back clears it", () => {
    const out = run("profile-missing", true);
    expectNamedRefusal(out, out.library, "removed or renamed");
    expect(out.retryError).toBeNull();
  }, SPAWN_BUDGET_MS);

  test("the OpenCodex profile edited outside OpenCodex: no fix that would overwrite the edits silently", () => {
    const out = run("profile-edited");
    expectNamedRefusal(out, out.profile, "edited outside OpenCodex", "copy anything you want to keep");
    expect(out.error).not.toContain("aside");
  }, SPAWN_BUDGET_MS);

  test("an unreadable Claude Desktop profile list", () => {
    const out = run("library-unreadable");
    expectNamedRefusal(out, out.library, "profile list");
  }, SPAWN_BUDGET_MS);

  test("an unsafe service token backup is named as such, not as the profile list", () => {
    const out = run("token-backup-unsafe");
    expectNamedRefusal(out, out.backup, "rotation backup");
    expect(out.error).not.toContain("profile list");
  }, SPAWN_BUDGET_MS);

  test("a single profile for this Home under another name; removing it clears it", () => {
    const out = run("profile-foreign", true);
    expectNamedRefusal(out, out.library, "cannot identify it as OpenCodex's");
    expect(out.error).not.toContain("extra");
    expect(out.retryError).toBeNull();
  }, SPAWN_BUDGET_MS);
});

describe("a disconnect is rolled back only before Claude Desktop is touched (O8)", () => {
  test("a receipt whose Desktop restore already ran is kept when the Codex restore is refused", () => {
    const out = run("desktop-restore-started");
    expect(out.error).toContain("Codex journal restore was partial");
    expect(out.error).toContain("Claude Desktop restore had already started");
    expect(out.error).not.toContain("was rolled back");
    expect(out.receipt).toBe("prepared");
  }, SPAWN_BUDGET_MS);
});
