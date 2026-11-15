import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * O8: a Child whose ocx disconnect was refused by the Codex journal restore.
 *
 * Seen on 2.100.2 under the desktop app: the refusal left desktop-remote/disconnect.json at
 * phase "prepared", the client runtime then refused to start until the folder was moved
 * aside. The Codex restore now keeps Codex's own later edits (preserveConfigEdits), so these
 * scenarios refuse it with the one change it still cannot settle alone: an OpenCodex-owned
 * value someone edited. Each scenario runs in its own process because the Codex paths are fixed
 * at import.
 */

const ORIGINAL = 'model_provider = "openai"\n';
const BASE_URL = "http://127.0.0.1:10100/v1";
const INJECTED = ORIGINAL + "# Auto-injected by opencodex (undo: ocx restore)\nopenai_base_url = \"" + BASE_URL + "\"\n";
// What Codex wrote on the field machine after injection: a trusted project and notice flags.
const CODEX_LINES = '\n[notice]\nhide_full_access_warning = true\n\n[projects."/srv/work/project"]\ntrust_level = "trusted"\n';
const ROUTING_GONE = ORIGINAL + CODEX_LINES;
// Someone pointed the OpenCodex-owned base URL elsewhere: disconnect refuses and keeps the journal.
const ROUTING_EDITED = ORIGINAL + "openai_base_url = \"https://user.example/v1\"\n" + CODEX_LINES;

type Scenario = { config: string; stuckReceipt?: boolean; overlapping?: boolean };
type Outcome = {
  error: string | null; stateKind: string; gateBefore: string; gateAfter: string;
  receipt: string; desktopRoot: boolean; journal: boolean; config: string; startupRefusal: string;
  overlappingError: string | null;
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function run(scenario: Scenario): Outcome {
  const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-disconnect-recovery-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-disconnect-recovery-codex-"));
  try {
    const token = "ocx_data_" + "e".repeat(40);
    const catalog = '{"models":[]}';
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      port: 10100, providers: {}, defaultProvider: "openai", runtimeRole: "client",
      client: {
        serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test", managementTransport: "direct",
        selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "client-key-1",
        tokenFingerprint: sha(token), protocolVersion: 1, connectedAt: "2026-08-28T00:00:00.000Z",
        catalogFingerprint: createHash("sha256").update(catalog).digest("base64url"), catalogSyncedAt: "2026-08-28T00:00:00.000Z",
      },
    }));
    writeFileSync(join(opencodexHome, "service-api-token"), token + "\n", { mode: 0o600 });
    writeFileSync(join(codexHome, "opencodex-catalog.json"), catalog);
    writeFileSync(join(codexHome, "config.toml"), scenario.config);
    writeFileSync(join(codexHome, "opencodex-journal.json"), JSON.stringify({
      version: 1, originalConfig: Buffer.from(ORIGINAL).toString("base64"), originalProfile: null,
      injectedConfigHash: sha(INJECTED), injectedProfileHash: null, injectedOpenaiBaseUrl: BASE_URL,
      injectedRealtimeWsBaseUrl: null, injectedCatalogPath: null,
      owner: { kind: "client", apiKeyId: "client-key-1" }, pid: 999_999, timestamp: "2026-08-28T00:00:00.000Z",
    }));
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const connectApi = require("./src/client/connect");
      const stateApi = require("./src/client/state");
      const store = require("./src/claude/desktop-remote-store");
      const locks = require("./src/client/lifecycle-lock");
      const lockDeps = { lockPath: path.join(process.env.OPENCODEX_HOME, "lifecycle.sqlite") };
      (async () => {
        if (${JSON.stringify(scenario.stuckReceipt === true)}) {
          // The receipt 2.100.2 left behind after its refused disconnect.
          const state = stateApi.readClientConnectionState();
          const owner = { serverUrl: state.value.serverUrl, apiKeyId: state.value.apiKeyId, connectedAt: state.value.connectedAt };
          locks.withClientLifecycleSync(held => store.writeDesktopDisconnectReceipt(held, null,
            { version: 1, owner, tokenFingerprint: state.value.tokenFingerprint, keepCatalog: false, phase: "prepared" }), lockDeps);
        }
        const gateBefore = stateApi.inspectClientRotationRecoveryGate(undefined, lockDeps).kind;
        const startupRefusal = stateApi.clientStartupRefusalMessage("client_disconnect_pending");
        // A second ocx disconnect started while the first is restoring Codex.
        let overlapping = null;
        if (${JSON.stringify(scenario.overlapping === true)}) {
          const journal = require("./src/codex/journal");
          const actual = journal.restoreJournalState;
          const { spyOn } = require("bun:test");
          spyOn(journal, "restoreJournalState").mockImplementation((...args) => {
            // A second process, as a second ocx disconnect would be, while this one holds its attempt lock.
            if (!overlapping) {
              const child = require("node:child_process").spawnSync(process.execPath, ["-e", 'require("./src/client/connect").disconnectClient({}, { lifecycleLockDeps: ' + JSON.stringify(lockDeps) + ' }).then(() => console.log("OK"), e => console.log(String(e && e.message)))'], { encoding: "utf8", env: process.env });
              const said = child.stdout.trim().split(String.fromCharCode(10)).at(-1) ?? "";
              overlapping = Promise.resolve(said === "OK" ? null : said || child.stderr);
            }
            return actual(...args);
          });
        }
        let error = null;
        try { await connectApi.disconnectClient({}, { lifecycleLockDeps: lockDeps }); }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        const overlappingError = overlapping ? await overlapping : null;
        const receipt = store.readDesktopDisconnectReceipt();
        console.log(JSON.stringify({
          error,
          overlappingError,
          stateKind: stateApi.readClientConnectionState().kind,
          gateBefore,
          startupRefusal,
          gateAfter: stateApi.inspectClientRotationRecoveryGate(undefined, lockDeps).kind,
          receipt: receipt.kind === "valid" ? receipt.value.phase : receipt.kind,
          desktopRoot: fs.existsSync(path.join(process.env.OPENCODEX_HOME, "desktop-remote")),
          journal: fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json")),
          config: fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"),
        }));
      })();
    `;
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 1_000,
      env: { ...process.env, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome,
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(opencodexHome, "desktop") },
    });
    const line = child.stdout.trim().split("\n").at(-1) ?? "";
    if (child.status !== 0 || !line.startsWith("{")) throw new Error("scenario failed: " + child.status + "\n" + child.stdout + "\n" + child.stderr);
    return JSON.parse(line) as Outcome;
  } finally {
    removeTreeWithRetry(opencodexHome);
    removeTreeWithRetry(codexHome);
  }
}

describe("a refused disconnect does not block the next start (O8)", () => {
  test("the prepared receipt and its folder are rolled back, so startup's recovery gate is clean", () => {
    const out = run({ config: ROUTING_EDITED });
    expect(out.error).not.toBeNull();
    expect(out.error).toContain("still connected");
    expect(out.stateKind).toBe("connected");
    expect(out.journal).toBe(true);
    expect(out.config).toBe(ROUTING_EDITED);
    expect(out.receipt).toBe("absent");
    expect(out.desktopRoot).toBe(false);
    expect(out.gateAfter).toBe("clean");
  }, SPAWN_BUDGET_MS);

  test("upgrade path: a receipt stuck at prepared by 2.100.2 finishes on the next disconnect", () => {
    const out = run({ config: ROUTING_GONE, stuckReceipt: true });
    expect(out.gateBefore).toBe("recovery-required");
    // What the desktop supervisor logged five times on the field machine, now with its fix.
    expect(out.startupRefusal).toContain("stopped part way at phase prepared");
    expect(out.startupRefusal).toContain("Run ocx disconnect again to finish it or roll it back");
    expect(out.startupRefusal.endsWith("(code client_disconnect_pending)")).toBe(true);
    expect(out.error).toBeNull();
    expect(out.stateKind).toBe("disconnected");
    expect(out.receipt).toBe("complete");
    expect(out.config).toBe(ROUTING_GONE);
  }, SPAWN_BUDGET_MS);

  test("upgrade path: a stuck receipt whose disconnect is still refused rolls back instead of staying stuck", () => {
    const out = run({ config: ROUTING_EDITED, stuckReceipt: true });
    expect(out.gateBefore).toBe("recovery-required");
    expect(out.error).not.toBeNull();
    expect(out.stateKind).toBe("connected");
    expect(out.receipt).toBe("absent");
    expect(out.desktopRoot).toBe(false);
    expect(out.gateAfter).toBe("clean");
    expect(out.journal).toBe(true);
  }, SPAWN_BUDGET_MS);

  test("a second disconnect started during the first one's Codex restore is refused and cannot clear its receipt", () => {
    const out = run({ config: ROUTING_EDITED, overlapping: true });
    expect(out.overlappingError).toContain("another ocx disconnect is running");
    // The first attempt still owns its receipt, so its own rollback is the one that removes it.
    expect(out.error).toContain("was rolled back");
    expect(out.receipt).toBe("absent");
    expect(out.gateAfter).toBe("clean");
  }, SPAWN_BUDGET_MS);
});
