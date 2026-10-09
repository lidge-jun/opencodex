import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

let home: TempHome;
setDefaultTimeout(SPAWN_BUDGET_MS);
beforeEach(() => { home = createTempHome("ocx-missing-home-"); });
afterEach(() => { home.remove(); });

function run<T>(body: string, explicit = true): { value: T; stderr: string } {
  const child = Bun.spawnSync([process.execPath, "-e", `
    (async () => {
      const value = await (async () => { ${body} })();
      console.log("RESULT:" + JSON.stringify(value));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: repoRoot(),
    env: { ...process.env, HOME: home.root, USERPROFILE: home.root,
      CODEX_HOME: explicit ? home.codexHome : "", ORCA_CODEX_HOME: "",
      CODEX_SQLITE_HOME: "", OPENCODEX_HOME: home.configDir,
      GROK_HOME: home.path("grok"), XDG_CONFIG_HOME: home.path("xdg") },
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  const stderr = child.stderr.toString();
  expect(child.exitCode, stderr).toBe(0);
  const line = child.stdout.toString().split("\n").find(line => line.startsWith("RESULT:"));
  expect(line, stderr).toBeDefined();
  return { value: JSON.parse(line!.slice(7)) as T, stderr };
}

function expectAbsent(): void {
  expect(existsSync(home.codexHome)).toBe(false);
  expect(existsSync(join(home.codexHome, "config.toml.ocx-write.lock"))).toBe(false);
}

for (const explicit of [true, false]) {
  for (const name of ["restoreNativeCodex", "restoreNativeCodexAsync"]) {
    test(`${name} skips a missing ${explicit ? "explicit" : "default"} home without creating it`, () => {
      const { value } = run<{ success: boolean; artifacts: Record<string, { state: string; changed: boolean }> }>(`
        const restore = require("./src/codex/inject/restore");
        return await restore.${name}();
      `, explicit);
      expect(value.success).toBe(true);
      for (const artifact of Object.values(value.artifacts)) {
        expect(artifact.state).toBe("skipped");
        expect(artifact.changed).toBe(false);
      }
      expectAbsent();
    });
  }
}

test("stop restore succeeds and emits no failure when Codex home is absent", () => {
  const { value, stderr } = run(`
    const { restoreSharedClientStateAfterStop } = require("./src/cli/stop-restore");
    return await restoreSharedClientStateAfterStop(() => { throw new Error("unexpected retained table"); });
  `);
  expect(value).toEqual({ historyOnly: false, historyDeferred: false, other: false });
  expect(stderr).toBe("");
  expectAbsent();
});

test("remove and journal recovery retain their nothing-to-restore results", () => {
  const { value } = run<{ removed: { success: boolean }; journal: { complete: boolean; unverified: boolean }; reconciled: boolean }>(`
    const { removeCodexConfig } = require("./src/codex/inject/remove");
    const { restoreJournalState, reconcileJournal } = require("./src/codex/journal");
    return { removed: removeCodexConfig(), journal: restoreJournalState(), reconciled: reconcileJournal() };
  `);
  expect(value.removed.success).toBe(true);
  expect(value.journal.complete).toBe(false);
  expect(value.journal.unverified).toBe(false);
  expect(value.reconciled).toBe(false);
  expectAbsent();
});

test("injection preserves the pre-6811 missing-home refusal and creates nothing", () => {
  const { value } = run<{ success: boolean; message: string }>(`
    return await require("./src/codex/inject").injectCodexConfig(19751, {}, {});
  `, false);
  expect(value.success).toBe(false);
  expect(value.message).toContain("does not exist yet");
  expect(value.message).toContain("Start Codex once");
  expectAbsent();
});

test("injection still creates config.toml when the home already exists", () => {
  mkdirSync(home.codexHome);
  const { value } = run<{ success: boolean }>(`
    return await require("./src/codex/inject").injectCodexConfig(19751, {}, {});
  `);
  expect(value.success).toBe(true);
  expect(readFileSync(join(home.codexHome, "config.toml"), "utf8")).toContain("opencodex");
});

test("prompt projection retains its missing-home and config creation", () => {
  const { value } = run<{ ok: boolean }>(`
    const prompts = require("./src/codex/prompt-layers");
    const path = require("node:path");
    const paths = { configPath: path.join(process.env.CODEX_HOME, "config.toml"),
      storePath: path.join(process.env.CODEX_HOME, "opencodex-prompt.json") };
    return prompts.setToggle("apps", false, prompts.readPromptLayers(paths).revision, paths);
  `);
  expect(value.ok).toBe(true);
  expect(readFileSync(join(home.codexHome, "config.toml"), "utf8")).toContain("include_apps_instructions = false");
  expect(existsSync(join(home.codexHome, "config.toml.ocx-write.lock"))).toBe(false);
});

test("prompt recovery with no journal does not create the missing home", () => {
  const { value } = run(`
    const path = require("node:path");
    return require("./src/codex/prompt-journal").recoverIfNeeded(path.join(process.env.CODEX_HOME, "prompt.journal"), {
      configPath: path.join(process.env.CODEX_HOME, "config.toml"),
      storePath: path.join(process.env.CODEX_HOME, "prompt.json") });
  `);
  expect(value).toEqual({ ok: true, action: "none" });
  expectAbsent();
});

test("management native feature toggle prepares the home and holds the lock before spawning", () => {
  const { value } = run<{ status: number; locked: boolean }>(`
    const fs = require("node:fs"), path = require("node:path");
    const { handleAgentSettingsRoutes } = require("./src/server/management/agent-settings-routes");
    const url = new URL("http://localhost/api/codex-auth/features/default-mode-request-user-input");
    const req = new Request(url, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    let locked = false;
    const response = await handleAgentSettingsRoutes({ req, url, config: {},
      deps: { toggleDefaultModeRequestUserInput: (enabled, env, validate) => {
        validate();
        locked = fs.existsSync(path.join(env.CODEX_HOME, "config.toml.ocx-write.lock"));
        fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), "[features]\\ndefault_mode_request_user_input = true\\n");
      } }, version: "fixture", trustedLoopbackIngress: true, guiSessionIssuance: null,
      convergeCodexCatalog: async () => {}, syncClaudeAgentDefsBestEffort: async () => {} });
    return { status: response.status, locked };
  `);
  expect(value).toEqual({ status: 200, locked: true });
  expect(existsSync(join(home.codexHome, "config.toml"))).toBe(true);
  expect(existsSync(join(home.codexHome, "config.toml.ocx-write.lock"))).toBe(false);
});

test("lock acquisition returns a handled missing-parent failure without creating it", () => {
  const { value } = run(`
    const lock = require("./src/codex/config-write-lock");
    const path = require("node:path").join(process.env.CODEX_HOME, "config.toml");
    return { sync: lock.withConfigWriteLock(path, () => { throw new Error("acquired"); }),
      async: await lock.acquireConfigWriteLock(path) };
  `);
  expect(value).toEqual({ sync: { ok: false, error: "missing-parent", detail: home.codexHome },
    async: { ok: false, error: "missing-parent", detail: home.codexHome } });
  expectAbsent();
});

test("scalar and multi-agent feature edits still refuse an unreadable config", () => {
  const { value } = run(`
    const features = require("./src/codex/features");
    const path = require("node:path").join(process.env.CODEX_HOME, "config.toml");
    return [features.setAgentsEnabled(true, path), features.transitionMultiAgentV2(true,
      () => { throw new Error("must not spawn"); }, { configPath: path })];
  `);
  expect(value).toEqual(Array(2).fill({ ok: false, error: `config.toml not readable at ${join(home.codexHome, "config.toml")}` }));
  expectAbsent();
});

test.skipIf(process.platform === "win32")("a dangling home symlink is refused rather than treated as absent", () => {
  symlinkSync(home.path("missing-target"), home.codexHome);
  const { value } = run<string>(`
    try { require("./src/codex/inject/restore").restoreNativeCodex(); return "unexpected success"; }
    catch (error) { return String(error); }
  `);
  expect(value).toContain("could not be read");
  expect(existsSync(home.path("missing-target"))).toBe(false);
});
