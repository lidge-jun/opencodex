// #7425: `ocx sync` re-runs Codex config injection, which must refresh only what OpenCodex owns in
// config.toml. Every case runs the real injector in a child process whose HOME, CODEX_HOME,
// OPENCODEX_HOME and CLAUDE_CONFIG_DIR all point into a fresh temporary directory, and the suite
// asserts that the parent test process's Codex home was left byte-for-byte alone.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  MANAGED_SUBAGENT_DEFAULT_MARKER,
  transformManagedSubagentDefaults,
} from "../../src/codex/subagent-defaults";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

const managedConfig = (injectionModel: string, injectionEffort = "high") => ({
  port: 10100,
  providers: {},
  defaultProvider: "openai",
  injectionModel,
  injectionEffort,
  syncCodexSubagentDefaults: true,
});

/** The runner/preload isolates this parent's HOME; children must leave it unchanged too. */
function parentCodexHomeFingerprint(): string {
  const parentHome = join(process.env.HOME || homedir(), ".codex");
  return ["config.toml", "opencodex-journal.json", "opencodex.config.toml"].map(name => {
    const path = join(parentHome, name);
    if (!existsSync(path)) return name + ":absent";
    const stat = statSync(path);
    return name + ":" + stat.size + ":" + Bun.hash(readFileSync(path)).toString(16);
  }).join("|");
}

let sandbox: string;
let codexHome: string;
let configPath: string;
let parentBefore: string;

beforeAll(() => { parentBefore = parentCodexHomeFingerprint(); });
afterAll(() => { expect(parentCodexHomeFingerprint()).toBe(parentBefore); });

beforeEach(() => {
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-sync-user-edits-")));
  codexHome = join(sandbox, "home", ".codex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(join(sandbox, "opencodex"), { recursive: true });
  mkdirSync(join(sandbox, "claude"), { recursive: true });
  configPath = join(codexHome, "config.toml");
});
afterEach(() => removeTreeWithRetry(sandbox));

/** Run `body` (an async function body) against the isolated home; it may return JSON. */
function inSandbox(body: string): unknown {
  const script = [
    'const fs = require("node:fs");',
    'const inject = require("./src/codex/inject");',
    'const paths = require("./src/codex/paths");',
    "(async () => {",
    "  const out = await (async () => {" + body + "})();",
    "  console.log(JSON.stringify({ configPath: paths.CODEX_CONFIG_PATH, out }));",
    "})().catch(error => { console.error(error); process.exit(1); });",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      HOME: join(sandbox, "home"),
      USERPROFILE: join(sandbox, "home"),
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: join(sandbox, "opencodex"),
      CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
    },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  if (result.status !== 0) throw new Error("sandboxed injection failed: " + result.stderr);
  const parsed = JSON.parse(result.stdout.trim().split("\n").pop()!) as { configPath: string; out: unknown };
  // paths.ts canonicalizes CODEX_HOME (/var aliases on macOS, short/case paths on Windows).
  // Compare the exact existing file as well as the separator-bounded sandbox directory.
  const childConfigPath = realpathSync.native(parsed.configPath);
  expect(childConfigPath).toBe(realpathSync.native(configPath));
  expect(childConfigPath.startsWith(sandbox + sep)).toBe(true);
  return parsed.out;
}

const sync = (injectionModel: string, injectionEffort = "high") =>
  "return inject.injectCodexConfig(10100, " + JSON.stringify(managedConfig(injectionModel, injectionEffort)) + ", { catalogPath: null });";

describe("ocx sync preserves user edits in config.toml (#7425)", () => {
  test("a user's root model_context_window survives repeated sync and restore", () => {
    writeFileSync(configPath, 'model = "gpt-5.5"\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n');
    inSandbox(sync("gpt-5.6-sol"));
    inSandbox(sync("gpt-5.6-sol"));
    const synced = readFileSync(configPath, "utf8");
    expect(synced).toContain("model_context_window = 1000000\n");
    expect(synced).toContain("model_auto_compact_token_limit = 900000\n");
    expect(synced).toContain("openai_base_url");
    inSandbox("return inject.removeCodexConfig();");
    const restored = readFileSync(configPath, "utf8");
    expect(restored).toContain("model_context_window = 1000000\n");
    expect(restored).not.toContain("openai_base_url");
  });

  test("an untouched managed sub-agent default still follows the OpenCodex setting", () => {
    writeFileSync(configPath, 'model = "gpt-5.5"\n');
    inSandbox(sync("gpt-5.6-sol"));
    inSandbox(sync("gpt-5.6-luna"));
    const agents = Bun.TOML.parse(readFileSync(configPath, "utf8")).agents as Record<string, unknown>;
    expect(agents.default_subagent_model).toBe("gpt-5.6-luna");
    expect(readFileSync(configPath, "utf8")).toContain(MANAGED_SUBAGENT_DEFAULT_MARKER + '\ndefault_subagent_model = "gpt-5.6-luna"');
    const journal = JSON.parse(readFileSync(join(codexHome, "opencodex-journal.json"), "utf8"));
    expect(journal.injectedSubagentDefaults).toEqual({
      default_subagent_model: "gpt-5.6-luna",
      default_subagent_reasoning_effort: "high",
    });
  });

  test("a managed sub-agent default the user edited in place is adopted, not reverted", () => {
    writeFileSync(configPath, 'model = "gpt-5.5"\n');
    inSandbox(sync("gpt-5.6-sol"));
    // The user (or a comment-preserving settings writer) changes the value and keeps our marker.
    writeFileSync(configPath, readFileSync(configPath, "utf8")
      .replace('default_subagent_model = "gpt-5.6-sol"', 'default_subagent_model = "user/picked-model"'));
    const result = inSandbox(sync("gpt-5.6-sol")) as { nativeSubagentDefaultsWarning?: string };
    const synced = readFileSync(configPath, "utf8");
    const agents = Bun.TOML.parse(synced).agents as Record<string, unknown>;
    expect(agents.default_subagent_model).toBe("user/picked-model");
    // The stale ownership claim on the edited line is gone, so later syncs read it as the user's.
    expect(synced).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER + '\ndefault_subagent_model');
    expect(result.nativeSubagentDefaultsWarning).toContain("user-owned agents.default_subagent_model preserved");
    inSandbox(sync("gpt-5.6-sol"));
    expect(readFileSync(configPath, "utf8")).toBe(synced);
    inSandbox("return inject.removeCodexConfig();");
    const restored = Bun.TOML.parse(readFileSync(configPath, "utf8")).agents as Record<string, unknown>;
    expect(restored.default_subagent_model).toBe("user/picked-model");
  });
});

describe.each(["restoreNativeCodex", "restoreNativeCodexAsync"] as const)("%s respects the latest default ownership evidence", restore => {
  test.each(["model", "effort"] as const)("preserves a user-edited %s even when bytes match the first injection", field => {
    const key = field === "model" ? "default_subagent_model" : "default_subagent_reasoning_effort";
    const firstValue = field === "model" ? "gpt-5.6-sol" : "high";
    const nextValue = field === "model" ? "gpt-5.6-luna" : "low";
    writeFileSync(configPath, 'model = "gpt-5.5"\n');
    inSandbox(sync("gpt-5.6-sol"));
    const firstInjected = readFileSync(configPath, "utf8");
    inSandbox(sync(field === "model" ? nextValue : "gpt-5.6-sol", field === "effort" ? nextValue : "high"));
    const journal = JSON.parse(readFileSync(join(codexHome, "opencodex-journal.json"), "utf8"));
    expect(journal.injectedSubagentDefaults[key]).toBe(nextValue);
    writeFileSync(configPath, readFileSync(configPath, "utf8")
      .replace(`${key} = ${JSON.stringify(nextValue)}`, `${key} = ${JSON.stringify(firstValue)}`));
    expect(readFileSync(configPath, "utf8")).toBe(firstInjected);

    const result = inSandbox("return inject." + restore + "();") as {
      success: boolean; artifacts: { config: { action: string } };
    };
    expect(result.success).toBe(true);
    const restored = readFileSync(configPath, "utf8");
    const agents = Bun.TOML.parse(restored).agents as Record<string, unknown> | undefined;
    expect(agents?.[key]).toBe(firstValue);
    expect(result.artifacts.config.action).toBe("owned-fields-stripped");
    expect(restored).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER + "\n" + key);
    expect(restored).not.toContain("openai_base_url");
  });

  test("restores the exact snapshot after managed defaults legitimately cycle back", () => {
    const original = 'model = "gpt-5.5"\n';
    writeFileSync(configPath, original);
    inSandbox(sync("gpt-5.6-sol"));
    const firstInjected = readFileSync(configPath, "utf8");
    inSandbox(sync("gpt-5.6-luna", "low"));
    inSandbox(sync("gpt-5.6-sol"));
    expect(readFileSync(configPath, "utf8")).toBe(firstInjected);
    const result = inSandbox("return inject." + restore + "();") as {
      success: boolean; artifacts: { config: { action: string } };
    };
    expect(result.success).toBe(true);
    expect(result.artifacts.config.action).toBe("journal-restored");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
});

describe("managed sub-agent default ownership evidence", () => {
  const marked = (model: string) => [
    "[agents]",
    MANAGED_SUBAGENT_DEFAULT_MARKER,
    'default_subagent_model = "' + model + '"',
    "",
  ].join("\n");

  test("a value matching the journaled write is still OpenCodex-owned and replaced", () => {
    const result = transformManagedSubagentDefaults(marked("ocx/a"), { model: "ocx/b" }, { default_subagent_model: "ocx/a" });
    expect(result).toMatchObject({ ok: true, changed: true, conflicts: [] });
    expect(result.content).toContain('default_subagent_model = "ocx/b"');
  });

  test("a value differing from the journaled write is user-owned on update and on removal", () => {
    const update = transformManagedSubagentDefaults(marked("user/x"), { model: "ocx/b" }, { default_subagent_model: "ocx/a" });
    expect(update.ok).toBe(true);
    expect(update.conflicts.map(conflict => conflict.key)).toEqual(["default_subagent_model"]);
    expect(update.content).toBe('[agents]\ndefault_subagent_model = "user/x"\n');
    const removal = transformManagedSubagentDefaults(marked("user/x"), null, { default_subagent_model: "ocx/a" });
    expect(removal.content).toBe('[agents]\ndefault_subagent_model = "user/x"\n');
  });

  test("an edit rewritten as a multiline string is still recognized as the user's", () => {
    const multiline = '[agents]\n' + MANAGED_SUBAGENT_DEFAULT_MARKER + '\ndefault_subagent_model = """\nuser/x"""\n';
    const result = transformManagedSubagentDefaults(multiline, { model: "ocx/b" }, { default_subagent_model: "ocx/a" });
    expect(result.ok).toBe(true);
    expect(result.conflicts.map(conflict => conflict.key)).toEqual(["default_subagent_model"]);
    expect(result.content).toBe('[agents]\ndefault_subagent_model = """\nuser/x"""\n');
  });

  test("without a journaled record the marker alone decides, as before", () => {
    const result = transformManagedSubagentDefaults(marked("user/x"), { model: "ocx/b" }, null);
    expect(result.content).toContain('default_subagent_model = "ocx/b"');
  });
});
