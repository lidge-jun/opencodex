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

  test("emits a shared model_providers block and per-model references (grok 0.2.109+)", () => {
    const block = buildGrokManagedBlock(10190, [{ id: "cursor/grok-4.5", contextWindow: 500_000 }]);
    expect(block).toContain("[model_providers.opencodex]");
    const providerBlock = block.slice(block.indexOf("[model_providers.opencodex]"), block.indexOf("[model."));
    expect(providerBlock).toContain('base_url = "http://127.0.0.1:10190/v1"');
    expect(providerBlock).toContain('api_backend = "responses"');
    expect(providerBlock).toContain('api_key = "opencodex-loopback"');
    expect(providerBlock).toContain('extra_headers = { "x-opencodex-grok" = "1" }');
    const table = block.slice(block.indexOf("[model.ocx-cursor-grok-4-5]"));
    expect(table).toContain('model = "cursor/grok-4.5"');
    expect(table).toContain('model_provider = "opencodex"');
    expect(table).not.toContain('base_url =');
    expect(table).not.toContain('api_key =');
    expect(table).not.toContain('api_backend =');
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

  test("decodes TOML unicode escapes in user model headers", () => {
    const configPath = join(grokHome, "config.toml");
    // \U0000006F and \u006F are both "o" — these headers canonically define model.ocx-esc*.
    const userContent = '[model."\\U0000006Fcx-esc"]\nmodel = "user/esc"\n[model."\\u006Fcx-esc4"]\nmodel = "user/esc4"\n';
    writeFileSync(configPath, userContent, "utf8");

    injectGrokConfig(10100, [{ id: "esc" }, { id: "esc4" }], { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).not.toContain("[model.ocx-esc]");
    expect(content).not.toContain("[model.ocx-esc4]");
    expect(content).toContain("[model.ocx-esc-2]");
    expect(content).toContain("[model.ocx-esc4-2]");
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

  describe("user table reservation across TOML header spellings", () => {
    const configPath = () => join(grokHome, "config.toml");

    // Every spelling below addresses the SAME table as a generated [model.ocx-mine]. grok's TOML
    // parser rejects the entire config layer on a duplicate key, so an unreserved spelling would
    // destroy every unrelated setting the user owns — not just our block.
    const collidingSpellings: Array<[label: string, header: string]> = [
      ["quoted first segment", '["model"."ocx-mine"]'],
      ["single-quoted first segment", "['model'.ocx-mine]"],
      ["mixed quoting with whitespace", `[ "model" . 'ocx-mine' ]`],
      ["bare (baseline)", "[model.ocx-mine]"],
      ["array of tables", "[[model.ocx-mine]]"],
      ["sub-table", "[model.ocx-mine.extra]"],
      ["trailing comment", '[model."ocx-mine"] # mine'],
    ];

    for (const [label, header] of collidingSpellings) {
      test(`reserves a user alias written as ${label}`, () => {
        writeFileSync(configPath(), `${header}\nmodel = "user/keeps-this"\n`, "utf8");

        injectGrokConfig(10100, [{ id: "mine" }], { grokHome });

        const written = readFileSync(configPath(), "utf8");
        const generated = written.slice(written.indexOf(BEGIN_MARKER));
        expect(generated).toContain("[model.ocx-mine-2]");
        expect(generated).not.toContain("[model.ocx-mine]\n");
      });
    }

    test("does not reserve aliases from unrelated tables", () => {
      // [models.*] and [model_providers.*] are different tables entirely — reserving from them
      // would needlessly suffix our aliases.
      writeFileSync(
        configPath(),
        '[models.ocx-mine]\nx = 1\n\n[model_providers.ocx-mine]\ny = 2\n\n[auth_provider.ocx-mine]\nz = 3\n',
        "utf8",
      );

      injectGrokConfig(10100, [{ id: "mine" }], { grokHome });

      const written = readFileSync(configPath(), "utf8");
      expect(written.slice(written.indexOf(BEGIN_MARKER))).toContain("[model.ocx-mine]");
    });

    test("an unclosed header inside a multiline string does not swallow the next real header", () => {
      // The sub-table tail must not run past its own line. When it did, this valid TOML made the
      // scan reserve "a" and miss ocx-mine entirely, so we emitted a duplicate [model.ocx-mine]
      // and grok rejected the whole config layer.
      const userContent = 'prompt = """\n[model.a.b\n"""\n\n[model.ocx-mine]\nmodel = "user/keeps-this"\n';
      writeFileSync(configPath(), userContent, "utf8");

      injectGrokConfig(10100, [{ id: "mine" }], { grokHome });

      const generated = readFileSync(configPath(), "utf8");
      expect(generated.slice(generated.indexOf(BEGIN_MARKER))).toContain("[model.ocx-mine-2]");
      expect(generated.match(/^\[model\.ocx-mine\]$/gm)).toHaveLength(1);
    });

    test("generated aliases never contain a dot", () => {
      // A bare [model.grok-4.5] header is a THREE-segment key path, not the id "grok-4.5".
      injectGrokConfig(10100, [{ id: "xai/grok-4.5" }, { id: "a.b.c" }], { grokHome });

      const written = readFileSync(configPath(), "utf8");
      const headers = [...written.matchAll(/^\[model\.(.+)\]$/gm)].map(m => m[1]!);
      expect(headers.length).toBeGreaterThan(0);
      for (const alias of headers) expect(alias).not.toContain(".");
    });
  });

  describe("byte-for-byte restore of user config", () => {
    const configPath = () => join(grokHome, "config.toml");

    const originals: Array<[label: string, content: string]> = [
      ["no trailing newline", 'theme = "dark"'],
      ["one trailing newline", 'theme = "dark"\n'],
      ["two trailing newlines", 'theme = "dark"\n\n'],
      ["three trailing newlines", 'theme = "dark"\n\n\n'],
      ["multi-section, no trailing newline", '[a]\nx = 1\n\n[b]\ny = 2'],
    ];

    for (const [label, original] of originals) {
      test(`inject + strip restores a config with ${label}`, () => {
        writeFileSync(configPath(), original, "utf8");

        injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome });
        stripGrokConfig({ grokHome });

        expect(readFileSync(configPath(), "utf8")).toBe(original);
      });
    }

    test("repeated inject/strip cycles never grow the file", () => {
      // Deliberately the shapes that the previous separator rule got wrong: a file with no
      // terminator, and a multi-section file. A file already ending in one newline round-tripped
      // even before the fix, so it cannot detect drift.
      for (const original of ['theme = "dark"', '[a]\nx = 1\n\n[b]\ny = 2']) {
        writeFileSync(configPath(), original, "utf8");
        for (let i = 0; i < 5; i += 1) {
          injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome });
          stripGrokConfig({ grokHome });
          expect(readFileSync(configPath(), "utf8")).toBe(original);
        }
      }
    });

    test("content the user appended after the block is preserved", () => {
      const original = 'theme = "dark"\n';
      writeFileSync(configPath(), original, "utf8");
      injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome });

      const withUserTail = `${readFileSync(configPath(), "utf8")}\n[mine]\nkeep = true\n`;
      writeFileSync(configPath(), withUserTail, "utf8");

      stripGrokConfig({ grokHome });

      expect(readFileSync(configPath(), "utf8")).toBe(`${original}\n[mine]\nkeep = true\n`);
    });

    test("uniform CRLF round-trips byte-for-byte", () => {
      // Mixed EOL cannot round-trip by design: applyEol normalizes the whole file to the
      // dominant terminator. Uniform CRLF is the contract we hold.
      const original = 'theme = "dark"\r\n[a]\r\nx = 1\r\n';
      writeFileSync(configPath(), original, "utf8");

      injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome });
      // After CRLF normalization every \n carries a \r, so asserting on a bare "\n\n" could
      // never fail. The real question is whether a blank CRLF line crept in before the fence.
      expect(readFileSync(configPath(), "utf8")).not.toContain("\r\n\r\n\r\n");
      stripGrokConfig({ grokHome });

      expect(readFileSync(configPath(), "utf8")).toBe(original);
    });
  });

  describe("non-loopback binds refuse auto-registration", () => {
    const configPath = () => join(grokHome, "config.toml");

    // A wildcard bind is NOT loopback: it exposes the proxy on every interface, so the data
    // plane demands the admission token that a regenerated block cannot safely carry.
    for (const hostname of ["0.0.0.0", "::", "[::]", "192.168.1.10", "proxy.lan"]) {
      test(`skips injection when bound to ${hostname}`, () => {
        const result = injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome, hostname });

        expect(result).toMatchObject({ ok: true, changed: false, skippedReason: "non-loopback" });
        expect(existsSync(configPath())).toBe(false);
        expect(result.message).toContain("admission token");
      });
    }

    for (const hostname of [undefined, "", "127.0.0.1", "localhost", "::1", "[::1]"]) {
      test(`still registers when bound to ${hostname === undefined ? "(unset)" : hostname || "(empty)"}`, () => {
        const result = injectGrokConfig(
          10100,
          [{ id: "gpt-5.6-sol" }],
          hostname === undefined ? { grokHome } : { grokHome, hostname },
        );

        expect(result).toMatchObject({ ok: true, changed: true });
        expect(readFileSync(configPath(), "utf8")).toContain("[model.ocx-gpt-5-6-sol]");
      });
    }

    test("never emits env_key, which would open grok's session-token fallthrough", () => {
      // With no `model_provider` to fail closed, an unresolved env_key makes grok fall through
      // to its xAI session bearer and send it to whatever base_url we wrote.
      injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome, hostname: "127.0.0.1" });
      expect(readFileSync(configPath(), "utf8")).not.toContain("env_key");
    });

    test("removes a stale loopback block when the bind moves to non-loopback", () => {
      const userContent = 'theme = "dark"\n';
      writeFileSync(configPath(), userContent, "utf8");
      injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome, hostname: "127.0.0.1" });
      expect(readFileSync(configPath(), "utf8")).toContain(BEGIN_MARKER);

      const result = injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome, hostname: "0.0.0.0" });

      expect(result).toMatchObject({ ok: true, changed: true, skippedReason: "non-loopback" });
      expect(readFileSync(configPath(), "utf8")).toBe(userContent);
    });

    test("leaves a user-managed api_key untouched across repeated syncs", () => {
      // The exact scenario the maintainer reproduced as REAL_TOKEN_PRESERVED=false.
      const userContent = '[model.mine]\nmodel = "gpt-5.6-sol"\nbase_url = "http://192.168.1.10:10100/v1"\napi_key = "real-admission-token"\n';
      writeFileSync(configPath(), userContent, "utf8");

      for (let i = 0; i < 3; i += 1) {
        injectGrokConfig(10100, [{ id: "gpt-5.6-sol" }], { grokHome, hostname: "192.168.1.10" });
      }

      expect(readFileSync(configPath(), "utf8")).toBe(userContent);
    });
  });
});
