import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  setPersistedConfigMutationBeforeCommitForTests,
} from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { getAuthStorePath, saveCredential } from "../../src/oauth/store";
import {
  CC_SWITCH_IMPORT_JOURNAL_FILENAME,
  CcSwitchImportError,
  METADATA_REFUSED_SENTINEL,
  URL_SYNTAX_REFUSED_SENTINEL,
  parseCodexTomlBytes,
  readSqliteRows,
  runCcSwitchProviderImport,
  scanCcSwitchJsonBytes,
  setCcSwitchSourceOpenHookForTests,
} from "../../src/providers/cc-switch-import";
import { cmdProviderCcSwitchImport } from "../../src/cli/provider-cc-switch-import";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Runtime-assembled canary so privacy:scan never sees a literal token prefix in the source file.
const CANARY_SECRET = ["sk", "canary", "DO", "NOT", "READ", "9876543210abcdef"].join("-");
const PREFIXLESS_HEX_SECRET = ["9f86d081", "884c7d65", "9a2feaa0", "c55ad015"].join("");
const PREFIXLESS_MIXED_SECRET = "Ab3Def9Gh1Jk2Lm4Np6Qr8St0Uv";
const WORD_CANARY = "violetotter";

let scratch: string;
let targetHome: string;
let sourceDir: string;
let originalHome: string | undefined;

function createSqliteFixture(
  rows: Array<{ id: string; app_type: string; name: string; settings_config: string; sort_index?: number }>,
  walMode = false,
): string {
  const dbPath = join(sourceDir, walMode ? "cc-switch-wal.db" : "cc-switch.db");
  const db = new Database(dbPath, { create: true });
  try {
    if (walMode) db.run("PRAGMA journal_mode = WAL;");
    db.run(`
      CREATE TABLE providers (
        id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        website_url TEXT,
        category TEXT,
        created_at INTEGER,
        sort_index INTEGER,
        notes TEXT,
        icon TEXT,
        icon_color TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        is_current BOOLEAN NOT NULL DEFAULT 0,
        in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
        PRIMARY KEY (id, app_type)
      )
    `);
    const insert = db.prepare("INSERT INTO providers (id, app_type, name, settings_config, sort_index) VALUES (?1, ?2, ?3, ?4, ?5)");
    try {
      for (const r of rows) {
        insert.run(r.id, r.app_type, r.name, r.settings_config, r.sort_index ?? 0);
      }
    } finally {
      insert.finalize();
    }
    if (walMode) db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
  return dbPath;
}

beforeEach(() => {
  originalHome = process.env.OPENCODEX_HOME;
  const ok = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => ok);
  setAsyncIcaclsRunnerForTests(async () => ok);
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-cc-switch-")));
  targetHome = join(scratch, "ocx-home");
  sourceDir = join(scratch, "cc-switch");
  mkdirSync(targetHome, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  process.env.OPENCODEX_HOME = targetHome;
  saveConfig(loadConfig());
});

afterEach(async () => {
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  setPersistedConfigMutationBeforeCommitForTests(null);
  setCcSwitchSourceOpenHookForTests(null);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(scratch);
});

describe("CC-Switch keyless provider import", () => {
  test("SQLite preview and apply strip TOML comments, drop free-text names, keep source read-only, and never materialize secrets", async () => {
    const codexToml = [
      `model = "gpt-5.6-sol" # inline_comment_token = "${CANARY_SECRET}" and ${PREFIXLESS_HEX_SECRET}`,
      `model_provider = "acme.\\u0071uoted" # ${PREFIXLESS_MIXED_SECRET}`,
      `experimental_bearer_token = "${CANARY_SECRET}"`,
      `[ model_providers . "acme.\\u0071uoted" ] # header_secret = "${CANARY_SECRET}"`,
      `base_url = "https://codex.acme.example/v1" # experimental_bearer_token = "${CANARY_SECRET}" ${PREFIXLESS_HEX_SECRET}`,
      `wire_api = "responses" # ${CANARY_SECRET}`,
      `api_key = "${CANARY_SECRET}"`,
    ].join("\n");

    const dbPath = createSqliteFixture([
      {
        id: "acme-claude",
        app_type: "claude",
        name: `FreeTextNameWithSecret ${CANARY_SECRET} ${PREFIXLESS_HEX_SECRET}`,
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://claude.acme.example",
            ANTHROPIC_API_KEY: CANARY_SECRET,
            ANTHROPIC_AUTH_TOKEN: PREFIXLESS_HEX_SECRET,
            ANTHROPIC_MODEL: "claude-opus-4-5-20251101",
          },
        }),
        sort_index: 1,
      },
      {
        id: "acme-codex",
        app_type: "codex",
        name: `CodexNameSecret ${PREFIXLESS_MIXED_SECRET}`,
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: CANARY_SECRET },
          config: codexToml + `\n[unrelated_section]\nbase_url = "${CANARY_SECRET}"\nmodel = "${CANARY_SECRET}"\n[model_providers.acme.extra]\nbase_url = "${CANARY_SECRET}"\n[model_providers."acme".extra]\nwire_api = "${CANARY_SECRET}"\n[model_providers."a"."b"]\nbase_url = "${CANARY_SECRET}"\n`,
        }),
        sort_index: 2,
      },
      {
        id: "acme-gemini",
        app_type: "gemini",
        name: `GeminiSecret ${CANARY_SECRET}`,
        settings_config: JSON.stringify({
          env: {
            GOOGLE_GEMINI_BASE_URL: "https://subrouter.ai/v1beta",
            GEMINI_API_KEY: CANARY_SECRET,
            GEMINI_MODEL: "gemini-2.5-pro",
          },
        }),
        sort_index: 3,
      },
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        app_type: "openai",
        name: `UuidSecret ${CANARY_SECRET}`,
        settings_config: JSON.stringify({
          baseUrl: "https://api.openai.com/v1",
          model: "qwen3-235b-a22b",
          apiKey: CANARY_SECRET,
        }),
        sort_index: 4,
      },
    ]);
    const walDbPath = createSqliteFixture([
      {
        id: "wal-claude",
        app_type: "claude",
        name: `WalSecret ${CANARY_SECRET}`,
        settings_config: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://wal.acme.example" } }),
      },
    ], true);
    const dbBytesBefore = readFileSync(dbPath);
    const decodedStrings: string[] = [];
    const origDecode = TextDecoder.prototype.decode;
    const decodeSpy = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args: unknown[]) {
      const res = origDecode.apply(this, args as [BufferSource?, TextDecodeOptions?]);
      decodedStrings.push(res);
      return res;
    });

    let preview;
    let walRows;
    try {
      const sqliteProjected = JSON.stringify(readSqliteRows(dbPath));
      expect(sqliteProjected).not.toContain(CANARY_SECRET);
      expect(sqliteProjected).not.toContain(PREFIXLESS_HEX_SECRET);
      expect(sqliteProjected).not.toContain(PREFIXLESS_MIXED_SECRET);
      walRows = readSqliteRows(walDbPath);

      preview = await runCcSwitchProviderImport({ mode: "preview", sourcePath: dbPath });
    } finally {
      decodeSpy.mockRestore();
    }
    expect(walRows).toHaveLength(1);
    expect(walRows[0]?.id).toBe("wal-claude");
    expect(walRows[0]?.claudeBaseUrl).toBe("https://wal.acme.example");
    for (const s of decodedStrings) {
      expect(s).not.toContain(CANARY_SECRET);
      expect(s).not.toContain(PREFIXLESS_HEX_SECRET);
      expect(s).not.toContain(PREFIXLESS_MIXED_SECRET);
    }

    expect(preview).toEqual({
      mode: "preview",
      discovered: 4,
      eligible: 4,
      imported: 0,
      conflicts: 0,
      conflictNames: [],
      invalid: 0,
      invalidReasons: {},
      providers: [
        {
          name: "acme-claude",
          sourceId: "acme-claude",
          appType: "claude",
          adapter: "anthropic",
          baseUrl: "https://claude.acme.example",
          defaultModel: "claude-opus-4-5-20251101",
        },
        {
          name: "acme-codex",
          sourceId: "acme-codex",
          appType: "codex",
          adapter: "openai-responses",
          baseUrl: "https://codex.acme.example/v1",
          defaultModel: "gpt-5.6-sol",
        },
        {
          name: "acme-gemini",
          sourceId: "acme-gemini",
          appType: "gemini",
          adapter: "google",
          baseUrl: "https://subrouter.ai/v1beta",
          defaultModel: "gemini-2.5-pro",
        },
        {
          name: "550e8400-e29b-41d4-a716-446655440000",
          sourceId: "550e8400-e29b-41d4-a716-446655440000",
          appType: "openai",
          adapter: "openai-chat",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "qwen3-235b-a22b",
        },
      ],
    });
    expect(JSON.stringify(preview)).not.toContain(CANARY_SECRET);
    expect(existsSync(join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME))).toBe(false);

    const applied = await runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath });
    expect(applied.mode).toBe("apply");
    if (applied.mode === "apply") {
      expect(applied.imported).toBe(4);
    }

    const configRaw = readFileSync(getConfigPath(), "utf8");
    const journalRaw = readFileSync(join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME), "utf8");
    expect(configRaw).not.toContain(CANARY_SECRET);
    expect(journalRaw).not.toContain(CANARY_SECRET);

    const saved = loadConfig();
    expect(saved.providers["acme-claude"]).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://claude.acme.example",
      defaultModel: "claude-opus-4-5-20251101",
    });
    expect(saved.providers["acme-claude"]?.apiKey).toBeUndefined();
    expect(saved.providers["acme-codex"]).toMatchObject({
      adapter: "openai-responses",
      baseUrl: "https://codex.acme.example/v1",
      defaultModel: "gpt-5.6-sol",
    });
    expect(saved.providers["acme-codex"]?.apiKey).toBeUndefined();
    expect(saved.providers["acme-gemini"]).toMatchObject({
      adapter: "google",
      baseUrl: "https://subrouter.ai/v1beta",
      defaultModel: "gemini-2.5-pro",
    });
    expect(saved.providers["acme-gemini"]?.apiKey).toBeUndefined();
    expect(saved.providers["550e8400-e29b-41d4-a716-446655440000"]).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "qwen3-235b-a22b",
    });
    expect(readFileSync(dbPath).equals(dbBytesBefore)).toBe(true);
  });

  test("legacy JSON byte scanner zeroes its buffer, skips secret fields, and disambiguates multi-app IDs", async () => {
    const jsonPath = join(sourceDir, "config.json");
    const doc = {
      apps: {
        claude: {
          providers: {
            shared: {
              name: `NameSecret ${CANARY_SECRET} ${PREFIXLESS_HEX_SECRET}`,
              settingsConfig: {
                env: {
                  ANTHROPIC_BASE_URL: "https://claude.shared.example",
                  ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
                  ANTHROPIC_API_KEY: CANARY_SECRET,
                },
              },
            },
          },
        },
        gemini: {
          providers: {
            "6ba7b810-9dad-11d1-80b4-00c04fd430c8": {
              name: `GemName ${CANARY_SECRET}`,
              settingsConfig: {
                env: {
                  GOOGLE_GEMINI_BASE_URL: "https://openrouter.ai/api",
                  GEMINI_API_KEY: CANARY_SECRET,
                  GEMINI_MODEL: "gpt-4o-2024-08-06",
                },
              },
            },
          },
        },
        openai: {
          providers: {
            shared: {
              name: "Shared OpenAI",
              settingsConfig: {
                baseUrl: "https://openai.shared.example/v1",
                apiKey: CANARY_SECRET,
                model: "gpt-4.1",
              },
            },
          },
        },
        codex: {
          providers: {
            "codex-json": {
              name: "Codex JSON",
              settingsConfig: {
                [PREFIXLESS_HEX_SECRET]: CANARY_SECRET,
                auth: { OPENAI_API_KEY: CANARY_SECRET },
                config: [
                  `model = "gpt-5.6-sol" # comment_secret = "${CANARY_SECRET}" ${PREFIXLESS_HEX_SECRET}`,
                  `model_provider = "cjson" # ${PREFIXLESS_MIXED_SECRET}`,
                  `experimental_bearer_token = "${CANARY_SECRET}"`,
                  `"${PREFIXLESS_HEX_SECRET}" = "ignored"`,
                  `[model_providers.cjson] # ${CANARY_SECRET}`,
                  `base_url = "https://codex.json.example/v1" # ${CANARY_SECRET} ${PREFIXLESS_HEX_SECRET}`,
                  'wire_api = "responses"',
                  `api_key = "${CANARY_SECRET}"`,
                  '[unrelated]',
                  `[unrelated.${PREFIXLESS_HEX_SECRET}]`,
                  `base_url = "${CANARY_SECRET}"`,
                ].join("\n"),
              },
            },
          },
        },
      },
    };
    writeFileSync(jsonPath, "\uFEFF" + JSON.stringify(doc, null, 2));
    const rawBytes = new Uint8Array(readFileSync(jsonPath));
    const decodedStrings: string[] = [];
    const origDecode = TextDecoder.prototype.decode;
    const decodeSpy = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args: unknown[]) {
      const res = origDecode.apply(this, args as [BufferSource?, TextDecodeOptions?]);
      decodedStrings.push(res);
      return res;
    });
    let scanned;
    let secretHeaderResult;
    let escapedQuoteHeaderResult;
    let escapedQuoteModelProviderResult;
    try {
      scanned = scanCcSwitchJsonBytes(rawBytes);
      const secretHeaderBytes = Buffer.from(`[model_providers.${PREFIXLESS_HEX_SECRET}]\nbase_url = "https://x.example.com/v1"\n`, "utf8");
      const escapedQuoteHeaderBytes = Buffer.from('[model_providers."foo\\"bar"]\nbase_url = "https://x.example.com/v1"\n', "utf8");
      const escapedQuoteMpBytes = Buffer.from('model_provider = "foo\\"bar"\n[model_providers.foo]\nbase_url = "https://x.example.com/v1"\n', "utf8");
      try {
        secretHeaderResult = parseCodexTomlBytes(secretHeaderBytes);
        escapedQuoteHeaderResult = parseCodexTomlBytes(escapedQuoteHeaderBytes);
        escapedQuoteModelProviderResult = parseCodexTomlBytes(escapedQuoteMpBytes);
      } finally {
        secretHeaderBytes.fill(0);
        escapedQuoteHeaderBytes.fill(0);
        escapedQuoteMpBytes.fill(0);
      }
    } finally {
      decodeSpy.mockRestore();
    }
    expect(secretHeaderResult).toEqual({ ok: false, reason: "disallowed_metadata" });
    expect(escapedQuoteHeaderResult).toEqual({ ok: false, reason: "disallowed_metadata" });
    expect(escapedQuoteModelProviderResult).toEqual({ ok: false, reason: "disallowed_metadata" });
    expect(decodedStrings.join("|")).not.toContain('foo"bar');
    expect(rawBytes.every(b => b === 0)).toBe(true);
    expect(JSON.stringify(scanned)).not.toContain(CANARY_SECRET);
    expect(JSON.stringify(scanned)).not.toContain(PREFIXLESS_HEX_SECRET);
    expect(JSON.stringify(scanned)).not.toContain(PREFIXLESS_MIXED_SECRET);
    for (const s of decodedStrings) {
      expect(s).not.toContain(CANARY_SECRET);
      expect(s).not.toContain(PREFIXLESS_HEX_SECRET);
      expect(s).not.toContain(PREFIXLESS_MIXED_SECRET);
    }
    expect(scanned.find(r => r.id === "codex-json")?.codexTomlLines).toBeNull();

    const applied = await runCcSwitchProviderImport({
      mode: "apply",
      sourcePath: jsonPath,
      selectedProviders: ["shared-claude", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
    });
    expect(applied.mode).toBe("apply");
    if (applied.mode === "apply") {
      expect(applied.imported).toBe(2);
      expect(applied.providers.map(p => p.name)).toEqual(["shared-claude", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"]);
    }
    const saved = loadConfig();
    expect(saved.providers["shared-claude"]?.baseUrl).toBe("https://claude.shared.example");
    expect(saved.providers["shared-claude"]?.defaultModel).toBe("claude-sonnet-4-20250514");
    expect(saved.providers["6ba7b810-9dad-11d1-80b4-00c04fd430c8"]).toMatchObject({
      adapter: "google",
      baseUrl: "https://openrouter.ai/api",
      defaultModel: "gpt-4o-2024-08-06",
    });
    expect(saved.providers["shared-openai"]).toBeUndefined();
  });

  test("restore removes unedited imported entries, retains edited or referenced ones, and blocks repeated apply until restored", async () => {
    const dbPath = createSqliteFixture([
      {
        id: "prov-a",
        app_type: "claude",
        name: "Prov A",
        settings_config: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://a.example.com", ANTHROPIC_MODEL: "token" } }),
      },
      {
        id: "prov-b",
        app_type: "openai",
        name: "Prov B",
        settings_config: JSON.stringify({ baseUrl: "https://b.example.com/v1" }),
      },
      {
        id: "prov-c",
        app_type: "openai",
        name: "Prov C",
        settings_config: JSON.stringify({ baseUrl: "https://c.example.com/v1" }),
      },
      {
        id: "kimi",
        app_type: "openai",
        name: "Kimi",
        settings_config: JSON.stringify({ baseUrl: "https://api.moonshot.ai/v1" }),
      },
    ]);

    await runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath });
    expect(loadConfig().providers["prov-a"]?.defaultModel).toBe("token");

    // Repeated apply while journal is active must be refused.
    await expect(runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath })).rejects.toThrow(
      /active CC-Switch import journal already exists/,
    );

    // User edits prov-b (adds a model), references prov-c in fallback.providers, and logs into kimi via OAuth store.
    const edited = loadConfig();
    edited.providers["prov-b"]!.defaultModel = "user-added-model";
    edited.fallback = { providers: { "prov-c": { provider: false } } };
    saveConfig(edited);
    await saveCredential("kimi", {
      access: "oauth-access-fixture",
      refresh: "oauth-refresh-fixture",
      expires: Date.now() + 3600_000,
    });

    const restored1 = await runCcSwitchProviderImport({ mode: "restore" });
    expect(restored1).toEqual({
      mode: "restore",
      restored: 1,
      restoredNames: ["prov-a"],
      alreadyAbsent: 0,
      retainedEdited: 3,
      retainedNames: ["kimi", "prov-b", "prov-c"],
    });

    const after1 = loadConfig();
    expect(after1.providers["prov-a"]).toBeUndefined();
    expect(after1.providers["prov-b"]?.defaultModel).toBe("user-added-model");
    expect(after1.providers["prov-c"]).toBeDefined();
    expect(after1.providers["kimi"]).toBeDefined();
    // Journal remains for the retained entries.
    expect(existsSync(join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME))).toBe(true);

    // If auth.json becomes malformed, restore fails closed and retains remaining journaled entries.
    const cleanCfg = loadConfig();
    delete cleanCfg.fallback;
    saveConfig(cleanCfg);
    writeFileSync(getAuthStorePath(), "{corrupt-json");
    const restoredWithCorruptAuth = await runCcSwitchProviderImport({ mode: "restore" });
    expect(restoredWithCorruptAuth).toEqual({
      mode: "restore",
      restored: 0,
      restoredNames: [],
      alreadyAbsent: 0,
      retainedEdited: 3,
      retainedNames: ["kimi", "prov-b", "prov-c"],
    });
    expect(loadConfig().providers["prov-c"]).toBeDefined();

    // Malformed escapes or unpaired UTF-16 surrogates in an unrelated provider's auth.json entry also fail closed
    // without decoding any auth.json strings.
    for (const badAuthJson of [
      '{"other":{"accounts":[{"access":"bad\\xescape"}]}}',
      '{"other":{"accounts":[{"access":"bad\\u123Ghex"}]}}',
      '{"other":{"accounts":[{"access":"lone\\uD800surrogate"}]}}',
    ]) {
      writeFileSync(getAuthStorePath(), badAuthJson);
      const authDecoded: string[] = [];
      const origDecode = TextDecoder.prototype.decode;
      const spy = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args: unknown[]) {
        const s = origDecode.apply(this, args as [BufferSource?, TextDecodeOptions?]);
        authDecoded.push(s);
        return s;
      });
      try {
        const res = await runCcSwitchProviderImport({ mode: "restore" });
        expect(res).toEqual({
          mode: "restore",
          restored: 0,
          restoredNames: [],
          alreadyAbsent: 0,
          retainedEdited: 3,
          retainedNames: ["kimi", "prov-b", "prov-c"],
        });
      } finally {
        spy.mockRestore();
      }
      expect(authDecoded.join("|")).not.toContain("escape");
      expect(authDecoded.join("|")).not.toContain("surrogate");
      expect(loadConfig().providers["prov-c"]).toBeDefined();
    }
  });

  test("rejects adversarial TOML multiline strings, non-scalar JSON paths, secret-like URLs, and private networks without opt-in", async () => {
    const dbPath = createSqliteFixture([
      {
        id: "multiline-toml",
        app_type: "codex",
        name: "Multiline",
        settings_config: JSON.stringify({
          config: `secret = """\nbase_url = "https://evil.example.com/v1"\n"""`,
        }),
      },
      {
        id: "non-scalar-url",
        app_type: "claude",
        name: "NonScalar",
        settings_config: JSON.stringify({
          env: { ANTHROPIC_BASE_URL: { nested: CANARY_SECRET } },
        }),
      },
      {
        id: "hex-path-url",
        app_type: "openai",
        name: "SecretUrl",
        settings_config: JSON.stringify({
          baseUrl: `https://api.example.com/v1/${PREFIXLESS_HEX_SECRET}`,
        }),
      },
      {
        id: "prefixless-secret-in-model",
        app_type: "claude",
        name: "PrefixlessModel",
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://claude.acme.example",
            ANTHROPIC_MODEL: PREFIXLESS_MIXED_SECRET,
          },
        }),
      },
      {
        id: PREFIXLESS_HEX_SECRET,
        app_type: "openai",
        name: "PrefixlessId",
        settings_config: JSON.stringify({
          baseUrl: "https://api.example.com/v1",
        }),
      },
      {
        id: "ollama",
        app_type: "openai",
        name: "Loopback",
        settings_config: JSON.stringify({
          baseUrl: "http://127.0.0.1:11434/v1",
        }),
      },
      {
        id: "ambiguous-codex",
        app_type: "codex",
        name: "Ambiguous",
        settings_config: JSON.stringify({
          config: '[model_providers.one]\nbase_url = "https://one.example.com/v1"\n[model_providers.two]\nbase_url = "https://two.example.com/v1"\n',
        }),
      },
      {
        id: "overlong-toml",
        app_type: "codex",
        name: "Overlong",
        settings_config: JSON.stringify({
          config: Array.from({ length: 505 }, (_, i) => `# comment ${i}`).concat(['base_url = "https://late.example.com/v1"']).join("\n"),
        }),
      },
      {
        id: "oversize-toml-bytes",
        app_type: "codex",
        name: "OversizeBytes",
        settings_config: JSON.stringify({
          config: "#" + "x".repeat(70_000) + '\nbase_url = "https://huge.example.com/v1"\n',
        }),
      },
      {
        id: "AbcDefGhiJ1-prov",
        app_type: "openai",
        name: "MixedCaseDigitId",
        settings_config: JSON.stringify({ baseUrl: "https://api.example.com/v1" }),
      },
      {
        id: "mixed-url-path",
        app_type: "openai",
        name: "MixedUrlPath",
        settings_config: JSON.stringify({ baseUrl: "https://api.example.com/AbCdEfGhIjKl" }),
      },
      {
        id: "bad-app-kind",
        app_type: PREFIXLESS_MIXED_SECRET,
        name: "SecretAppType",
        settings_config: JSON.stringify({ baseUrl: "https://api.example.com/v1" }),
      },
      {
        id: "escaped-quote-sqlite",
        app_type: "codex",
        name: "EscapedQuoteSqlite",
        settings_config: JSON.stringify({
          config: 'model_provider = "foo\\"bar"\n[model_providers."foo\\"bar"]\nbase_url = "https://x.example.com/v1"\n',
        }),
      },
      {
        id: "non-date-digits-model",
        app_type: "claude",
        name: "NonDateDigits",
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://claude.acme.example",
            ANTHROPIC_MODEL: "12345678-12345678",
          },
        }),
      },
      {
        id: "uuid-in-model-rejected",
        app_type: "claude",
        name: "UuidModel",
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://claude.acme.example",
            ANTHROPIC_MODEL: "550e8400-e29b-41d4-a716-446655440000",
          },
        }),
      },
    ]);

    const decodedDuringSqlite: string[] = [];
    const origDecode = TextDecoder.prototype.decode;
    const decodeSpy = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args: unknown[]) {
      const s = origDecode.apply(this, args as [BufferSource?, TextDecodeOptions?]);
      decodedDuringSqlite.push(s);
      return s;
    });
    let rawSqliteRows;
    try {
      rawSqliteRows = readSqliteRows(dbPath);
    } finally {
      decodeSpy.mockRestore();
    }
    const projected = JSON.stringify(rawSqliteRows);
    expect(projected).not.toContain(PREFIXLESS_HEX_SECRET);
    expect(projected).not.toContain(PREFIXLESS_MIXED_SECRET);
    expect(projected).not.toContain("AbcDefGhiJ1-prov");
    expect(projected).not.toContain("AbCdEfGhIjKl");
    expect(projected).not.toContain('foo"bar');
    expect(rawSqliteRows.find(r => r.id === "mixed-url-path")?.genericBaseUrl).toBe(URL_SYNTAX_REFUSED_SENTINEL);
    expect(rawSqliteRows.find(r => r.id === "bad-app-kind")?.appType).toBe(METADATA_REFUSED_SENTINEL);
    for (const s of decodedDuringSqlite) {
      expect(s).not.toContain(PREFIXLESS_HEX_SECRET);
      expect(s).not.toContain(PREFIXLESS_MIXED_SECRET);
      expect(s).not.toContain("AbcDefGhiJ1-prov");
      expect(s).not.toContain("AbCdEfGhIjKl");
      expect(s).not.toContain('foo"bar');
    }

    const preview = await runCcSwitchProviderImport({ mode: "preview", sourcePath: dbPath });
    expect(preview.mode).toBe("preview");
    if (preview.mode === "preview") {
      expect(preview.eligible).toBe(0);
      expect(preview.invalid).toBe(15);
      expect(preview.invalidReasons).toEqual({
        malformed_entry: 3,
        missing_base_url: 1,
        invalid_base_url: 2,
        disallowed_metadata: 7,
        private_network_refused: 1,
        ambiguous_codex_provider: 1,
      });
    }

    const withPrivate = await runCcSwitchProviderImport({
      mode: "preview",
      sourcePath: dbPath,
      selectedProviders: ["ollama"],
      allowPrivateNetwork: true,
    });
    if (withPrivate.mode === "preview") {
      expect(withPrivate.eligible).toBe(1);
      expect(withPrivate.providers[0]?.allowPrivateNetwork).toBe(true);
    }
  });

  test("rebase conflict inside mutatePersistedConfig fails closed and cleans up the un-published prepared journal", async () => {
    const dbPath = createSqliteFixture([
      {
        id: "raced-prov",
        app_type: "openai",
        name: "Raced",
        settings_config: JSON.stringify({ baseUrl: "https://raced.example.com/v1" }),
      },
    ]);

    setPersistedConfigMutationBeforeCommitForTests(() => {
      const concurrent = loadConfig();
      concurrent.providers["raced-prov"] = {
        adapter: "openai-chat",
        baseUrl: "https://other-writer.example.com/v1",
      };
      saveConfig(concurrent);
    });

    await expect(runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath })).rejects.toThrow(
      CcSwitchImportError,
    );
    // Because the other writer's raced-prov does not carry our importId note, the prepared journal is cleaned up
    // and cannot delete the other writer's provider on restore!
    expect(existsSync(join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME))).toBe(false);
    expect(loadConfig().providers["raced-prov"]?.baseUrl).toBe("https://other-writer.example.com/v1");
  });

  test("prepared journal left behind after config publication still blocks re-apply and restores cleanly", async () => {
    const dbPath = createSqliteFixture([
      {
        id: "crash-prov",
        app_type: "openai",
        name: "Crash Prov",
        settings_config: JSON.stringify({ baseUrl: "https://crash.example.com/v1" }),
      },
    ]);

    await runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath });
    const journalPath = join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME);
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    // Simulate a crash right after config publication before the journal state transitioned from prepared to committed.
    writeFileSync(journalPath, JSON.stringify({ ...journal, state: "prepared" }, null, 2) + "\n");

    // Because crash-prov in config.providers carries journal.importId in its note, apply must refuse!
    await expect(runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath })).rejects.toThrow(
      /active CC-Switch import journal already exists/,
    );

    // And restore must still roll back crash-prov and remove the journal.
    const restored = await runCcSwitchProviderImport({ mode: "restore" });
    expect(restored).toEqual({
      mode: "restore",
      restored: 1,
      restoredNames: ["crash-prov"],
      alreadyAbsent: 0,
      retainedEdited: 0,
      retainedNames: [],
    });
    expect(loadConfig().providers["crash-prov"]).toBeUndefined();
    expect(existsSync(journalPath)).toBe(false);
  });

  test("refuses FIFO special files without hanging and detects TOCTOU source replacement", async () => {
    if (process.platform !== "win32") {
      const fifoPath = join(sourceDir, "pipe.db");
      const mk = Bun.spawnSync(["mkfifo", fifoPath]);
      expect(mk.exitCode).toBe(0);
      await expect(runCcSwitchProviderImport({ mode: "preview", sourcePath: fifoPath })).rejects.toThrow(
        /regular file/,
      );
    }

    const dbPath = createSqliteFixture([
      {
        id: "toctou-prov",
        app_type: "openai",
        name: "Toctou",
        settings_config: JSON.stringify({ baseUrl: "https://toctou.example.com/v1" }),
      },
    ]);
    const replacementPath = join(sourceDir, "other.db");
    writeFileSync(replacementPath, readFileSync(dbPath));

    setCcSwitchSourceOpenHookForTests(target => {
      writeFileSync(target + ".swap", readFileSync(replacementPath));
      const { renameSync } = require("node:fs");
      renameSync(target + ".swap", target);
    });

    await expect(runCcSwitchProviderImport({ mode: "preview", sourcePath: dbPath })).rejects.toThrow(
      /changed while opening/,
    );
  });

  test("F1/F2: word-shaped canary in secret fields or 16-byte header never materializes, URL path grammar rejects non-API paths, and --apply prints before writing", async () => {
    const sqlPath = join(sourceDir, "word-canary.db");
    const db = new Database(sqlPath, { create: true });
    try {
      db.run(`CREATE TABLE providers (
        id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
        website_url TEXT, notes TEXT, meta TEXT NOT NULL DEFAULT '{}', sort_index INTEGER, PRIMARY KEY (id, app_type)
      )`);
      db.prepare("INSERT INTO providers (id, app_type, name, settings_config, website_url, notes, meta, sort_index) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").run(
        "dashscope-compat",
        "openai",
        WORD_CANARY,
        JSON.stringify({
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          model: "qwen3-coder-plus",
          apiKey: WORD_CANARY,
          api_key: WORD_CANARY,
          env: { OPENAI_API_KEY: WORD_CANARY },
          auth: { bearer: WORD_CANARY },
        }),
        `https://${WORD_CANARY}.example.com`,
        WORD_CANARY,
        JSON.stringify({ token: WORD_CANARY }),
        1,
      );
      for (const [idx, badUrl] of [
        `https://api.example.com/${WORD_CANARY}`,
        `https://api.example.com/v1/${WORD_CANARY}`,
        "https://api.example.com/V1",
        "https://api.example.com/a/b/c/d/v1",
        "https://api.example.com/v1/%76ioletotter",
        `https://api.example.com/v1?key=${WORD_CANARY}`,
      ].entries()) {
        db.prepare("INSERT INTO providers (id, app_type, name, settings_config, sort_index) VALUES (?1, ?2, ?3, ?4, ?5)").run(
          `bad-url-${idx}`,
          "openai",
          WORD_CANARY,
          JSON.stringify({ baseUrl: badUrl, apiKey: WORD_CANARY }),
          idx + 2,
        );
      }
    } finally {
      db.close();
    }

    // Compact JSON placing WORD_CANARY inside bytes 0..15 of the file header AND in secret fields,
    // plus an invalid .db file starting with WORD_CANARY in bytes 0..15.
    const headerJsonPath = join(sourceDir, "header-canary.json");
    const headerJsonString = JSON.stringify({
      [WORD_CANARY]: WORD_CANARY,
      providers: {
        "ok-codex": {
          name: WORD_CANARY,
          app_type: "codex",
          apiKey: WORD_CANARY,
          settings_config: {
            auth: { OPENAI_API_KEY: WORD_CANARY },
            config: [
              `model = "gpt-5.6-sol" # ${WORD_CANARY}`,
              `api_key = "${WORD_CANARY}"`,
              `[model_providers.ok]`,
              `base_url = "https://api.openai.com/v1" # ${WORD_CANARY}`,
              `[other]`,
              `base_url = "https://api.example.com/${WORD_CANARY}"`,
            ].join("\n"),
          },
        },
        "bad-json-url": {
          app_type: "openai",
          settings_config: {
            baseUrl: `https://api.example.com/v1/${WORD_CANARY}`,
          },
        },
      },
    });
    expect(headerJsonString.slice(0, 15)).toContain(WORD_CANARY);
    writeFileSync(headerJsonPath, headerJsonString);
    const fakeDbPath = join(sourceDir, "fake-header.db");
    writeFileSync(fakeDbPath, `${WORD_CANARY}0123456789abcdef`);

    const observedStrings: string[] = [];
    const origDecode = TextDecoder.prototype.decode;
    const origBufToString = Buffer.prototype.toString;
    const origFromCharCode = String.fromCharCode;
    const origFromCodePoint = String.fromCodePoint;
    const decodeSpy = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args: unknown[]) {
      const s = origDecode.apply(this, args as [BufferSource?, TextDecodeOptions?]);
      observedStrings.push(s);
      return s;
    });
    const bufStrSpy = spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, ...args: unknown[]) {
      const s = origBufToString.apply(this, args as [BufferEncoding?, number?, number?]);
      observedStrings.push(s);
      return s;
    });
    const charCodeSpy = spyOn(String, "fromCharCode").mockImplementation((...codes: number[]) => {
      const s = origFromCharCode(...codes);
      observedStrings.push(s);
      return s;
    });
    const codePointSpy = spyOn(String, "fromCodePoint").mockImplementation((...codes: number[]) => {
      const s = origFromCodePoint(...codes);
      observedStrings.push(s);
      return s;
    });

    const cliLines: string[] = [];
    let printedBeforeDiskCommit = false;
    const logSpy = spyOn(console, "log").mockImplementation(v => { cliLines.push(String(v)); });
    const errSpy = spyOn(console, "error").mockImplementation(v => { cliLines.push(String(v)); });
    try {
      await expect(runCcSwitchProviderImport({ mode: "preview", sourcePath: fakeDbPath })).rejects.toThrow(/not a valid SQLite 3 file/);
      const jsonPreview = await runCcSwitchProviderImport({ mode: "preview", sourcePath: headerJsonPath });
      expect(jsonPreview).toMatchObject({
        mode: "preview",
        discovered: 2,
        eligible: 1,
        invalid: 1,
        invalidReasons: { invalid_base_url: 1 },
      });
      expect(JSON.stringify(jsonPreview)).not.toContain(WORD_CANARY);

      // Direct --apply without prior preview must print imported id, model, and URL BEFORE writing config.json!
      let callbackSawNoJournalOrConfig = false;
      const callbackPrinted = await runCcSwitchProviderImport({
        mode: "apply",
        sourcePath: sqlPath,
        onBeforeApplyWrite: providers => {
          expect(existsSync(join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME))).toBe(false);
          expect(loadConfig().providers["dashscope-compat"]).toBeUndefined();
          expect(providers).toEqual([{
            name: "dashscope-compat",
            sourceId: "dashscope-compat",
            appType: "openai",
            adapter: "openai-chat",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            defaultModel: "qwen3-coder-plus",
          }]);
          callbackSawNoJournalOrConfig = true;
        },
      });
      expect(callbackSawNoJournalOrConfig).toBe(true);
      expect(callbackPrinted.mode).toBe("apply");
      await runCcSwitchProviderImport({ mode: "restore" });

      // Also verify CLI --apply --json prints pre-write summary to stderr BEFORE writing config.json, while keeping stdout pure JSON!
      const stdoutOnly: string[] = [];
      const stderrOnly: string[] = [];
      logSpy.mockImplementation(v => { cliLines.push(String(v)); stdoutOnly.push(String(v)); });
      errSpy.mockImplementation(v => { cliLines.push(String(v)); stderrOnly.push(String(v)); });
      setPersistedConfigMutationBeforeCommitForTests(() => {
        const currentOnDisk = loadConfig();
        expect(currentOnDisk.providers["dashscope-compat"]).toBeUndefined();
        expect(stdoutOnly).toHaveLength(0);
        const printedSoFar = stderrOnly.join("\n");
        expect(printedSoFar).toContain("id=dashscope-compat");
        expect(printedSoFar).toContain("model=qwen3-coder-plus");
        expect(printedSoFar).toContain("url=https://dashscope.aliyuncs.com/compatible-mode/v1");
        printedBeforeDiskCommit = true;
      });
      const exitCode = await cmdProviderCcSwitchImport(["--source", sqlPath, "--apply", "--json"]);
      expect(exitCode).toBe(0);
      expect(printedBeforeDiskCommit).toBe(true);
      expect(JSON.parse(stdoutOnly[0]!)).toMatchObject({ mode: "apply", imported: 1, invalidReasons: { invalid_base_url: 6 } });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      decodeSpy.mockRestore();
      bufStrSpy.mockRestore();
      charCodeSpy.mockRestore();
      codePointSpy.mockRestore();
    }

    for (const s of observedStrings) {
      expect(s).not.toContain(WORD_CANARY);
    }
    expect(cliLines.join("\n")).not.toContain(WORD_CANARY);
    expect(readFileSync(getConfigPath(), "utf8")).not.toContain(WORD_CANARY);
    expect(readFileSync(join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME), "utf8")).not.toContain(WORD_CANARY);
  });

  test("F3: refuses open WAL database holding uncheckpointed inserts and updates until checkpointed", async () => {
    const walDbPath = join(sourceDir, "live-wal.db");
    const writer = new Database(walDbPath, { create: true });
    try {
      writer.run("PRAGMA journal_mode = WAL;");
      writer.run("CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL, sort_index INTEGER, PRIMARY KEY (id, app_type))");
      writer.prepare("INSERT INTO providers VALUES (?1, ?2, ?3, ?4, ?5)").run(
        "existing-prov",
        "openai",
        "Existing",
        JSON.stringify({ baseUrl: "https://old.acme.example/v1" }),
        1,
      );
      writer.run("PRAGMA wal_checkpoint(TRUNCATE);");

      // Disable auto-checkpoint so subsequent UPDATE and INSERT stay exclusively in live-wal.db-wal.
      writer.run("PRAGMA wal_autocheckpoint = 0;");
      writer.prepare("UPDATE providers SET settings_config = ?1 WHERE id = 'existing-prov'").run(
        JSON.stringify({ baseUrl: "https://updated.acme.example/v1" }),
      );
      writer.prepare("INSERT INTO providers VALUES (?1, ?2, ?3, ?4, ?5)").run(
        "uncheckpointed-prov",
        "claude",
        "Uncheckpointed",
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://claude-new.acme.example/v1" } }),
        2,
      );
      expect(statSync(`${walDbPath}-wal`).size).toBeGreaterThan(0);

      // Original path (nlink === 1) is refused while live-wal.db-wal is non-empty.
      expect(() => readSqliteRows(walDbPath)).toThrow(/uncheckpointed WAL changes.*close CC-Switch/i);
      await expect(runCcSwitchProviderImport({ mode: "preview", sourcePath: walDbPath })).rejects.toThrow(
        /uncheckpointed WAL changes.*close CC-Switch/i,
      );
      await expect(runCcSwitchProviderImport({ mode: "apply", sourcePath: walDbPath })).rejects.toThrow(
        /uncheckpointed WAL changes.*close CC-Switch/i,
      );

      // Hard-linked alias path has no sibling alias-live.db-wal; descriptor fstat nlink > 1 must refuse
      // both alias and original fail-closed rather than silently reading stale pre-WAL bytes!
      const aliasDbPath = join(sourceDir, "alias-live.db");
      linkSync(walDbPath, aliasDbPath);
      try {
        expect(existsSync(`${aliasDbPath}-wal`)).toBe(false);
        expect(statSync(`${walDbPath}-wal`).size).toBeGreaterThan(0);
        expect(() => readSqliteRows(aliasDbPath)).toThrow(/multiple hard links.*original CC-Switch database path/i);
        await expect(runCcSwitchProviderImport({ mode: "preview", sourcePath: aliasDbPath })).rejects.toThrow(
          /multiple hard links.*original CC-Switch database path/i,
        );
        await expect(runCcSwitchProviderImport({ mode: "preview", sourcePath: walDbPath })).rejects.toThrow(
          /multiple hard links.*original CC-Switch database path/i,
        );
        const cliJsonOut: string[] = [];
        const logSpy = spyOn(console, "log").mockImplementation(v => { cliJsonOut.push(String(v)); });
        try {
          expect(await cmdProviderCcSwitchImport(["--source", aliasDbPath, "--json"])).toBe(1);
        } finally {
          logSpy.mockRestore();
        }
        expect(cliJsonOut.join("\n")).not.toContain(aliasDbPath);
        expect(JSON.parse(cliJsonOut[0]!)).toMatchObject({ error: "sqlite_hardlink_refused" });
      } finally {
        writer.close();
        unlinkSync(aliasDbPath);
      }
    } finally {
      try { writer.close(); } catch { /* already closed */ }
    }

    // Reopen and checkpoint cleanly (simulating CC-Switch closing/checkpointing); retry now succeeds with updated data.
    const checkpointer = new Database(walDbPath);
    try {
      checkpointer.run("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      checkpointer.close();
    }

    const afterClose = await runCcSwitchProviderImport({ mode: "preview", sourcePath: walDbPath });
    expect(afterClose.mode).toBe("preview");
    if (afterClose.mode === "preview") {
      expect(afterClose.eligible).toBe(2);
      expect(afterClose.providers).toEqual([
        {
          name: "existing-prov",
          sourceId: "existing-prov",
          appType: "openai",
          adapter: "openai-chat",
          baseUrl: "https://updated.acme.example/v1",
        },
        {
          name: "uncheckpointed-prov",
          sourceId: "uncheckpointed-prov",
          appType: "claude",
          adapter: "anthropic",
          baseUrl: "https://claude-new.acme.example/v1",
        },
      ]);
    }
  });
});
