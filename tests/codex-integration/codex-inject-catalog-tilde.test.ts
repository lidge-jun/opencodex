import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

test.skipIf(process.platform === "win32")("expands a POSIX catalog tilde in the generated profile", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-catalog-tilde-")));
  try {
    const codexHome = join(root, "codex");
    const home = join(root, "home");
    mkdirSync(codexHome);
    mkdirSync(home);
    const catalogPath = join(home, "models.json");
    writeFileSync(catalogPath, '{"models":[]}\n');
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model_catalog_json = "~//models.json"\n');

    const spawned = spawnSync(process.execPath, ["--eval", `
      const { injectCodexConfig } = require("./src/codex/inject");
      const result = await injectCodexConfig(10100, {});
      if (!result.success) throw new Error(result.message);
    `], {
      cwd: repoRoot(),
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx"), CODEX_SQLITE_HOME: "" },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(spawned.status, spawned.stderr).toBe(0);
    const profile = join(codexHome, "opencodex.config.toml");
    expect(Bun.TOML.parse(readFileSync(profile, "utf8")).model_catalog_json).toBe(catalogPath);
    expect(Bun.TOML.parse(readFileSync(configPath, "utf8")).model_catalog_json).toBe("~//models.json");
  } finally {
    removeTreeWithRetry(root);
  }
});
