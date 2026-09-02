import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { Database } from "bun:sqlite";

import {
  buildCatalogEntries,
  readCodexCatalogPath,
  syncCatalogModels,
} from "../src/codex/catalog";
import { buildProfileFile } from "../src/codex/inject";
import { classifyNativeRoutedResidue } from "../src/codex/native-residue";
import { readCodexTransitionState } from "../src/codex/transition-state";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import type { OcxConfig } from "../src/types";
import { INVALID_HISTORY_BACKUP_FIXTURES, validHistoryBackupFixture } from "./helpers/codex-history-manifest-fixtures";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let codexHome = "";
let opencodexHome = "";
let coordinatorPath = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ocx-native-residue-codex-"));
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-native-residue-opencodex-"));
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${coordinatorPath}${suffix}`, { force: true });
  }
  removeTreeWithRetry(codexHome);
  removeTreeWithRetry(opencodexHome);
});

function pathInCodexHome(name: string): string {
  return join(codexHome, name);
}

function canonicalPathInCodexHome(name: string): string {
  return join(realpathSync.native(codexHome), name);
}

function routedCatalog(): string {
  const models = buildCatalogEntries(
    null,
    [],
    [{ provider: "fixture-provider", id: "fixture-model" }],
  );
  return JSON.stringify({ models }, null, 2) + "\n";
}

function sessionMeta(id: string, modelProvider: string): string {
  return JSON.stringify({
    timestamp: "2026-08-04T00:00:00.000Z",
    type: "session_meta",
    payload: { id, model_provider: modelProvider, source: "cli" },
  });
}

function createHistoryDatabase(
  modelProvider: "openai" | "opencodex",
  rolloutProviders: string[] = [modelProvider],
): void {
  writeFileSync(
    pathInCodexHome("rollout.jsonl"),
    rolloutProviders.map(provider => sessionMeta("thread-1", provider)).join("\n") + "\n",
  );
  const database = new Database(pathInCodexHome("state_5.sqlite"));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      source TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      has_user_event INTEGER NOT NULL DEFAULT 0
    )
  `);
  database.query(`
    INSERT INTO threads (
      id, rollout_path, model_provider, source, first_user_message, has_user_event
    ) VALUES (?, ?, ?, 'cli', 'routed history', 1)
  `).run("thread-1", pathInCodexHome("rollout.jsonl"), modelProvider);
  database.close();
}

function historyBackupPath(): string {
  const databasePath = join(realpathSync.native(codexHome), "state_5.sqlite");
  const normalized = process.platform === "win32"
    ? resolve(databasePath).toLowerCase()
    : resolve(databasePath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(opencodexHome, `codex-history-backup-${id}.json`);
}

const residueFixtures: Array<{
  name: string;
  surface: string;
  arrange: () => void;
}> = [
  {
    name: "injected config.toml",
    surface: "config",
    arrange: () => writeFileSync(pathInCodexHome("config.toml"), [
      "# Auto-injected by opencodex",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n")),
  },
  {
    name: "generated profile",
    surface: "profile",
    arrange: () => writeFileSync(
      pathInCodexHome("opencodex.config.toml"),
      buildProfileFile(10100, null),
    ),
  },
  {
    name: "routed catalog",
    surface: "catalog",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-catalog.json"), routedCatalog()),
  },
  {
    name: "routed models cache",
    surface: "models-cache",
    arrange: () => writeFileSync(pathInCodexHome("models_cache.json"), routedCatalog()),
  },
  {
    name: "restore journal",
    surface: "journal",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-journal.json"), JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model = "gpt-5.5"\n').toString("base64"),
      originalProfile: null,
      pid: 12345,
      timestamp: "2026-08-04T00:00:00.000Z",
    })),
  },
  {
    name: "history backup entry",
    surface: "history-backup",
    arrange: () => {
      writeFileSync(pathInCodexHome("rollout.jsonl"), sessionMeta("thread-1", "openai") + "\n");
      writeFileSync(historyBackupPath(), JSON.stringify({
        version: 1,
        stateDbPath: join(realpathSync.native(codexHome), "state_5.sqlite"),
        entries: {
          "thread-1": {
            id: "thread-1",
            rolloutPath: pathInCodexHome("rollout.jsonl"),
            modelProvider: "openai",
            source: "cli",
            hasUserEvent: 1,
          },
        },
      }));
    },
  },
];

for (const fixture of residueFixtures) {
  test(`${fixture.name} is structurally provable routed residue`, () => {
    fixture.arrange();
    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "residue",
      surface: fixture.surface,
    });
  });
}

test("a bare routed history row and its matching rollout are not managed residue", () => {
  createHistoryDatabase("opencodex");

  expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 0, currentTxId: null },
  });
});

test("an OpenCodex atomic-write artifact is indeterminate", () => {
  writeFileSync(pathInCodexHome("config.toml.ocx.123.1.tmp"), "partial");
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "partial-write",
  });
});

test("a routed catalog at the configured nested path refuses coordinator initialization", async () => {
  const catalogPath = canonicalPathInCodexHome("nested/custom-catalog.json");
  mkdirSync(pathInCodexHome("nested"));
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/custom-catalog.json"\n');
  writeFileSync(catalogPath, JSON.stringify({ models: [] }));
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-chat",
        baseUrl: "https://fixture.invalid/v1",
        liveModels: false,
        models: ["fixture-model"],
      },
    },
  };

  const sync = await syncCatalogModels(config);

  expect(sync).toMatchObject({ path: catalogPath, catalogWritten: true });
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "catalog",
    path: catalogPath,
  });
  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});

test("a BOM-prefixed configured catalog refuses coordinator initialization", () => {
  writeFileSync(
    pathInCodexHome("config.toml"),
    '\uFEFFmodel_catalog_json = "bom-catalog.json"\n',
  );
  const productionTarget = readCodexCatalogPath();
  mkdirSync(dirname(productionTarget), { recursive: true });
  writeFileSync(productionTarget, routedCatalog());

  expect(classifyNativeRoutedResidue()).toEqual({
    kind: "residue",
    surface: "catalog",
    path: productionTarget,
  });
  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});

const catalogConfigShapes: Array<{
  name: string;
  content: string;
  strictOnlyTargets?: string[];
}> = [
  {
    name: "quoted key",
    content: '"model_catalog_json" = "quoted.json"\n',
    strictOnlyTargets: ["quoted.json"],
  },
  { name: "single-quoted value", content: "model_catalog_json = 'single.json'\n" },
  { name: "BOM prefix", content: '\uFEFFmodel_catalog_json = "bom.json"\n' },
  { name: "CRLF", content: 'model_catalog_json = "crlf.json"\r\n' },
  { name: "leading whitespace", content: '  model_catalog_json = "ws.json"\n' },
  { name: "after table header", content: '[tools]\nmodel_catalog_json = "nested.json"\n' },
  { name: "trailing comment", content: 'model_catalog_json = "cmt.json" # comment\n' },
];

for (const shape of catalogConfigShapes) {
  test(`catalog candidate coverage matches production for ${shape.name}`, () => {
    writeFileSync(pathInCodexHome("config.toml"), shape.content);
    for (const target of shape.strictOnlyTargets ?? []) {
      writeFileSync(pathInCodexHome(target), JSON.stringify({ models: [] }));
    }
    const productionTarget = readCodexCatalogPath();
    mkdirSync(dirname(productionTarget), { recursive: true });
    writeFileSync(productionTarget, routedCatalog());

    expect(classifyNativeRoutedResidue()).toEqual({
      kind: "residue",
      surface: "catalog",
      path: productionTarget,
    });
  });
}

const catalogPathShapes: Array<{
  name: string;
  configuredPath: (outsideRoot: string, leaf: string) => string;
}> = [
  { name: "root-relative", configuredPath: (_outsideRoot, leaf) => leaf },
  { name: "nested-relative", configuredPath: (_outsideRoot, leaf) => `nested/${leaf}` },
  {
    name: "absolute inside CODEX_HOME",
    configuredPath: (_outsideRoot, leaf) => canonicalPathInCodexHome(leaf),
  },
  {
    name: "absolute outside CODEX_HOME",
    configuredPath: (outsideRoot, leaf) => join(outsideRoot, leaf),
  },
  {
    name: "parent-escaping relative",
    configuredPath: (_outsideRoot, leaf) => `../${basename(codexHome)}-${leaf}`,
  },
];

for (const shape of catalogPathShapes) {
  test(`configured catalog classification follows the ${shape.name} path`, () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "ocx-native-residue-catalog-outside-"));
    const configuredPath = shape.configuredPath(outsideRoot, randomUUID());
    const targetPath = resolve(realpathSync.native(codexHome), configuredPath);
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(
        pathInCodexHome("config.toml"),
        `model_catalog_json = ${JSON.stringify(configuredPath)}\n`,
      );

      expect(classifyNativeRoutedResidue(), "configured absence must fail closed").toMatchObject({
        kind: "indeterminate",
        surface: "catalog",
        path: targetPath,
      });

      writeFileSync(targetPath, routedCatalog());
      expect(classifyNativeRoutedResidue(), "routed target must be detected").toEqual({
        kind: "residue",
        surface: "catalog",
        path: targetPath,
      });
    } finally {
      rmSync(targetPath, { force: true });
      removeTreeWithRetry(outsideRoot);
    }
  });
}

const productionCatalogLeafShapes = [
  { name: "extensionless", suffix: "" },
  { name: ".txt", suffix: ".txt" },
  { name: ".json5", suffix: ".json5" },
  { name: "trailing dot", suffix: "." },
  { name: "uppercase .JSON", suffix: ".JSON" },
] as const;

for (const shape of productionCatalogLeafShapes) {
  const configuredLeaf = `${randomUUID()}${shape.suffix}`;
  test(`production writer routes the ${shape.name} configured catalog ${configuredLeaf}`, async () => {
    const catalogPath = canonicalPathInCodexHome(`nested/${configuredLeaf}`);
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(
      pathInCodexHome("config.toml"),
      `model_catalog_json = ${JSON.stringify(`nested/${configuredLeaf}`)}\n`,
    );
    writeFileSync(catalogPath, JSON.stringify({ models: [] }));
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "https://fixture.invalid/v1",
          liveModels: false,
          models: ["fixture-model"],
        },
      },
    };

    const sync = await syncCatalogModels(config);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    const routedRows = catalog.models.filter(model =>
      typeof model.description === "string"
        && model.description.startsWith("Routed via opencodex → ")
    );

    expect(sync).toMatchObject({ path: catalogPath, catalogWritten: true });
    expect(routedRows).toHaveLength(1);
    expect(classifyNativeRoutedResidue()).toEqual({
      kind: "residue",
      surface: "catalog",
      path: catalogPath,
    });
  });
}

test("an atomic-write artifact beside the configured catalog is indeterminate", () => {
  const catalogPath = canonicalPathInCodexHome("nested/custom-catalog.json");
  const artifactPath = `${catalogPath}.ocx.42.7.tmp`;
  mkdirSync(pathInCodexHome("nested"));
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/custom-catalog.json"\n');
  writeFileSync(catalogPath, JSON.stringify({ models: [] }));
  writeFileSync(artifactPath, "partial");

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "partial-write",
    path: artifactPath,
  });
});

test("an atomic-write artifact is found before its configured target exists", () => {
  const catalogPath = canonicalPathInCodexHome("nested/pending.json");
  const artifactPath = `${catalogPath}.ocx.42.7.tmp`;
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/pending.json"\n');
  writeFileSync(artifactPath, "partial");

  expect(lstatSync(catalogPath, { throwIfNoEntry: false })).toBeUndefined();
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "partial-write",
    path: artifactPath,
  });
});

test("a configured catalog target that is not a readable regular file is indeterminate", () => {
  const catalogPath = canonicalPathInCodexHome("nested/custom-catalog.json");
  mkdirSync(catalogPath, { recursive: true });
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/custom-catalog.json"\n');

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "catalog",
    path: catalogPath,
  });
});

const permissionTest = process.platform === "win32" ? test.skip : test;
permissionTest("EACCES on a configured regular catalog file is indeterminate", () => {
  const catalogPath = canonicalPathInCodexHome("permission-target.json");
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "permission-target.json"\n');
  writeFileSync(catalogPath, routedCatalog());
  expect(lstatSync(catalogPath).isFile()).toBe(true);
  chmodSync(catalogPath, 0o000);
  try {
    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "indeterminate",
      surface: "catalog",
      path: catalogPath,
    });
  } finally {
    chmodSync(catalogPath, 0o600);
  }
});

test("an absent configured catalog target is indeterminate", () => {
  const catalogPath = canonicalPathInCodexHome("nested/missing-catalog.json");
  mkdirSync(pathInCodexHome("nested"));
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/missing-catalog.json"\n');

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "catalog",
    path: catalogPath,
  });
});

test("the default catalog is still inspected when a custom catalog is configured", () => {
  const defaultCatalogPath = canonicalPathInCodexHome("opencodex-catalog.json");
  mkdirSync(pathInCodexHome("nested"));
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/custom-catalog.json"\n');
  writeFileSync(pathInCodexHome("nested/custom-catalog.json"), JSON.stringify({ models: [] }));
  writeFileSync(defaultCatalogPath, routedCatalog());

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "catalog",
    path: defaultCatalogPath,
  });
});

for (const location of ["inside", "outside"] as const) {
  test(`the default catalog remains inspected with an absolute ${location} configured path`, () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "ocx-native-residue-default-outside-"));
    const configuredPath = location === "inside"
      ? canonicalPathInCodexHome("absolute-custom.json")
      : join(outsideRoot, "absolute-custom.json");
    const defaultCatalogPath = canonicalPathInCodexHome("opencodex-catalog.json");
    try {
      writeFileSync(
        pathInCodexHome("config.toml"),
        `model_catalog_json = ${JSON.stringify(configuredPath)}\n`,
      );
      writeFileSync(configuredPath, JSON.stringify({ models: [] }));
      writeFileSync(defaultCatalogPath, routedCatalog());

      expect(classifyNativeRoutedResidue()).toMatchObject({
        kind: "residue",
        surface: "catalog",
        path: defaultCatalogPath,
      });
    } finally {
      rmSync(configuredPath, { force: true });
      removeTreeWithRetry(outsideRoot);
    }
  });
}

test("every non-string TOML type for model_catalog_json is indeterminate", () => {
  const nonStringTomlValues = [
    ["number", "42"],
    ["boolean", "true"],
    ["array", '["custom.json"]'],
    ["inline table", '{ path = "custom.json" }'],
  ] as const;

  for (const [type, value] of nonStringTomlValues) {
    writeFileSync(pathInCodexHome("config.toml"), `model_catalog_json = ${value}\n`);
    expect(classifyNativeRoutedResidue(), type).toMatchObject({
      kind: "indeterminate",
      surface: "config",
      path: canonicalPathInCodexHome("config.toml"),
    });
  }
});

// TOML datetime is deliberately not in the list above: which SURFACE reports the
// problem is runtime-dependent, and neither answer is a defect.
//
// Bun 1.3.14 has no datetime support, so the document fails to parse and the
// config surface reports it. Bun 1.4 added datetime and yields a string, so
// `model_catalog_json` becomes a syntactically valid path, the classifier
// resolves it like any other, and the CATALOG surface reports it as absent.
// Pinning `surface: "config"` for both fails on 1.4 for a reason unrelated to
// this repository — found during Bun 1.4 canary qualification (#1691).
//
// The property worth pinning survives both: a datetime literal is never
// accepted as a usable catalog. It is either unparseable config or a path that
// does not exist, and `indeterminate` is what refuses coordinator
// initialization in both cases.
test("a TOML datetime for model_catalog_json is never accepted as a usable catalog", () => {
  writeFileSync(pathInCodexHome("config.toml"), "model_catalog_json = 1979-05-27T07:32:00Z\n");
  const classification = classifyNativeRoutedResidue();

  expect(classification.kind).toBe("indeterminate");
  // 1.3.14 blames the unreadable config; 1.4 blames the catalog path it parsed.
  expect(["config", "catalog"]).toContain(
    (classification as { surface: string }).surface,
  );
});

test("duplicate configured catalog paths are indeterminate", () => {
  writeFileSync(pathInCodexHome("config.toml"), [
    'model_catalog_json = "first.json"',
    'model_catalog_json = "second.json"',
    "",
  ].join("\n"));

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "config",
    path: canonicalPathInCodexHome("config.toml"),
  });
});

test("an invalid sqlite_home is indeterminate instead of selecting a fallback database", () => {
  writeFileSync(pathInCodexHome("config.toml"), "sqlite_home = 123\n");

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "config",
    path: canonicalPathInCodexHome("config.toml"),
  });
});

const arbitraryComboAlias = randomUUID();

test(`production-generated arbitrary bare combo alias ${arbitraryComboAlias} is routed residue`, async () => {
  const catalogPath = canonicalPathInCodexHome("opencodex-catalog.json");
  writeFileSync(catalogPath, JSON.stringify({ models: [] }));
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-chat",
        baseUrl: "https://fixture.invalid/v1",
        liveModels: false,
        models: ["combo-member"],
        modelContextWindows: { "combo-member": 128_000 },
      },
    },
    disabledModels: ["fixture/combo-member"],
    combos: {
      edge: {
        alias: arbitraryComboAlias,
        targets: [{ provider: "fixture", model: "combo-member" }],
      },
    },
  };

  const sync = await syncCatalogModels(config);
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    models: Array<Record<string, unknown>>;
  };
  const routedRows = catalog.models.filter(model =>
    typeof model.description === "string"
      && model.description.startsWith("Routed via opencodex → ")
  );

  expect(sync).toMatchObject({ path: catalogPath, catalogWritten: true });
  expect(arbitraryComboAlias).not.toContain("/");
  expect(routedRows).toEqual([
    expect.objectContaining({
      slug: arbitraryComboAlias,
      description: "Routed via opencodex → combo (combo).",
      owned_by: "combo",
    }),
  ]);
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "catalog",
  });
  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});

const arbitraryForeignSlug = `${randomUUID()}/${randomUUID()}`;
const arbitraryForeignDescription = randomUUID();

test(`arbitrary foreign row ${arbitraryForeignSlug} described as ${arbitraryForeignDescription} is indeterminate`, () => {
  writeFileSync(pathInCodexHome("opencodex-catalog.json"), JSON.stringify({
    models: [{ slug: arbitraryForeignSlug, description: arbitraryForeignDescription }],
  }));

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "catalog",
  });
});

test("a native-tagged history row with routed latest rollout metadata refuses coordinator initialization", () => {
  createHistoryDatabase("openai", ["openai", "opencodex"]);

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "history",
    path: pathInCodexHome("rollout.jsonl"),
  });
  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});

test("routed first rollout metadata is residue even when the latest metadata is native", () => {
  createHistoryDatabase("openai", ["opencodex", "openai"]);

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "history",
    path: pathInCodexHome("rollout.jsonl"),
  });
});

test("an opencodex first rollout with invalid latest metadata is indeterminate", () => {
  createHistoryDatabase("openai");
  writeFileSync(
    pathInCodexHome("rollout.jsonl"),
    sessionMeta("thread-1", "opencodex") + "\n" + sessionMeta("thread-2", "openai") + "\n",
  );

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "history",
    path: pathInCodexHome("rollout.jsonl"),
    reason: expect.stringContaining("latest session_meta"),
  });
});

test("a referenced rollout with native first and latest metadata is clean", () => {
  createHistoryDatabase("openai", ["openai", "openai"]);

  expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
});

test("a routed rollout without a trailing newline is residue", () => {
  createHistoryDatabase("openai");
  writeFileSync(pathInCodexHome("rollout.jsonl"), sessionMeta("thread-1", "opencodex"));

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "history",
    path: pathInCodexHome("rollout.jsonl"),
  });
});

test("a routed rollout with a non-ASCII id split across the read chunk is residue", () => {
  createHistoryDatabase("openai");
  const boundary = 64 * 1024;
  const prefix = `{"timestamp":"2026-08-04T00:00:00.000Z","type":"session_meta","payload":{"description":"`;
  const suffix = `","id":"thread-1","model_provider":"opencodex","source":"cli"}}\n`;
  const paddingLength = boundary - Buffer.byteLength(prefix) - 1; // 🚀 starts at byte 65535, straddling 64 KiB
  const content = `${prefix}${"x".repeat(paddingLength)}🚀${suffix}`;
  const emojiByteOffset = Buffer.from(content, "utf8").indexOf(Buffer.from("🚀", "utf8"));
  expect(emojiByteOffset).toBe(boundary - 1);
  writeFileSync(pathInCodexHome("rollout.jsonl"), content);

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "history",
    path: pathInCodexHome("rollout.jsonl"),
  });
});

test("an oversized referenced rollout is indeterminate without being loaded", () => {
  createHistoryDatabase("openai");
  truncateSync(pathInCodexHome("rollout.jsonl"), 64 * 1024 * 1024 + 1);

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "history",
    path: pathInCodexHome("rollout.jsonl"),
    reason: expect.stringContaining("inspection limit"),
  });
});

test("a BOM-prefixed rollout record is indeterminate", () => {
  createHistoryDatabase("openai");
  writeFileSync(pathInCodexHome("rollout.jsonl"), `\uFEFF${sessionMeta("thread-1", "opencodex")}\n`);

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "history",
    path: pathInCodexHome("rollout.jsonl"),
    reason: expect.stringContaining("malformed rollout JSONL"),
  });
});

for (const fixture of [
  {
    name: "missing",
    arrange: () => {
      createHistoryDatabase("openai");
      rmSync(pathInCodexHome("rollout.jsonl"));
    },
  },
  {
    name: "malformed",
    arrange: () => {
      createHistoryDatabase("openai");
      writeFileSync(pathInCodexHome("rollout.jsonl"), "{not-json\n");
    },
  },
  {
    name: "non-file",
    arrange: () => {
      createHistoryDatabase("openai");
      rmSync(pathInCodexHome("rollout.jsonl"));
      mkdirSync(pathInCodexHome("rollout.jsonl"));
    },
  },
]) {
  test(`a ${fixture.name} rollout referenced by a live history row is indeterminate`, () => {
    fixture.arrange();

    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "indeterminate",
      surface: "history",
      path: pathInCodexHome("rollout.jsonl"),
    });
    expect(readCodexTransitionState()).toEqual({
      kind: "legacy-ambiguous",
      message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
    });
  });
}

test("a manifest-referenced routed rollout is residue", () => {
  writeFileSync(pathInCodexHome("rollout.jsonl"), sessionMeta("thread-1", "opencodex") + "\n");
  writeFileSync(historyBackupPath(), JSON.stringify({
    version: 1,
    stateDbPath: join(realpathSync.native(codexHome), "state_5.sqlite"),
    entries: {
      "thread-1": {
        id: "thread-1",
        rolloutPath: pathInCodexHome("rollout.jsonl"),
        modelProvider: "openai",
        source: "cli",
        hasUserEvent: 1,
      },
    },
  }));

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "history-backup",
    path: pathInCodexHome("rollout.jsonl"),
  });
});

test("a missing manifest-referenced rollout is indeterminate", () => {
  writeFileSync(historyBackupPath(), JSON.stringify({
    version: 1,
    stateDbPath: join(realpathSync.native(codexHome), "state_5.sqlite"),
    entries: {
      "thread-1": {
        id: "thread-1",
        rolloutPath: pathInCodexHome("missing-rollout.jsonl"),
        modelProvider: "openai",
        source: "cli",
        hasUserEvent: 1,
      },
    },
  }));

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "history-backup",
    path: pathInCodexHome("missing-rollout.jsonl"),
  });
});

test("history backup schema diagnostics preserve entry shape and provenance distinctions", () => {
  const stateDbPath = join(realpathSync.native(codexHome), "state_5.sqlite");
  const rolloutPath = pathInCodexHome("rollout.jsonl");
  writeFileSync(historyBackupPath(), JSON.stringify({
    version: 1,
    stateDbPath,
    entries: { "thread-1": null },
  }));
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "history-backup",
    reason: "history backup entry has an unknown shape",
  });

  const invalidProvenance = validHistoryBackupFixture(stateDbPath, rolloutPath);
  invalidProvenance.entries["thread-1"].id = "thread-2";
  writeFileSync(historyBackupPath(), JSON.stringify(invalidProvenance));
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "history-backup",
    reason: "history backup entry has invalid provenance metadata",
  });
});

for (const fixture of INVALID_HISTORY_BACKUP_FIXTURES) {
  test(`a history backup with ${fixture.name} is indeterminate and not adopted`, () => {
    writeFileSync(pathInCodexHome("rollout.jsonl"), sessionMeta("thread-1", "opencodex") + "\n");
    const manifest = validHistoryBackupFixture(
      join(realpathSync.native(codexHome), "state_5.sqlite"),
      pathInCodexHome("rollout.jsonl"),
    );
    fixture.mutate(manifest);
    writeFileSync(historyBackupPath(), JSON.stringify(manifest));

    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "indeterminate",
      surface: "history-backup",
    });
    expect(readCodexTransitionState()).toEqual({
      kind: "legacy-ambiguous",
      message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
    });
  });
}

const indeterminateFixtures: Array<{
  name: string;
  surface: string;
  arrange: () => void;
}> = [
  {
    name: "malformed config TOML",
    surface: "config",
    arrange: () => writeFileSync(pathInCodexHome("config.toml"), 'model = "unterminated\n'),
  },
  {
    name: "malformed profile TOML",
    surface: "profile",
    arrange: () => writeFileSync(pathInCodexHome("opencodex.config.toml"), "[features\n"),
  },
  {
    name: "malformed catalog JSON",
    surface: "catalog",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-catalog.json"), "{not-json"),
  },
  {
    name: "unreadable models cache shape",
    surface: "models-cache",
    arrange: () => mkdirSync(pathInCodexHome("models_cache.json")),
  },
  {
    name: "malformed journal JSON",
    surface: "journal",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-journal.json"), "{not-json"),
  },
  {
    name: "partial write",
    surface: "partial-write",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-catalog.json.ocx.42.7.tmp"), ""),
  },
  {
    name: "malformed history database",
    surface: "history",
    arrange: () => writeFileSync(pathInCodexHome("state_5.sqlite"), "not sqlite"),
  },
  {
    name: "malformed history backup",
    surface: "history-backup",
    arrange: () => writeFileSync(historyBackupPath(), "{not-json"),
  },
];

for (const fixture of indeterminateFixtures) {
  test(`${fixture.name} is indeterminate and refuses coordinator initialization`, () => {
    fixture.arrange();
    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "indeterminate",
      surface: fixture.surface,
    });
    expect(readCodexTransitionState()).toEqual({
      kind: "legacy-ambiguous",
      message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
    });
  });
}

const symlinkTest = process.platform === "win32" ? test.skip : test;
symlinkTest("an unresolvable surface symlink is indeterminate", () => {
  symlinkSync(pathInCodexHome("missing-config"), pathInCodexHome("config.toml"));
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "config",
  });
});

test("an empty CODEX_HOME is clean and coordinator initialization succeeds", () => {
  expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 0, currentTxId: null },
  });
});

test("user-owned non-OpenCodex content is clean and coordinator initialization succeeds", () => {
  writeFileSync(pathInCodexHome("config.toml"), 'model = "gpt-5.5"\n');
  writeFileSync(pathInCodexHome("notes.txt"), "user content\n");
  writeFileSync(pathInCodexHome("opencodex-catalog.json"), JSON.stringify({
    models: [{ slug: "gpt-5.5", description: "Native GPT model" }],
  }));
  writeFileSync(pathInCodexHome("models_cache.json"), JSON.stringify({
    models: [{ slug: "gpt-5.5", description: "Native GPT model" }],
  }));
  createHistoryDatabase("openai");

  expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 0, currentTxId: null },
  });
});

test("CODEX_HOME is resolved at call time", () => {
  const secondHome = mkdtempSync(join(tmpdir(), "ocx-native-residue-second-codex-"));
  try {
    writeFileSync(join(secondHome, "opencodex.config.toml"), buildProfileFile(10100, null));
    expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
    process.env.CODEX_HOME = secondHome;
    expect(classifyNativeRoutedResidue()).toMatchObject({ kind: "residue", surface: "profile" });
  } finally {
    process.env.CODEX_HOME = codexHome;
    removeTreeWithRetry(secondHome);
  }
});

test("a missing coordinator with only the generated profile refuses initialization", () => {
  writeFileSync(join(codexHome, "opencodex.config.toml"), buildProfileFile(10100, null));

  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});
