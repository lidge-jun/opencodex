import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConfigCommand } from "../../src/cli/config-command";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const CONFIG_BYTES = JSON.stringify({
  port: 10100,
  providers: { local: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "fixture-only" } },
  defaultProvider: "local",
  autoSwitchThreshold: 50,
}, null, 2) + "\n";

async function withConfig(run: (fixture: {
  root: string;
  configPath: string;
  invoke: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ocx-config-default-show-"));
  const configPath = join(root, "config.json");
  const previousHome = process.env.OPENCODEX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousExitCode = process.exitCode;
  process.env.OPENCODEX_HOME = root;
  process.env.CODEX_HOME = join(root, "codex");
  mkdirSync(process.env.CODEX_HOME);
  writeFileSync(configPath, CONFIG_BYTES);
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  const network = spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("config commands must remain offline");
  });
  try {
    await run({ root, configPath, invoke: async args => {
      out.mockClear(); err.mockClear();
      const original = [...args];
      const code = await handleConfigCommand(args);
      expect(args).toEqual(original);
      return {
        code,
        stdout: out.mock.calls.map(call => call.join(" ")).join("\n"),
        stderr: err.mock.calls.map(call => call.join(" ")).join("\n"),
      };
    } });
    expect(network).not.toHaveBeenCalled();
  } finally {
    out.mockRestore(); err.mockRestore(); network.mockRestore();
    process.exitCode = previousExitCode;
    await flushConfigDirHardeningAndReaps(root);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(root);
  }
}

test.each([
  { args: [], source: false },
  { args: ["show"], source: false },
  { args: ["--json"], source: false },
  { args: ["show", "--json"], source: false },
  { args: ["--json", "show"], source: false },
  { args: ["--source"], source: true },
  { args: ["--json", "--source"], source: true },
  { args: ["--source", "--json"], source: true },
  { args: ["show", "--source", "--json"], source: true },
  { args: ["--source", "show", "--json"], source: true },
])("config display $args preserves the offline, redacted show contract", async ({ args, source }) => {
  await withConfig(async ({ configPath, invoke }) => {
    const explicit = await invoke(["show", "--json"]);
    expect(explicit.code).toBe(0);
    const result = await invoke(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const shown = JSON.parse(result.stdout);
    expect(source ? shown.config : shown).toEqual(JSON.parse(explicit.stdout));
    if (source) expect(shown).toMatchObject({ source: "file", error: null, warnings: [] });
    expect((source ? shown.config : shown).providers.local.apiKey).toBe("********");
    expect(result.stdout).not.toContain("fixture-only");
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG_BYTES);
  });
});

test.each([
  ["--unknown"], ["unknown"], ["show", "extra"],
  ["--json", "--json"], ["--source", "--source"],
  ["show", "--json", "--json"], ["show", "--source", "--source"],
  ["--json", "--unknown"], ["--source", "--unknown"],
  ["--json", "set", "port", "10200", "--json"],
  ["set", "customNote", "--json", "--json"],
  ["--source", "set", "port", "10200"],
  ["set", "port", "10200", "--source"],
  ["--json", "--source", "unset", "defaultProvider"],
  ["get", "port", "--source"], ["validate", "--source"],
  ["export", "-", "--source"], ["import", "missing.json", "--yes", "--source"],
])("config rejects invalid arguments %j before displaying or writing", async (...args) => {
  await withConfig(async ({ configPath, invoke }) => {
    const result = await invoke(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG_BYTES);
  });
});

test.each([true, false])("JSON flag leading=%s retains explicit get, set, and unset actions", async leading => {
  const jsonArgs = (args: string[]) => leading ? ["--json", ...args] : [...args, "--json"];
  await withConfig(async ({ configPath, invoke }) => {
    const get = await invoke(jsonArgs(["get", "port"]));
    expect(get.code).toBe(0);
    expect(JSON.parse(get.stdout)).toBe(10100);
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG_BYTES);
    const set = await invoke(jsonArgs(["set", "port", "10200"]));
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout)).toEqual({ ok: true, path: "port", value: 10200 });
    expect(JSON.parse(readFileSync(configPath, "utf8")).port).toBe(10200);
    const unset = await invoke(jsonArgs(["unset", "autoSwitchThreshold"]));
    expect(unset.code).toBe(0);
    expect(JSON.parse(unset.stdout)).toEqual({ ok: true, path: "autoSwitchThreshold", value: null });
    expect(JSON.parse(readFileSync(configPath, "utf8")).autoSwitchThreshold).toBeUndefined();
  });
});

test("leading --json preserves validate, export, and confirmed import", async () => {
  await withConfig(async ({ root, configPath, invoke }) => {
    expect((await invoke(["--json", "validate"])).code).toBe(0);
    const backup = join(root, "backup.json");
    expect((await invoke(["--json", "export", backup])).code).toBe(0);
    expect(JSON.parse(readFileSync(backup, "utf8")).providers.local.apiKey).toBe("fixture-only");
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG_BYTES);
    expect((await invoke(["--json", "import", backup])).code).toBe(2);
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG_BYTES);
    const replacement = { ...JSON.parse(CONFIG_BYTES), port: 10300 };
    writeFileSync(backup, JSON.stringify(replacement));
    const imported = await invoke(["--json", "import", backup, "--yes"]);
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.stdout)).toEqual({ ok: true, source: backup });
    expect(JSON.parse(readFileSync(configPath, "utf8")).port).toBe(10300);
  });
});

test.each([["--json", "--source"], ["--source", "--json"]])(
  "real config CLI accepts flags-only %j without network access",
  async (...args) => {
    await withConfig(async ({ root, configPath }) => {
      const preload = join(root, "offline-preload.ts");
      writeFileSync(preload, `let attempts = 0;
globalThis.fetch = () => { attempts++; throw new Error("config CLI must remain offline"); };
process.on("exit", () => { if (attempts) process.exitCode = 97; });\n`);
      const result = spawnSync(process.execPath, [
        "--preload", preload, repoPath("src", "cli", "index.ts"), "config", ...args,
      ], {
        cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: root, CODEX_HOME: join(root, "codex") },
        encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        config: { port: 10100, providers: { local: { apiKey: "********" } } },
        source: "file", error: null, warnings: [],
      });
      expect(readFileSync(configPath, "utf8")).toBe(CONFIG_BYTES);
    });
  }, SPAWN_BUDGET_MS,
);


test.each([["config", "--help"], ["help", "config"]])(
  "config help %j documents optional show and display flags",
  async (...args) => {
    await withConfig(async ({ root, configPath }) => {
      const result = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), ...args], {
        cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: root, CODEX_HOME: join(root, "codex") },
        encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("ocx config [show|get|set|unset|validate|export|import]");
      expect(result.stdout).toContain("show is the default");
      expect(result.stdout).toContain("ocx config [show] [--json] [--source]");
      expect(result.stdout).toContain("--source is only supported for show");
      expect(readFileSync(configPath, "utf8")).toBe(CONFIG_BYTES);
    });
  }, SPAWN_BUDGET_MS,
);
