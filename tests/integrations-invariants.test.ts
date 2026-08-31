import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXPORT_CLIENTS, EXPORT_CLIENT_IDS, type ExportModel } from "../src/clients/config-export";
import { parseConfig } from "../src/integrations/config-io";
import { INTEGRATION_CLIENTS, INTEGRATION_CLIENT_IDS, type IntegrationClientId } from "../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../src/integrations/store";
import { readIntegrationState } from "../src/integrations/state";
import { applyIntegration, disableIntegration, restoreIntegration } from "../src/integrations/writer";
import { printSubcommandUsage, printUsage } from "../src/cli/help";
import type { OcxConfig } from "../src/types";

/**
 * Properties that hold ACROSS the whole client-integration feature, which is
 * why they live here rather than inside any one phase's suite.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/070 §4. The matrix
 * there was rewritten at the A-gate after an audit found three of the
 * original five duplicated existing coverage and one was unfalsifiable; these
 * are the properties nothing else asserts.
 */

const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
];

const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as unknown as OcxConfig;

let home: string;
let store: IntegrationStateStore;
let storeRoot: string;

/** Empty on purpose: no home override, so the registry picks the platform default. */
const TEST_ENV = {} as NodeJS.ProcessEnv;

/**
 * Create the directory each client's detector actually looks for, and return
 * its config path. Never hardcode `~/.hermes`: on Windows Hermes lives under
 * `%LOCALAPPDATA%\hermes`, so a hardcoded POSIX layout creates a directory the
 * detector ignores and every apply refuses with `not_installed`.
 */
function installClient(clientId: IntegrationClientId): string {
  const spec = INTEGRATION_CLIENTS[clientId];
  /*
   * Aside resolves its config path THROUGH its account manifest, so unlike
   * every other client the path does not exist as a pure function of home. It
   * throws rather than guessing an account, which is the point of that design,
   * so the fixture has to establish which account is current before any
   * resolver runs.
   */
  if (clientId === "aside") {
    mkdirSync(join(home, ".aside"), { recursive: true });
    writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({ currentAccountId: 0 }));
  }
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ocx-integrations-invariants-"));
  home = join(base, "home");
  storeRoot = join(base, "store", "integrations");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(storeRoot);
});

afterEach(() => {
  rmSync(dirname(home), { recursive: true, force: true });
});

describe("the client registries cannot drift apart", () => {
  test("every list of clients holds exactly the same twelve ids", async () => {
    /*
     * Five lists name the same twelve clients, and two of them are maintained by
     * hand: the GUI cannot import the backend registry, because that would
     * pull node:os and node:path into the browser bundle. A client added
     * server-side renders no row until someone remembers the tuple, and the
     * only thing that catches forgetting is this test.
     */
    const gui = await import("../gui/src/components/apikeys-workspace/client-config-clients");
    const guiIntegrations = await import("../gui/src/pages/integrations/integration-api");
    const guiRouting = await import("../gui/src/app-routing");

    const expected = [...EXPORT_CLIENT_IDS].sort();
    expect(expected).toHaveLength(12);

    expect([...INTEGRATION_CLIENT_IDS].sort()).toEqual(expected);
    expect([...gui.CLIENTS].sort()).toEqual(expected);
    expect(Object.keys(gui.CLIENT_LABEL_KEYS).sort()).toEqual(expected);
    expect([...guiIntegrations.FILE_INTEGRATION_CLIENTS].sort()).toEqual(expected);
    // The Integrations tab strip needs a registered hash per file client, or
    // App normalization strips the route and the tab can never render. The
    // remaining per-page Record maps are enforced by the GUI typecheck
    // (Record<FileIntegrationClientId, TKey> is exhaustive).
    const routedFileClients = guiRouting.INTEGRATION_TAB_HASHES
      .filter(hash => /^integrations\/[a-z-]+$/.test(hash))
      .map(hash => hash.split("/")[1]!)
      .filter(id => (expected as string[]).includes(id))
      .sort();
    expect(routedFileClients).toEqual(expected);
  });

  test("source preservation and cross-process locking are registry capabilities", () => {
    expect(INTEGRATION_CLIENTS.omp.sourcePreservingYaml?.path).toEqual(["providers", "opencodex"]);
    expect(INTEGRATION_CLIENTS.dsh.sourcePreservingYaml?.path).toEqual([
      "llm-pi-ai", "providers", "opencodex",
    ]);
    expect(INTEGRATION_CLIENT_IDS.filter(id => INTEGRATION_CLIENTS[id].writerLock)).toEqual(["dsh", "mcode"]);
    expect(INTEGRATION_CLIENTS.dsh.writerLock).toEqual({ suffix: ".lock" });
    expect(INTEGRATION_CLIENTS.mcode.writerLock).toEqual({ suffix: ".lock" });
  });
});

describe("the journal is metadata, never a copy of the file", () => {
  test("a sentinel in the user's config never reaches journal.jsonl", () => {
    /*
     * Both files are written 0600, so this is not a permissions argument: it
     * is data minimization. The journal is an operation log the user may hand
     * to someone debugging; the snapshot is the one place a copy of their
     * config legitimately lives.
     */
    const sentinel = ["do", "not", "log", "this", "line"].join("-");
    const configPath = installClient("hermes");
    const before = `providers:\n  mine:\n    api: http://${sentinel}\n`;
    writeFileSync(configPath, before);

    const result = applyIntegration({
      clientId: "hermes", models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    });
    expect(result.ok).toBe(true);

    const journal = readFileSync(join(storeRoot, "journal.jsonl"), "utf8");
    expect(journal).not.toContain(sentinel);
    // …and the ownership record is metadata too.
    expect(readFileSync(join(storeRoot, "records.json"), "utf8")).not.toContain(sentinel);

    // The snapshot DOES hold it — byte for byte — which is what makes the
    // rollback promise true rather than the journal's job.
    const operation = store.listOperations("hermes")[0]!;
    const snapshot = store.readSnapshot(operation);
    expect(snapshot.kind).toBe("stored");
    if (snapshot.kind === "stored") expect(snapshot.text).toBe(before);
  });
});

describe("every client survives a full lifecycle", () => {
  /** A pre-existing user document in each client's own format. */
  const SEED: Record<IntegrationClientId, string> = {
    opencode: '{\n  "provider": {\n    "mine": { "npm": "keep-me" }\n  }\n}\n',
    pi: '{\n  "providers": {\n    "mine": { "api": "http://keep-me" }\n  }\n}\n',
    omp: "providers:\n  mine:\n    api: http://keep-me\n",
    hermes: "providers:\n  mine:\n    api: http://keep-me\n",
    openclaw: '{\n  models: {\n    providers: {\n      mine: { api: "http://keep-me" },\n    },\n  },\n}\n',
    kimi: '[providers.mine]\napi = "http://keep-me"\n',
    gajae: "providers:\n  mine:\n    api: http://keep-me\n",
    dsh: "llm-pi-ai:\n  providers:\n    mine:\n      api: openai-completions\n",
    mcode: "custom_provider:\n  mine:\n    name: Keep Me\n",
    zcode: '{\n  "provider": {\n    "builtin:zai-start-plan": { "name": "Keep Me", "kind": "anthropic" }\n  }\n}\n',
    // Prime reads Pi's models.json contract, so it seeds the same shape.
    prime: '{\n  "providers": {\n    "mine": { "api": "http://keep-me" }\n  }\n}\n',
    // Aside reads the same models.json contract as Pi and Prime.
    aside: '{\n  "providers": {\n    "mine": { "api": "http://keep-me" }\n  }\n}\n',
  };

  for (const clientId of INTEGRATION_CLIENT_IDS) {
    test(`${clientId}: apply adds only our block, disable removes only our block`, () => {
      const configPath = installClient(clientId);
      const seed = SEED[clientId];
      writeFileSync(configPath, seed);
      const format = EXPORT_CLIENTS[clientId].format;
      const original = parseConfig(seed, format);

      const applied = applyIntegration({
        clientId, models: MODELS, config: CONFIG, port: 10100,
        env: TEST_ENV, home, store,
      });
      expect(applied.ok).toBe(true);

      // Our fragments are present…
      const afterApply = parseConfig(readFileSync(configPath, "utf8"), format);
      const record = store.readRecords()[clientId]!;
      expect(record.fragmentPaths.length).toBeGreaterThan(0);
      for (const path of record.fragmentPaths) {
        let cursor: unknown = afterApply;
        for (const segment of path) {
          expect(cursor && typeof cursor === "object").toBe(true);
          cursor = (cursor as Record<string, unknown>)[segment];
        }
        expect(cursor).toBeDefined();
      }
      // …and the user's own entry is untouched.
      expect((afterApply as Record<string, unknown>)).toMatchObject(
        original as Record<string, unknown>,
      );

      const disabled = disableIntegration({
        clientId, models: MODELS, config: CONFIG, port: 10100,
        env: TEST_ENV, home, store,
      });
      expect(disabled.ok).toBe(true);

      /*
       * Semantic equality, not byte equality. The writer parses and
       * re-serializes, so formatting and comments do not survive an apply —
       * that is what the snapshot is for. What disable owes the user is that
       * every value they had is still there and ours is gone.
       */
      const afterDisable = parseConfig(readFileSync(configPath, "utf8"), format);
      expect(afterDisable).toEqual(original);
    });
  }
});

describe("a stale refresh does not forget what we created", () => {
  test("kimi: apply, refresh with a changed catalog, disable — no residue", () => {
    /*
     * The boundary the plain lifecycle test cannot reach. A refresh removes
     * the previous fragments before merging the new ones, and if that removal
     * does not carry the old `createdContainers`, our own empty `models` map
     * survives into the document the new record is derived from — which makes
     * the new record conclude the user owns it. The residue then outlives
     * every future disable.
     */
    const configPath = installClient("kimi");
    const seed = '[providers.mine]\napi = "http://keep-me"\n';
    writeFileSync(configPath, seed);

    const write = (models: ExportModel[]) => ({
      clientId: "kimi" as const, models, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    });

    expect(applyIntegration(write(MODELS)).ok).toBe(true);
    expect(store.readRecords().kimi?.createdContainers).toContain("models");

    // The catalog moves, so the next apply classifies as `stale` and refreshes.
    const refreshed: ExportModel[] = [
      { namespaced: "openai/gpt-5.5", provider: "openai", id: "gpt-5.5", contextWindow: 400_000 },
    ];
    expect(applyIntegration(write(refreshed)).ok).toBe(true);
    // The replacement record must still know the container is ours.
    expect(store.readRecords().kimi?.createdContainers).toContain("models");

    expect(disableIntegration(write(refreshed)).ok).toBe(true);
    expect(parseConfig(readFileSync(configPath, "utf8"), "toml")).toEqual(parseConfig(seed, "toml"));
  });
});

describe("a container we would have to replace is refused, not overwritten", () => {
  /*
   * `setPath` replaces a non-object intermediate with `{}` on its way to our
   * leaf, and the classifier used to call such a document `absent` — which
   * authorized the write. A user whose config held an array or a scalar where
   * our fragment path expects an object lost it to an apply that reported
   * success. Per client, because each one's path shape differs.
   */
  const NON_OBJECT: Partial<Record<IntegrationClientId, string[]>> = {
    pi: ['{\n  "providers": ["user-value"]\n}\n'],
    // Two containers to check: opencode owns both blocks, so a user value under either
    // one has to be refused rather than replaced on the way to our leaf.
    opencode: [
      '{\n  "provider": ["user-value"]\n}\n',
      '{\n  "providers": ["user-value"]\n}\n',
    ],
    hermes: ["providers:\n  - user-value\n"],
    kimi: ['models = ["user-value"]\n'],
  };

  for (const [clientId, seeds] of Object.entries(NON_OBJECT) as [IntegrationClientId, string[]][]) {
    for (const [index, seed] of seeds.entries()) {
      test(`${clientId}: apply refuses and leaves the user's value untouched (${index + 1})`, () => {
        const configPath = installClient(clientId);
        writeFileSync(configPath, seed);

        const result = applyIntegration({
          clientId, models: MODELS, config: CONFIG, port: 10100,
          env: TEST_ENV, home, store,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("unsafe");
        // The bytes are exactly as the user left them — not restored from a
        // snapshot afterwards, never written in the first place.
        expect(readFileSync(configPath, "utf8")).toBe(seed);
        expect(store.listOperations()).toHaveLength(0);
      });
    }
  }

  test("openclaw: a collision in the NESTED container is refused too", () => {
    // OpenClaw's fragment path is two segments (`models.providers`), so a
    // one-level check would miss a collision at the inner container.
    const configPath = installClient("openclaw");
    const seed = '{\n  models: {\n    providers: ["user-value"],\n  },\n}\n';
    writeFileSync(configPath, seed);

    const result = applyIntegration({
      clientId: "openclaw", models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toBe(seed);
  });

  test("a document that is literally null is not treated as absent", () => {
    /*
     * A missing file parses as `{}`, so an absent prefix reads `undefined`.
     * A parsed `null` is a value the file actually contains — treating it as
     * absent let apply replace the whole document and report success.
     */
    const configPath = installClient("pi");
    writeFileSync(configPath, "null\n");

    const result = applyIntegration({
      clientId: "pi", models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe("null\n");
  });

  test("disable refuses a blocked container instead of throwing", () => {
    /*
     * The GUI locks the switch for `unsafe`, but `ocx integration client
     * disable` and direct API callers do not — and the removal path
     * dereferences a record that a blocked container never has, so this threw
     * a TypeError and surfaced as a 500.
     */
    const configPath = installClient("pi");
    const seed = '{\n  "providers": ["user-value"]\n}\n';
    writeFileSync(configPath, seed);

    const result = disableIntegration({
      clientId: "pi", models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toBe(seed);
  });
});

describe("openclaw follows the config path its gateway actually reads", () => {
  test("OPENCLAW_CONFIG_PATH is where apply writes and disable removes", () => {
    /*
     * End to end, not just the resolver: the writer, the ownership record and
     * the snapshot must all land on the overridden file. Writing the default
     * while the gateway reads elsewhere is a success message attached to a
     * file nobody loads.
     */
    const relocated = join(home, "elsewhere", "openclaw-custom.json");
    mkdirSync(dirname(relocated), { recursive: true });
    const seed = '{\n  models: {\n    providers: {\n      mine: { api: "http://keep-me" },\n    },\n  },\n}\n';
    writeFileSync(relocated, seed);
    const env = { OPENCLAW_CONFIG_PATH: relocated } as NodeJS.ProcessEnv;
    // Detection still needs a directory to find; the state dir is separate.
    mkdirSync(INTEGRATION_CLIENTS.openclaw.detectDir(env, home), { recursive: true });

    const write = {
      clientId: "openclaw" as const, models: MODELS, config: CONFIG, port: 10100,
      env, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);

    // The overridden file gained our block…
    expect(readFileSync(relocated, "utf8")).toContain("opencodex");
    // …the record points at it, so a later disable cannot go looking elsewhere…
    expect(store.readRecords().openclaw?.configPath).toBe(relocated);
    // …and the default path was never created.
    expect(existsSync(join(home, ".openclaw", "openclaw.json"))).toBe(false);

    expect(disableIntegration(write).ok).toBe(true);
    expect(readFileSync(relocated, "utf8")).not.toContain("opencodex");
    expect(readFileSync(relocated, "utf8")).toContain("keep-me");
  });

  test("OPENCLAW_STATE_DIR relocates the whole install, detection included", () => {
    const stateDir = join(home, "custom-state");
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    expect(INTEGRATION_CLIENTS.openclaw.detectDir(env, home)).toBe(stateDir);
    mkdirSync(stateDir, { recursive: true });

    const write = {
      clientId: "openclaw" as const, models: MODELS, config: CONFIG, port: 10100,
      env, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);
    expect(existsSync(join(stateDir, "openclaw.json"))).toBe(true);
    expect(existsSync(join(home, ".openclaw", "openclaw.json"))).toBe(false);
  });
});

describe("openclaw's legacy layout is discovered, not declared obsolete", () => {
  test("an unmigrated .clawdbot install is found instead of reported missing", () => {
    /*
     * OpenClaw still treats `.clawdbot` as an active runtime candidate rather
     * than migration debris: it prefers the modern directory when present and
     * otherwise selects the legacy one. Without mirroring that, an install
     * that never migrated reads as "not installed" while its gateway runs
     * perfectly well — and if we wrote anyway, we would create a modern file
     * nothing loads.
     */
    const legacyDir = join(home, ".clawdbot");
    mkdirSync(legacyDir, { recursive: true });
    const legacyFile = join(legacyDir, "clawdbot.json");
    writeFileSync(legacyFile, '{\n  models: { providers: { mine: { api: "http://keep-me" } } },\n}\n');

    const env = {} as NodeJS.ProcessEnv;
    expect(INTEGRATION_CLIENTS.openclaw.detectDir(env, home)).toBe(legacyDir);
    expect(INTEGRATION_CLIENTS.openclaw.configPath(env, home)).toBe(legacyFile);

    const write = {
      clientId: "openclaw" as const, models: MODELS, config: CONFIG, port: 10100,
      env, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);
    expect(readFileSync(legacyFile, "utf8")).toContain("opencodex");
    // No modern file conjured beside it.
    expect(existsSync(join(home, ".openclaw", "openclaw.json"))).toBe(false);
  });

  test("an empty modern directory does not beat a real legacy config", () => {
    /*
     * OpenClaw searches FILE candidates, not directories. Checking the
     * directory first picked an ABSENT `.openclaw/openclaw.json` over a real
     * `.clawdbot/clawdbot.json` and wrote where nothing reads — the same
     * defect the legacy support was added to prevent.
     */
    mkdirSync(join(home, ".clawdbot"), { recursive: true });
    writeFileSync(join(home, ".clawdbot", "clawdbot.json"), "{}\n");
    mkdirSync(join(home, ".openclaw"), { recursive: true });

    const env = {} as NodeJS.ProcessEnv;
    expect(INTEGRATION_CLIENTS.openclaw.configPath(env, home))
      .toBe(join(home, ".clawdbot", "clawdbot.json"));
  });

  test("a real modern config wins over a legacy one", () => {
    // The other direction: a migrated user must not have us writing the old file.
    mkdirSync(join(home, ".clawdbot"), { recursive: true });
    writeFileSync(join(home, ".clawdbot", "clawdbot.json"), "{}\n");
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    writeFileSync(join(home, ".openclaw", "openclaw.json"), "{}\n");

    const env = {} as NodeJS.ProcessEnv;
    expect(INTEGRATION_CLIENTS.openclaw.configPath(env, home))
      .toBe(join(home, ".openclaw", "openclaw.json"));
  });
});

describe("a real user document is not rejected for being richer than ours", () => {
  test("hermes: YAML nulls survive an apply and a disable", () => {
    /*
     * The serializers were written against our own builder output, so the
     * first value a real config held that our generators never emit — a
     * `null` — threw out of the writer and reached the user as a 500. Nothing
     * was overwritten, but a valid file could not use the feature at all.
     */
    const configPath = installClient("hermes");
    const seed = "providers:\n  mine:\n    api: http://keep-me\n    token: null\n";
    writeFileSync(configPath, seed);

    const write = {
      clientId: "hermes" as const, models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);

    const applied = parseConfig(readFileSync(configPath, "utf8"), "yaml") as Record<string, unknown>;
    const providers = applied.providers as Record<string, Record<string, unknown>>;
    expect(providers.mine!.token).toBeNull();
    expect(providers.opencodex).toBeDefined();

    expect(disableIntegration(write).ok).toBe(true);
    expect(parseConfig(readFileSync(configPath, "utf8"), "yaml")).toEqual(parseConfig(seed, "yaml"));
  });

  test("kimi: a numeric TOML array survives an apply and a disable", () => {
    const configPath = installClient("kimi");
    const seed = '[providers.mine]\napi = "http://keep-me"\nports = [1, 2]\n';
    writeFileSync(configPath, seed);

    const write = {
      clientId: "kimi" as const, models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);
    const applied = parseConfig(readFileSync(configPath, "utf8"), "toml") as Record<string, unknown>;
    const providers = applied.providers as Record<string, Record<string, unknown>>;
    expect(providers.mine!.ports).toEqual([1, 2]);

    expect(disableIntegration(write).ok).toBe(true);
    expect(parseConfig(readFileSync(configPath, "utf8"), "toml")).toEqual(parseConfig(seed, "toml"));
  });

});

describe("we refuse rather than corrupt or crash", () => {
  test("a TOML file with special floats is refused, not silently rewritten", () => {
    /*
     * Bun's TOML parser mangles these before we ever see the document: `inf`
     * comes back as the STRING "inf", `-inf` as the number 0, `nan` as "nan".
     * Re-serializing that wrote the corruption back while reporting success —
     * a silent value change is worse than a refusal.
     */
    const configPath = installClient("kimi");
    const seed = '[providers.mine]\napi = "http://keep-me"\nvalues = [inf, -inf, nan]\n';
    writeFileSync(configPath, seed);

    const result = applyIntegration({
      clientId: "kimi", models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toBe(seed);
  });

  test("an inline table survives, because TOML allows it", () => {
    const configPath = installClient("kimi");
    const seed = '[providers.mine]\napi = "http://keep-me"\nitems = [{ x = 1 }]\n';
    writeFileSync(configPath, seed);

    const write = {
      clientId: "kimi" as const, models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);
    const applied = parseConfig(readFileSync(configPath, "utf8"), "toml") as Record<string, unknown>;
    const providers = applied.providers as Record<string, Record<string, unknown>>;
    expect(providers.mine!.items).toEqual([{ x: 1 }]);
  });

  test("a relative OpenClaw selector refuses instead of throwing a 500", () => {
    /*
     * Resolution itself can refuse. Letting that escape as an exception meant
     * the LIST route answered 500 for the whole Integrations page because one
     * client was misconfigured.
     */
    const env = { OPENCLAW_CONFIG_PATH: "relative/path.json" } as NodeJS.ProcessEnv;
    const write = {
      clientId: "openclaw" as const, models: MODELS, config: CONFIG, port: 10100,
      env, home, store,
    };
    const result = applyIntegration(write);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unsafe");
      expect(result.message).toContain("OPENCLAW_CONFIG_PATH");
    }

    // And the read path reports it rather than throwing, so the page renders.
    const status = readIntegrationState({
      clientId: "openclaw", models: MODELS, config: CONFIG, port: 10100,
      env, home, store,
    });
    expect(status.state).toBe("unsafe");
    expect(status.reason).toBe("unresolvable-path");
  });
});

describe("an absence is not a drift", () => {
  test("undoing an apply that created the file needs no drift confirmation", () => {
    /*
     * Apply to a missing file journals `resultAbsent: true` with an empty
     * fingerprint, and restoring it means deleting the file again. The route
     * represented "missing" as `""` and offered the row as Undo; the writer
     * hashed `""` into a real digest and called the unchanged absence a drift.
     * So the button appeared and then demanded confirmation for edits nobody
     * had made.
     */
    const configPath = installClient("hermes");
    expect(existsSync(configPath)).toBe(false);
    const write = {
      clientId: "hermes" as const, models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);
    const applyOp = store.listOperations("hermes")[0]!;
    expect(applyOp.resultAbsent).toBe(false);

    // Restore back to absence: the file we created is removed again.
    expect(restoreIntegration({ ...write, opId: applyOp.opId }).ok).toBe(true);
    expect(existsSync(configPath)).toBe(false);
    const restoreOp = store.listOperations("hermes")[0]!;
    expect(restoreOp.resultAbsent).toBe(true);

    // Undo THAT restore with no confirmDrift. The file is still absent, which
    // is exactly the result recorded, so nothing drifted.
    const undo = restoreIntegration({ ...write, opId: restoreOp.opId });
    expect(undo.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
  });

  test("a file that appeared where absence was recorded IS a drift", () => {
    // The other side of the same rule: absence-vs-present must still be caught.
    const configPath = installClient("hermes");
    const write = {
      clientId: "hermes" as const, models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);
    const applyOp = store.listOperations("hermes")[0]!;
    expect(restoreIntegration({ ...write, opId: applyOp.opId }).ok).toBe(true);
    const restoreOp = store.listOperations("hermes")[0]!;

    // Someone writes the file back before we undo the restore-to-absence.
    writeFileSync(configPath, "providers:\n  mine:\n    api: http://new\n");
    const undo = restoreIntegration({ ...write, opId: restoreOp.opId });
    expect(undo.ok).toBe(false);
    if (!undo.ok) expect(undo.reason).toBe("drift_requires_confirm");
    expect(readFileSync(configPath, "utf8")).toContain("http://new");
  });
});

describe("the base URL is composed, never interpolated", () => {
  test("IPv6 and wildcard binds produce a URL a client can actually dial", () => {
    /*
     * The defect was bypassing the shared composer, so this asserts the
     * emitted bytes rather than the helper — bypassing it again would pass a
     * helper-level test.
     */
    const cases: [string, string][] = [
      ["::1", "http://[::1]:10100/v1"],
      ["::", "http://127.0.0.1:10100/v1"],
      ["0.0.0.0", "http://127.0.0.1:10100/v1"],
    ];
    for (const [hostname, expected] of cases) {
      const configPath = installClient("hermes");
      writeFileSync(configPath, "providers: {}\n");
      const result = applyIntegration({
        clientId: "hermes", models: MODELS, port: 10100,
        config: { ...CONFIG, hostname } as OcxConfig,
        env: TEST_ENV, home, store,
      });
      expect(result.ok).toBe(true);
      expect(readFileSync(configPath, "utf8")).toContain(expected);
      rmSync(configPath, { force: true });
      store.dropRecord("hermes");
    }
  });
});

describe("a restore never launders a foreign edit into owned content", () => {
  test("undoing a confirmed drift-restore leaves the user's edit protected", () => {
    /*
     * The chain: apply, user edits the file by hand, confirmed drift-restore
     * rewinds it (snapshotting the edited bytes first), then undo THAT restore
     * — which puts the user's edited bytes back on disk carrying a record that
     * describes what opencodex wrote. Overwriting that record's fingerprint
     * made the state read `current`, and disable then deleted the user's own
     * field as if it were ours.
     */
    const configPath = installClient("hermes");
    writeFileSync(configPath, "providers:\n  mine:\n    api: http://keep-me\n");
    const write = {
      clientId: "hermes" as const, models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);
    const applyOp = store.listOperations("hermes")[0]!.opId;

    // The user edits the file by hand, adding something of their own.
    const edited = `${readFileSync(configPath, "utf8")}user_field: mine\n`;
    writeFileSync(configPath, edited);

    // Confirmed drift-restore back to the applied bytes; the edit is snapshotted.
    expect(restoreIntegration({ ...write, opId: applyOp, confirmDrift: true }).ok).toBe(true);
    const restoreOp = store.listOperations("hermes")[0]!.opId;

    // Undo that restore: the user's edited bytes come back.
    expect(restoreIntegration({ ...write, opId: restoreOp, confirmDrift: true }).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain("user_field: mine");

    // The record no longer describes these bytes, so the state is conflict…
    const status = readIntegrationState({
      clientId: "hermes", models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    });
    expect(status.state).toBe("conflict");

    // …and disable refuses rather than deleting what the user wrote.
    const disabled = disableIntegration(write);
    expect(disabled.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toContain("user_field: mine");
  });
});

describe("the store's own root stays tidy", () => {
  test("a full lifecycle leaves exactly records, journal and snapshots", () => {
    /*
     * Scoped honestly: listing the root cannot prove nothing was written
     * OUTSIDE it — `tests/integrations-journal.test.ts` owns that claim by
     * asserting the real config dir's manifest is untouched. What this
     * catches is a new bookkeeping file appearing without anyone deciding it
     * should exist.
     */
    writeFileSync(installClient("hermes"), "providers: {}\n");
    const write = {
      clientId: "hermes" as const, models: MODELS, config: CONFIG, port: 10100,
      env: TEST_ENV, home, store,
    };
    expect(applyIntegration(write).ok).toBe(true);
    expect(disableIntegration(write).ok).toBe(true);

    // An unexpected entry here means a new bookkeeping file appeared without
    // anyone deciding it should exist.
    expect(readdirSync(storeRoot).sort()).toEqual(["journal.jsonl", "records.json", "snapshots"]);
  });
});

describe("the CLI names every client it supports", () => {
  test("export help and the top-level list are not stuck on opencode and Pi", () => {
    /*
     * The command has accepted several clients since WP1, but its help said two.
     * A user reading it concluded the feature did not support their client —
     * the one failure mode a help string has.
     *
     * Asserted against what the commands actually PRINT, not against the
     * source text: the help table is module-private, and a test that greps
     * the file would keep passing if printing stopped using it.
     */
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { captured.push(args.join(" ")); };
    try {
      printSubcommandUsage("export");
      printUsage();
    } finally {
      console.log = originalLog;
    }
    const output = captured.join("\n");

    for (const id of EXPORT_CLIENT_IDS) {
      expect(output.toLowerCase()).toContain(id);
    }
    expect(output).not.toContain("Print an opencode/Pi config");
    // The headless toggle added alongside the WP4 routes is discoverable.
    expect(output).toContain("ocx integration client");
  });
});
