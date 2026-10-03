import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withCatalogWriteSerialization } from "../../src/codex/catalog-write-serialization";
import { CODEX_CATALOG_AUDIT_FILE } from "../../src/codex/catalog/write-audit";
import {
  CODEX_HOME_JOURNAL_FILE,
  currentOpencodexHome,
  inspectCodexHomeOwner,
  opencodexHomeForInjection,
} from "../../src/codex/codex-home-owner";
import { resolveCodexCatalogSerializationDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";

function runInHomes(script: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot(),
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: process.env.OPENCODEX_HOME },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout?.trim() ?? "", stderr: result.stderr ?? "" };
}

let root = "";
let codexHome = "";
let ownHome = "";
let otherHome = "";
let previousOpencodexHome: string | undefined;

function bindTo(home: string | undefined): void {
  writeFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), JSON.stringify({
    version: 1,
    originalConfig: "",
    originalProfile: null,
    pid: 1,
    timestamp: "2026-10-04T00:00:00.000Z",
    ...(home === undefined ? {} : { opencodexHome: home }),
  }));
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-home-owner-")));
  codexHome = join(root, "codex");
  ownHome = join(root, "own");
  otherHome = join(root, "other");
  for (const dir of [codexHome, ownHome, otherHome]) mkdirSync(dir);
  process.env.OPENCODEX_HOME = ownHome;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  const path = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  removeTreeWithRetry(root);
});

describe("Codex home binding (#6529)", () => {
  test("a Codex home without a journal, or with a pre-binding journal, is unbound", () => {
    expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unbound" });
    bindTo(undefined);
    expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unbound" });
    writeFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), "{not json");
    expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unbound" });
    // Read-only: an unreadable journal is recovery evidence, not ours to clean.
    expect(existsSync(join(codexHome, CODEX_HOME_JOURNAL_FILE))).toBe(true);
  });

  test("the injecting home owns it, under any spelling of the same directory", () => {
    bindTo(ownHome);
    expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "owned" });
    const alias = join(root, "alias");
    symlinkSync(ownHome, alias);
    bindTo(alias);
    expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "owned" });
  });

  test("another existing home is foreign; a vanished one is stale", () => {
    bindTo(otherHome);
    expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "foreign", boundHome: otherHome });
    removeTreeWithRetry(otherHome);
    expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "stale", boundHome: otherHome });
  });

  test("an injection keeps an existing owner, fills a missing one, and replaces only a stale one", () => {
    const current = currentOpencodexHome();
    expect(current).toBe(ownHome);
    expect(opencodexHomeForInjection(undefined)).toBe(ownHome);
    expect(opencodexHomeForInjection(ownHome)).toBe(ownHome);
    expect(opencodexHomeForInjection(otherHome)).toBe(otherHome);
    removeTreeWithRetry(otherHome);
    expect(opencodexHomeForInjection(otherHome)).toBe(ownHome);
  });

  test("K refuses a writer from another home before running its callback", () => {
    bindTo(otherHome);
    let ran = false;
    const outcome = withCatalogWriteSerialization(codexHome, () => { ran = true; }, { intent: "refresh", writer: "test" });
    expect(outcome).toEqual({ kind: "unavailable", reason: "foreign-owner" });
    expect(ran).toBe(false);
    // No audit file was created on the owner's behalf.
    expect(existsSync(join(codexHome, CODEX_CATALOG_AUDIT_FILE))).toBe(false);
  });

  test("a refused writer leaves one line in an audit file the owner created", () => {
    bindTo(otherHome);
    writeFileSync(join(codexHome, CODEX_CATALOG_AUDIT_FILE), "");
    withCatalogWriteSerialization(codexHome, () => null, { intent: "restore", writer: "codex-restore" });
    const lines = readFileSync(join(codexHome, CODEX_CATALOG_AUDIT_FILE), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      target: "catalog",
      outcome: "refused",
      reason: "foreign-owner",
      intent: "restore",
      writer: "codex-restore",
      pid: process.pid,
    });
  });

  test("K lets the owner, an unbound home and a stale binding through", () => {
    for (const bound of [ownHome, undefined]) {
      bindTo(bound);
      expect(withCatalogWriteSerialization(codexHome, () => "ran", { intent: "refresh", writer: "test" }))
        .toEqual({ kind: "completed", value: "ran" });
    }
    bindTo(otherHome);
    removeTreeWithRetry(otherHome);
    expect(withCatalogWriteSerialization(codexHome, () => "ran", { intent: "refresh", writer: "test" }))
      .toEqual({ kind: "completed", value: "ran" });
  });

  test("an injection records the injecting home, and fills it into a pre-binding journal", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
    const first = runInHomes(`
      const { writeJournal } = require("./src/codex/journal");
      writeJournal();
    `);
    expect(first.status).toBe(0);
    const journalPath = join(codexHome, CODEX_HOME_JOURNAL_FILE);
    expect(JSON.parse(readFileSync(journalPath, "utf8")).opencodexHome).toBe(ownHome);

    const legacy = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    delete legacy.opencodexHome;
    writeFileSync(journalPath, JSON.stringify(legacy));
    const marked = runInHomes(`
      const { markJournalInjectedState } = require("./src/codex/journal");
      markJournalInjectedState("routed", null, { injectedOpenaiBaseUrl: null, injectedRealtimeWsBaseUrl: null, injectedCatalogPath: null });
    `);
    expect(marked.status).toBe(0);
    expect(JSON.parse(readFileSync(journalPath, "utf8")).opencodexHome).toBe(ownHome);
  });

  test("a replacement native snapshot from another home keeps the binding", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
    bindTo(otherHome);
    const replaced = runInHomes(`
      const { writeJournal } = require("./src/codex/journal");
      writeJournal({ currentStateIsNative: true });
    `);
    expect(replaced.status).toBe(0);
    const journal = JSON.parse(readFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), "utf8")) as Record<string, unknown>;
    expect(journal.originalConfig).toBe(Buffer.from('model = "gpt-5.5"\n').toString("base64"));
    expect(journal.opencodexHome).toBe(otherHome);
  });

  test("a sync from another home leaves a bound catalog alone, even with a valid config", () => {
    const catalog = `${JSON.stringify({ models: [
      { slug: "gpt-5.5", display_name: "GPT-5.5", description: "native", priority: 1, visibility: "list" },
      { slug: "ark/glm-5.3", display_name: "ark/glm-5.3", description: "Routed via opencodex → ark/glm-5.3 (ark).", priority: 5, visibility: "list" },
    ] }, null, 2)}\n`;
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n');
    writeFileSync(join(codexHome, "catalog.json"), catalog);
    bindTo(otherHome);
    // The #6530 guard cannot see this one: config.json is valid and genuinely routes nothing.
    writeFileSync(join(ownHome, "config.json"), JSON.stringify({ providers: {} }));
    const r = runInHomes(`
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);
    expect(readFileSync(join(codexHome, "catalog.json"), "utf8")).toBe(catalog);
    const result = JSON.parse(r.stdout.split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    expect(result).toMatchObject({ catalogWritten: false, refreshOutcome: "refused", skippedReason: "foreign_owner" });
  });
});
