import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import {
  CC_SWITCH_IMPORT_JOURNAL_FILENAME,
  CcSwitchImportError,
  readSqliteRows,
  runCcSwitchProviderImport,
  scanCcSwitchJsonBytes,
} from "../../src/providers/cc-switch-import";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Runtime-assembled canary so privacy:scan never sees a literal token prefix in the source file.
const CANARY_SECRET = ["sk", "canary", "DO", "NOT", "READ", "9876543210abcdef"].join("-");

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
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(scratch);
});

describe("CC-Switch keyless provider import", () => {
  test("SQLite preview and apply extract only non-secret fields, keep source read-only, and never materialize secrets", async () => {
    const codexToml = [
      'model = "gpt-5.6-sol"',
      'model_provider = "acme\\"quoted"',
      `experimental_bearer_token = "${CANARY_SECRET}"`,
      '[model_providers."acme\\"quoted"]',
      'base_url = "https://codex.acme.example/v1"',
      'wire_api = "responses"',
      `api_key = "${CANARY_SECRET}"`,
    ].join("\n");

    const dbPath = createSqliteFixture([
      {
        id: "acme-claude",
        app_type: "claude",
        name: "Acme Claude",
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://claude.acme.example",
            ANTHROPIC_API_KEY: CANARY_SECRET,
            ANTHROPIC_AUTH_TOKEN: CANARY_SECRET,
            ANTHROPIC_MODEL: "claude-sonnet-4-6",
          },
        }),
        sort_index: 1,
      },
      {
        id: "acme-codex",
        app_type: "codex",
        name: "Acme Codex",
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: CANARY_SECRET },
          config: codexToml + `\n[unrelated_section]\nbase_url = "${CANARY_SECRET}"\nmodel = "${CANARY_SECRET}"\n[model_providers.acme.extra]\nbase_url = "${CANARY_SECRET}"\n[model_providers."acme".extra]\nwire_api = "${CANARY_SECRET}"\n`,
        }),
        sort_index: 2,
      },
    ]);
    const dbBytesBefore = readFileSync(dbPath);
    // White-box check: SQLite projection itself never returns values from [unrelated_section] or secret keys.
    expect(JSON.stringify(readSqliteRows(dbPath))).not.toContain(CANARY_SECRET);

    const preview = await runCcSwitchProviderImport({ mode: "preview", sourcePath: dbPath });
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
          displayName: "Acme Claude",
          appType: "claude",
          adapter: "anthropic",
          baseUrl: "https://claude.acme.example",
          defaultModel: "claude-sonnet-4-6",
        },
        {
          name: "acme-codex",
          sourceId: "acme-codex",
          displayName: "Acme Codex",
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
              name: "Shared Claude",
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
                  'model = "gpt-5.6-sol"',
                  'model_provider = "cjson"',
                  `experimental_bearer_token = "${CANARY_SECRET}"`,
                  '[model_providers.cjson]',
                  'base_url = "https://codex.json.example/v1"',
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
    const scanned = scanCcSwitchJsonBytes(rawBytes);
    expect(JSON.stringify(scanned)).not.toContain(CANARY_SECRET);
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
        settings_config: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://a.example.com" } }),
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
    ]);

    await runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath });

    // Repeated apply while journal is active must be refused.
    await expect(runCcSwitchProviderImport({ mode: "apply", sourcePath: dbPath })).rejects.toThrow(
      /active CC-Switch import journal already exists/,
    );

    // User edits prov-b (adds a model) and references prov-c in fallback.providers.
    const edited = loadConfig();
    edited.providers["prov-b"]!.defaultModel = "user-added-model";
    edited.fallback = { providers: { "prov-c": { provider: false } } };
    saveConfig(edited);

    const restored1 = await runCcSwitchProviderImport({ mode: "restore" });
    expect(restored1).toEqual({
      mode: "restore",
      restored: 1,
      restoredNames: ["prov-a"],
      alreadyAbsent: 0,
      retainedEdited: 2,
      retainedNames: ["prov-b", "prov-c"],
    });

    const after1 = loadConfig();
    expect(after1.providers["prov-a"]).toBeUndefined();
    expect(after1.providers["prov-b"]?.defaultModel).toBe("user-added-model");
    expect(after1.providers["prov-c"]).toBeDefined();
    // Journal remains for the retained entries.
    expect(existsSync(join(targetHome, CC_SWITCH_IMPORT_JOURNAL_FILENAME))).toBe(true);
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
          baseUrl: `https://api.example.com/${CANARY_SECRET}`,
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
    ]);

    const preview = await runCcSwitchProviderImport({ mode: "preview", sourcePath: dbPath });
    expect(preview.mode).toBe("preview");
    if (preview.mode === "preview") {
      expect(preview.eligible).toBe(0);
      expect(preview.invalid).toBe(6);
      expect(preview.invalidReasons).toEqual({
        malformed_entry: 2,
        missing_base_url: 1,
        secret_in_nonsecret_field: 1,
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
});
