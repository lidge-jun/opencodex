import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_HOME_JOURNAL_FILE, currentOpencodexHome, inspectCodexHomeOwner, opencodexHomeForInjection } from "../../src/codex/codex-home-owner";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);
let root: string, codexHome: string, ownHome: string, otherHome: string;
let previous: string | undefined;
const journal = (home?: string) => ({ version: 1, originalConfig: "", originalProfile: null,
  pid: 1, timestamp: "2026-10-04T00:00:00.000Z", ...(home === undefined ? {} : { opencodexHome: home }) });
const bind = (home?: string) => writeFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), JSON.stringify(journal(home)));
function run(script: string): Record<string, unknown> {
  const child = spawnSync(process.execPath, ["--eval", script], { cwd: repoRoot(),
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "", OPENCODEX_HOME: ownHome },
    encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000 });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}");
}
beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-owner-")));
  codexHome = join(root, "codex"); ownHome = join(root, "own"); otherHome = join(root, "other");
  for (const home of [codexHome, ownHome, otherHome]) mkdirSync(home);
  process.env.OPENCODEX_HOME = ownHome;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(root);
});

test("missing and valid hashless legacy journals are unbound", () => {
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unbound" });
  bind();
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unbound" });
});
test("canonical paths and aliases on both sides identify the physical owner", () => {
  bind(ownHome);
  expect(currentOpencodexHome()).toBe(ownHome);
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "owned" });
  const alias = join(root, "alias"); symlinkSync(ownHome, alias, "dir");
  bind(alias);
  expect(inspectCodexHomeOwner(codexHome, ownHome)).toEqual({ kind: "owned" });
  bind(ownHome);
  expect(inspectCodexHomeOwner(codexHome, alias)).toEqual({ kind: "owned" });
});
test("extant foreign directories are refused and proven absent bindings are stale", () => {
  bind(otherHome);
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "foreign", boundHome: otherHome });
  rmSync(otherHome, { recursive: true });
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "stale", boundHome: otherHome });
});
test("uncertain current resolution and dangling owner links fail closed", () => {
  bind(ownHome);
  expect(inspectCodexHomeOwner(codexHome, join(root, "missing"))).toEqual({ kind: "unknown" });
  const alias = join(root, "dangling"); symlinkSync(join(root, "absent"), alias, "dir");
  bind(alias);
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unknown" });
  expect(opencodexHomeForInjection(alias)).toBe(alias);
});
test("malformed, invalid binding and oversized journals remain unknown and unchanged", () => {
  const path = join(codexHome, CODEX_HOME_JOURNAL_FILE);
  for (const bytes of ["{broken", "null", "{}", JSON.stringify(journal("relative")),
    JSON.stringify({ ...journal(), opencodexHome: null }), " ".repeat(1024 * 1024 + 1)]) {
    writeFileSync(path, bytes);
    expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unknown" });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  }
});
test("symlinked journal, directory journal and owner file are not authority", () => {
  const path = join(codexHome, CODEX_HOME_JOURNAL_FILE);
  const target = join(root, "target"); writeFileSync(target, JSON.stringify(journal(ownHome)));
  symlinkSync(target, path, "file");
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unknown" });
  rmSync(path); mkdirSync(path);
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unknown" });
  rmSync(path, { recursive: true }); bind(target);
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unknown" });
});
test("unresolvable owner paths and journals fail closed without a blocking read", () => {
  const loop = join(root, "loop"); symlinkSync(loop, loop, "dir");
  bind(loop);
  expect(inspectCodexHomeOwner(codexHome)).toEqual({ kind: "unknown" });
  expect(inspectCodexHomeOwner(join(loop, "codex"))).toEqual({ kind: "unknown" });
  expect(opencodexHomeForInjection(loop)).toBe(loop);
});
test("injection binding selection preserves foreign evidence and adopts only legacy/stale", () => {
  expect(opencodexHomeForInjection(undefined)).toBe(ownHome);
  expect(opencodexHomeForInjection(ownHome)).toBe(ownHome);
  expect(opencodexHomeForInjection(otherHome)).toBe(otherHome);
  rmSync(otherHome, { recursive: true });
  expect(opencodexHomeForInjection(otherHome)).toBe(ownHome);
});
test("snapshot and injected-state writers fill legacy, refresh owned native snapshots, and adopt stale bindings", () => {
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\n');
  const script = `const j = require("./src/codex/journal");
    j.writeJournal({currentStateIsNative:true});
    j.markJournalInjectedState("routed", null, {injectedOpenaiBaseUrl:null,injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null});
    console.log(require("node:fs").readFileSync(j.JOURNAL_PATH,"utf8"));`;
  expect(run(script).opencodexHome).toBe(ownHome);
  bind(); expect(run(script).opencodexHome).toBe(ownHome);
  bind(ownHome);
  const replaced = run(script);
  expect(replaced.opencodexHome).toBe(ownHome);
  expect(replaced.originalConfig).toBe(Buffer.from('model = "gpt-6.1-sol"\n').toString("base64"));
  bind(otherHome);
  rmSync(otherHome, { recursive: true });
  expect(run(script).opencodexHome).toBe(ownHome);
});
test("direct snapshot and mark refuse foreign ownership preserving all recovery bytes", () => {
  const configPath = join(codexHome, "config.toml");
  const profilePath = join(codexHome, "opencodex.config.toml");
  const journalPath = join(codexHome, CODEX_HOME_JOURNAL_FILE);
  writeFileSync(configPath, 'model = "gpt-6.1-sol"\n');
  writeFileSync(profilePath, "profile-before\n");
  const bytes = JSON.stringify({ ...journal(otherHome), originalConfig: Buffer.from("foreign original").toString("base64"),
    injectedConfigHash: "foreign-hash", injectedCatalogPath: "foreign-catalog.json" }, null, 2) + "\n";
  writeFileSync(journalPath, bytes);
  const result = run(`const j=require("./src/codex/journal");const fs=require("node:fs");let reasons=[],snapshots=[];
    for(const fn of [()=>j.writeJournal({currentStateIsNative:true}),
      ()=>j.markJournalInjectedState("routed", "new profile", {injectedOpenaiBaseUrl:"http://127.0.0.1:19999",injectedRealtimeWsBaseUrl:null,injectedCatalogPath:"new-catalog.json"})]) {
      try {fn();} catch(e) {reasons.push(e.reason);}
      snapshots.push(fs.readFileSync(j.JOURNAL_PATH,"utf8"));
    }console.log(JSON.stringify({reasons,snapshots}));`);
  expect(result.reasons).toEqual(["foreign-owner", "foreign-owner"]);
  expect(result.snapshots).toEqual([bytes, bytes]);
  expect(readFileSync(journalPath, "utf8")).toBe(bytes);
  expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-6.1-sol"\n');
  expect(readFileSync(profilePath, "utf8")).toBe("profile-before\n");
});
test("corrupt journals refuse direct snapshot and mark without overwriting evidence", () => {
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\n');
  const path = join(codexHome, CODEX_HOME_JOURNAL_FILE); writeFileSync(path, "{broken");
  const result = run(`const j = require("./src/codex/journal"); let reasons=[];
    for (const fn of [()=>j.writeJournal({currentStateIsNative:true}),
      ()=>j.markJournalInjectedState("routed",null,{injectedOpenaiBaseUrl:null,injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null})]) {
      try {fn();} catch(e) {reasons.push(e.reason);}
    } console.log(JSON.stringify({reasons}));`);
  expect(result.reasons).toEqual(["owner-unknown", "owner-unknown"]);
  expect(readFileSync(path, "utf8")).toBe("{broken");
});
test("foreign valid providerless sync preserves catalog and cache", () => {
  const catalog = JSON.stringify({ models: [
    { slug: "gpt-6.1-sol", display_name: "native", description: "native", priority: 1, visibility: "list" },
    { slug: "ark/glm-5.3", display_name: "routed", description: "Routed via opencodex → ark/glm-5.3 (ark).", priority: 5, visibility: "list" },
  ] });
  writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n');
  writeFileSync(join(codexHome, "catalog.json"), catalog);
  writeFileSync(join(codexHome, "models_cache.json"), "cache-before");
  writeFileSync(join(ownHome, "config.json"), JSON.stringify({ providers: {} })); bind(otherHome);
  const result = run(`const {syncCatalogModels}=require("./src/codex/catalog");
    console.log(JSON.stringify(await syncCatalogModels({providers:{}})));`);
  expect(result).toMatchObject({ catalogWritten: false, refreshOutcome: "refused", skippedReason: "foreign_owner" });
  expect(readFileSync(join(codexHome, "catalog.json"), "utf8")).toBe(catalog);
  expect(readFileSync(join(codexHome, "models_cache.json"), "utf8")).toBe("cache-before");
});
