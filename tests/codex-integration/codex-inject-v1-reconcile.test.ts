import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

const repoRoot = resolveRepoRoot();

setDefaultTimeout(SPAWN_BUDGET_MS);

// Full injectCodexConfig runs in a subprocess with isolated CODEX_HOME/OPENCODEX_HOME so
// module-level path constants bind to the temp dirs (same pattern as codex-journal.test.ts).
function runInject(
  codexHome: string,
  ocxHome: string,
  configJson = "{}",
): { stdout: string; stderr: string; status: number } {
  const script = `
    const { injectCodexConfig } = require("./src/codex/inject");
    injectCodexConfig(10100, JSON.parse(process.env.TEST_OCX_CONFIG)).then(r => {
      console.log(JSON.stringify(r));
    });
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, TEST_OCX_CONFIG: configJson },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    status: result.status ?? 1,
  };
}

function runV1CoordinatorFailure(
  codexHome: string,
  ocxHome: string,
  failure: "commit" | "publish",
): { threw: boolean; message: string; toggles: number; sawReconcile: boolean; sawArtifactsAtCommit: boolean } {
  const script = `
    const fs = require("node:fs");
    const { join } = require("node:path");
    const { injectCodexConfig, setHistoryArtifactStageForTests, setInjectPublishCurrentTxIdForTests } = require("./src/codex/inject");
    const { setBeforeCoordinatorCommitForTests } = require("./src/codex/codex-write-lock");
    const { setCodexMultiAgentV2ToggleForTests } = require("./src/codex/inject/multi-agent-v2");
    const configPath = join(process.env.CODEX_HOME, "config.toml");
    const profilePath = join(process.env.CODEX_HOME, "opencodex.config.toml");
    const journalPath = join(process.env.CODEX_HOME, "opencodex-journal.json");
    let toggles = 0;
    let sawReconcile = false;
    let sawArtifactsAtCommit = false;
    setCodexMultiAgentV2ToggleForTests(enabled => {
      toggles += 1;
      const current = fs.readFileSync(configPath, "utf8");
      fs.writeFileSync(configPath, current.replace("multi_agent_v2 = true", "multi_agent_v2 = " + enabled));
    });
    setHistoryArtifactStageForTests(stage => {
      if (stage === "after-v1-reconcile") {
        sawReconcile = fs.readFileSync(configPath, "utf8").includes("multi_agent_v2 = false");
      }
    });
    if (process.env.TEST_FAILURE === "publish") {
      setInjectPublishCurrentTxIdForTests(() => "stale-current-tx");
    } else {
      setBeforeCoordinatorCommitForTests(() => {
        sawArtifactsAtCommit = fs.readFileSync(configPath, "utf8").includes("multi_agent_v2 = false")
          && fs.existsSync(profilePath) && fs.existsSync(journalPath);
        throw new Error("fixture coordinator commit failed");
      });
    }
    let threw = false;
    let message = "";
    try { await injectCodexConfig(10100, { multiAgentMode: "v1" }); }
    catch (error) { threw = true; message = String(error); }
    console.log(JSON.stringify({ threw, message, toggles, sawReconcile, sawArtifactsAtCommit }));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, TEST_FAILURE: failure },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

describe("injectCodexConfig v1-surface reconcile", () => {
  let codexHome: string;
  let ocxHome: string;

  beforeEach(() => {
    codexHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-inject-codex-")));
    ocxHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-inject-home-")));
  });

  afterEach(() => {
    removeTreeWithRetry(codexHome);
    removeTreeWithRetry(ocxHome);
  });

  test("inject does not turn on multi_agent_v2; fresh installs stay on Codex's default v1 surface until the user opts in", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).not.toContain("[features.multi_agent_v2]");
    expect(config).not.toContain("multi_agent_v2 = true");
    expect(config).not.toContain("multi_agent_v2 = {");
  });

  test("a v1 injection disables a pre-existing global v2 override", () => {
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.5"\n\n[features]\nmulti_agent_v2 = true\n', "utf8");
    const script = `
      const fs = require("node:fs");
      const { join } = require("node:path");
      const { injectCodexConfig } = require("./src/codex/inject");
      const { setCodexMultiAgentV2ToggleForTests } = require("./src/codex/inject/multi-agent-v2");
      const path = join(process.env.CODEX_HOME, "config.toml");
      setCodexMultiAgentV2ToggleForTests(enabled => {
        const current = fs.readFileSync(path, "utf8");
        fs.writeFileSync(path, current.replace("multi_agent_v2 = true", "multi_agent_v2 = " + enabled));
      });
      const result = await injectCodexConfig(10100, { multiAgentMode: "v1" });
      console.log(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ success: true });
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("multi_agent_v2 = false");
    expect(config).toContain("openai_base_url = ");
  });

  test("the published witness identifies the plan committed after v1 reconciliation", () => {
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.5"\n\n[features]\nmulti_agent_v2 = true\n', "utf8");
    const script = `
      const fs = require("node:fs");
      const { join } = require("node:path");
      const { readConfigAdmissionSnapshot, observeConfigGeneration } = require("./src/config");
      const { injectCodexConfig, setHistoryArtifactStageForTests } = require("./src/codex/inject");
      const { buildInjectWitness } = require("./src/codex/inject-coordination");
      const { setCodexMultiAgentV2ToggleForTests } = require("./src/codex/inject/multi-agent-v2");
      const { deriveCodexInjectionPlan } = require("./src/codex/inject/plan");
      const { standaloneCodexRoutingTarget } = require("./src/codex/inject/routing-target");
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      const config = { multiAgentMode: "v1" };
      const path = join(process.env.CODEX_HOME, "config.toml");
      const persisted = readConfigAdmissionSnapshot();
      const persistedIdentity = persisted.kind === "read" ? persisted.contentSha256 : "unreadable";
      const observed = observeConfigGeneration();
      const generation = observed.kind === "ready"
        ? { present: true, value: observed.generation.value }
        : { present: false, value: 0 };
      let expectedId;
      let expectedConfig;
      setCodexMultiAgentV2ToggleForTests(enabled => {
        const current = fs.readFileSync(path, "utf8");
        fs.writeFileSync(path, current.replace("multi_agent_v2 = true", "multi_agent_v2 = " + enabled));
      });
      setHistoryArtifactStageForTests(stage => {
        if (stage !== "after-v1-reconcile") return;
        const nativeInput = fs.readFileSync(path, "utf8");
        const plan = deriveCodexInjectionPlan(nativeInput, {
          config,
          routingTarget: standaloneCodexRoutingTarget(10100, config),
          catalogPathOption: undefined,
          journalReadOnly: false,
        });
        if (plan.kind !== "ok") throw new Error(plan.message);
        expectedConfig = plan.content;
        expectedId = buildInjectWitness(
          plan.candidate, nativeInput, persistedIdentity, generation, "unknown",
        ).comparisonId;
      });
      const result = await injectCodexConfig(10100, config);
      const state = readCodexTransitionState();
      console.log(JSON.stringify({
        result, expectedId, expectedConfig,
        publishedId: state.kind === "ready" ? state.state.historySchedule?.authoritySnapshotId : null,
        committedConfig: fs.readFileSync(path, "utf8"),
      }));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });

    expect(child.status, child.stderr).toBe(0);
    const out = JSON.parse(child.stdout);
    expect(out.result).toMatchObject({ success: true });
    expect(out.expectedId).toMatch(/^[a-f0-9]{64}$/);
    expect(out.publishedId).toBe(out.expectedId);
    expect(out.committedConfig).toBe(out.expectedConfig);
    expect(out.committedConfig).toContain("multi_agent_v2 = false");
  });

  test("a skipped v1 injection does not run the v2 reconcile or leave the file changed", () => {
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.5"\n\n[features]\nmulti_agent_v2 = true\n', "utf8");
    // Integration OFF in the OCX config snapshot the write gate reads.
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify({ clientIntegrations: { codex: false } }));
    const script = `
      const fs = require("node:fs");
      const { join } = require("node:path");
      const { injectCodexConfig } = require("./src/codex/inject");
      const { setCodexMultiAgentV2ToggleForTests } = require("./src/codex/inject/multi-agent-v2");
      const path = join(process.env.CODEX_HOME, "config.toml");
      let toggles = 0;
      setCodexMultiAgentV2ToggleForTests(() => { toggles += 1; });
      const result = await injectCodexConfig(10100, { multiAgentMode: "v1" });
      console.log(JSON.stringify({ result, toggles }));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });

    expect(child.status, child.stderr).toBe(0);
    const out = JSON.parse(child.stdout);
    expect(out.result).toMatchObject({ success: true, status: "skipped", skippedReason: "desired_disabled" });
    // The gate ran before the reconcile: no transition ran and nothing was written.
    expect(out.toggles).toBe(0);
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("multi_agent_v2 = true");
    expect(config).not.toContain("openai_base_url");
  });

  test("a post-reconcile failure restores the exact original config bytes and feature state", () => {
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.5"\n\n[features]\nmulti_agent_v2 = true\n';
    writeFileSync(configPath, original, "utf8");
    const script = `
      const fs = require("node:fs");
      const { join } = require("node:path");
      const { injectCodexConfig, setHistoryArtifactStageForTests } = require("./src/codex/inject");
      const { setCodexMultiAgentV2ToggleForTests } = require("./src/codex/inject/multi-agent-v2");
      const path = join(process.env.CODEX_HOME, "config.toml");
      setCodexMultiAgentV2ToggleForTests(enabled => {
        const current = fs.readFileSync(path, "utf8");
        fs.writeFileSync(path, current.replace("multi_agent_v2 = true", "multi_agent_v2 = " + enabled));
      });
      setHistoryArtifactStageForTests(stage => {
        // The feature transition has landed; failing here must roll it back too.
        if (stage === "after-v1-reconcile") throw new Error("injected post-reconcile failure");
      });
      try {
        const result = await injectCodexConfig(10100, { multiAgentMode: "v1" });
        console.log(JSON.stringify({ threw: false, result }));
      } catch (error) {
        console.log(JSON.stringify({ threw: true, message: String(error) }));
      }
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ threw: true });
    // Byte-exact restoration: the flag flip was rolled back with everything else.
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "opencodex-journal.json"))).toBe(false);
  });

  test("post-toggle coordinator commit failure restores preimages", () => {
    const configPath = join(codexHome, "config.toml");
    const profilePath = join(codexHome, "opencodex.config.toml");
    const originalConfig = 'model = "gpt-5.5"\n\n[features]\nmulti_agent_v2 = true\n';
    writeFileSync(configPath, originalConfig);

    const out = runV1CoordinatorFailure(codexHome, ocxHome, "commit");
    expect(out).toMatchObject({ threw: true, toggles: 1, sawReconcile: true, sawArtifactsAtCommit: true });
    expect(out.message).toContain("fixture coordinator commit failed");
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(existsSync(profilePath)).toBe(false);
    expect(existsSync(join(codexHome, "opencodex-journal.json"))).toBe(false);
  });

  test("toggle ran, publish conflict restores preimages", () => {
    const configPath = join(codexHome, "config.toml");
    const profilePath = join(codexHome, "opencodex.config.toml");
    const originalConfig = 'model = "gpt-5.5"\n\n[features]\nmulti_agent_v2 = true\n';
    writeFileSync(configPath, originalConfig);

    const out = runV1CoordinatorFailure(codexHome, ocxHome, "publish");
    expect(out).toMatchObject({ threw: true, toggles: 1, sawReconcile: true, sawArtifactsAtCommit: false });
    expect(out.message).toContain("could not be published: conflict");
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(existsSync(profilePath)).toBe(false);
    expect(existsSync(join(codexHome, "opencodex-journal.json"))).toBe(false);
  });

  test("a competing writer cannot land between the feature transition and the injection commit", () => {
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.5"\n\n[features]\nmulti_agent_v2 = true\n', "utf8");
    const script = `
      const fs = require("node:fs");
      const { join } = require("node:path");
      const { spawnSync } = require("node:child_process");
      const { injectCodexConfig, setHistoryArtifactStageForTests } = require("./src/codex/inject");
      const { setCodexMultiAgentV2ToggleForTests } = require("./src/codex/inject/multi-agent-v2");
      const path = join(process.env.CODEX_HOME, "config.toml");
      setCodexMultiAgentV2ToggleForTests(enabled => {
        const current = fs.readFileSync(path, "utf8");
        fs.writeFileSync(path, current.replace("multi_agent_v2 = true", "multi_agent_v2 = " + enabled));
      });
      let competitor = null;
      setHistoryArtifactStageForTests(stage => {
        if (stage !== "after-v1-reconcile") return;
        // The transition has landed and the commit has not: a second injection on
        // the same home must be serialized by the write lock, never admitted.
        const grandchild = spawnSync(process.execPath, ["--eval", \`
          const { injectCodexConfig } = require("./src/codex/inject");
          injectCodexConfig(10100, { multiAgentMode: "v1" }, { lockTimeoutMs: 800 }).then(r => {
            console.log(JSON.stringify(r));
          });
        \`], {
          cwd: ${JSON.stringify(repoRoot)},
          env: { ...process.env },
          encoding: "utf8",
          timeout: 30000,
        });
        competitor = {
          status: grandchild.status,
          stdout: (grandchild.stdout || "").trim(),
          stderr: (grandchild.stderr || "").trim(),
        };
      });
      const result = await injectCodexConfig(10100, { multiAgentMode: "v1" });
      console.log(JSON.stringify({ result, competitor }));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });

    expect(child.status, child.stderr).toBe(0);
    const out = JSON.parse(child.stdout);
    expect(out.result).toMatchObject({ success: true });
    expect(out.competitor.status).toBe(0);
    expect(JSON.parse(out.competitor.stdout).success).toBe(false);
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("multi_agent_v2 = false");
    expect(config).toContain("openai_base_url = ");
  });
});
