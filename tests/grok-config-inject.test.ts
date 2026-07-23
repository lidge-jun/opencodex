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

  test("emits per-model direct fields (grok 0.2.101 ignores model_providers inheritance)", () => {
    const block = buildGrokManagedBlock(10190, [{ id: "cursor/grok-4.5", contextWindow: 500_000 }]);
    expect(block).not.toContain("[model_providers");
    expect(block).not.toContain("model_provider =");
    const table = block.slice(block.indexOf("[model.ocx-cursor-grok-4-5]"));
    expect(table).toContain('model = "cursor/grok-4.5"');
    expect(table).toContain('base_url = "http://127.0.0.1:10190/v1"');
    expect(table).toContain('api_backend = "chat_completions"');
    expect(table).toContain('api_key = "opencodex-loopback"');
    expect(table).toContain("context_window = 500000");
  });

  test("reserves user-owned [model.*] aliases outside the fence", () => {
    const configPath = join(grokHome, "config.toml");
    const userContent = '[model.ocx-mine]\nmodel = "user/model"\nbase_url = "https://example.test/v1"\n';
    writeFileSync(configPath, userContent, "utf8");

    const result = injectGrokConfig(10100, [{ id: "mine" }], { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    // The user's table survives untouched and our entry takes a suffixed alias —
    // a duplicate [model.ocx-mine] header would invalidate the whole TOML.
    expect(content.match(/\[model\.ocx-mine\]/g) ?? []).toHaveLength(1);
    expect(content).toContain("[model.ocx-mine-2]");
    expect(content.startsWith(userContent)).toBe(true);
  });

  test("recognizes quoted and whitespace-padded user model headers (TOML-equivalent forms)", () => {
    const configPath = join(grokHome, "config.toml");
    const userContent = [
      '[model."ocx-quoted"]',
      'model = "user/a"',
      "[ model . ocx-spaced ]",
      'model = "user/b"',
      "[model.'ocx-single']",
      'model = "user/c"',
      "",
    ].join("\n");
    writeFileSync(configPath, userContent, "utf8");

    injectGrokConfig(10100, [{ id: "quoted" }, { id: "spaced" }, { id: "single" }], { grokHome });
    const content = readFileSync(configPath, "utf8");
    // Each equivalent user spelling reserves its canonical alias; ours are suffixed.
    expect(content).toContain("[model.ocx-quoted-2]");
    expect(content).toContain("[model.ocx-spaced-2]");
    expect(content).toContain("[model.ocx-single-2]");
    // Exactly one bare-form [model.ocx-quoted] must NOT exist (only the user's quoted header).
    expect(content).not.toContain("[model.ocx-quoted]");
    // The whole file must stay valid TOML (no duplicate table definitions).
    expect(() => Bun.TOML.parse(content)).not.toThrow();
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

  test("refuses to mutate when the begin marker is orphaned (data-safety)", () => {
    const configPath = join(grokHome, "config.toml");
    const damaged = `theme = "dark"\n\n${BEGIN_MARKER}\npartial = true\n[model.user-added-later]\nmodel = "keep/me"\n`;
    writeFileSync(configPath, damaged, "utf8");

    const stripResult = stripGrokConfig({ grokHome });
    expect(stripResult).toMatchObject({ ok: false, changed: false, skippedReason: "orphaned-marker" });
    expect(readFileSync(configPath, "utf8")).toBe(damaged);

    const injectResult = injectGrokConfig(10100, [{ id: "x" }], { grokHome });
    expect(injectResult).toMatchObject({ ok: false, changed: false, skippedReason: "orphaned-marker" });
    expect(readFileSync(configPath, "utf8")).toBe(damaged);
  });
});
