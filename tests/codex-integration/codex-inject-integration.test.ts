import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  MANAGED_AGENTS_TABLE_MARKER,
  MANAGED_SUBAGENT_DEFAULT_MARKER,
} from "../../src/codex/subagent-defaults";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

setDefaultTimeout(SPAWN_BUDGET_MS);

// Reads back what a TOML consumer would see for a top-level string key. A Windows path
// is stored with escaped separators, so the raw file text never contains the unescaped path.
function readRootTomlString(toml: string, key: string): string | undefined {
  const value = Bun.TOML.parse(toml)[key];
  return typeof value === "string" ? value : undefined;
}

test("catalog readback requires a root string rather than a nested namesake", () => {
  const key = "model_catalog_json";
  const catalog = String.raw`C:\Codex\catalog.json`;
  expect(readRootTomlString(`${key} = ${JSON.stringify(catalog)}\n[profile]\n${key} = "nested"\n`, key)).toBe(catalog);
  expect(readRootTomlString(`[profile]\n${key} = ${JSON.stringify(catalog)}\n`, key)).toBeUndefined();
  expect(readRootTomlString(`[[profiles]]\n${key} = ${JSON.stringify(catalog)}\n`, key)).toBeUndefined();
});

// Full injectCodexConfig runs in a subprocess with isolated CODEX_HOME/OPENCODEX_HOME so
// module-level path constants bind to the temp dirs (same pattern as codex-journal.test.ts).
function runInject(
  codexHome: string,
  ocxHome: string,
  configJson = "{}",
): { stdout: string; stderr: string; status: number } {
  const script = `
    const { injectCodexConfig } = require("./src/codex/inject");
    injectCodexConfig(10100, JSON.parse(process.env.TEST_OCX_CONFIG)).then(r => {
      console.log(JSON.stringify(r));
    });
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, TEST_OCX_CONFIG: configJson },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    status: result.status ?? 1,
  };
}

function runRestore(codexHome: string, ocxHome: string, asyncRestore = false): { stdout: string; status: number } {
  const script = `
    const { restoreNativeCodex, restoreNativeCodexAsync } = require("./src/codex/inject");
    console.log(JSON.stringify(${asyncRestore ? "await restoreNativeCodexAsync()" : "restoreNativeCodex()"}));
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

describe("injectCodexConfig integration (Design B)", () => {
  const DESIGN_B_BLOCK = [
    "# Auto-injected by opencodex",
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    "# Auto-injected by opencodex",
    'experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"',
  ].join("\n");
  let codexHome: string;
  let ocxHome: string;

  beforeEach(() => {
    codexHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-inject-codex-")));
    ocxHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-inject-home-")));
  });

  afterEach(() => {
    removeTreeWithRetry(codexHome);
    removeTreeWithRetry(ocxHome);
  });

  test.each(["sync", "async"])("paginated manifest-owned rows stand down while routing is restored (%s)", (kind) => {
    writeFileSync(join(codexHome, "config.toml"), 'model="test"\n');
    const script = `
      const fs = require("node:fs");
      const { join } = require("node:path");
      const { Database } = require("bun:sqlite");
      const { injectCodexConfig, restoreNativeCodex, restoreNativeCodexAsync } = require("./src/codex/inject");
      const { syncCodexHistoryProvider, historyBackupPathFor } = require("./src/codex/history-provider");
      const { resolveCodexStateDbPath } = require("./src/codex/paths");
      const enabled = await injectCodexConfig(10100, {});
      if (!enabled.success) throw new Error("fixture injection failed");
      // Match the runtime authority: Windows Temp may spell CODEX_HOME with an 8.3 alias,
      // while getCodexHome resolves its long path. Manifest names bind to that path spelling.
      const dbPath = require("./src/codex/paths").resolveCodexStateDbPath();
      const rollout = join(process.env.CODEX_HOME, "manifest-fixture.jsonl");
      fs.appendFileSync(join(process.env.CODEX_HOME,"config.toml"), [
        "# Auto-injected by opencodex",
        "[model_providers.opencodex]",
        'name="OpenCodex"',
        'base_url="http://127.0.0.1:10100/v1"',
        'wire_api="responses"',
        "",
      ].join(String.fromCharCode(10)));
      fs.writeFileSync(rollout, JSON.stringify({type:"session_meta",payload:{id:"fixture",model_provider:"openai",source:"cli"}})+String.fromCharCode(10));
      const db = new Database(dbPath);
      db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, source TEXT, first_user_message TEXT, has_user_event INTEGER)");
      db.run("INSERT INTO threads VALUES ('fixture', ?, 'openai', 'cli', 'hello', 1)", rollout);
      const routed = syncCodexHistoryProvider("opencodex", dbPath);
      if (routed.failed || routed.rows !== 1) throw new Error("fixture history route failed");
      db.run("ALTER TABLE threads ADD COLUMN history_mode TEXT DEFAULT 'legacy'");
      db.close();
      const backup = historyBackupPathFor(dbPath);
      const entries = Object.keys(JSON.parse(fs.readFileSync(backup,"utf8")).entries).length;
      const defaultEntries = Object.keys(JSON.parse(fs.readFileSync(historyBackupPathFor(resolveCodexStateDbPath()),"utf8")).entries).length;
      const historyPaths = [backup,rollout];
      const beforeHistory = historyPaths.map(p=>fs.readFileSync(p,"utf8"));
      const result = ${kind === "sync" ? "restoreNativeCodex()" : "await restoreNativeCodexAsync()"};
      const restoredDb = new Database(dbPath, { readonly: true });
      const provider = restoredDb.query("SELECT model_provider FROM threads WHERE id='fixture'").get().model_provider;
      restoredDb.close();
      const config = fs.readFileSync(join(process.env.CODEX_HOME,"config.toml"),"utf8");
      console.log(JSON.stringify({entries,defaultEntries,result,provider,config,historyPreserved:historyPaths.every((p,i)=>fs.readFileSync(p,"utf8")===beforeHistory[i])}));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot, env: { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "", OPENCODEX_HOME: ocxHome },
      encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.entries).toBe(1);
    expect(result.defaultEntries).toBe(1);
    expect(result.result.success).toBe(true);
    expect(result.result.historyPreflightRefusal).toBeUndefined();
    expect(result.result.artifacts.config).toMatchObject({
      state: "partial",
      action: "routing-restored-provider-retained",
      retained: { reason: "history_paginated_requires_native_writer" },
    });
    expect(result.result.retainedCodexProviderTable).toEqual(result.result.artifacts.config.retained);
    expect(result.result.retainedCodexProviderTable.followUp).toContain("ocx restore --remove-codex-provider-table");
    expect(result.result.artifacts.history).toMatchObject({ state: "skipped", changed: false, rows: 0, files: 0 });
    expect(result.provider).toBe("opencodex");
    expect(result.config).not.toContain('model_provider = "opencodex"');
    expect(result.config).toContain("[model_providers.opencodex]");
    expect(result.historyPreserved).toBe(true);
  });

  // The denial has to be a real filesystem permission. `inject-coordination.ts`
  // binds `readFileSync` as an ESM named import, so `spyOn(fs, "readFileSync")`
  // on the child's `require("node:fs")` handle never reached it: the mock
  // matched nothing and every assertion below passed through an undenied run.
  // `unreadable` now proves the precondition before anything depends on it.
  // Root reads a mode-0 file regardless, and Windows chmod only toggles the
  // read-only bit, so neither can express the permission this test needs.
  const unreadablePreimages =
    process.platform === "win32" || process.getuid?.() === 0 ? test.skip : test;
  unreadablePreimages("unreadable preimages abort capture and remain visible as compensation failures", () => {
    const script = `
      const fs = require("node:fs");
      const { join } = require("node:path");
      const target = require("./src/codex/paths").CODEX_PROFILE_PATH;
      const configPath = join(process.env.CODEX_HOME,"config.toml");
      fs.writeFileSync(configPath,'model="test"');
      const {injectCodexConfig,restoreNativeCodex,restoreNativeCodexAsync}=require("./src/codex/inject");
      const initial=await injectCodexConfig(10100,{});
      if(!initial.success) throw new Error("fixture injection failed");
      const watched=[configPath,target,join(process.env.CODEX_HOME,"opencodex-journal.json")];
      const original=watched.map(path=>fs.readFileSync(path,"utf8"));
      const deny=()=>fs.chmodSync(target,0o000);
      const allow=()=>fs.chmodSync(target,0o600);
      const readWatched=()=>{allow();const seen=watched.map(path=>fs.readFileSync(path,"utf8"));deny();return seen;};
      deny();
      let unreadable=false;
      try { fs.readFileSync(target,"utf8"); } catch(error) { unreadable=error.code==="EACCES"; }
      const {captureCodexPreImages,restoreCodexPreImages}=require("./src/codex/inject-coordination");
      let captureCode;
      try { captureCodexPreImages(); } catch(error) { captureCode=error.code; }
      const outcomes=[];
      const unchangedAfterEach=[];
      for(const operation of [()=>restoreNativeCodex(),()=>restoreNativeCodexAsync(),()=>injectCodexConfig(10100,{})]) {
        try { outcomes.push((await operation()).success===false); }
        catch(error) { outcomes.push(error.code==="EACCES"); }
        unchangedAfterEach.push(readWatched().every((bytes,i)=>bytes===original[i]));
      }
      const restored=restoreCodexPreImages({config:original[0],profile:original[1],journal:original[2]});
      const preserved=readWatched().every((bytes,i)=>bytes===original[i]);
      allow();
      console.log(JSON.stringify({unreadable,captureCode,restored,outcomes,unchangedAfterEach,preserved}));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot, env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      unreadable: true, captureCode: "EACCES", restored: { complete: false, unrestored: ["profile"] }, outcomes: [true, true, true], unchangedAfterEach: [true, true, true], preserved: true,
    });
  });

  test.each([
    ["before-preflight", false, false],
    ["after-preflight", false, false],
    ["after-config", false, false],
    ["after-artifacts", false, false],
    ["after-config", true, false],
    ["after-config", false, true],
  ] as const)("late pagination preserves an existing provider (%s, coordinated=%s, authless=%s)", (stage, coordinated, authless) => {
    const original = 'model_provider="opencodex"\n[model_providers.opencodex]\nname="OpenCodex"\nbase_url="http://127.0.0.1:10100/v1"\nwire_api="responses"\nrequires_openai_auth=true\n';
    const configPath = join(codexHome, "config.toml");
    const profilePath = join(codexHome, "opencodex.config.toml");
    writeFileSync(configPath, original);
    if (!coordinated) writeFileSync(profilePath, "# original profile\n");
    if (coordinated) {
      writeFileSync(configPath, 'model="test"\n');
      const seed = runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true }));
      expect(seed.status).toBe(0);
      expect(JSON.parse(seed.stdout).success).toBe(true);
    }
    const journalPath = join(codexHome, "opencodex-journal.json");
    const before = [configPath, profilePath, journalPath].map(path => existsSync(path) ? readFileSync(path, "utf8") : null);
    const script = `
      const {Database}=require("bun:sqlite");
      const {join}=require("node:path");
      const {injectCodexConfig,setBeforeHistoryArtifactCommitForTests,setHistoryArtifactStageForTests}=require("./src/codex/inject");
      const migrate=()=>{
        const db=new Database(join(process.env.CODEX_HOME,"state_5.sqlite"));
        db.run("CREATE TABLE threads (rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
        db.run("INSERT INTO threads VALUES (\'fixture\',\'opencodex\',\'paginated\')");
        db.close();
      };
      let kind;
      setBeforeHistoryArtifactCommitForTests(value=>{kind=value;if(${JSON.stringify(stage)}==="before-preflight")migrate();});
      setHistoryArtifactStageForTests(value=>{if(value===${JSON.stringify(stage)})migrate();});
      const readState=${coordinated ? 'require("./src/codex/transition-state").readCodexTransitionState' : "()=>null"};
      const before=readState();
      const result=await injectCodexConfig(10100,{codexDesktopAuthless:${authless}});
      console.log(JSON.stringify({kind,result,before,after:readState()}));
    `;
    const child=spawnSync(process.execPath,["--eval",script],{cwd:repoRoot,env:{...process.env,CODEX_HOME:codexHome,OPENCODEX_HOME:ocxHome},encoding:"utf8",timeout:SPAWN_BUDGET_MS-5000});
    expect(child.status, child.stderr).toBe(0);
    const value = JSON.parse(child.stdout);
    expect(value.kind, child.stdout).toBe(coordinated ? "coordinated" : "legacy-uncoordinated");
    expect(value.result).toMatchObject({success:true,historyPreflightFailureReason:"history_paginated_requires_native_writer"});
    const config = Bun.TOML.parse(readFileSync(configPath,"utf8")) as any;
    expect(config.model_provider).toBe(authless ? "opencodex" : undefined);
    expect(config.model_providers.opencodex.base_url).toBe("http://127.0.0.1:10100/v1");
    expect(readFileSync(profilePath,"utf8")).not.toBe(before[1]);
    if (coordinated) expect(value.after).not.toEqual(value.before);
    const db = new Database(join(codexHome, "state_5.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT model_provider FROM threads").get()).toEqual({model_provider:"opencodex"});
    } finally { db.close(); }
  });

  test.each([false, true])("pagination after artifact commit keeps the existing provider (coordinated=%s)", coordinated => {
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, coordinated ? 'model="test"\n' : DESIGN_B_BLOCK + "\n");
    if (coordinated) {
      const seed = runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true }));
      expect(seed.status, seed.stderr).toBe(0);
      expect(JSON.parse(seed.stdout).success).toBe(true);
    } else {
      writeFileSync(configPath, 'model_provider="opencodex"\n[model_providers.opencodex]\nname="OpenCodex"\nbase_url="http://127.0.0.1:10100/v1"\nwire_api="responses"\n');
      writeFileSync(join(codexHome, "opencodex.config.toml"), "# legacy profile\n");
    }
    const script = `
      const {Database}=require("bun:sqlite");
      const {join}=require("node:path");
      const {injectCodexConfig,setHistoryArtifactStageForTests}=require("./src/codex/inject");
      let migrated=false;
      setHistoryArtifactStageForTests(stage=>{
        if(stage!=="before-history-worker") return;
        const db=new Database(join(process.env.CODEX_HOME,"state_5.sqlite"));
        db.run("CREATE TABLE threads (rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
        db.run("INSERT INTO threads VALUES ('fixture','opencodex','paginated')");
        db.close();migrated=true;
      });
      const result=await injectCodexConfig(10100,{});
      console.log(JSON.stringify({migrated,result}));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot, env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const value = JSON.parse(child.stdout);
    expect(value.migrated).toBe(true);
    const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.model_providers?.opencodex?.base_url).toBe("http://127.0.0.1:10100/v1");
    expect(value.result.success).toBe(true);
    const db = new Database(join(codexHome, "state_5.sqlite"), { readonly: true });
    try { expect(db.query("SELECT model_provider FROM threads").get()).toEqual({ model_provider: "opencodex" }); }
    finally { db.close(); }
  });

  for (const stage of ["before-preflight", "after-preflight", "after-config", "after-artifacts"]) {
  test.each([false,true])(`a store that migrates mid-transaction retires the relabel unit and keeps the config (${stage}, legacy=%s)`,(legacy)=>{
    const original=legacy ? DESIGN_B_BLOCK+"\n" : 'model="test"\n';
    writeFileSync(join(codexHome,"config.toml"),original);
    if(legacy) writeFileSync(join(codexHome,"opencodex.config.toml"),"[invalid profile\n");
    const script=`
      const {Database}=require("bun:sqlite");
      const {join}=require("node:path");
      const {injectCodexConfig,setBeforeHistoryArtifactCommitForTests,setHistoryArtifactStageForTests}=require("./src/codex/inject");
      let kind;
      const migrate=()=>{
        const db=new Database(join(process.env.CODEX_HOME,"state_5.sqlite"));
        db.run("CREATE TABLE threads (rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
        db.run("INSERT INTO threads VALUES ('fixture','opencodex','paginated')");
        db.close();
      };
      setBeforeHistoryArtifactCommitForTests(value=>{
        kind=value;
        if (${JSON.stringify(stage)} === "before-preflight") migrate();
      });
      setHistoryArtifactStageForTests(value=>{if(value===${JSON.stringify(stage)})migrate();});
      const result=await injectCodexConfig(10100,{});
      console.log(JSON.stringify({kind,result}));
    `;
    const child=spawnSync(process.execPath,["--eval",script],{cwd:repoRoot,env:{...process.env,CODEX_HOME:codexHome,OPENCODEX_HOME:ocxHome},encoding:"utf8",timeout:SPAWN_BUDGET_MS-5000});
    expect(child.status).toBe(0);
    const value=JSON.parse(child.stdout);
    expect(value.kind).toBe(legacy?"legacy-uncoordinated":"coordinated");
    // A migration observed at ANY point in the transaction stands the relabel unit down and
    // says so. With no prior provider table to retire, it need not roll the config back:
    // rolling it back is what left every paginated home with no OpenCodex models at all.
    expect(value.result).toMatchObject({success:true,historyPreflightFailureReason:"history_paginated_requires_native_writer"});
    expect(value.result.message).toContain("left to Codex's native writer");
    // The profile is replaced inside the artifact transaction, so a profile that is no longer
    // the fixture's is proof the config half ran to completion instead of compensating away.
    const profileAfter=readFileSync(join(codexHome,"opencodex.config.toml"),"utf8");
    expect(profileAfter).not.toBe("[invalid profile\n");
    expect(profileAfter.length).toBeGreaterThan(0);
    expect(readFileSync(join(codexHome,"config.toml"),"utf8")).toContain("127.0.0.1:10100");
  });
  }

  test.each(["sync", "legacy-uncoordinated", "coordinated"])("config restore failure aborts every later artifact (%s)", (kind) => {
    const original = kind === "coordinated" ? 'model="test"\n' : DESIGN_B_BLOCK + "\n";
    writeFileSync(join(codexHome, "config.toml"), original);
    if (kind !== "coordinated") writeFileSync(join(codexHome, "opencodex.config.toml"), "[invalid profile\n");
    const catalog = '{"models":[],"sentinel":"preserve"}\n';
    writeFileSync(join(codexHome, "models_cache.json"), catalog);
    const script = `
      const fs=require("node:fs");
      const {Database}=require("bun:sqlite");
      const {join}=require("node:path");
      const {restoreNativeCodex,restoreNativeCodexAsync,setBeforeRestoreConfigForTests}=require("./src/codex/inject");
      const readState=${kind === "coordinated" ? 'require("./src/codex/transition-state").readCodexTransitionState' : "()=>null"};
      const before=readState();
      let observed;
      setBeforeRestoreConfigForTests(value=>{
        observed=value;
        const rollout=join(process.env.CODEX_HOME,"invalid-rollout.jsonl");
        fs.writeFileSync(rollout,"not-json\\n");
        const db=new Database(join(process.env.CODEX_HOME,"state_5.sqlite"));
        db.run("CREATE TABLE threads (rollout_path TEXT, model_provider TEXT)");
        db.run("INSERT INTO threads VALUES (?, 'opencodex')",rollout);
        db.close();
      });
      const result=${kind === "sync" ? "restoreNativeCodex()" : "await restoreNativeCodexAsync()"};
      console.log(JSON.stringify({observed,result,before,after:readState()}));
    `;
    const child=spawnSync(process.execPath,["--eval",script],{cwd:repoRoot,env:{...process.env,CODEX_HOME:codexHome,OPENCODEX_HOME:ocxHome},encoding:"utf8",timeout:SPAWN_BUDGET_MS-5000});
    expect(child.status).toBe(0);
    const value=JSON.parse(child.stdout);
    expect(value.observed).toBe(kind);
    expect(value.result.success).toBe(false);
    if(kind==="coordinated") {
      // Never advance durable generation/tx state when config restoration fails.
      expect(value.before.state).toMatchObject({nativeGeneration:0,currentTxId:null});
      expect(value.after.state).toEqual(value.before.state);
    }
    expect(value.result.artifacts.config).toMatchObject({state:"failed",changed:false});
    for (const artifact of [value.result.artifacts.catalog, value.result.artifacts.history]) {
      expect(artifact).toMatchObject({state:"skipped",changed:false});
    }
    expect(readFileSync(join(codexHome,"config.toml"),"utf8")).toBe(original);
    expect(readFileSync(join(codexHome,"models_cache.json"),"utf8")).toBe(catalog);
    expect(existsSync(join(codexHome,"opencodex-journal.json"))).toBe(false);
    if(kind!=="coordinated") expect(readFileSync(join(codexHome,"opencodex.config.toml"),"utf8")).toBe("[invalid profile\n");
    else expect(existsSync(join(codexHome,"opencodex.config.toml"))).toBe(false);
  });

  for (const path of ["journal", "fallback"]) {
    test.each([
      ["sync", "schema"], ["legacy-uncoordinated", "schema"], ["coordinated", "schema"],
      ["sync", "ordinal"], ["coordinated", "none"],
    ])(`history format at successful ${path} restore commit (%s, %s)`, (kind, migration) => {
      const script = `
        const fs = require("node:fs");
        const { join } = require("node:path");
        const { Database } = require("bun:sqlite");
        const { spyOn } = require("bun:test");
        let onUnlink;
        const realUnlink = fs.unlinkSync;
        spyOn(fs, "unlinkSync").mockImplementation((p, ...args) => {
          const result = realUnlink(p, ...args);
          onUnlink?.(p);
          return result;
        });
        const { restoreNativeCodex, restoreNativeCodexAsync, setBeforeRestoreConfigForTests } = require("./src/codex/inject");
        const { writeJournal, markJournalInjectedState } = require("./src/codex/journal");
        const { syncCodexHistoryProvider, historyBackupPathFor } = require("./src/codex/history-provider");
        // Use the same canonical home as the writer (Windows TEMP may use an 8.3 alias).
        const home = require("./src/codex/paths").CODEX_HOME;
        const configPath = join(home, "config.toml");
        const profilePath = join(home, "opencodex.config.toml");
        const journalPath = join(home, "opencodex-journal.json");
        fs.writeFileSync(configPath, 'model="test"\\n');
        const readState = ${kind === "coordinated" ? 'require("./src/codex/transition-state").readCodexTransitionState' : "() => null"};
        const beforeState = readState();
        if (${JSON.stringify(path)} === "journal") writeJournal();
        const routed = 'model_provider="opencodex"\\n[model_providers.opencodex]\\nname="OpenCodex"\\nbase_url="http://127.0.0.1:10100/v1"\\nwire_api="responses"\\n';
        const profile = ${JSON.stringify(kind === "legacy-uncoordinated" ? "[invalid profile\n" : "# generated profile\n")};
        fs.writeFileSync(configPath, routed);
        fs.writeFileSync(profilePath, profile);
        if (${JSON.stringify(path)} === "journal") markJournalInjectedState(routed, profile, {
          injectedOpenaiBaseUrl: null, injectedRealtimeWsBaseUrl: null, injectedCatalogPath: null,
        });
        const dbPath = join(home, "state_5.sqlite");
        const rollout = join(home, "restore-migration.jsonl");
        fs.writeFileSync(rollout, JSON.stringify({type:"session_meta",payload:{id:"fixture",model_provider:"openai",source:"cli"}})+"\\n");
        const db = new Database(dbPath);
        db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, source TEXT, first_user_message TEXT, has_user_event INTEGER)");
        db.run("INSERT INTO threads VALUES ('fixture', ?, 'openai', 'cli', 'hello', 1)", rollout);
        db.close();
        const routedHistory = syncCodexHistoryProvider("opencodex", dbPath);
        if (routedHistory.failed || routedHistory.rows !== 1) throw new Error("fixture history route failed");
        fs.writeFileSync(join(home, "models_cache.json"), '{"models":[],"sentinel":"preserve"}\\n');
        fs.writeFileSync(join(home, "config.toml.bak"), "legacy backup sentinel\\n");
        const read = p => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
        const watched = [configPath, profilePath, journalPath, join(home,"models_cache.json"), join(home,"config.toml.bak"), historyBackupPathFor(dbPath), rollout];
        const before = watched.map(read);
        const target = ${JSON.stringify(path)} === "journal" ? journalPath : profilePath;
        let observed;
        let migrations = 0;
        let reachedSuccessfulWrite = false;
        setBeforeRestoreConfigForTests(value => {
          observed = value;
          onUnlink = p => {
            if (String(p) === target && migrations++ === 0) {
              reachedSuccessfulWrite = !fs.existsSync(target) && read(configPath) !== before[0];
              if (${JSON.stringify(migration)} === "schema") {
                const migrated = new Database(dbPath);
                migrated.run("ALTER TABLE threads ADD COLUMN history_mode TEXT DEFAULT 'legacy'");
                migrated.close();
              } else if (${JSON.stringify(migration)} === "ordinal") {
                const lines = read(rollout).split("\\n");
                lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), ordinal: 0 });
                fs.writeFileSync(rollout, lines.join("\\n"));
                // The simulated native writer owns these new rollout bytes.
                before[before.length - 1] = read(rollout);
              }
            }
          };
        });
        const result = ${kind === "sync" ? "restoreNativeCodex()" : "await restoreNativeCodexAsync()"};
        const after = watched.map(read);
        const afterState = readState();
        const historyDb = new Database(dbPath, {readonly:true});
        const provider = historyDb.query("SELECT model_provider FROM threads WHERE id='fixture'").get().model_provider;
        historyDb.close();
        console.log(JSON.stringify({observed, migrations, reachedSuccessfulWrite, result, before, after, beforeState, afterState, provider}));
      `;
      const child = spawnSync(process.execPath, ["--eval", script], {
        cwd: repoRoot, env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
        encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      });
      expect(child.status, child.stderr).toBe(0);
      const value = JSON.parse(child.stdout);
      expect(value.observed).toBe(kind);
      expect(value.migrations, JSON.stringify(value.result)).toBe(1);
      expect(value.reachedSuccessfulWrite).toBe(true);
      if (migration === "none") {
        expect(value.result.success).toBe(true);
        expect([
          path === "journal" ? "journal-restored" : "owned-fields-stripped",
          "routing-restored-provider-retained",
        ]).toContain(value.result.artifacts.config.action);
        expect(value.result.artifacts.history).toMatchObject({state:"ok",rows:1});
        expect(value.provider).toBe("openai");
        expect(value.after[1]).toBeNull();
        expect(value.after[2]).toBeNull();
        expect(value.after[3]).toBe(value.before[3]);
        expect(value.after[4]).toBe(value.before[4]);
        expect(value.afterState.state).toMatchObject({nativeGeneration:1,history:{status:"converged"},historySchedule:{direction:"remove"}});
        return;
      }
      expect(value.result.success).toBe(true);
      expect(value.result.historyPreflightRefusal).toBeUndefined();
      expect(value.result.artifacts.config).toMatchObject({
        state: "partial",
        changed: true,
        action: "routing-restored-provider-retained",
        retained: { reason: "history_paginated_requires_native_writer" },
      });
      expect(value.result.retainedCodexProviderTable).toEqual(value.result.artifacts.config.retained);
      expect(value.result.artifacts.history).toMatchObject({ state: "skipped", changed: false });
      expect(value.provider).toBe("opencodex");
      expect(value.after[0]).not.toContain('model_provider="opencodex"');
      expect(value.after[0]).toContain("[model_providers.opencodex]");
      expect(value.after[5]).toBe(value.before[5]);
      expect(value.after[6]).toBe(value.before[6]);
    });
  }

  test.each([false, true])("a paginated home still gets its config written, and keeps the provider table its rows need (authless=%s)", (authless) => {
    const original = 'model_provider = "opencodex"\n[model_providers.opencodex]\nname="OpenCodex"\nbase_url="http://127.0.0.1:10100/v1"\nwire_api="responses"\n';
    const configPath = join(codexHome, "config.toml");
    const profilePath = join(codexHome, "opencodex.config.toml");
    writeFileSync(configPath, original);
    writeFileSync(profilePath, "# preserve profile\n");
    const rollout = join(codexHome, "fixture.jsonl");
    const bytes = JSON.stringify({ordinal:0,type:"session_meta",payload:{id:"fixture",history_mode:"paginated",model_provider:"opencodex"}}) + "\n";
    writeFileSync(rollout, bytes);
    const db = new Database(join(codexHome, "state_5.sqlite"));
    db.run("CREATE TABLE threads (id TEXT, rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
    db.run("INSERT INTO threads VALUES ('fixture', ?, 'opencodex', 'paginated')", rollout);
    db.close();
    // Apply: the config transitions and the relabel unit stands down by name. The rollout is
    // the thing that must not move, because its ordinals belong to Codex's own writer.
    const result = runInject(codexHome, ocxHome, JSON.stringify({codexDesktopAuthless:authless}));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      historyPreflightFailureReason: "history_paginated_requires_native_writer",
    });
    expect(result.stdout).toContain("left to Codex's native writer");
    expect(readFileSync(rollout,"utf8")).toBe(bytes);
    // The profile is replaced inside the artifact transaction; no longer holding the fixture
    // sentinel is proof the config half committed rather than being compensated away.
    expect(readFileSync(profilePath,"utf8")).not.toBe("# preserve profile\n");
    // The relabel stood down, so the rows still say `opencodex`. Retiring the table that
    // publishes that provider id would leave those conversations pointing at nothing, so a
    // table this home already had survives the write even in the root-override form.
    expect(readFileSync(configPath,"utf8")).toContain("[model_providers.opencodex]");

    // Routing can come out without rewriting these rows. The table remains as thread-resolution
    // state, and each entry point reports the degraded result as a successful partial restore.
    const restoreScript = `
      const { restoreNativeCodex, restoreNativeCodexAsync, removeCodexConfig } = require("./src/codex/inject");
      const results = [restoreNativeCodex(), await restoreNativeCodexAsync(), removeCodexConfig({ historyDisposition: "stand-down-retain" })];
      console.log(JSON.stringify(results));
    `;
    const restored = spawnSync(process.execPath, ["--eval", restoreScript], {
      cwd: repoRoot, env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(restored.status).toBe(0);
    const outcomes = JSON.parse(restored.stdout);
    for (const outcome of outcomes) expect(outcome.success).toBe(true);
    for (const outcome of outcomes.slice(0, 2)) {
      expect(outcome.historyPreflightRefusal).toBeUndefined();
      expect(outcome.artifacts.config).toMatchObject({
        state: "partial",
        action: "routing-restored-provider-retained",
        retained: { reason: "history_paginated_requires_native_writer" },
      });
      expect(outcome.artifacts.history).toMatchObject({ state: "skipped", changed: false });
    }
    const restoredConfig = readFileSync(configPath,"utf8");
    expect(restoredConfig).not.toContain('model_provider = "opencodex"');
    expect(restoredConfig).toContain("[model_providers.opencodex]");
    expect(readFileSync(rollout,"utf8")).toBe(bytes);
  });

  test.each([
    ["sync", false],
    ["async", false],
    ["sync", true],
    ["async", true],
  ] as const)("paginated %s restore removes every root route and honors removeProviderTable=%s", (kind, removeProviderTable) => {
    const configPath = join(codexHome, "config.toml");
    const profilePath = join(codexHome, "opencodex.config.toml");
    const catalogPath = join(codexHome, "opencodex-catalog.json");
    const rolloutPath = join(codexHome, "paginated-contract.jsonl");
    const dbPath = join(codexHome, "state_5.sqlite");
    const providerBlock = [
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.opencodex.env_http_headers]",
      '"x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN"',
    ];
    writeFileSync(configPath, [
      'user_owned = "keep-me"',
      'model_provider = "opencodex"',
      "# Auto-injected by opencodex",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "# Auto-injected by opencodex",
      'experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"',
      'model = "vendor/routed-model"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      "",
      "[profiles.opencodex]",
      'model_provider = "opencodex"',
      "",
      ...providerBlock,
      "",
      "[user_table]",
      'value = "preserve"',
      "",
    ].join("\n"));
    writeFileSync(profilePath, "# generated profile\n");
    writeFileSync(catalogPath, '{"models":[]}\n');
    const rolloutBytes = JSON.stringify({
      ordinal: 0,
      type: "session_meta",
      payload: { id: "paginated-contract", history_mode: "paginated", model_provider: "opencodex" },
    }) + "\n";
    writeFileSync(rolloutPath, rolloutBytes);
    const db = new Database(dbPath);
    db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, history_mode TEXT, user_note TEXT)");
    db.run("INSERT INTO threads VALUES ('paginated-contract', ?, 'opencodex', 'paginated', 'preserve-me')", rolloutPath);
    db.close();
    const beforeRow = new Database(dbPath, { readonly: true });
    const rowBytes = JSON.stringify(beforeRow.query("SELECT * FROM threads WHERE id='paginated-contract'").get());
    beforeRow.close();

    const script = `
      const { restoreNativeCodex, restoreNativeCodexAsync } = require("./src/codex/inject");
      const options = { removeProviderTable: ${JSON.stringify(removeProviderTable)} };
      const result = ${kind === "sync" ? "restoreNativeCodex(options)" : "await restoreNativeCodexAsync(options)"};
      console.log(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    const restored = readFileSync(configPath, "utf8");
    const root = Bun.TOML.parse(restored);
    const afterRow = new Database(dbPath, { readonly: true });
    const restoredRowBytes = JSON.stringify(afterRow.query("SELECT * FROM threads WHERE id='paginated-contract'").get());
    afterRow.close();

    expect(result.success).toBe(true);
    expect(result.historyPreflightRefusal).toBeUndefined();
    expect(result.artifacts.history).toMatchObject({ state: "skipped", changed: false, rows: 0, files: 0 });
    expect(root.user_owned).toBe("keep-me");
    expect(root.user_table).toEqual({ value: "preserve" });
    expect(root.model_provider).toBeUndefined();
    expect(root.openai_base_url).toBeUndefined();
    expect(root.experimental_realtime_ws_base_url).toBeUndefined();
    expect(root.model).toBeUndefined();
    expect(root.model_catalog_json).toBeUndefined();
    expect(restored).not.toContain("[profiles.opencodex]");
    expect(existsSync(profilePath)).toBe(false);
    expect(readFileSync(rolloutPath, "utf8")).toBe(rolloutBytes);
    expect(restoredRowBytes).toBe(rowBytes);
    // Upstream rejects the whole config when this root id has no matching table. Every
    // output, including explicit full removal, must avoid that catastrophic combination.
    expect(root.model_provider === "opencodex" && !restored.includes("[model_providers.opencodex]")).toBe(false);
    if (removeProviderTable) {
      expect(result.retainedCodexProviderTable).toBeUndefined();
      expect(result.artifacts.config.state).toBe("ok");
      expect(restored).not.toContain("[model_providers.opencodex]");
    } else {
      expect(result.artifacts.config).toMatchObject({
        state: "partial",
        action: "routing-restored-provider-retained",
        retained: { reason: "history_paginated_requires_native_writer", lines: providerBlock },
      });
      expect(result.retainedCodexProviderTable).toEqual(result.artifacts.config.retained);
      expect(result.retainedCodexProviderTable.followUp).toContain("ocx restore --remove-codex-provider-table");
      expect(restored).toContain(providerBlock.join("\n"));
    }
  });

  test("restore, stop teardown, and uninstall restore are idempotent on a paginated home", () => {
    const configPath = join(codexHome, "config.toml");
    const rolloutPath = join(codexHome, "paginated-idempotent.jsonl");
    const dbPath = join(codexHome, "state_5.sqlite");
    writeFileSync(configPath, [
      'user_owned = "survives-every-pass"',
      'model_provider = "opencodex"',
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"));
    const rolloutBytes = JSON.stringify({
      ordinal: 0,
      type: "session_meta",
      payload: { id: "paginated-idempotent", history_mode: "paginated", model_provider: "opencodex" },
    }) + "\n";
    writeFileSync(rolloutPath, rolloutBytes);
    const db = new Database(dbPath);
    db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, history_mode TEXT, user_note TEXT)");
    db.run("INSERT INTO threads VALUES ('paginated-idempotent', ?, 'opencodex', 'paginated', 'unchanged')", rolloutPath);
    db.close();
    const before = new Database(dbPath, { readonly: true });
    const rowBytes = JSON.stringify(before.query("SELECT * FROM threads WHERE id='paginated-idempotent'").get());
    before.close();

    const script = `
      const { restoreNativeCodex, restoreNativeCodexAsync } = require("./src/codex/inject");
      const { performStopTeardown } = require("./src/server/stop-teardown");
      const restored = restoreNativeCodex();
      const stopped = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
        restoreNativeCodex: () => restoreNativeCodexAsync(),
        stripGrok: () => ({ ok: true, changed: false, message: "clean" }),
      });
      const uninstalled = await restoreNativeCodexAsync();
      console.log(JSON.stringify({ restored, stopped, uninstalled }));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const outcomes = JSON.parse(child.stdout);
    const finalConfig = readFileSync(configPath, "utf8");
    const after = new Database(dbPath, { readonly: true });
    const restoredRowBytes = JSON.stringify(after.query("SELECT * FROM threads WHERE id='paginated-idempotent'").get());
    after.close();

    expect(outcomes.restored.success).toBe(true);
    expect(outcomes.stopped).toMatchObject({ success: true, sharedTeardown: "performed" });
    expect(outcomes.uninstalled.success).toBe(true);
    expect(finalConfig).toContain('user_owned = "survives-every-pass"');
    expect(finalConfig).not.toContain('model_provider = "opencodex"');
    expect(finalConfig).toContain("[model_providers.opencodex]");
    expect(readFileSync(rolloutPath, "utf8")).toBe(rolloutBytes);
    expect(restoredRowBytes).toBe(rowBytes);
  });

  test("a provider-table transition refuses rather than strand a paginated openai thread", () => {
    const original = 'model_provider = "openai"\n# >>> opencodex managed openai_base_url >>>\nopenai_base_url = "http://127.0.0.1:10100/v1"\n# <<< opencodex managed openai_base_url <<<\n';
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, original);
    const rollout = join(codexHome, "openai-paginated.jsonl");
    const bytes = JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: "fixture", history_mode: "paginated", model_provider: "openai" } }) + "\n";
    writeFileSync(rollout, bytes);
    const db = new Database(join(codexHome, "state_5.sqlite"));
    db.run("CREATE TABLE threads (id TEXT, rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
    db.run("INSERT INTO threads VALUES ('fixture', ?, 'openai', 'paginated')", rollout);
    db.close();

    const result = runInject(codexHome, ocxHome, JSON.stringify({ codexDesktopAuthless: true }));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      historyPreflightFailureReason: "history_paginated_openai_requires_native_writer",
    });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readFileSync(rollout, "utf8")).toBe(bytes);
  });

  test("a paginated home still receives the model catalog path the picker reads", () => {
    // The user-visible regression this pins. A paginated rollout made the injector refuse
    // the whole write, so `model_catalog_json` never reached config.toml: the Codex app and
    // CLI both fell back to their native model list while `ocx sync` still said synchronized.
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.5"\n');
    const catalogPath = join(codexHome, "opencodex-catalog.json");
    writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: "xai/grok-4.6", display_name: "Grok 4.6" }] }));
    const rollout = join(codexHome, "paginated.jsonl");
    const bytes = JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: "paginated", history_mode: "paginated", model_provider: "opencodex" } }) + "\n";
    writeFileSync(rollout, bytes);
    const db = new Database(join(codexHome, "state_5.sqlite"));
    db.run("CREATE TABLE threads (id TEXT, rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
    db.run("INSERT INTO threads VALUES ('paginated', ?, 'opencodex', 'paginated')", rollout);
    db.close();

    const result = runInject(codexHome, ocxHome);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      historyPreflightFailureReason: "history_paginated_requires_native_writer",
    });
    const written = readFileSync(configPath, "utf8");
    expect(written).toContain("model_catalog_json");
    // What the picker reads is the decoded TOML value, not the raw file text. A Windows path
    // is written as a basic string with escaped separators, so asserting on the raw text
    // compared an unescaped path against escaped bytes and failed on Windows only.
    expect(readRootTomlString(written, "model_catalog_json")).toBe(catalogPath);
    expect(readFileSync(rollout, "utf8")).toBe(bytes);
  });

  test("remote target validate-only writes nothing; commit journals client ownership and restores exact preimage", () => {
    const original = '# remote baseline\nmodel_provider = "openai"\n';
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const { injectCodexConfig } = require("./src/codex/inject");
      const { journalOwner, restoreJournalState } = require("./src/codex/journal");
      const target = { baseUrl: "https://hub.example.test/v1", requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" };
      (async () => {
        const configPath = path.join(process.env.CODEX_HOME, "config.toml");
        const journalPath = path.join(process.env.CODEX_HOME, "opencodex-journal.json");
        const before = fs.readFileSync(configPath, "utf8");
        const preflight = await injectCodexConfig(10100, { syncResumeHistory: false }, {
          validateOnly: true, routingTarget: target, catalogPath: null,
          journalOwner: { kind: "client", apiKeyId: "client-key-1" },
        });
        const afterPreflight = fs.readFileSync(configPath, "utf8");
        const journalAfterPreflight = fs.existsSync(journalPath);
        const committed = await injectCodexConfig(10100, { syncResumeHistory: false }, {
          routingTarget: target, catalogPath: null,
          journalOwner: { kind: "client", apiKeyId: "client-key-1" },
        });
        const injected = fs.readFileSync(configPath, "utf8");
        const owner = journalOwner();
        const restored = restoreJournalState();
        console.log(JSON.stringify({ preflight, committed, before, afterPreflight, journalAfterPreflight, injected, owner, restored, final: fs.readFileSync(configPath, "utf8") }));
      })();
    `;
    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout.trim());
    expect(value.preflight.success).toBe(true);
    expect(value.before).toBe(original);
    expect(value.afterPreflight).toBe(original);
    expect(value.journalAfterPreflight).toBe(false);
    expect(value.committed.success).toBe(true);
    expect(value.injected).toContain('base_url = "https://hub.example.test/v1"');
    expect(value.injected).toContain('env_key = "OPENCODEX_API_AUTH_TOKEN"');
    expect(value.owner).toEqual({ kind: "client", apiKeyId: "client-key-1" });
    expect(value.restored.complete).toBe(true);
    expect(value.final).toBe(original);
  });

  test("upgrade path: a legacy-injected config converts to the Design B form in one inject", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "opencodex"',
      'model = "gpt-5.5"',
      "",
      "[features]",
      "fast_mode = true",
      "",
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(config).toContain("# Auto-injected by opencodex");
    expect(config).toContain("[model_providers.opencodex]");
    expect(config).not.toContain('model_provider = "opencodex"');
    expect(config).toContain('model = "gpt-5.5"');
    // Routing, realtime sideband and the retained compatibility provider each have one marker.
    expect(config.match(/Auto-injected by opencodex/g)?.length).toBe(3);
    expect(config).toContain(DESIGN_B_BLOCK);
  });

  test("upgrade path: a non-loopback legacy env_http_headers config converts to env_key (#2073)", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "opencodex"',
      "",
      "# Auto-injected by opencodex",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://192.168.1.50:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      'env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }',
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ hostname: "192.168.1.50" }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('env_key = "OPENCODEX_API_AUTH_TOKEN"');
    expect(config).not.toContain("env_http_headers");
    // Still exactly one provider block, no duplicate accumulation.
    expect(config.match(/\[model_providers\.opencodex]/g)?.length).toBe(1);
  });

  test("re-inject over a Design B config is idempotent", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const first = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const second = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(second.match(/openai_base_url/g)?.length).toBe(1);
    expect(second.match(/Auto-injected by opencodex/g)?.length).toBe(2);
    expect(second).toBe(first);
    // Voice sideband override rides along with the routing override (#35830 regression).
    expect(second.match(/experimental_realtime_ws_base_url/g)?.length).toBe(1);
    expect(second).toContain('experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"');
  });

  describe("realtime sideband override (openai/codex #35830 regression)", () => {
    const proxyUrl = "http://127.0.0.1:10100/v1";

    test("inject writes it under the marker block, journals it, and restore removes both keys", () => {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
      expect(runInject(codexHome, ocxHome).status).toBe(0);
      const config = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(config).toContain(DESIGN_B_BLOCK);
      const journal = JSON.parse(readFileSync(join(codexHome, "opencodex-journal.json"), "utf8"));
      expect(journal.injectedOpenaiBaseUrl).toBe(proxyUrl);
      expect(journal.injectedRealtimeWsBaseUrl).toBe(proxyUrl);

      expect(runRestore(codexHome, ocxHome).status).toBe(0);
      const restored = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(restored).not.toContain("openai_base_url");
      expect(restored).not.toContain("experimental_realtime_ws_base_url");
      expect(restored).toContain('model = "gpt-5.5"');
    });

    test("a user-owned override survives injection and restore, even when it equals the proxy URL", () => {
      const original = [
        `experimental_realtime_ws_base_url = "${proxyUrl}"`,
        'model = "gpt-5.5"',
        "",
      ].join("\n");
      writeFileSync(join(codexHome, "config.toml"), original, "utf8");
      expect(runInject(codexHome, ocxHome).status).toBe(0);
      const config = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(config).toContain(`openai_base_url = "${proxyUrl}"`);
      expect(config.match(/experimental_realtime_ws_base_url/g)?.length).toBe(1);
      const journal = JSON.parse(readFileSync(join(codexHome, "opencodex-journal.json"), "utf8"));
      expect(journal.injectedOpenaiBaseUrl).toBe(proxyUrl);
      expect(journal.injectedRealtimeWsBaseUrl).toBeNull();

      // Simulate the Codex app reserializing config.toml (values kept, comments dropped) so
      // restore has to rely on journaled value evidence: the routing URL is ours, the
      // realtime override is not, even though the two strings are identical.
      const rewritten = readFileSync(join(codexHome, "config.toml"), "utf8")
        .split("\n").filter(line => !line.startsWith("#")).join("\n");
      writeFileSync(join(codexHome, "config.toml"), rewritten, "utf8");
      expect(runRestore(codexHome, ocxHome).status).toBe(0);
      const restored = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(restored).not.toContain("openai_base_url");
      expect(restored).toContain(`experimental_realtime_ws_base_url = "${proxyUrl}"`);
    });

    test("an app-reserialized routed config is not mistaken for the user's native baseline on re-inject", () => {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
      expect(runInject(codexHome, ocxHome).status).toBe(0);
      const journalPath = join(codexHome, "opencodex-journal.json");
      const firstSnapshot = JSON.parse(readFileSync(journalPath, "utf8")).originalConfig;

      const rewritten = readFileSync(join(codexHome, "config.toml"), "utf8")
        .split("\n").filter(line => !line.startsWith("#")).join("\n");
      writeFileSync(join(codexHome, "config.toml"), rewritten, "utf8");
      expect(runInject(codexHome, ocxHome).status).toBe(0);
      expect(JSON.parse(readFileSync(journalPath, "utf8")).originalConfig).toBe(firstSnapshot);
      const config = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(config.match(/openai_base_url/g)?.length).toBe(1);
      expect(config.match(/experimental_realtime_ws_base_url/g)?.length).toBe(1);

      expect(runRestore(codexHome, ocxHome).status).toBe(0);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe('model = "gpt-5.5"\n');
    });

    test("a user-owned openai_base_url means no realtime override is injected either", () => {
      const original = 'openai_base_url = "https://my-own-gateway.example/v1"\nmodel = "gpt-5.5"\n';
      writeFileSync(join(codexHome, "config.toml"), original, "utf8");
      expect(runInject(codexHome, ocxHome).status).toBe(0);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain("experimental_realtime_ws_base_url");
    });

    test("provider-table forms (non-loopback admission, authless Desktop) do not write it", () => {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
      expect(runInject(codexHome, ocxHome, JSON.stringify({ hostname: "192.168.1.20" })).status).toBe(0);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain("experimental_realtime_ws_base_url");
      expect(runRestore(codexHome, ocxHome).status).toBe(0);

      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
      expect(runInject(codexHome, ocxHome, JSON.stringify({ codexDesktopAuthless: true })).status).toBe(0);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain("experimental_realtime_ws_base_url");
    });

    test("an app-reserialized Design B config switching to a provider-table form drops our root URLs", () => {
      // Comment-dropping rewrite, then the operator turns on authless Desktop (provider-table
      // form). Our old root URLs must not survive as if the user had written them.
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
      expect(runInject(codexHome, ocxHome).status).toBe(0);
      const rewritten = readFileSync(join(codexHome, "config.toml"), "utf8")
        .split("\n").filter(line => !line.startsWith("#")).join("\n");
      writeFileSync(join(codexHome, "config.toml"), rewritten, "utf8");

      expect(runInject(codexHome, ocxHome, JSON.stringify({ codexDesktopAuthless: true })).status).toBe(0);
      const table = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(table).toContain("requires_openai_auth = false");
      expect(table).not.toContain("openai_base_url");
      expect(table).not.toContain("experimental_realtime_ws_base_url");

      expect(runRestore(codexHome, ocxHome).status).toBe(0);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe('model = "gpt-5.5"\n');
    });

    test("CRLF config: re-inject keeps both keys single and CRLF-pure; restore removes both", () => {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\r\n\r\n[features]\r\nfast_mode = true\r\n', "utf8");
      expect(runInject(codexHome, ocxHome).status).toBe(0);
      expect(runInject(codexHome, ocxHome).status).toBe(0);
      const config = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(config).not.toContain("\n\n\n");
      expect(config.match(/openai_base_url/g)?.length).toBe(1);
      expect(config.match(/experimental_realtime_ws_base_url/g)?.length).toBe(1);
      expect(config.match(/Auto-injected by opencodex/g)?.length).toBe(2);
      expect(config).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
      expect(config).toContain('experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"');
      expect(config.includes("\r\n")).toBe(true);
      expect(config.replace(/\r\n/g, "").includes("\n")).toBe(false);

      expect(runRestore(codexHome, ocxHome).status).toBe(0);
      const restored = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(restored).not.toContain("openai_base_url");
      expect(restored).not.toContain("experimental_realtime_ws_base_url");
      expect(restored).toContain("fast_mode = true");
    });
  });

  test.each([
    'model_catalog_json = "custom-catalog.json" # user catalog',
    '"model_catalog_json" = "custom-catalog.json" # user catalog',
  ])(
    "preserves a commented user catalog assignment without duplicating it: %s",
    (assignment) => {
      writeFileSync(join(codexHome, "config.toml"), [
        assignment,
        "",
        "[features]",
        "fast_mode = true",
        "",
      ].join("\n"), "utf8");

      const result = runInject(codexHome, ocxHome);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).success).toBe(true);

      const config = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(
        config.match(/^(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=/gm)?.length,
      ).toBe(1);
      expect(config).toContain(assignment);
      expect(() => Bun.TOML.parse(config)).not.toThrow();

      const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
      expect(profile).toContain('model_catalog_json = "custom-catalog.json"');
    },
  );

  test("repairs an owned duplicate without replacing a commented user catalog", () => {
    const userAssignment = 'model_catalog_json = "custom-catalog.json" # user catalog';
    writeFileSync(join(codexHome, "config.toml"), [
      userAssignment,
      'model_catalog_json = "opencodex-catalog.json"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"), "utf8");

    const result = runInject(codexHome, ocxHome);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config.match(/^model_catalog_json\s*=/gm)?.length).toBe(1);
    expect(config).toContain(userAssignment);
    expect(config).not.toContain('model_catalog_json = "opencodex-catalog.json"');
    expect(() => Bun.TOML.parse(config)).not.toThrow();

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).toContain('model_catalog_json = "custom-catalog.json"');
  });

  test("removes a stale OpenCodex catalog assignment with a trailing comment", () => {
    writeFileSync(
      join(codexHome, "config.toml"),
      'model_catalog_json = "opencodex-catalog.json" # stale catalog\n',
      "utf8",
    );

    const result = runInject(codexHome, ocxHome);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).not.toContain("model_catalog_json");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
  });

  test("does not strip a catalog-shaped assignment from a user table", () => {
    const nestedAssignment = '"model_catalog_json" = "opencodex-catalog.json" # user table value';
    writeFileSync(join(codexHome, "config.toml"), [
      "[user_metadata]",
      nestedAssignment,
      "",
    ].join("\n"), "utf8");

    const result = runInject(codexHome, ocxHome);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain(nestedAssignment);
    expect(() => Bun.TOML.parse(config)).not.toThrow();
  });

  test("fastMode=false forces fast_mode=false in both config and profile", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).toContain("fast_mode = false");
    expect(profile).not.toContain("fast_mode = true");
  });

  test("fastMode=true adds fast_mode=true to a config without a [features] table", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: true }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain("fast_mode = true");

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).toContain("fast_mode = true");
  });

  test("fastMode unset preserves the user's existing fast_mode setting", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n\n[features]\nfast_mode = false\n', "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).not.toContain("fast_mode");
  });

  test("fastMode unset does not add a [features] table to a config that lacks one", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).not.toContain("[features]");
    expect(config).not.toContain("fast_mode");

    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(profile).not.toContain("fast_mode");
  });

  test("fastMode=false updates a commented [features] header without duplicating the table", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      "",
      "[features] # user comment",
      "fast_mode = true",
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(Bun.TOML.parse(config).features.fast_mode).toBe(false);
  });

  test("fastMode=false updates a quoted [\"features\"] header without duplicating the table", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      "",
      '["features"]',
      "fast_mode = true",
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(Bun.TOML.parse(config).features.fast_mode).toBe(false);
  });

  test("fastMode=false updates a quoted \"fast_mode\" key", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      "",
      "[features]",
      '"fast_mode" = true',
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(Bun.TOML.parse(config).features.fast_mode).toBe(false);
  });

  test("opt-in injects native subagent defaults, removes them when disabled, and restores the native config", () => {
    const original = [
      'model = "gpt-5.5"',
      "",
      "[notice]",
      "hide = true",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");
    const enabled = JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    });

    expect(runInject(codexHome, ocxHome, enabled).status).toBe(0);
    const injected = readFileSync(join(codexHome, "config.toml"), "utf8");
    const profile = readFileSync(join(codexHome, "opencodex.config.toml"), "utf8");
    expect(injected).toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(injected).toContain('default_subagent_model = "gpt-5.6-sol"');
    expect(injected).toContain('default_subagent_reasoning_effort = "high"');
    expect(injected).toContain(MANAGED_AGENTS_TABLE_MARKER);
    expect(profile).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(profile).not.toContain("default_subagent_model");

    expect(runInject(codexHome, ocxHome, "{}").status).toBe(0);
    const disabled = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(disabled).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(disabled).not.toContain("default_subagent_model");
    expect(disabled).not.toContain("default_subagent_reasoning_effort");
    expect(disabled).toContain("[notice]\nhide = true");

    expect(runInject(codexHome, ocxHome, enabled).status).toBe(0);
    expect(runRestore(codexHome, ocxHome).status).toBe(0);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("opt-in preserves a user-owned native default pair and reports the conflict", () => {
    const original = [
      'model = "gpt-5.5"',
      "",
      "[agents]",
      'default_subagent_model = "user/model" # owned by user',
      'default_subagent_reasoning_effort = "medium"',
      "max_threads = 6",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const result = runInject(codexHome, ocxHome, JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message).toContain("user-owned agents.default_subagent_model");

    const injected = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(injected).toContain('default_subagent_model = "user/model" # owned by user');
    expect(injected).toContain('default_subagent_reasoning_effort = "medium"');
    expect(injected).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(injected).not.toContain('default_subagent_model = "gpt-5.6-sol"');
  });

  test("sync-disabled injection cleans managed-default residue before journaling and restore", () => {
    const residue = [
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "stale/routed-model"',
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_reasoning_effort = "high"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), residue, "utf8");

    const injectedResult = runInject(codexHome, ocxHome, "{}");
    expect(injectedResult.status).toBe(0);
    expect(JSON.parse(injectedResult.stdout).success).toBe(true);
    const injected = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(injected).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(injected).not.toContain("default_subagent_model");
    expect(() => Bun.TOML.parse(injected)).not.toThrow();

    const restoredResult = runRestore(codexHome, ocxHome);
    expect(restoredResult.status).toBe(0);
    expect(JSON.parse(restoredResult.stdout).success).toBe(true);
    const restored = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(restored).not.toContain(MANAGED_AGENTS_TABLE_MARKER);
    expect(restored).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(restored).not.toContain("default_subagent_model");
    expect(restored).toContain("[features]\nfast_mode = true");
  });

  test("ambiguous managed-default residue refuses injection without changing files", () => {
    const ambiguous = [
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "",
      'default_subagent_model = "stale/routed-model"',
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), ambiguous, "utf8");

    const result = runInject(codexHome, ocxHome, "{}");
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(false);
    expect(payload.message).toContain("injection refused");
    expect(payload.message).toContain("orphaned managed subagent default marker");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(ambiguous);
    expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "opencodex-journal.json"))).toBe(false);
  });

  test("kept-user-base-url: reports routing NOT injected and leaves the user's override alone", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'openai_base_url = "https://my-own-gateway.example/v1"',
      'model = "gpt-5.5"',
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    }));
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).not.toContain("All models now route through opencodex proxy");
    expect(result.nativeSubagentDefaultsWarning).toContain("user-owned root openai_base_url");

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('openai_base_url = "https://my-own-gateway.example/v1"');
    expect(config).not.toContain("# Auto-injected by opencodex\nopenai_base_url");
    expect(config).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(config).not.toContain("default_subagent_model");
  });

  test("external model provider stays byte-for-byte unchanged so its session history remains visible", () => {
    const original = [
      'model_provider = "custom"',
      'model = "third-party-model"',
      "",
      "[model_providers.custom]",
      'name = "Provider Manager"',
      'base_url = "https://gateway.example/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir);
    const profilePath = join(codexHome, "opencodex.config.toml");
    const profile = "sentinel profile\n";
    writeFileSync(profilePath, profile, "utf8");
    const rolloutPath = join(sessionsDir, "rollout-custom.jsonl");
    const rollout = JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-custom", model_provider: "custom", source: "cli", cwd: codexHome },
    }) + "\n";
    writeFileSync(rolloutPath, rollout, "utf8");
    const dbPath = join(codexHome, "state_5.sqlite");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL
    )`);
    db.run(`INSERT INTO threads VALUES ('thread-custom', ?, 'custom', 'cli', 'hello', 1)`, rolloutPath);
    db.close();
    const dbBefore = readFileSync(dbPath);
    const journalPath = join(codexHome, "opencodex-journal.json");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }), "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    }));
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).toContain('external model_provider "custom"');
    expect(result.message).toContain("http://127.0.0.1:10100/v1");
    expect(result.message).toContain("Responses passthrough");
    expect(result.nativeSubagentDefaultsWarning).toContain("external model_provider");

    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(readFileSync(profilePath, "utf8")).toBe(profile);
   expect(readFileSync(dbPath).equals(dbBefore)).toBe(true);
   expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
   expect(existsSync(journalPath)).toBe(false);
 });

  // Regression for #1090: the reporter's Windows shape — CRLF line endings, an external
  // root model_provider, a coexisting [model_providers.opencodex] table, and a [windows]
  // section — must survive injectCodexConfig byte-for-byte. The external-provider guard
  // runs on raw (pre-EOL-normalized) content, so CRLF parsing is part of what this proves.
  test("#1090: CRLF Windows config with external deepseek provider and opencodex table stays byte-for-byte unchanged", () => {
    const original = [
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      "",
      "[model_providers.opencodex]",
      'name = "opencodex"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      'env_key = "CODEX_DEEPSEEK_API_KEY"',
      "",
      "[windows]",
      'sandbox = "unelevated"',
      "",
    ].join("\r\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).toContain('external model_provider "deepseek"');

    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test.each([false,true])("restore removes a stale journal without changing external provider state (async=%s)", (asyncRestore) => {
    const configPath = join(codexHome, "config.toml");
    const config = 'model_provider = "custom"\nmodel = "third-party-model"\n';
    writeFileSync(configPath, config, "utf8");
    const profilePath = join(codexHome, "opencodex.config.toml");
    const profile = 'model_provider = "custom"\n';
    writeFileSync(profilePath, profile, "utf8");

    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir);
    const rolloutPath = join(sessionsDir, "rollout-custom.jsonl");
    const rollout = JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-custom", model_provider: "custom", source: "cli", cwd: codexHome },
    }) + "\n";
    writeFileSync(rolloutPath, rollout, "utf8");
    const dbPath = join(codexHome, "state_5.sqlite");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL
    )`);
      db.run(`INSERT INTO threads VALUES ('thread-custom', ?, 'custom', 'cli', 'hello', 1)`, rolloutPath);
      db.run("ALTER TABLE threads ADD COLUMN history_mode TEXT DEFAULT 'legacy'");
      db.run("INSERT INTO threads VALUES ('old-routed', ?, 'opencodex', 'cli', 'older', 1, 'paginated')", rolloutPath);
    db.close();
    const dbBefore = readFileSync(dbPath);

    const journalPath = join(codexHome, "opencodex-journal.json");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }), "utf8");

      const r = runRestore(codexHome, ocxHome, asyncRestore);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain('External Codex provider "custom" preserved');
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(readFileSync(profilePath, "utf8")).toBe(profile);
    expect(readFileSync(dbPath).equals(dbBefore)).toBe(true);
    expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("provider selected through a legacy root profile is also preserved", () => {
    const original = [
      'profile = "work"',
      'model_provider = "openai"',
      "",
      "[profiles.work]",
      'model_provider = "custom"',
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(codexHome, ocxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).message).toContain('external model_provider "custom"');
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("external provider guidance includes the admission header for non-loopback binds", () => {
    const original = 'model_provider = "custom"\n';
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ hostname: "192.168.1.20" }));
    expect(r.status).toBe(0);
    const message = JSON.parse(r.stdout).message;
    expect(message).toContain("http://192.168.1.20:10100/v1");
    expect(message).toContain("x-opencodex-api-key from OPENCODEX_API_AUTH_TOKEN");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("authless Desktop opt-in (#1107): loopback injects the table with requires_openai_auth = false, idempotently", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ codexDesktopAuthless: true }));
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(String(payload.message)).toContain("authless Desktop mode");

    const first = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(first).toContain('model_provider = "opencodex"');
    expect(first).toContain("[model_providers.opencodex]");
    expect(first).toContain('base_url = "http://127.0.0.1:10100/v1"');
    expect(first).toContain("requires_openai_auth = false");
    expect(first).not.toContain("env_key");
    expect(first).not.toContain("openai_base_url");

    expect(runInject(codexHome, ocxHome, JSON.stringify({ codexDesktopAuthless: true })).status).toBe(0);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(first);
    expect(readFileSync(join(codexHome, "opencodex.config.toml"), "utf8")).toContain("requires_openai_auth = false");
  });

  test("authless Desktop opt-in: turning it off restores Design B on the next inject, and restore strips it", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ocxHome, JSON.stringify({ codexDesktopAuthless: true })).status).toBe(0);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("requires_openai_auth = false");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const back = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(back).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(back).toContain("[model_providers.opencodex]");
    expect(back).toContain("requires_openai_auth = true");
    expect(back).not.toContain('model_provider = "opencodex"');
    expect(back.match(/Auto-injected by opencodex/g)?.length).toBe(3);
    expect(back).toContain(DESIGN_B_BLOCK);

    expect(runInject(codexHome, ocxHome, JSON.stringify({ codexDesktopAuthless: true })).status).toBe(0);
    expect(runRestore(codexHome, ocxHome).status).toBe(0);
    const restored = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(restored).not.toContain("opencodex");
    expect(restored).toContain('model = "gpt-5.5"');
  });

  test("client compaction opt-in (#3978): writes an authenticated provider table and returns to Design B", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const enabled = runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true }));
    expect(enabled.status).toBe(0);
    expect(String(JSON.parse(enabled.stdout).message)).toContain("client-side compaction mode");
    const providerTable = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(providerTable).toContain('model_provider = "opencodex"');
    expect(providerTable).toContain("[model_providers.opencodex]");
    expect(providerTable).toContain("requires_openai_auth = true");
    expect(providerTable).not.toContain("requires_openai_auth = false");
    // The root override is retained next to the table, which is what keeps threads still tagged
    // `openai` resolving to this proxy instead of to api.openai.com.
    expect(providerTable).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const designB = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(designB).toContain(DESIGN_B_BLOCK);
    expect(designB).toContain("[model_providers.opencodex]");
    expect(designB).not.toContain('model_provider = "opencodex"');
    // Disabling leaves exactly one root override, not the table form's copy plus a new one.
    expect(designB.match(/openai_base_url/g)?.length).toBe(1);
  });

  test("client compaction never replaces a user-owned root override", () => {
    // The retention is marker-owned like every other injected root line. When the user owns
    // that line, nothing is injected and their destination stands. The guarantee that an
    // `openai`-tagged thread reaches this proxy therefore holds for the managed override only;
    // a user pointing the built-in provider elsewhere keeps pointing it there.
    const userOwned = 'openai_base_url = "https://user.example/v1"\nmodel = "gpt-5.5"\n';
    writeFileSync(join(codexHome, "config.toml"), userOwned, "utf8");

    const enabled = runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true }));
    expect(enabled.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('openai_base_url = "https://user.example/v1"');
    expect(config).not.toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(config.match(/openai_base_url/g)?.length).toBe(1);
    // The opt-in itself still applies: new threads default to the proxy provider.
    expect(config).toContain('model_provider = "opencodex"');
    expect(config).toContain("[model_providers.opencodex]");
    // The user's line must never be journaled as ours, or a later restore would strip it.
    const journal = JSON.parse(readFileSync(join(codexHome, "opencodex-journal.json"), "utf8"));
    expect(journal.injectedOpenaiBaseUrl).toBeNull();

    // The reported result has to match the file that was just written. The old root-only
    // warning claimed nothing was injected and told the operator to delete a valid setting,
    // while the history line claimed those threads still reached the proxy. Both were wrong
    // for this mixed configuration.
    const message = String(JSON.parse(enabled.stdout).message);
    expect(message).toContain("Injected opencodex as default provider");
    expect(message).not.toContain("Codex routing NOT injected");
    expect(message).not.toContain("remove your openai_base_url line");
    expect(message).toContain("left exactly as you set it");
    expect(message).toContain("follow your configured root openai_base_url");
    expect(message).not.toContain("not the proxy");
    expect(message).not.toContain("Remove that line");
  });

  test("client compaction does not mistake a user-owned proxy URL for a foreign destination (#4110)", () => {
    // The URL equals the target but lacks our marker: keep ownership separate from destination.
    const rootLine = 'openai_base_url = "http://127.0.0.1:10100/v1"';
    writeFileSync(join(codexHome, "config.toml"), `${rootLine}\nmodel = "gpt-5.5"\n`, "utf8");

    const enabled = runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true }));
    expect(enabled.status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain(rootLine);
    expect(config.match(/openai_base_url/g)?.length).toBe(1);
    expect(config).toContain('model_provider = "opencodex"');
    expect(config).toContain("[model_providers.opencodex]");
    const journal = JSON.parse(readFileSync(join(codexHome, "opencodex-journal.json"), "utf8"));
    expect(journal.injectedOpenaiBaseUrl).toBeNull();

    const message = String(JSON.parse(enabled.stdout).message);
    expect(message).toContain("Injected opencodex as default provider");
    expect(message).toContain("left exactly as you set it");
    expect(message).toContain("follow your configured root openai_base_url");
    expect(message).not.toContain("not the proxy");
    expect(message).not.toContain("Remove that line");
    expect(message).not.toContain("Codex routing NOT injected");
  });

  test("the managed override keeps reporting proxy routing for existing threads", () => {
    // Control for the case above: with no user-owned line, opencodex writes the root override
    // itself, so the proxy claim is accurate and the root-only warning must not appear.
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const enabled = runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true }));
    expect(enabled.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');

    const message = String(JSON.parse(enabled.stdout).message);
    expect(message).toContain("keep reaching the proxy through the retained openai_base_url override");
    expect(message).not.toContain("Codex routing NOT injected");
    expect(message).not.toContain("not the proxy");
  });

  test("the retained root override is journaled so a comment-dropping rewrite can still restore", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    expect(runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true })).status).toBe(0);

    // The marker comment is not durable: the app can reserialize config.toml and drop comments,
    // after which only the journaled value distinguishes our line from a user's (#1798).
    const journal = JSON.parse(readFileSync(join(codexHome, "opencodex-journal.json"), "utf8"));
    expect(journal.injectedOpenaiBaseUrl).toBe("http://127.0.0.1:10100/v1");

    const rewritten = readFileSync(join(codexHome, "config.toml"), "utf8")
      .split("\n").filter(line => !line.startsWith("#")).join("\n");
    writeFileSync(join(codexHome, "config.toml"), rewritten, "utf8");
    expect(runRestore(codexHome, ocxHome).status).toBe(0);
    const restored = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("[model_providers.opencodex]");
  });

  test("authless together with client compaction keeps the authless form, root key and all", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = join(sessionsDir, "rollout-authless.jsonl");
    writeFileSync(rolloutPath, `${JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-authless", model_provider: "openai" },
    })}\n`, "utf8");
    const db = new Database(join(codexHome, "state_5.sqlite"));
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT, first_user_message TEXT, has_user_event INTEGER
    )`);
    db.run("INSERT INTO threads VALUES ('thread-authless', ?, 'openai', 'cli', 'hello', 1)", rolloutPath);
    db.close();

    const enabled = runInject(codexHome, ocxHome, JSON.stringify({
      codexClientCompaction: true,
      codexDesktopAuthless: true,
    }));
    expect(enabled.status).toBe(0);

    // Authless is the stronger form and cannot carry the root key, so it keeps its existing
    // shape: no root override, and resume history is forward-tagged with originals backed up.
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("requires_openai_auth = false");
    expect(config).not.toContain("openai_base_url");
    const verifier = new Database(join(codexHome, "state_5.sqlite"), { readonly: true });
    expect(verifier.query("SELECT model_provider FROM threads WHERE id = 'thread-authless'").get())
      .toEqual({ model_provider: "opencodex" });
    verifier.close();
  });
  test("client compaction opt-in leaves pre-existing ocx1 resume history byte-for-byte unchanged", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = join(sessionsDir, "rollout-ocx1.jsonl");
    const rollout = `${JSON.stringify({
      type: "compacted",
      payload: {
        replacement_history: [{
          type: "compaction",
          encrypted_content: "ocx1:cG9ydGFibGUgc3VtbWFyeQ==",
        }],
      },
    })}\n`;
    writeFileSync(rolloutPath, rollout, "utf8");
    const db = new Database(join(codexHome, "state_5.sqlite"));
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT, first_user_message TEXT, has_user_event INTEGER
    )`);
    db.run("INSERT INTO threads VALUES ('thread-ocx1', ?, 'opencodex', 'cli', 'hello', 1)", rolloutPath);
    db.close();

    const enabled = runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true }));
    expect(enabled.status).toBe(0);
    expect(String(JSON.parse(enabled.stdout).message)).toContain("left unchanged");
    expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
    const verifier = new Database(join(codexHome, "state_5.sqlite"), { readonly: true });
    expect(verifier.query("SELECT model_provider FROM threads WHERE id = 'thread-ocx1'").get())
      .toEqual({ model_provider: "opencodex" });
    verifier.close();
  });

  test("client compaction opt-in keeps existing Design B threads routed without touching history", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = join(sessionsDir, "rollout-designb.jsonl");
    const rollout = `${JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-designb", model_provider: "openai" },
    })}\n`;
    writeFileSync(rolloutPath, rollout, "utf8");
    const db = new Database(join(codexHome, "state_5.sqlite"));
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT, first_user_message TEXT, has_user_event INTEGER
    )`);
    db.run("INSERT INTO threads VALUES ('thread-designb', ?, 'openai', 'cli', 'hello', 1)", rolloutPath);
    db.close();

    const enabled = runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true }));
    expect(enabled.status).toBe(0);

    // The thread stays tagged `openai` and its rollout is untouched. It keeps reaching the proxy
    // because the injection retains the root override next to the provider table, so codex's
    // built-in `openai` entry still resolves to this proxy. Re-tagging would have been the other
    // way to keep it routed, but the length-preserving first-line repair cannot grow "openai"
    // into "opencodex", and codex re-appends that stale first line on its next metadata write.
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model_provider = "opencodex"');
    expect(config).toContain("[model_providers.opencodex]");
    expect(config).toContain("openai_base_url");
    expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
    const verifier = new Database(join(codexHome, "state_5.sqlite"), { readonly: true });
    expect(verifier.query("SELECT model_provider FROM threads WHERE id = 'thread-designb'").get())
      .toEqual({ model_provider: "openai" });
    verifier.close();
  });

  test("authless Desktop opt-in never weakens non-loopback admission", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ hostname: "192.168.1.20", codexDesktopAuthless: true }));
    expect(r.status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("requires_openai_auth = true");
    expect(config).toContain('env_key = "OPENCODEX_API_AUTH_TOKEN"');
    expect(config).not.toContain("requires_openai_auth = false");
  });

  test("non-loopback hostname still uses the legacy provider-table injection", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ocxHome, JSON.stringify({ hostname: "192.168.1.20" }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model_provider = "opencodex"');
    expect(config).toContain("[model_providers.opencodex]");
    expect(config).toContain('base_url = "http://192.168.1.20:10100/v1"');
    expect(config).not.toContain("openai_base_url");
  });

  test("CRLF config (Windows-edited) stays uniformly CRLF after injection", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\r\n\r\n[features]\r\nfast_mode = true\r\n', "utf8");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    // Every newline is CRLF — no mixed-EOL file on Windows.
    expect(config.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(config).toContain("\r\n");

    // Idempotent re-inject keeps the CRLF form stable.
    expect(runInject(codexHome, ocxHome).status).toBe(0);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(config);
  });

  test("LF config gains no carriage returns from injection", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).toContain("openai_base_url");
    expect(config).not.toContain("\r");
  });

  test("inject does not turn on multi_agent_v2; fresh installs stay on Codex's default v1 surface until the user opts in", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ocxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).not.toContain("[features.multi_agent_v2]");
    expect(config).not.toContain("multi_agent_v2 = true");
    expect(config).not.toContain("multi_agent_v2 = {");
  });
});
