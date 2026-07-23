import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGrokManagedBlock, injectGrokConfig, stripGrokConfig } from "../src/grok/inject";

const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const END_MARKER = "# <<< opencodex managed block <<<";

describe("Grok config injection", () => {
  let root: string;
  let grokHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-grok-inject-"));
    grokHome = join(root, ".grok");
    mkdirSync(grokHome);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("creates and strips a fresh config", () => {
    const configPath = join(grokHome, "config.toml");

    const injected = injectGrokConfig(10100, [{ id: "gpt-5.6-sol", contextWindow: 1_050_000 }], { grokHome });
    expect(injected).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toContain(BEGIN_MARKER);
    expect(readFileSync(configPath, "utf8")).toContain(END_MARKER);

    const stripped = stripGrokConfig({ grokHome });
    expect(stripped).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe("");
  });

  test("backs up once, appends to user config, and restores user bytes", () => {
    const configPath = join(grokHome, "config.toml");
    const backupPath = join(grokHome, "config.toml.bak-opencodex");
    const userContent = "theme = \"dark\"\n";
    writeFileSync(configPath, userContent, "utf8");

    injectGrokConfig(10100, [{ id: "first" }], { grokHome });
    expect(readFileSync(backupPath, "utf8")).toBe(userContent);
    writeFileSync(backupPath, "backup-must-survive\n", "utf8");

    injectGrokConfig(10101, [{ id: "second" }], { grokHome });
    expect(readFileSync(backupPath, "utf8")).toBe("backup-must-survive\n");

    stripGrokConfig({ grokHome });
    expect(readFileSync(configPath, "utf8")).toBe(userContent);
  });

  test("replaces the managed region idempotently", () => {
    const configPath = join(grokHome, "config.toml");
    injectGrokConfig(10100, [{ id: "old-model" }], { grokHome });
    injectGrokConfig(10100, [{ id: "new-model" }, { id: "newer-model" }], { grokHome });

    const content = readFileSync(configPath, "utf8");
    expect(content.match(new RegExp(BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).toHaveLength(1);
    expect(content).not.toContain("old-model");
    expect(content).toContain("[model.ocx-new-model]");
    expect(content).toContain("[model.ocx-newer-model]");
  });

  test("skips a user-owned opencodex provider table", () => {
    const configPath = join(grokHome, "config.toml");
    const userContent = "[model_providers.opencodex]\nbase_url = \"https://example.test/v1\"\n";
    writeFileSync(configPath, userContent, "utf8");

    const result = injectGrokConfig(10100, [{ id: "ignored" }], { grokHome });
    expect(result).toMatchObject({ ok: true, changed: false, skippedReason: "user-owned-provider" });
    expect(result.message.toLowerCase()).toContain("user-owned");
    expect(readFileSync(configPath, "utf8")).toBe(userContent);
    expect(existsSync(join(grokHome, "config.toml.bak-opencodex"))).toBe(false);
  });

  test("sanitizes aliases, suffixes collisions, and escapes TOML strings", () => {
    const block = buildGrokManagedBlock(10100, [
      { id: "anthropic/claude-opus-4.8" },
      { id: "same/path", name: "Quoted \"name\"" },
      { id: "same.path", contextWindow: 200_000 },
    ]);

    expect(block).toContain("[model.ocx-anthropic-claude-opus-4-8]");
    expect(block).toContain("[model.ocx-same-path]");
    expect(block).toContain("[model.ocx-same-path-2]");
    expect(block).toContain('name = "Quoted \\"name\\""');
    expect(block).toContain("context_window = 200000");
  });

  test("preserves CRLF through inject and strip", () => {
    const configPath = join(grokHome, "config.toml");
    const userContent = "theme = \"dark\"\r\nnotify = true\r\n";
    writeFileSync(configPath, userContent, "utf8");

    injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome });
    expect(readFileSync(configPath, "utf8")).not.toMatch(/(?<!\r)\n/);

    stripGrokConfig({ grokHome });
    expect(readFileSync(configPath, "utf8")).toBe(userContent);
  });

  test("skips when the Grok home directory is absent", () => {
    const missingHome = join(root, "missing");
    const result = injectGrokConfig(10100, [], { grokHome: missingHome });
    expect(result).toMatchObject({ ok: true, changed: false, skippedReason: "no-grok-home" });
  });

  test("strips an orphaned begin marker through EOF", () => {
    const configPath = join(grokHome, "config.toml");
    writeFileSync(configPath, `theme = "dark"\n\n${BEGIN_MARKER}\npartial = true\n`, "utf8");

    const result = stripGrokConfig({ grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.message.toLowerCase()).toContain("orphaned");
    expect(readFileSync(configPath, "utf8")).toBe('theme = "dark"\n');
  });
});
