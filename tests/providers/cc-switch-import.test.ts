import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  readSqliteRows,
  runCcSwitchProviderImport,
  scanCcSwitchJsonBytes,
  setCcSwitchSourceOpenHookForTests,
} from "../../src/providers/cc-switch-import";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Runtime-assembled canary so privacy:scan never sees a literal token prefix in the source file.
const CANARY_SECRET = ["sk", "canary", "DO", "NOT", "READ", "9876543210abcdef"].join("-");
const PREFIXLESS_HEX_SECRET = ["9f86d081", "884c7d65", "9a2feaa0", "c55ad015"].join("");
const PREFIXLESS_MIXED_SECRET = "Ab3Def9Gh1Jk2Lm4Np6Qr8St0Uv";

let scratch: string;
let targetHome: string;
let sourceDir: string;
let originalHome: string | undefined;

function createSqliteFixture(rows: Array<{ id: string; app_type: string; name: string; settings_config: string; sort_index?: number }>): string {
  const dbPath = join(sourceDir, "cc-switch.db");
  const db = new Database(dbPath, { create: true });
  try {
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
    for (const r of rows) {
      insert.run(r.id, r.app_type, r.name, r.settings_config, r.sort_index ?? 0);
    }
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
      `model_provider = "acme\\"quoted" # ${PREFIXLESS_MIXED_SECRET}`,
      `experimental_bearer_token = "${CANARY_SECRET}"`,
      `[ model_providers . "acme\\"quoted" ] # header_secret = "${CANARY_SECRET}"`,
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
            ANTHROPIC_MODEL: "claude-sonnet-4-6",
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
    ]);
    const dbBytesBefore = readFileSync(dbPath);
    const decodedStrings: string[] = [];
    const origDecode = TextDecoder.prototype.decode;
    const decodeSpy = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args: unknown[]) {
      const res = origDecode.apply(this, args as [BufferSource?, TextDecodeOptions?]);
      decodedStrings.push(res);
      return res;
    });

    let preview;
    try {
      const sqliteProjected = JSON.stringify(readSqliteRows(dbPath));
      expect(sqliteProjected).not.toContain(CANARY_SECRET);
      expect(sqliteProjected).not.toContain(PREFIXLESS_HEX_SECRET);
      expect(sqliteProjected).not.toContain(PREFIXLESS_MIXED_SECRET);

      preview = await runCcSwitchProviderImport({ mode: "preview", sourcePath: dbPath });
    } finally {
      decodeSpy.mockRestore();
    }
    for (const s of decodedStrings) {
      expect(s).not.toContain(CANARY_SECRET);
      expect(s).not.toContain(PREFIXLESS_HEX_SECRET);
      expect(s).not.toContain(PREFIXLESS_MIXED_SECRET);
    }

    expect(preview).toEqual({
      mode: "preview",
      discovered: 2,
      eligible: 2,
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
          defaultModel: "claude-sonnet-4-6",
        },
        {
          name: "acme-codex",
          sourceId: "acme-codex",
          appType: "codex",
          adapter: "openai-responses",
          baseUrl: "https://codex.acme.example/v1",
          defaultModel: "gpt-5.6-sol",
        },
      ],
    });
    expect(JSON.stringify(preview)).not.toContain(CANARY_SECRET);
    expect(existsSync(join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME))).toBe(false);

    const applied = await runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath });
    expect(applied.mode).toBe("apply");
    if (applied.mode === "apply") {
      expect(applied.imported).toBe(2);
    }

    const configRaw = readFileSync(getConfigPath(), "utf8");
    const journalRaw = readFileSync(join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME), "utf8");
    expect(configRaw).not.toContain(CANARY_SECRET);
    expect(journalRaw).not.toContain(CANARY_SECRET);

    const saved = loadConfig();
    expect(saved.providers["acme-claude"]).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://claude.acme.example",
      defaultModel: "claude-sonnet-4-6",
    });
    expect(saved.providers["acme-claude"]?.apiKey).toBeUndefined();
    expect(saved.providers["acme-codex"]).toMatchObject({
      adapter: "openai-responses",
      baseUrl: "https://codex.acme.example/v1",
      defaultModel: "gpt-5.6-sol",
    });
    expect(saved.providers["acme-codex"]?.apiKey).toBeUndefined();
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
                  ANTHROPIC_API_KEY: CANARY_SECRET,
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
                auth: { OPENAI_API_KEY: CANARY_SECRET },
                config: [
                  `model = "gpt-5.6-sol" # comment_secret = "${CANARY_SECRET}" ${PREFIXLESS_HEX_SECRET}`,
                  `model_provider = "cjson" # ${PREFIXLESS_MIXED_SECRET}`,
                  `experimental_bearer_token = "${CANARY_SECRET}"`,
                  `[model_providers.cjson] # ${CANARY_SECRET}`,
                  `base_url = "https://codex.json.example/v1" # ${CANARY_SECRET} ${PREFIXLESS_HEX_SECRET}`,
                  'wire_api = "responses"',
                  `api_key = "${CANARY_SECRET}"`,
                  '[unrelated]',
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
    try {
      scanned = scanCcSwitchJsonBytes(rawBytes);
    } finally {
      decodeSpy.mockRestore();
    }
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
      selectedProviders: ["shared-claude"],
    });
    expect(applied.mode).toBe("apply");
    if (applied.mode === "apply") {
      expect(applied.imported).toBe(1);
      expect(applied.providers.map(p => p.name)).toEqual(["shared-claude"]);
    }
    const saved = loadConfig();
    expect(saved.providers["shared-claude"]?.baseUrl).toBe("https://claude.shared.example");
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
        id: "secret-in-url",
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
    ]);

    const projected = JSON.stringify(readSqliteRows(dbPath));
    expect(projected).not.toContain(PREFIXLESS_HEX_SECRET);
    expect(projected).not.toContain(PREFIXLESS_MIXED_SECRET);

    const preview = await runCcSwitchProviderImport({ mode: "preview", sourcePath: dbPath });
    expect(preview.mode).toBe("preview");
    if (preview.mode === "preview") {
      expect(preview.eligible).toBe(0);
      expect(preview.invalid).toBe(9);
      expect(preview.invalidReasons).toEqual({
        malformed_entry: 3,
        missing_base_url: 1,
        secret_in_nonsecret_field: 3,
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
});
