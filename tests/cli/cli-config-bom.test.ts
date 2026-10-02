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

test("validate and import accept a Windows UTF-8 BOM without rewriting string data", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-bom-"));
  const previous = process.env.OPENCODEX_HOME;
  const previousExit = process.exitCode;
  process.env.OPENCODEX_HOME = root;
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const input = join(root, "input.json");
    const config = { port: 10100, providers: { local: { adapter: "openai-chat", baseUrl: "https://example.test/v1", note: "kept\uFEFFinside" } }, defaultProvider: "local" };
    writeFileSync(input, "\uFEFF" + JSON.stringify(config));
    expect(await handleConfigCommand(["validate", input, "--json"])).toBe(0);
    expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toMatchObject({ ok: true });
    expect(await handleConfigCommand(["import", input, "--yes", "--json"])).toBe(0);
    const persisted = readFileSync(join(root, "config.json"), "utf8");
    expect(JSON.parse(persisted).providers.local.note).toBe("kept\uFEFFinside");
    writeFileSync(input, "\uFEFF{ invalid");
    expect(await handleConfigCommand(["import", input, "--yes"])).not.toBe(0);
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(persisted);
  } finally {
    out.mockRestore(); err.mockRestore(); process.exitCode = previousExit;
    await flushConfigDirHardeningAndReaps(root);
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(root);
  }
});

test.each(["validate", "import"])("accepts a BOM on real config %s stdin", action => {
  const root = mkdtempSync(join(tmpdir(), "ocx-bom-stdin-"));
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  const config = { port: 10100, providers: { local: { adapter: "openai-chat", baseUrl: "https://example.test/v1", note: "kept\uFEFFinside" } }, defaultProvider: "local" };
  try {
    const args = [repoPath("src", "cli", "index.ts"), "config", action, "-", "--json"];
    if (action === "import") args.push("--yes");
    const result = spawnSync(process.execPath, args, {
      cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: root, CODEX_HOME: codexHome },
      input: "\uFEFF" + JSON.stringify(config), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    if (action === "import") {
      expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).providers.local.note).toBe("kept\uFEFFinside");
    }
  } finally { removeTreeWithRetry(root); }
}, SPAWN_BUDGET_MS);
