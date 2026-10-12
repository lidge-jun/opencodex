/**
 * What the paginated-history transition leaves behind, judged by destination.
 *
 * #5321 made the provider-table transition complete on a home Codex has already migrated to
 * paginated history. Completing it is not the property that matters to the operator: a
 * transition that succeeds while quietly moving the conversations a home already had onto
 * Codex's own OpenAI endpoint is worse than the refusal it replaced. Every case below reads
 * the state AFTER the write and resolves, for each conversation the home already had and for
 * the one it will create next, which destination Codex would actually use.
 *
 * Nothing here starts the proxy or any service. The injector runs in a child process against a
 * temporary CODEX_HOME so its module-level path constants bind to the fixture, which is the
 * isolation the neighbouring integration file already uses.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE,
  HISTORY_RELABEL_STANDS_DOWN,
} from "../../src/codex/history-provider";
import { OCX_ROUTING_MARKER_LINE } from "../../src/codex/injected-marker";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { validHistoryBackupFixture } from "../helpers/codex-history-manifest-fixtures";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const repoRoot = resolveRepoRoot();
setDefaultTimeout(SPAWN_BUDGET_MS);

const PORT = 10100;

/** Derived from the injector's own target builder, so the URL under test is never a literal. */
const PROXY_BASE_URL = standaloneCodexRoutingTarget(PORT, { codexDesktopAuthless: true }).baseUrl;

/**
 * Where a conversation ends up when nothing this project wrote applies to it: Codex's built-in
 * `openai` entry with no root override, or a `model_provider` id whose table is absent. Both are
 * "not this proxy", which is the outcome these cases exist to rule out.
 */
const CODEX_OWN_ENDPOINT = "codex-built-in-openai-endpoint";

/**
 * The resolution Codex performs, applied to the config that was actually written.
 *
 * An `openai`-tagged conversation reads the built-in entry, whose base URL is the root
 * `openai_base_url` when one is present. Any other tag reads its own provider table. Asserting
 * on key presence would have passed for a config that names a provider it never defines.
 */
function destinationOf(config: Record<string, unknown>, modelProvider: string): string {
  if (modelProvider === "openai") {
    const override = config.openai_base_url;
    return typeof override === "string" ? override : CODEX_OWN_ENDPOINT;
  }
  const tables = config.model_providers;
  const table = tables && typeof tables === "object"
    ? (tables as Record<string, unknown>)[modelProvider]
    : undefined;
  const baseUrl = table && typeof table === "object"
    ? (table as Record<string, unknown>).base_url
    : undefined;
  return typeof baseUrl === "string" ? baseUrl : CODEX_OWN_ENDPOINT;
}

interface ThreadRow {
  id: string;
  model_provider: string;
  history_mode: string;
}

function paginatedRollout(id: string, modelProvider: string): string {
  return JSON.stringify({
    ordinal: 0,
    type: "session_meta",
    payload: { id, history_mode: "paginated", model_provider: modelProvider },
  }) + "\n";
}

/** Seed one home: the config bytes, plus a paginated row and rollout per conversation. */
function seedHome(
  codexHome: string,
  configText: string,
  conversations: readonly { id: string; provider: string }[],
): Map<string, string> {
  writeFileSync(join(codexHome, "config.toml"), configText);
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
  const rollouts = new Map<string, string>();
  for (const conversation of conversations) {
    const path = join(codexHome, conversation.id + ".jsonl");
    const bytes = paginatedRollout(conversation.id, conversation.provider);
    writeFileSync(path, bytes);
    rollouts.set(path, bytes);
    db.run(
      "INSERT INTO threads VALUES (?, ?, ?, 'paginated')",
      conversation.id,
      path,
      conversation.provider,
    );
  }
  db.close();
  return rollouts;
}

function readThreads(codexHome: string): ThreadRow[] {
  const db = new Database(join(codexHome, "state_5.sqlite"), { readonly: true });
  const rows = db
    .query<ThreadRow, []>("SELECT id, model_provider, history_mode FROM threads ORDER BY id")
    .all();
  db.close();
  return rows;
}

function readConfig(codexHome: string): Record<string, unknown> {
  return Bun.TOML.parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as Record<string, unknown>;
}

function runChild(
  codexHome: string,
  ocxHome: string,
  script: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "", OPENCODEX_HOME: ocxHome },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    status: result.status ?? 1,
  };
}

const INJECT_SCRIPT = [
  'const { injectCodexConfig } = require("./src/codex/inject");',
  'const result = await injectCodexConfig(' + PORT + ', JSON.parse(process.env.TEST_OCX_CONFIG));',
  "console.log(JSON.stringify(result));",
].join("\n");

const RESTORE_SCRIPT = [
  'const { restoreNativeCodex } = require("./src/codex/inject");',
  "console.log(JSON.stringify(restoreNativeCodex()));",
].join("\n");

/** Run a child and parse its single JSON line, reporting the child's stderr when it failed. */
function runJson(
  codexHome: string,
  ocxHome: string,
  script: string,
  extraEnv: Record<string, string> = {},
): Record<string, unknown> {
  const child = runChild(codexHome, ocxHome, script, extraEnv);
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

describe("paginated transition destinations (#5321)", () => {
  let codexHome: string;
  let ocxHome: string;

  beforeEach(() => {
    codexHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-l4-codex-")));
    ocxHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-l4-home-")));
  });

  afterEach(() => {
    removeTreeWithRetry(codexHome);
    removeTreeWithRetry(ocxHome);
  });

  test("enabling on a paginated openai home keeps every conversation reaching this proxy", () => {
    const catalogPath = join(codexHome, "opencodex-catalog.json");
    writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: "vendor/routed-model" }] }));
    const rollouts = seedHome(codexHome, 'model = "gpt-5.5"\n', [
      { id: "already-openai", provider: "openai" },
      { id: "already-routed", provider: "opencodex" },
    ]);
    const before = readThreads(codexHome);

    const applied = runJson(codexHome, ocxHome, INJECT_SCRIPT, {
      TEST_OCX_CONFIG: JSON.stringify({ codexDesktopAuthless: true }),
    });
    expect(applied).toMatchObject({
      success: true,
      historyPreflightFailureReason: HISTORY_RELABEL_STANDS_DOWN,
    });

    const config = readConfig(codexHome);
    // Each conversation the home already had, resolved through whichever entry its own tag
    // names. The openai-tagged one is the case #5321 was about: it is never relabeled, so the
    // retained root override is the only thing keeping it off Codex's own endpoint.
    for (const row of readThreads(codexHome)) {
      expect(destinationOf(config, row.model_provider)).toBe(PROXY_BASE_URL);
    }
    // The conversation created next reads the root model_provider, so the id it names has to
    // exist as a table and that table has to point here.
    expect(config.model_provider).toBe("opencodex");
    expect(destinationOf(config, config.model_provider as string)).toBe(PROXY_BASE_URL);
    expect(config.model_catalog_json).toBe(catalogPath);
    expect(existsSync(config.model_catalog_json as string)).toBe(true);
    // Preserving those destinations may not cost a history byte or a row: the ordinals in a
    // paginated rollout belong to Codex's own writer.
    for (const [path, bytes] of rollouts) expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(readThreads(codexHome)).toEqual(before);
  });

  test("a root override the operator owns is neither taken over nor removed by the restore", () => {
    const operatorUrl = "https://gateway.operator.example/v1";
    const rollouts = seedHome(codexHome, [
      'openai_base_url = "' + operatorUrl + '"',
      'user_owned = "keep-me"',
      'model = "gpt-5.5"',
      "",
    ].join("\n"), [{ id: "already-openai", provider: "openai" }]);

    const applied = runJson(codexHome, ocxHome, INJECT_SCRIPT, {
      TEST_OCX_CONFIG: JSON.stringify({ codexDesktopAuthless: true }),
    });
    expect(applied.success).toBe(true);

    const written = readFileSync(join(codexHome, "config.toml"), "utf8");
    const config = Bun.TOML.parse(written) as Record<string, unknown>;
    // Their line, their destination. The marker that would claim the line as ours is never
    // written above it, which is what stops a later restore from deleting their setting.
    expect(config.openai_base_url).toBe(operatorUrl);
    expect(written).not.toContain(OCX_ROUTING_MARKER_LINE + "\nopenai_base_url");
    expect(destinationOf(config, "openai")).toBe(operatorUrl);
    // The transition is still a transition: new threads reach this proxy through the table.
    expect(destinationOf(config, config.model_provider as string)).toBe(PROXY_BASE_URL);

    expect(runJson(codexHome, ocxHome, RESTORE_SCRIPT).success).toBe(true);
    const afterRestore = readConfig(codexHome);
    expect(afterRestore.openai_base_url).toBe(operatorUrl);
    expect(afterRestore.user_owned).toBe("keep-me");
    expect(afterRestore.model_provider).toBeUndefined();
    for (const [path, bytes] of rollouts) expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  test("an admission-token home is refused rather than reported as supported", () => {
    const original = 'model = "gpt-5.5"\n';
    const rollouts = seedHome(codexHome, original, [{ id: "already-openai", provider: "openai" }]);
    const before = readThreads(codexHome);

    const script = [
      'const { injectCodexConfig } = require("./src/codex/inject");',
      'const result = await injectCodexConfig(' + PORT + ', {}, { routingTarget: {',
      '  baseUrl: "https://hub.example.test/v1",',
      "  requiresAdmissionToken: true,",
      '  tokenEnv: "OPENCODEX_API_AUTH_TOKEN",',
      "} });",
      "console.log(JSON.stringify(result));",
    ].join("\n");
    expect(runJson(codexHome, ocxHome, script)).toMatchObject({
      success: false,
      historyPreflightFailureReason: HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE,
    });
    // Codex's built-in openai entry carries no admission header, so there is no root override
    // this form can own. Refusing has to mean nothing was written: a refusal reported beside a
    // half-applied config is the state an operator cannot diagnose without reading the file.
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
    expect(readThreads(codexHome)).toEqual(before);
    for (const [path, bytes] of rollouts) expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  test("a missing database and an unreadable manifest stay their own failure class", () => {
    const original = 'model = "gpt-5.5"\n';
    writeFileSync(join(codexHome, "config.toml"), original);
    const rolloutPath = join(codexHome, "manifest-owned.jsonl");
    writeFileSync(rolloutPath, JSON.stringify({
      type: "session_meta",
      payload: { id: "manifest-owned", model_provider: "openai", source: "cli" },
    }) + "\n");

    // No state database at all, and a manifest that still owns restore work. The manifest name
    // is derived inside the child, because it binds to the path spelling the runtime resolves.
    const script = [
      'const fs = require("node:fs");',
      'const { dirname, join } = require("node:path");',
      'const { historyBackupPathFor, preflightCodexHistoryInjection } = require("./src/codex/history-provider");',
      'const { resolveCodexStateDbPath } = require("./src/codex/paths");',
      'const { injectCodexConfig } = require("./src/codex/inject");',
      "const dbPath = resolveCodexStateDbPath();",
      "const manifestPath = historyBackupPathFor(dbPath);",
      "const manifest = JSON.parse(process.env.TEST_OCX_MANIFEST);",
      "manifest.stateDbPath = dbPath;",
      "fs.mkdirSync(dirname(manifestPath), { recursive: true });",
      "fs.writeFileSync(manifestPath, JSON.stringify(manifest));",
      "const missing = {",
      "  preflight: preflightCodexHistoryInjection(false, true),",
      '  inject: await injectCodexConfig(' + PORT + ', {}),',
      "};",
      'fs.writeFileSync(manifestPath, "{ not json");',
      "const unreadable = {",
      "  preflight: preflightCodexHistoryInjection(false, true),",
      '  inject: await injectCodexConfig(' + PORT + ', {}),',
      "};",
      'const config = fs.readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8");',
      "console.log(JSON.stringify({ missing, unreadable, config, dbAbsent: !fs.existsSync(dbPath) }));",
    ].join("\n");
    const observed = runJson(codexHome, ocxHome, script, {
      TEST_OCX_MANIFEST: JSON.stringify(validHistoryBackupFixture("", rolloutPath)),
    }) as {
      dbAbsent: boolean;
      config: string;
      missing: { preflight: string; inject: { success: boolean; historyPreflightFailureReason?: string } };
      unreadable: { preflight: string; inject: { success: boolean; historyPreflightFailureReason?: string } };
    };

    expect(observed.dbAbsent).toBe(true);
    // Neither condition may be folded into the path that completes a transition. The two
    // stand-down reasons are the supported path; these are not, they are distinct from each
    // other, and each one stops the injector before it writes.
    const standDown = [HISTORY_RELABEL_STANDS_DOWN, HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE];
    for (const observation of [observed.missing, observed.unreadable]) {
      expect(typeof observation.preflight).toBe("string");
      expect(standDown).not.toContain(observation.preflight);
      expect(observation.inject.success).toBe(false);
      expect(observation.inject.historyPreflightFailureReason).toBe(observation.preflight);
    }
    expect(observed.unreadable.preflight).not.toBe(observed.missing.preflight);
    expect(observed.config).toBe(original);
  });
});
