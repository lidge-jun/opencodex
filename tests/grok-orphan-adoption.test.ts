import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectGrokConfig, stripGrokConfig } from "../src/grok/inject";

/**
 * #511 — Grok Build reported 200k for every model.
 *
 * `~/.grok/config.toml` accumulated a SECOND entry per model above the managed block,
 * written by a version that predates the fence. Those entries carry no `context_window`,
 * so Grok fell back to its own 200k default — and because they sit outside the fence,
 * `userModelAliases` reserved them as user-owned, so every sync wrote a correct `-2`
 * duplicate beside the stale original instead of replacing it. `[models] default` named
 * the stale one.
 *
 * Failure-mode ids below map to devlog/_plan/260727_grok_orphan_adoption/001.
 */

const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const MODELS = [{ id: "gpt-5.6-sol", contextWindow: 372_000 }];
const OWNERSHIP_MARKER = 'extra_headers = { "x-opencodex-grok" = "1" }';

describe("Grok orphan adoption (#511)", () => {
  let root: string;
  let grokHome: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-grok-orphan-"));
    grokHome = join(root, ".grok");
    mkdirSync(grokHome);
    configPath = join(grokHome, "config.toml");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The real shape from a machine that hit #511. */
  function writeOrphanedConfig(extra = ""): void {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "chat_completions"',
      'api_key = "opencodex-loopback"',
      'name = "OCX gpt-5.6-sol"',
      "",
      extra,
    ].join("\n"));
  }

  function modelTables(content: string): string[] {
    return [...content.matchAll(/^\[model\.([^\]]+)\]$/gm)].map(match => match[1]!);
  }

  function countStringValue(value: unknown, target: string): number {
    if (value === target) return 1;
    if (Array.isArray(value)) {
      return value.reduce((count, item) => count + countStringValue(item, target), 0);
    }
    if (typeof value === "object" && value !== null) {
      return Object.values(value).reduce(
        (count, item) => count + countStringValue(item, target),
        0,
      );
    }
    return 0;
  }

  test("adopts the stale entry so exactly one table per model survives", () => {
    writeOrphanedConfig();
    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    const tables = modelTables(content);
    expect(tables).toHaveLength(1);
    // The survivor is inside the fence and carries the authoritative window.
    expect(content.indexOf(`[model.${tables[0]}]`)).toBeGreaterThan(content.indexOf(BEGIN_MARKER));
    expect(content).toContain("context_window = 372000");
  });

  // F2: on a real machine `default` names the orphan, so this is the common path.
  test("repoints default at the surviving alias", () => {
    writeOrphanedConfig();
    injectGrokConfig(10100, MODELS, { grokHome });

    const content = readFileSync(configPath, "utf8");
    const survivor = modelTables(content)[0]!;
    expect(content).toContain(`default = "${survivor}"`);
  });

  // F1: the worst outcome is deleting a model a human wrote. Loopback alone is legitimate.
  test("never adopts a hand-written model, even on a loopback base_url", () => {
    writeOrphanedConfig([
      "[model.my-own]",
      'model = "my-local"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "my-own-secret"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[model.my-own]");
    expect(content).toContain('api_key = "my-own-secret"');
  });

  // F1: our api_key pointed at a REMOTE host is not ours to delete.
  test("does not adopt our api_key when the base_url is remote", () => {
    writeFileSync(configPath, [
      "[model.ocx-remote]",
      'model = "gpt-5.6-sol"',
      'base_url = "https://example.com/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    expect(readFileSync(configPath, "utf8")).toContain("[model.ocx-remote]");
  });

  test("preserves documented and generated-looking markerless manual tables", () => {
    const fixtures = [
      [
        "[model.ocx-opus]",
        'model = "anthropic/claude-opus-4-8"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_backend = "responses"',
        'api_key = "opencodex-loopback"',
        "",
      ],
      [
        "[model.ocx-opus]",
        'model = "anthropic/claude-opus-4-8"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_backend = "chat_completions"',
        'api_key = "opencodex-loopback"',
        "",
      ],
      [
        "[model.ocx-anthropic-claude-opus-4-8]",
        'model = "anthropic/claude-opus-4-8"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_backend = "responses"',
        'api_key = "opencodex-loopback"',
        'name = "OCX anthropic/claude-opus-4-8"',
        "",
      ],
      [
        "[model.ocx-anthropic-claude-opus-4-8]",
        'model = "anthropic/claude-opus-4-8"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_backend = "responses"',
        'api_key = "opencodex-loopback"',
        'name = "OCX anthropic/claude-opus-4-8"',
        'extra_headers = { "x-opencodex-grok" = "0" }',
        "",
      ],
    ];

    for (const lines of fixtures) {
      const original = lines.join("\n");
      writeFileSync(configPath, original);
      expect(injectGrokConfig(10100, MODELS, { grokHome }))
        .toMatchObject({ ok: true, changed: true });
      expect(readFileSync(configPath, "utf8")).toContain(original);
      expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(configPath, "utf8")).toBe(original);
    }
  });

  // F3: `[[model.x]]` collides with a generated `[model.x]` and makes Grok reject the
  // WHOLE config layer, so that spelling must stay reserved rather than adopted.
  test("leaves an array-of-table model reserved", () => {
    writeFileSync(configPath, [
      "[[model.ocx-arr]]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[[model.ocx-arr]]");
    expect(content).not.toContain("\n[model.ocx-arr]\n");
  });

  // F4: a partial removal would re-parent leftover keys onto the neighbouring table.
  test("removal keeps the following table intact", () => {
    writeOrphanedConfig([
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[ui]");
    expect(content).toContain('theme = "dark"');
    // No key from the removed table leaked into [ui].
    expect(content).not.toContain('api_backend = "responses"\ntheme');
  });

  // F5: an orphan with no replacement stays, and its reference is not rewritten to
  // something arbitrary — a working config beats a dangling default.
  test("keeps an orphan whose model is no longer in the catalog", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-retired"',
      "",
      "[ui]",
      'fork_secondary_model = "ocx-retired"',
      "",
      "[model.ocx-retired]",
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n"));

    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain('default = "ocx-retired"');
    expect(content).toContain('fork_secondary_model = "ocx-retired"');
    expect(content).toContain("[model.ocx-retired]");
    expect(content).toContain('model = "retired/model"');

    const second = injectGrokConfig(10100, MODELS, { grokHome });
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(configPath, "utf8")).toBe(content);
  });

  test("keeps an owned-looking orphan whose model id is missing", () => {
    const original = [
      "[model.ocx-unknown]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[model.ocx-unknown]");
    expect(content).toContain('api_key = "opencodex-loopback"');
    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preserves empty-model and array-child marker lookalikes", () => {
    const fixtures = [
      [
        "[model.ocx-empty]",
        'model = ""',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_key = "opencodex-loopback"',
        OWNERSHIP_MARKER,
        "",
      ],
      [
        "[model.ocx-array-marker]",
        'model = "gpt-5.6-sol"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_backend = "responses"',
        'api_key = "opencodex-loopback"',
        "",
        "[[model.ocx-array-marker.extra_headers]]",
        'x-opencodex-grok = "1"',
        "",
      ],
    ];

    for (const lines of fixtures) {
      const original = lines.join("\n");
      writeFileSync(configPath, original);
      expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: false });
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(injectGrokConfig(10100, MODELS, { grokHome }))
        .toMatchObject({ ok: true, changed: true });
      expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(configPath, "utf8")).toBe(original);
    }
  });

  test("removes a hidden current orphan but preserves a genuinely retired one", () => {
    writeFileSync(configPath, [
      "[model.ocx-hidden]",
      'model = "hidden/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
      "[model.ocx-retired]",
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, {
      grokHome,
      catalogModelIds: new Set(["gpt-5.6-sol", "hidden/model"]),
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    expect(content).not.toContain("[model.ocx-hidden]");
    expect(content).not.toContain('model = "hidden/model"');
    expect(content).toContain("[model.ocx-retired]");
    expect(content).toContain('model = "retired/model"');
  });

  test("adopts a current orphan whose TOML model id uses literal quotes", () => {
    writeOrphanedConfig();
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace('model = "gpt-5.6-sol"', "model = 'gpt-5.6-sol'"),
    );

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    expect(modelTables(content)).toEqual(["ocx-gpt-5-6-sol"]);
    expect(content).not.toContain("model = 'gpt-5.6-sol'");
    expect(content).toContain('model = "gpt-5.6-sol"');
  });

  test("teardown removes a preserved retired orphan and restores user bytes exactly", () => {
    for (const eol of ["\n", "\r\n"]) {
      const userPrefix = [`theme = "${eol === "\n" ? "lf" : "crlf"}"`, "", ""].join(eol);
      const orphan = [
        "[model.ocx-retired]",
        'model = "retired/model"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_key = "opencodex-loopback"',
        OWNERSHIP_MARKER,
        "",
      ].join(eol);
      writeFileSync(configPath, userPrefix + orphan);
      expect(injectGrokConfig(10100, MODELS, { grokHome }))
        .toMatchObject({ ok: true, changed: true });
      expect(readFileSync(configPath, "utf8")).toContain("[model.ocx-retired]");

      const stripped = stripGrokConfig({ grokHome });
      expect(stripped).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(configPath, "utf8")).toBe(userPrefix);
    }
  });

  test("teardown preserves a headerless tail beyond the fence byte-for-byte", () => {
    for (const eol of ["\n", "\r\n"]) {
      const userPrefix = [
        "[models]",
        `keep = "${eol === "\n" ? "lf" : "crlf"}"`,
        "",
        "",
      ].join(eol);
      const orphan = [
        "[model.ocx-retired]",
        'model = "retired/model"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_key = "opencodex-loopback"',
        OWNERSHIP_MARKER,
        "",
      ].join(eol);
      const tail = [
        "# keep this post-fence note",
        'default = "ocx-retired"',
        'models.default = "ocx-retired"',
        "bare_user_key = true",
        "",
      ].join(eol);
      writeFileSync(configPath, userPrefix + orphan);
      expect(injectGrokConfig(10100, MODELS, { grokHome }))
        .toMatchObject({ ok: true, changed: true });
      writeFileSync(configPath, readFileSync(configPath, "utf8") + tail);

      expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(configPath, "utf8")).toBe(userPrefix + tail);
    }
  });

  test("markerless teardown removes only ownership-proven orphan tables", () => {
    const owned = [
      "[model.ocx-retired]",
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n");
    const userOwned = [
      "[model.user-owned]",
      'model = "user/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "not-ours"',
      "",
    ].join("\n");
    writeFileSync(configPath, owned + userOwned);

    const stripped = stripGrokConfig({ grokHome });
    expect(stripped).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(userOwned);
  });

  test("teardown clears only section-owned references to swept aliases", () => {
    for (const withFence of [false, true]) {
      const modelsHeader = withFence ? '["models"]' : "[models]";
      const defaultKey = withFence ? '"default"' : "default";
      const uiHeader = withFence ? "['ui']" : "[ui]";
      const secondaryKey = withFence ? "'fork_secondary_model'" : "fork_secondary_model";
      const otherHeader = withFence ? '["other]"]' : "[other]";
      const expected = [
        modelsHeader,
        'keep = "models"',
        "",
        uiHeader,
        'keep = "ui"',
        "",
        otherHeader,
        'default = "ocx-retired"',
        'fork_secondary_model = "ocx-retired"',
        "",
        "",
      ].join("\n");
      writeFileSync(configPath, [
        modelsHeader,
        `${defaultKey} = "ocx-retired"`,
        'keep = "models"',
        "",
        uiHeader,
        `${secondaryKey} = 'ocx-retired' # removed with its table`,
        'keep = "ui"',
        "",
        otherHeader,
        'default = "ocx-retired"',
        'fork_secondary_model = "ocx-retired"',
        "",
        "[model.ocx-retired]",
        'model = "retired/model"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_key = "opencodex-loopback"',
        OWNERSHIP_MARKER,
        "",
      ].join("\n"));
      if (withFence) {
        expect(injectGrokConfig(10100, MODELS, { grokHome }))
          .toMatchObject({ ok: true, changed: true });
      }

      expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(configPath, "utf8")).toBe(expected);
    }
  });

  test("teardown clears multiline section-owned references to swept aliases", () => {
    for (const delimiter of ['"""', "'''"]) {
      const original = [
        "[models]",
        `default = ${delimiter}ocx-retired${delimiter}`,
        'keep = "models"',
        "",
        "[ui]",
        `fork_secondary_model = ${delimiter}`,
        "ocx-retired" + delimiter,
        'keep = "ui"',
        "",
        "[model.ocx-retired]",
        'model = "retired/model"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_key = "opencodex-loopback"',
        OWNERSHIP_MARKER,
        "",
      ].join("\n");
      writeFileSync(configPath, original);

      expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
      const content = readFileSync(configPath, "utf8");
      expect(content).toBe([
        "[models]",
        'keep = "models"',
        "",
        "[ui]",
        'keep = "ui"',
        "",
        "",
      ].join("\n"));
    }
  });

  test("teardown preserves an escaped multiline value that is not the swept alias", () => {
    const reference = [
      "[models]",
      'default = """\\\\',
      'u006Fcx-retired"""',
      'keep = "models"',
      "",
    ].join("\n");
    writeFileSync(configPath, reference + [
      "[model.ocx-retired]",
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n"));

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(reference);
  });

  test("teardown does not reinterpret nested array elements as table headers", () => {
    const userContent = [
      "[other]",
      "model_names = [",
      '  ["models"],',
      "]",
      'default = "ocx-retired"',
      "ui_names = [",
      '  ["ui"],',
      "]",
      'fork_secondary_model = "ocx-retired"',
      "",
      "",
    ].join("\n");
    writeFileSync(configPath, userContent + [
      "[model.ocx-retired]",
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n"));

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(userContent);
  });

  test("teardown clears quoted root dotted references to swept aliases", () => {
    writeFileSync(configPath, [
      '"models".\'default\' = "ocx-retired"',
      '\'ui\'."fork_secondary_model" = \'ocx-retired\'',
      'keep = "root"',
      "",
      "[model.ocx-retired]",
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n"));

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(['keep = "root"', "", ""].join("\n"));
  });

  test("adoption rewrites a quoted root dotted reference", () => {
    const oldAlias = "ocx-gpt-5-6-sol-2";
    writeFileSync(configPath, [
      `"models".'default' = '${oldAlias}'`,
      "",
      `[model.${oldAlias}]`,
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n"));

    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    const defaultAlias = /^"models"\.'default' = "([^"]+)"$/m.exec(content)?.[1];
    expect(defaultAlias).toBeDefined();
    expect(defaultAlias).not.toBe(oldAlias);
    expect(content).toContain(`[model.${defaultAlias}]`);
    expect(content).not.toContain(`[model.${oldAlias}]`);
  });

  test("adoption rewrites an inline-table reference", () => {
    const oldAlias = "ocx-gpt-5-6-sol-2";
    const decoys = Array.from({ length: 40 }, () => "default = 'not-a-key'").join(", ");
    writeFileSync(configPath, [
      `models = { note = "{ ${decoys} }", default = "${oldAlias}", keep = true }`,
      "",
      `[model.${oldAlias}]`,
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n"));

    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    const defaultAlias = /models = \{ note = .*?, default = "([^"]+)", keep = true \}/.exec(content)?.[1];
    expect(defaultAlias).toBeDefined();
    expect(defaultAlias).not.toBe(oldAlias);
    expect(content).toContain(`[model.${defaultAlias}]`);
  });

  test("teardown fails closed on an inline-table reference", () => {
    const original = [
      'models = { default = "ocx-retired", keep = true }',
      "",
      "[model.ocx-retired]",
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: false, changed: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("semantic probing cannot confuse an existing sentinel-shaped alias", () => {
    const unrelated = 'default = "keep"\n';
    const alias = `__opencodex_reference_probe_0_${unrelated.indexOf('"')}__`;
    writeFileSync(configPath, unrelated + [
      `models.default = "${alias}"`,
      "",
      `[model.${alias}]`,
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n"));

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe('default = "keep"\n\n');
  });

  test("adoption prefers the managed survivor over a same-model user table", () => {
    const oldAlias = "ocx-gpt-5-6-sol-2";
    writeFileSync(configPath, [
      "[models]",
      `default = "${oldAlias}"`,
      "",
      "[model.manual]",
      'model = "gpt-5.6-sol"',
      'base_url = "https://example.com/v1"',
      'api_key = "user-secret"',
      "",
      `[model.${oldAlias}]`,
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
    ].join("\n"));

    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    const defaultAlias = /^default = "([^"]+)"$/m.exec(content)?.[1];
    expect(defaultAlias).toBeDefined();
    expect(defaultAlias).not.toBe("manual");
    expect(defaultAlias).not.toBe(oldAlias);
    expect(content).toContain(`[model.${defaultAlias}]`);
  });

  test("teardown follows a non-contiguous ownership child table", () => {
    const alias = "ocx-retired";
    const preserved = ["[other]", "keep = true", "", ""].join("\n");
    writeFileSync(configPath, [
      `[model.${alias}]`,
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
      "[other]",
      "keep = true",
      "",
      `[model.${alias}.extra_headers]`,
      'x-opencodex-grok = "1"',
      "",
    ].join("\n"));

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(preserved);
  });

  test("teardown follows an ownership child written before its parent", () => {
    const alias = "ocx-retired";
    const preserved = ["[other]", "keep = true", "", ""].join("\n");
    writeFileSync(configPath, [
      `[model.${alias}.extra_headers]`,
      'x-opencodex-grok = "1"',
      "",
      "[other]",
      "keep = true",
      "",
      `[model.${alias}]`,
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(preserved);
  });

  test("teardown follows an ownership child re-serialized beyond the fence", () => {
    const alias = "ocx-retired";
    writeFileSync(configPath, [
      `[model.${alias}]`,
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));
    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    writeFileSync(configPath, readFileSync(configPath, "utf8") + [
      `[model.${alias}.extra_headers]`,
      'x-opencodex-grok = "1"',
      "",
    ].join("\n"));

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8").trim()).toBe("");
  });

  test("teardown follows a pre-fence ownership child to a post-fence parent", () => {
    const alias = "ocx-retired";
    writeFileSync(configPath, [
      `[model.${alias}.extra_headers]`,
      'x-opencodex-grok = "1"',
      "",
    ].join("\n"));
    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    writeFileSync(configPath, readFileSync(configPath, "utf8") + [
      `[model.${alias}]`,
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8").trim()).toBe("");
  });

  test("a Unicode line separator inside a comment does not hide a user model header", () => {
    const alias = "ocx-gpt-5-6-sol";
    writeFileSync(configPath, [
      `[model.${alias}] # alpha\u2028omega`,
      'model = "user/model"',
      'base_url = "https://example.com/v1"',
      'api_key = "user-secret"',
      "",
    ].join("\n"));

    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain(`[model.${alias}] # alpha\u2028omega`);
    expect(content).toContain(`[model.${alias}-2]`);
  });

  test("teardown ignores generated-looking tables inside multiline TOML strings", () => {
    for (const delimiter of ['"""', "'''"]) {
      const original = [
        `notes = ${delimiter}`,
        "[model.ocx-retired]",
        'model = "retired/model"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_key = "opencodex-loopback"',
        OWNERSHIP_MARKER,
        delimiter,
        "",
        "[model.user-owned]",
        'model = "user/model"',
        'base_url = "https://example.com/v1"',
        'api_key = "user-secret"',
        "",
      ].join("\n");
      writeFileSync(configPath, original);

      expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: false });
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(injectGrokConfig(10100, MODELS, { grokHome }))
        .toMatchObject({ ok: true, changed: true });
      expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(configPath, "utf8")).toBe(original);
    }
  });

  test("ownership keys inside a multiline value do not claim a manual table", () => {
    for (const delimiter of ['"""', "'''"]) {
      const original = [
        "[model.hand-written]",
        `notes = ${delimiter}`,
        'model = "retired/model"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_key = "opencodex-loopback"',
        OWNERSHIP_MARKER,
        delimiter,
        'model = "user/model"',
        'base_url = "https://example.com/v1"',
        'api_key = "user-secret"',
        "",
      ].join("\n");
      writeFileSync(configPath, original);

      expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: false });
      expect(readFileSync(configPath, "utf8")).toBe(original);
    }
  });

  test("adoption ignores fake survivors and references inside multiline strings", () => {
    const oldAlias = "ocx-gpt-5-6-sol-2";
    writeFileSync(configPath, [
      "[models]",
      `default = "${oldAlias}"`,
      'notes = """',
      "[model.fake-survivor]",
      'model = "gpt-5.6-sol"',
      `default = "${oldAlias}"`,
      '"""',
      "",
      `[model.${oldAlias}]`,
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "chat_completions"',
      'api_key = "opencodex-loopback"',
      'name = "OCX gpt-5.6-sol"',
      "",
    ].join("\n"));

    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain('default = "ocx-gpt-5-6-sol"');
    expect(content).toContain(`[model.fake-survivor]\nmodel = "gpt-5.6-sol"\ndefault = "${oldAlias}"`);
    expect(content).not.toContain(`[model.${oldAlias}]`);
  });

  test("markerless teardown preserves an ambiguous legacy row", () => {
    const legacy = [
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "chat_completions"',
      'api_key = "opencodex-loopback"',
      'name = "OCX gpt-5.6-sol"',
      "",
    ].join("\n");
    writeFileSync(configPath, legacy);

    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(configPath, "utf8")).toBe(legacy);
    expect(injectGrokConfig(10100, MODELS, {
      grokHome,
      excluded: new Set(["gpt-5.6-sol"]),
    })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toContain('api_backend = "chat_completions"');
    expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(legacy);
    // Injection can migrate the same legacy row because it writes a marked replacement now.
    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf8")).not.toContain('api_backend = "chat_completions"');
  });

  test("still removes a catalog orphan when that model is excluded", () => {
    writeOrphanedConfig(OWNERSHIP_MARKER);

    injectGrokConfig(10100, MODELS, {
      grokHome,
      excluded: new Set(["gpt-5.6-sol"]),
    });
    expect(modelTables(readFileSync(configPath, "utf8"))).toEqual([]);
  });

  test("managed exclusion leaves zero references to a removed model (#2830)", () => {
    const alias = "ocx-gpt-5-6-sol";
    writeFileSync(configPath, [
      "[models]",
      `default = "${alias}"`,
      `web_search = "${alias}"`,
      `session_summary = "${alias}"`,
      `image_description = "${alias}"`,
      `prompt_suggestion = "${alias}"`,
      "",
      "[ui]",
      `fork_secondary_model = "${alias}"`,
      "",
      "[subagents.models]",
      `explore = "${alias}"`,
      "",
      "[subagents.roles.reviewer]",
      `model = "${alias}"`,
      'description = "Review code"',
      "",
      "[subagents.personas.concise]",
      `model = "${alias}"`,
      'instructions = "Be concise"',
      "",
      "[auto_mode]",
      `classifier_model = "${alias}"`,
      "",
      "[goal]",
      `planner_model = { model = "${alias}", agent_type = "grok-build-plan" }`,
      "",
      "[goal.strategist_model]",
      `model = "${alias}"`,
      'agent_type = "cursor"',
      "",
      "[[goal.skeptic_models]]",
      `model = "${alias}"`,
      'agent_type = "grok-build-plan"',
      "",
    ].join("\n"));

    expect(injectGrokConfig(10100, MODELS, { grokHome }))
      .toMatchObject({ ok: true, changed: true });
    const activeContent = readFileSync(configPath, "utf8");
    expect(modelTables(activeContent)).toEqual([alias]);
    expect(countStringValue(Bun.TOML.parse(activeContent), alias)).toBe(13);

    expect(injectGrokConfig(10100, MODELS, {
      grokHome,
      excluded: new Set(["gpt-5.6-sol"]),
    })).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    expect(modelTables(content)).toEqual([]);
    expect(countStringValue(Bun.TOML.parse(content), alias)).toBe(0);
    expect(content).toContain('[subagents.roles.reviewer]\ndescription = "Review code"');
    expect(content).toContain('[subagents.personas.concise]\ninstructions = "Be concise"');
  });

  // F7: the sweep must converge, or `changed` is meaningless to callers.
  test("is idempotent: the second sync reports no change", () => {
    writeOrphanedConfig();
    injectGrokConfig(10100, MODELS, { grokHome });
    const afterFirst = readFileSync(configPath, "utf8");

    const second = injectGrokConfig(10100, MODELS, { grokHome });
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(configPath, "utf8")).toBe(afterFirst);
  });

  // F6: the sweep runs inside the normalized window, so the user's EOL survives.
  test("preserves CRLF line endings", () => {
    writeOrphanedConfig();
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/\n/g, "\r\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("\r\n");
    expect(content.replace(/\r\n/g, "")).not.toContain("\n");
  });


  // The state a REAL machine reached (#511 field evidence): Grok re-serialized the file
  // into its own format and dropped our marker COMMENTS entirely. findManagedRegion then
  // returns null, so the whole file is in scope and the ownership predicate is the only
  // thing standing between the sweep and the user's own models.
  test("still adopts safely when Grok has dropped the markers entirely", () => {
    writeFileSync(configPath, [
      "[ui]",
      'fork_secondary_model = "grok-build"',
      "",
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "[model.ocx-gpt-5-6-sol]",            // stale: no context_window
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "chat_completions"',
      'api_key = "opencodex-loopback"',
      'name = "OCX gpt-5.6-sol"',
      "",
      "[model.ocx-gpt-5-6-sol-2]",          // the correct duplicate, also unfenced now
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "context_window = 372000",
      "",
      "[model.ocx-gpt-5-6-sol-2.extra_headers]",
      'x-opencodex-grok = "1"',
      "",
      "[model.hand-written]",               // must survive
      'model = "mine"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "not-ours"',
      "",
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    // Both opencodex duplicates collapse into the single regenerated entry.
    expect(modelTables(content).filter(alias => alias.startsWith("ocx-"))).toHaveLength(1);
    expect(content).toContain("context_window = 372000");
    // The user's model and settings are untouched.
    expect(content).toContain("[model.hand-written]");
    expect(content).toContain('api_key = "not-ours"');
    expect(content).toContain('fork_secondary_model = "grok-build"');
    // default still resolves.
    const survivor = /^default = "([^"]+)"/m.exec(content)?.[1];
    expect(content).toContain(`[model.${survivor}]`);
  });

  // F8: an ambiguous fence must refuse BEFORE the sweep, or "outside the region" could
  // mean the entire file.
  test("refuses to sweep when the end marker is missing", () => {
    const content = [
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
      BEGIN_MARKER,
      "",
    ].join("\n");
    writeFileSync(configPath, content);

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: false, changed: false, skippedReason: "orphaned-marker" });
    expect(readFileSync(configPath, "utf8")).toBe(content);
  });

  /**
   * The 2026-07-27 field failure. Grok re-serialized the file (marker comments gone,
   * `extra_headers` promoted to sub-tables) and, separately, the proxy had once run on a
   * different port. The result is a generation of OUR OWN entries pinned to a port
   * nothing listens on, with `[models] default` naming one of them: the TUI shows the
   * right context window (the stale entry carries it) while every turn retries against a
   * refused connection and nothing ever reaches the proxy.
   *
   * A stale entry is only distinguishable from the live one by VALUE — its loopback port
   * is not the port being injected — so port equality has to be part of the sweep.
   */
  test("adopts our own entries left on a port the proxy no longer listens on", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "[model.ocx-gpt-5-6-sol]",            // stale generation: dead port
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:4179/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      "context_window = 372000",
      "",
      "[model.ocx-gpt-5-6-sol.extra_headers]",
      'x-opencodex-grok = "1"',
      "",
      "[model.hand-written]",               // must survive untouched
      'model = "mine"',
      'base_url = "http://127.0.0.1:4179/v1"',
      'api_key = "not-ours"',
      "",
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    // No opencodex-owned entry may still point at the dead port.
    expect(content).not.toContain("127.0.0.1:4179/v1\"\napi_backend");
    expect(modelTables(content).filter(alias => alias.startsWith("ocx-"))).toHaveLength(1);
    // Its orphaned sub-table went with it, or the alias stays reserved forever.
    expect(content).not.toContain("[model.ocx-gpt-5-6-sol.extra_headers]");
    // `default` must name a table that actually exists and reaches the live port.
    const survivor = /^default = "([^"]+)"/m.exec(content)?.[1];
    expect(survivor).toBeDefined();
    expect(content).toContain(`[model.${survivor}]`);
    expect(content).toContain('base_url = "http://127.0.0.1:10100/v1"');
    // The user's own entry keeps its port, whatever it is.
    expect(content).toContain("[model.hand-written]");
    expect(content).toContain('api_key = "not-ours"');
  });
});

/**
 * Follow-up to the #511 fix: the sweep computed an orphan's span as "up to the next TABLE
 * HEADER", but the fence opens with a COMMENT. When nothing separated the orphan from the
 * fence, the span swallowed the BEGIN marker and the sweep deleted the fence opener — so the
 * block was re-appended at EOF, the old END marker was stranded, and every later sync
 * rewrote the file forever with `default` alternating between the two aliases.
 *
 * Every fixture in the suite above puts a blank line and another table between the orphan and
 * the fence, which is why 55 green tests missed it. Adjacency is the whole point here.
 */
describe("Grok orphan adoption — fence boundary (#511 follow-up)", () => {
  const END_MARKER = "# <<< opencodex managed block <<<";
  let root: string;
  let grokHome: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-grok-fence-"));
    grokHome = join(root, ".grok");
    mkdirSync(grokHome);
    configPath = join(grokHome, "config.toml");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const orphan = (alias: string): string[] => [
    `[model.${alias}]`,
    'model = "gpt-5.6-sol"',
    'base_url = "http://127.0.0.1:10100/v1"',
    'api_backend = "chat_completions"',
    'api_key = "opencodex-loopback"',
    'name = "OCX gpt-5.6-sol"',
  ];

  const fence = (alias: string): string[] => [
    BEGIN_MARKER,
    `[model.${alias}]`,
    'model = "gpt-5.6-sol"',
    "context_window = 372000",
    'base_url = "http://127.0.0.1:10100/v1"',
    'api_key = "opencodex-loopback"',
    END_MARKER,
  ];

  const count = (content: string, needle: string): number =>
    content.split(needle).length - 1;
  const tables = (content: string): string[] =>
    [...content.matchAll(/^\[model\.([^\]]+)\]$/gm)].map(match => match[1]!);

  test("an orphan directly above the fence does not swallow the BEGIN marker", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
    ].join("\n"));

    const results = [1, 2, 3].map(() => injectGrokConfig(10100, MODELS, { grokHome }));
    const content = readFileSync(configPath, "utf8");

    // The fence survives: exactly one of each marker, never a stranded second END.
    expect(count(content, BEGIN_MARKER)).toBe(1);
    expect(count(content, END_MARKER)).toBe(1);
    // The duplicate is gone, not routed around.
    expect(tables(content)).toEqual(["ocx-gpt-5-6-sol"]);
    // Convergence: only the first run may change the file.
    expect(results.map(result => result.changed)).toEqual([true, false, false]);
    // `default` settles instead of alternating between the two aliases every sync.
    expect(content).toContain('default = "ocx-gpt-5-6-sol"');
    expect(content).not.toContain('default = "ocx-gpt-5-6-sol-2"');
  });

  test("a below-fence orphan still gets its sub-tables swept", () => {
    // Grok re-serializes `extra_headers` into a sub-table. Leaving one behind keeps the alias
    // reserved by `userModelAliases`, which forces a `-2` duplicate forever — so the fence
    // clamp must NOT apply to a parent that already sits past the fence.
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...fence("ocx-placeholder"),
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      "[model.ocx-gpt-5-6-sol.extra_headers]",
      'x-opencodex-grok = "1"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");

    // Not a bare "extra_headers" check: the generated block legitimately writes an INLINE
    // `extra_headers = { ... }` key. What must be gone is the orphan's SUB-TABLE header.
    expect(content).not.toContain("[model.ocx-gpt-5-6-sol.extra_headers]");
    expect(tables(content)).toEqual(["ocx-gpt-5-6-sol"]);
    // The alias is free, so the writer never needs the suffixed form.
    expect(content).not.toContain("ocx-gpt-5-6-sol-2");
  });

  test("a below-fence orphan still gets its reasoning_efforts tables swept", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...fence("ocx-placeholder"),
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      "[[model.ocx-gpt-5-6-sol.reasoning_efforts]]",
      'id = "low"',
      'value = "low"',
      'label = "Low"',
      'description = "Quick, fast implementations"',
      "default = true",
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");

    expect(content).not.toContain("[[model.ocx-gpt-5-6-sol.reasoning_efforts]]");
    expect(tables(content)).toEqual(["ocx-gpt-5-6-sol"]);
    expect(content).not.toContain("ocx-gpt-5-6-sol-2");
  });

  test("an adjacent orphan with no blank line before the marker is still bounded", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
    ].join("\n"));

    const first = injectGrokConfig(10100, MODELS, { grokHome });
    const second = injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");

    expect(count(content, BEGIN_MARKER)).toBe(1);
    expect(count(content, END_MARKER)).toBe(1);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  test("orphans on both sides of the fence collapse together", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
      ...orphan("ocx-gpt-5-6-sol-3"),
      "",
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n"));

    const first = injectGrokConfig(10100, MODELS, { grokHome });
    const second = injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");

    expect(count(content, BEGIN_MARKER)).toBe(1);
    expect(count(content, END_MARKER)).toBe(1);
    expect(tables(content)).toEqual(["ocx-gpt-5-6-sol"]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    // Unrelated user config is untouched.
    expect(content).toContain("[ui]");
    expect(content).toContain('theme = "dark"');
  });

  test("a comment trailing an adopted orphan goes with it, and the sync converges", () => {
    // Known and accepted: a table's body runs to the next header, so a comment sitting
    // between the orphan and the fence belongs to the orphan and is removed with it. The
    // fence itself must still survive — that is the part this guards. A user note that must
    // outlive the sweep belongs above the orphan, and the pre-sweep backup keeps a copy.
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "# this note is above the orphan",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      "# this note trails the orphan",
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
    ].join("\n"));

    const first = injectGrokConfig(10100, MODELS, { grokHome });
    const second = injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");

    expect(content).toContain("# this note is above the orphan");
    expect(content).not.toContain("# this note trails the orphan");
    expect(count(content, BEGIN_MARKER)).toBe(1);
    expect(count(content, END_MARKER)).toBe(1);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    // The removed note is recoverable.
    expect(readFileSync(`${configPath}.bak-opencodex`, "utf8")).toContain("# this note trails the orphan");
  });

  test("adopting an orphan backs the user's config up first", () => {
    // The backup used to appear only as a side effect of the fence being destroyed.
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });

    const backup = readFileSync(`${configPath}.bak-opencodex`, "utf8");
    expect(backup).toContain("[model.ocx-gpt-5-6-sol]");
    expect(backup).toContain("[model.ocx-gpt-5-6-sol-2]");
  });

  // A stale [model_providers.opencodex] block from a previous managed fence (written by
  // the provider-inheritance shape) sits outside the current fence if the fence was
  // removed and re-added. The sweep must remove it just like a per-model orphan, or the
  // next sync writes a second [model_providers.opencodex] and Grok rejects the duplicate.
  // The fenced writer always emits the durable marker on the provider, so a real leftover
  // carries it even after a fence removal.
  test("sweeps a stale model_providers.opencodex block outside the fence", () => {
    writeFileSync(configPath, [
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      'extra_headers = { "x-opencodex-grok" = "1" }',
      "",
      ...fence("ocx-gpt-5-6-sol"),
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });

    const content = readFileSync(configPath, "utf8");
    // Exactly one [model_providers.opencodex] table survives, inside the fence.
    expect(content.match(/\[model_providers\.opencodex\]/g) ?? []).toHaveLength(1);
    expect(content.indexOf("[model_providers.opencodex]")).toBeGreaterThan(content.indexOf(BEGIN_MARKER));
  });

  test("does not sweep a user-authored model_providers block with a different id", () => {
    writeFileSync(configPath, [
      "[model_providers.my-gateway]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
      ...fence("ocx-gpt-5-6-sol"),
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });

    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[model_providers.my-gateway]");
    // And the managed block's own provider table is separate.
    expect(content.match(/\[model_providers\.opencodex\]/g) ?? []).toHaveLength(1);
  });

  test("does not sweep a model_providers.opencodex with a non-loopback base_url", () => {
    writeFileSync(configPath, [
      "[model_providers.opencodex]",
      'base_url = "https://example.com/v1"',
      'api_key = "opencodex-loopback"',
      "",
      ...fence("ocx-gpt-5-6-sol"),
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });

    // A remote base_url with our key is not ours to delete.
    expect(readFileSync(configPath, "utf8")).toContain('base_url = "https://example.com/v1"');
  });

  // Field state from a real machine (2026-08-27): Grok re-serialized the provider block,
  // promoting the inline `extra_headers` into a sub-table placed BETWEEN the provider
  // header and its own keys. The provider-only body then looks empty, and a leftover
  // child collides with the regenerated block's inline `extra_headers`
  // ("Cannot redefine key") — the whole TOML layer is rejected.
  test("sweeps a reserialized provider block whose sub-table precedes its keys", () => {
    writeFileSync(configPath, [
      "[model_providers.opencodex]",
      "[model_providers.opencodex.extra_headers]",
      'x-opencodex-grok = "1"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      "",
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'model_provider = "opencodex"',
      'name = "OCX gpt-5.6-sol"',
      "",
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    // The unfenced provider + model are adopted; exactly one of each survives, inside the fence.
    expect(content.match(/\[model_providers\.opencodex\]/g) ?? []).toHaveLength(1);
    expect(content.match(/\[model_providers\.opencodex\.extra_headers\]/g) ?? []).toHaveLength(0);
    expect(tables(content).filter(alias => alias.startsWith("ocx-"))).toHaveLength(1);
    expect(content.indexOf("[model_providers.opencodex]")).toBeGreaterThan(content.indexOf(BEGIN_MARKER));
    // default still resolves.
    const survivor = /^default = "([^"]+)"/m.exec(content)?.[1];
    expect(content).toContain(`[model.${survivor}]`);
    expect(() => Bun.TOML.parse(content)).not.toThrow();
  });

  // The other re-serialization order: keys first, sub-table after. The provider's own
  // body still judges, and the child must be swallowed or the same key collision returns.
  test("sweeps a reserialized provider block whose sub-table follows its keys", () => {
    writeFileSync(configPath, [
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      "",
      "[model_providers.opencodex.extra_headers]",
      'x-opencodex-grok = "1"',
      "",
      ...fence("ocx-gpt-5-6-sol"),
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });

    const content = readFileSync(configPath, "utf8");
    expect(content.match(/\[model_providers\.opencodex\]/g) ?? []).toHaveLength(1);
    expect(content.match(/\[model_providers\.opencodex\.extra_headers\]/g) ?? []).toHaveLength(0);
    expect(() => Bun.TOML.parse(content)).not.toThrow();
  });

  // The migration's real regression: model tables in the provider-inheritance shape carry
  // NO api_key/base_url of their own, so the legacy predicate missed them and every sync
  // after a Grok rewrite allocated a -2 duplicate beside the stale original. Adoption
  // must follow the model_provider reference to the owned provider table.
  test("adopts model_provider-referencing entries left unfenced by a Grok rewrite", () => {
    writeFileSync(configPath, [
      "[ui]",
      'fork_secondary_model = "grok-build"',
      "",
      "[model_providers.opencodex]",
      "[model_providers.opencodex.extra_headers]",
      'x-opencodex-grok = "1"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      "",
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'model_provider = "opencodex"',
      'name = "OCX gpt-5.6-sol"',
      "",
      "[model.ocx-gpt-5-6-terra]",
      'model = "gpt-5.6-terra"',
      'model_provider = "opencodex"',
      'name = "OCX gpt-5.6-terra"',
      "",
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    // The sol entry collapses into the single regenerated one — no -2 duplicates. The
    // terra entry is genuinely retired (not in MODELS): explicitly-owned rows are kept
    // outside the fence rather than deleted by an inject, so it remains — unfenced but
    // adopted (its alias is reserved and never re-suffixed). One table survives per
    // model id.
    expect(tables(content)).toEqual(["ocx-gpt-5-6-terra", "ocx-gpt-5-6-sol"]);
    expect(content).not.toContain("[model.ocx-gpt-5-6-sol-2]");
    expect(content).not.toContain("[model.ocx-gpt-5-6-terra-2]");
    // default still resolves: it names the sol entry, which survives inside the fence.
    const survivor = /^default = "([^"]+)"/m.exec(content)?.[1];
    expect(content).toContain(`[model.${survivor}]`);
    expect(content).toContain("context_window = 372000");
    // User content survives.
    expect(content).toContain('fork_secondary_model = "grok-build"');
    expect(() => Bun.TOML.parse(content)).not.toThrow();
  });

  test("does not adopt a model referencing a provider that fails the ownership predicate", () => {
    writeFileSync(configPath, [
      "[model_providers.my-gateway]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "user-secret"',
      "",
      "[model.ocx-mine]",
      'model = "user/model"',
      'model_provider = "my-gateway"',
      'name = "OCX mine"',
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    // A referenced-but-user-owned provider keeps its model table untouched, and ours
    // takes a suffixed alias instead of clobbering it.
    expect(content).toContain("[model.ocx-mine]");
    expect(content).toContain('model_provider = "my-gateway"');
    expect(content).not.toContain("[model.ocx-mine-2]");
    expect(() => Bun.TOML.parse(content)).not.toThrow();
  });

  test("folds provider sub-tables separated from their parent by a user table", () => {
    // TOML allows the re-serialized child to sit after an unrelated table. A first-mismatch
    // stop left the stale provider unfolded: without the marker evidence it stayed, and the
    // next sync declared a duplicate [model_providers.opencodex] — invalid TOML for Grok.
    writeFileSync(configPath, [
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      "",
      "[ui.detailed]",
      "verbose = true",
      "",
      "[model_providers.opencodex.extra_headers]",
      'x-opencodex-grok = "1"',
      "",
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'model_provider = "opencodex"',
      'name = "OCX gpt-5.6-sol"',
      "",
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    expect(content.match(/\[model_providers\.opencodex\]/g) ?? []).toHaveLength(1);
    expect(content.match(/\[model_providers\.opencodex\.extra_headers\]/g) ?? []).toHaveLength(0);
    // The interleaved user table survives.
    expect(content).toContain("[ui.detailed]");
    expect(tables(content).filter(alias => alias.startsWith("ocx-"))).toHaveLength(1);
    expect(() => Bun.TOML.parse(content)).not.toThrow();
  });

  test("teardown resolves inherited ownership through the fenced provider", () => {
    // A retired model kept outside the fence inherits its verdict from the provider table
    // INSIDE it. Classification must see the fenced provider, or strip removes the fence
    // but leaves the model with a dangling `model_provider = "opencodex"` reference.
    writeFileSync(configPath, [
      "[ui]",
      'fork_secondary_model = "grok-build"',
      "",
      BEGIN_MARKER,
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      OWNERSHIP_MARKER,
      "",
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'model_provider = "opencodex"',
      'name = "OCX gpt-5.6-sol"',
      END_MARKER,
      "",
      "[model.ocx-gpt-5-6-terra]",
      'model = "gpt-5.6-terra"',
      'model_provider = "opencodex"',
      'name = "OCX gpt-5.6-terra"',
      "",
      "[models]",
      'default = "ocx-gpt-5-6-terra"',
    ].join("\n"));

    const result = stripGrokConfig({ grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    // The fence and the retired model are both gone; no dangling reference survives.
    expect(content).not.toContain("model_provider = \"opencodex\"");
    expect(content).not.toContain("[model_providers.opencodex]");
    expect(content).toContain('fork_secondary_model = "grok-build"');
    expect(() => Bun.TOML.parse(content)).not.toThrow();
  });

  test("does not adopt a user-written model that references the managed provider", () => {
    // Inheritance must not grant removal authority over every model that references
    // opencodex: a user is free to write their own [model.*] table that inherits the
    // managed provider, and adoption without a generated alias deletes it.
    for (const operation of ["inject", "teardown"] as const) {
      writeFileSync(configPath, [
        BEGIN_MARKER,
        "[model_providers.opencodex]",
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_backend = "responses"',
        'api_key = "opencodex-loopback"',
        OWNERSHIP_MARKER,
        "",
        "[model.ocx-gpt-5-6-sol]",
        'model = "gpt-5.6-sol"',
        'model_provider = "opencodex"',
        'name = "OCX gpt-5.6-sol"',
        END_MARKER,
        "",
        "[model.custom-variant]",
        'model = "gpt-5.6-sol"',
        'model_provider = "opencodex"',
        'name = "my fast variant"',
        "context_window = 128000",
        "",
      ].join("\n"));

      if (operation === "inject") {
        expect(injectGrokConfig(10100, MODELS, { grokHome }))
          .toMatchObject({ ok: true, changed: true });
      } else {
        expect(stripGrokConfig({ grokHome })).toMatchObject({ ok: true, changed: true });
      }
      const content = readFileSync(configPath, "utf8");
      expect(content).toContain("[model.custom-variant]");
      expect(content).toContain('name = "my fast variant"');
      expect(content).toContain("context_window = 128000");
      expect(() => Bun.TOML.parse(content)).not.toThrow();
    }
  });

  test("sweeping a provider-only orphan backs the user's config up first", () => {
    // Provider orphans carry no alias, so an alias-count backup condition skipped the
    // backup entirely even though teardown removed the table.
    writeFileSync(configPath, [
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      'extra_headers = { "x-opencodex-grok" = "1" }',
      "",
      BEGIN_MARKER,
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      'extra_headers = { "x-opencodex-grok" = "1" }',
      "",
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'model_provider = "opencodex"',
      'name = "OCX gpt-5.6-sol"',
      END_MARKER,
      "",
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
    ].join("\n"));

    const result = stripGrokConfig({ grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    expect(existsSync(join(grokHome, "config.toml.bak-opencodex"))).toBe(true);
    const content = readFileSync(configPath, "utf8");
    expect(content).not.toContain("[model_providers.opencodex]");
    expect(content).toContain("[models]");
    expect(() => Bun.TOML.parse(content)).not.toThrow();
  });
});
