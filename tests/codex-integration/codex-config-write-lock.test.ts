/**
 * Contract for src/codex/config-write-lock.ts: every opencodex-originated
 * config.toml write serializes through `<config>.ocx-write.lock`.
 *
 * The lock primitive itself is prompt-lock's, covered by codex-prompt-lock.
 * These tests pin the part that is NEW here: each writer honors the shared
 * lock — while another holder has it the writer refuses fast and leaves the
 * file byte-identical — and a caller that already holds the file can pass its
 * handle through (`heldConfigWriteLock`) so a nested writer does not refuse
 * itself inside the caller's wider section.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireConfigWriteLock,
  CONFIG_WRITE_LOCKED_MESSAGE,
  configWriteLockPath,
  releaseConfigWriteLock,
  withConfigWriteLock,
  withConfigWriteLockHeld,
} from "../../src/codex/config-write-lock";
import { release, tryAcquire, type LockDeps, type LockHandle } from "../../src/codex/prompt-lock";
import {
  isMultiAgentV2Enabled,
  setAgentsEnabled,
  setMaxConcurrentThreads,
  setMultiAgentModeHintText,
  transitionMultiAgentV2,
} from "../../src/codex/features";
import { readPromptLayers, setToggle } from "../../src/codex/prompt-layers";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";

const roots: string[] = [];
const alive: LockDeps = { isProcessAlive: () => true, now: () => Date.now() };

function fixtureConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-cfglock-"));
  roots.push(dir);
  const path = join(dir, "config.toml");
  writeFileSync(path, content);
  return path;
}

/** Hold the shared write lock on `configPath` from outside the writer under test. */
function holdLock(configPath: string): LockHandle {
  const acquired = tryAcquire(configWriteLockPath(configPath), alive);
  if (!acquired.ok) throw new Error("setup: could not take the lock under test");
  return acquired.handle;
}

afterEach(() => {
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

describe("withConfigWriteLock", () => {
  test("implicit nested acquisition refuses; an explicit live handle permits nesting", () => {
    const path = fixtureConfig("x = 1\n");
    const outer = withConfigWriteLock(path, handle => {
      expect(withConfigWriteLock(path, () => "implicit")).toEqual({ ok: false, error: "locked" });
      expect(withConfigWriteLockHeld(path, handle, () => "explicit")).toEqual({ ok: true, value: "explicit" });
    });
    expect(outer.ok).toBe(true);
    expect(withConfigWriteLock(path, () => "after release").ok).toBe(true);
  });

  test("a failed feature transition rolls back while competing scalar writes are refused", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n");
    const before = readFileSync(path, "utf8");
    const result = transitionMultiAgentV2(false, () => {
      expect(setAgentsEnabled(false, path)).toEqual({ ok: false, error: CONFIG_WRITE_LOCKED_MESSAGE });
      writeFileSync(path, "[features.multi_agent_v2]\nenabled = false\n");
      throw new Error("synthetic toggle failure");
    }, { configPath: path });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(withConfigWriteLock(path, () => "after rollback").ok).toBe(true);
  });

  test("a noncooperating synthetic process can write despite the advisory lock", () => {
    const path = fixtureConfig("x = 1\n");
    const held = withConfigWriteLock(path, () => {
      const child = Bun.spawnSync([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(path)}, 'x = 2\\n')`]);
      expect(child.exitCode).toBe(0);
      expect(readFileSync(path, "utf8")).toBe("x = 2\n");
    });
    expect(held.ok).toBe(true);
  });

  test("runs the section and releases when the file is free", () => {
    const path = fixtureConfig("[agents]\nmax_threads = 2\n");
    const locked = withConfigWriteLock(path, () => "done");
    expect(locked).toEqual({ ok: true, value: "done" });
    expect(existsSync(configWriteLockPath(path))).toBe(false);
  });

  test("refuses fast while another holder owns the file", () => {
    const path = fixtureConfig("[agents]\nmax_threads = 2\n");
    holdLock(path);
    expect(withConfigWriteLock(path, () => "done")).toEqual({ ok: false, error: "locked" });
  });

  test("a throwing section still releases the lock", () => {
    const path = fixtureConfig("");
    expect(() => withConfigWriteLock(path, () => { throw new Error("boom"); })).toThrow("boom");
    expect(withConfigWriteLock(path, () => "again")).toEqual({ ok: true, value: "again" });
  });
});

describe("withConfigWriteLockHeld", () => {
  test("a caller-held handle runs the section without re-acquiring", () => {
    const path = fixtureConfig("x = 1\n");
    const handle = holdLock(path);
    const ran = withConfigWriteLockHeld(path, handle, () => "inside the held lock");
    expect(ran).toEqual({ ok: true, value: "inside the held lock" });
    release(handle);
  });

  test("a superseded handle is refused, not silently trusted", () => {
    const path = fixtureConfig("x = 1\n");
    const handle = holdLock(path);
    release(handle);
    // A released handle means someone else may own the path now — the section
    // must not run under it.
    expect(withConfigWriteLockHeld(path, handle, () => "no")).toEqual({ ok: false, error: "locked" });
  });

  test("a handle minted on another config's lock is refused", () => {
    const path = fixtureConfig("x = 1\n");
    const other = fixtureConfig("y = 2\n");
    // Live handle, wrong lock path: running under it would leave `path`'s
    // writes unserialized while its own holders correctly believe it is free.
    const foreign = holdLock(other);
    try {
      expect(withConfigWriteLockHeld(path, foreign, () => "no")).toEqual({ ok: false, error: "locked" });
    } finally {
      release(foreign);
    }
  });
});

describe("acquireConfigWriteLock", () => {
  test("async callers take the file immediately when free", async () => {
    const path = fixtureConfig("x = 1\n");
    const acquired = await acquireConfigWriteLock(path, { timeoutMs: 50 });
    expect(acquired.ok).toBe(true);
    if (acquired.ok) releaseConfigWriteLock(acquired.handle);
  });

  test("async callers give up after the bounded wait", async () => {
    const path = fixtureConfig("x = 1\n");
    holdLock(path);
    const acquired = await acquireConfigWriteLock(path, { timeoutMs: 50 });
    expect(acquired).toEqual({ ok: false, error: "locked" });
  });
});

describe("every writer honors the shared lock", () => {
  test("automatic recovery rechecks a replacement journal's live owner under the lock", () => {
    const configPath = fixtureConfig('model = "a"\n');
    const home = join(configPath, ".."), ready = join(home, "replacement-ready"), stop = join(home, "replacement-stop");
    const replacement = [
      "const fs=require('node:fs'),path=require('node:path');",
      "const {withConfigWriteLock}=require('./src/codex/config-write-lock');",
      "const journal=require('./src/codex/journal'),config=path.join(process.env.CODEX_HOME,'config.toml');",
      "const held=withConfigWriteLock(config,()=>{fs.writeFileSync(config,'model = \"b\"\\n');journal.writeJournal({currentStateIsNative:true});fs.writeFileSync(config,'model = \"route\"\\n');journal.markJournalInjectedState(fs.readFileSync(config,'utf8'),null,{injectedOpenaiBaseUrl:null,injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null});});if(!held.ok)throw Error('setup');",
      "fs.writeFileSync(" + JSON.stringify(ready) + ",'ready');",
      "const until=Date.now()+3000;while(!fs.existsSync(" + JSON.stringify(stop) + ")){if(Date.now()>until)throw Error('hold timeout');await Bun.sleep(5);}",
    ].join("\n");
    const script = [
      "const fs=require('node:fs'),path=require('node:path');",
      "const {spyOn}=require('bun:test'),locks=require('./src/codex/config-write-lock'),journal=require('./src/codex/journal');",
      "const config=path.join(process.env.CODEX_HOME,'config.toml'),jp=path.join(process.env.CODEX_HOME,'opencodex-journal.json');",
      "journal.writeJournal();fs.writeFileSync(config,'model = \"route\"\\n');journal.markJournalInjectedState(fs.readFileSync(config,'utf8'),null,{injectedOpenaiBaseUrl:null,injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null});",
      "const old=JSON.parse(fs.readFileSync(jp,'utf8'));old.pid=999999999;old.owner={kind:'process',pid:999999999};fs.writeFileSync(jp,JSON.stringify(old));",
      "const original=locks.withConfigWriteLockHeld;let child,swapped=false;",
      "const spy=spyOn(locks,'withConfigWriteLockHeld').mockImplementation((...args)=>{if(!swapped){swapped=true;child=Bun.spawn([process.execPath,'-e'," + JSON.stringify(replacement) + "],{cwd:process.cwd(),env:process.env,stdout:'pipe',stderr:'pipe'});const until=Date.now()+3000;while(!fs.existsSync(" + JSON.stringify(ready) + ")){if(Date.now()>until)throw Error('barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return original(...args);});",
      "try{const recovered=journal.reconcileJournal();console.log(JSON.stringify({swapped,recovered,config:fs.readFileSync(config,'utf8'),journalExists:fs.existsSync(jp)}));}finally{spy.mockRestore();fs.writeFileSync(" + JSON.stringify(stop) + ",'stop');if(child){await child.exited;}}",
    ].join("\n");
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(out).toMatchObject({ swapped: true, recovered: false, config: 'model = "route"\n', journalExists: true });
  });

  test("journal replay re-reads the latest journal after acquiring the shared lock", () => {
    const configPath = fixtureConfig('model = "a"\n');
    const home = join(configPath, "..");
    const replacement = [
      "const fs=require('node:fs'),path=require('node:path');",
      "const {withConfigWriteLock}=require('./src/codex/config-write-lock');",
      "const {writeJournal,markJournalInjectedState}=require('./src/codex/journal');",
      "const config=path.join(process.env.CODEX_HOME,'config.toml');",
      "const locked=withConfigWriteLock(config,()=>{",
      "fs.writeFileSync(config,'model = \"b\"\\n');writeJournal({currentStateIsNative:true});",
      "fs.writeFileSync(config,'model = \"route\"\\n');",
      "markJournalInjectedState(fs.readFileSync(config,'utf8'),null,{injectedOpenaiBaseUrl:null,injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null});",
      "});if(!locked.ok)throw Error('replacement could not acquire');",
    ].join("\n");
    const script = [
      "const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');",
      "const {spyOn}=require('bun:test'),locks=require('./src/codex/config-write-lock');",
      "const journal=require('./src/codex/journal'),config=path.join(process.env.CODEX_HOME,'config.toml');",
      "journal.writeJournal();fs.writeFileSync(config,'model = \"route\"\\n');",
      "journal.markJournalInjectedState(fs.readFileSync(config,'utf8'),null,{injectedOpenaiBaseUrl:null,injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null});",
      "const original=locks.withConfigWriteLockHeld;let swapped=false;",
      "const spy=spyOn(locks,'withConfigWriteLockHeld').mockImplementation((...args)=>{",
      "if(!swapped){swapped=true;const result=spawnSync(process.execPath,['-e'," + JSON.stringify(replacement) + "],{cwd:process.cwd(),env:process.env,encoding:'utf8'});if(result.status!==0)throw Error(result.stderr);}",
      "return original(...args);});",
      "try{const result=journal.restoreJournalState();console.log(JSON.stringify({result,config:fs.readFileSync(config,'utf8')}));}finally{spy.mockRestore();}",
    ].join("\n");
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(out.result.complete).toBe(true);
    expect(out.config).toBe('model = "b"\n');
  });

  test("isolated journal replay, remove, retained-table write and restore refuse busy without compensation", () => {
    const configPath = fixtureConfig('model = "fixture"\n');
    const home = join(configPath, "..");
    const child = Bun.spawnSync([process.execPath, "-e", `
      const fs=require('node:fs'),path=require('node:path');
      const {writeJournal,markJournalInjectedState,restoreJournalState}=require('./src/codex/journal');
      const {removeCodexConfig,retainOcxProviderTableOnDisk}=require('./src/codex/inject/remove');
      const {restoreNativeCodex}=require('./src/codex/inject/restore');
      const {tryAcquire,release,stillHeld}=require('./src/codex/prompt-lock');
      const {configWriteLockPath}=require('./src/codex/config-write-lock');
      const config=path.join(process.env.CODEX_HOME,'config.toml'),journal=path.join(process.env.CODEX_HOME,'opencodex-journal.json');
      const original=fs.readFileSync(config,'utf8');
      writeJournal(); fs.writeFileSync(config,'# opencodex-managed\\nopenai_base_url = "http://127.0.0.1:10100/v1"\\n');
      markJournalInjectedState(fs.readFileSync(config,'utf8'),null,{injectedOpenaiBaseUrl:'http://127.0.0.1:10100/v1',injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null});
      const held=tryAcquire(configWriteLockPath(config)); if(!held.ok)throw Error('setup');
      const before=[config,journal].map(p=>fs.readFileSync(p,'utf8'));
      const replay=restoreJournalState(),remove=removeCodexConfig();
      let retainRefused=false;try{retainOcxProviderTableOnDisk('[model_providers.opencodex]\\nname="fixture"\\n');}catch{retainRefused=true;}
      const restore=restoreNativeCodex();
      const untouched=[config,journal].every((p,i)=>fs.readFileSync(p,'utf8')===before[i]);
      const nested=restoreJournalState({heldConfigWriteLock:held.handle});
      const ownerSurvived=stillHeld(held.handle);
      release(held.handle);
      console.log(JSON.stringify({replayBusy:replay.lockBusy,removeSuccess:remove.success,retainRefused,restoreConfig:restore.artifacts.config,untouched,nestedComplete:nested.complete,originalRestored:fs.readFileSync(config,'utf8')===original,journalRemoved:!fs.existsSync(journal),ownerSurvived}));
    `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(out).toMatchObject({ replayBusy: true, removeSuccess: false, retainRefused: true, untouched: true, nestedComplete: true, originalRestored: true, journalRemoved: true, ownerSurvived: true });
    expect(out.restoreConfig.state).toBe("failed");
    expect(out.restoreConfig.changed).toBe(false);
  });

  test("the real injector honors config busy in a synthetic legacy eligibility fixture", async () => {
    const configPath = fixtureConfig('model = "fixture"\n');
    const home = join(configPath, "..");
    const child = Bun.spawnSync([process.execPath, "-e", `
      const {spyOn}=require('bun:test');
      const fs=require('node:fs'),path=require('node:path');
      const eligibility=require('./src/codex/inject-coordination');
      const mock=spyOn(eligibility,'codexWriteCoordinationEligibility').mockReturnValue({kind:'legacy-uncoordinated',reason:'synthetic fixture'});
      const {injectCodexConfig}=require('./src/codex/inject');
      const {tryAcquire,release}=require('./src/codex/prompt-lock');
      const {configWriteLockPath}=require('./src/codex/config-write-lock');
      const config=path.join(process.env.CODEX_HOME,'config.toml'),before=fs.readFileSync(config,'utf8');
      const held=tryAcquire(configWriteLockPath(config));if(!held.ok)throw Error('setup');
      try {const result=await injectCodexConfig(10100,undefined,{lockTimeoutMs:0});console.log(JSON.stringify({result,unchanged:fs.readFileSync(config,'utf8')===before}));}
      finally{release(held.handle);mock.mockRestore();}
    `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(out.result).toMatchObject({ success: false, retryable: true });
    expect(out.result.message).toContain("writing Codex configuration");
    expect(out.unchanged).toBe(true);
  });

  test("setMaxConcurrentThreads refuses busy and leaves bytes identical", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 4\n");
    const before = readFileSync(path, "utf8");
    holdLock(path);
    expect(setMaxConcurrentThreads(9, path)).toEqual({ ok: false, error: CONFIG_WRITE_LOCKED_MESSAGE });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("setAgentsEnabled refuses busy", () => {
    const path = fixtureConfig("[agents]\nmax_threads = 2\n");
    const before = readFileSync(path, "utf8");
    holdLock(path);
    expect(setAgentsEnabled(false, path)).toEqual({ ok: false, error: CONFIG_WRITE_LOCKED_MESSAGE });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("setMultiAgentModeHintText refuses busy", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    const before = readFileSync(path, "utf8");
    holdLock(path);
    expect(setMultiAgentModeHintText("hint", path)).toEqual({ ok: false, error: CONFIG_WRITE_LOCKED_MESSAGE });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("transitionMultiAgentV2 refuses busy without running the toggle", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    const before = readFileSync(path, "utf8");
    holdLock(path);
    let toggled = false;
    const result = transitionMultiAgentV2(false, () => { toggled = true; }, { configPath: path });
    expect(result).toEqual({ ok: false, error: CONFIG_WRITE_LOCKED_MESSAGE });
    expect(toggled).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a prompt-layer commit refuses while the config write lock is held", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cfglock-prompt-"));
    roots.push(dir);
    const configPath = join(dir, "config.toml");
    const storePath = join(dir, "opencodex-prompt.json");
    const paths = { configPath, storePath };
    const before = readPromptLayers(paths);
    holdLock(configPath);
    const result = setToggle("apps", false, before.revision, paths);
    expect(result).toEqual({ ok: false, error: "locked" });
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("heldConfigWriteLock handoff", () => {
  test("transitionMultiAgentV2 runs under a caller-held lock", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n\n[agents]\nmax_depth = 2\n");
    const flipTableFlag = (enabled: boolean) => {
      const content = readFileSync(path, "utf8");
      writeFileSync(path, content.replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
    };
    const handle = holdLock(path);
    // The transition is a nested writer inside the injector's held section: it
    // must run on the caller's handle rather than refusing itself.
    const result = transitionMultiAgentV2(false, flipTableFlag, { configPath: path, heldConfigWriteLock: handle });
    expect(result).toMatchObject({ ok: true, changed: true, threadLimit: 63 });
    expect(isMultiAgentV2Enabled(path)).toBe(false);
    release(handle);
  });

  test("transitionMultiAgentV2 refuses a superseded caller handle", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    const before = readFileSync(path, "utf8");
    const handle = holdLock(path);
    release(handle);
    const result = transitionMultiAgentV2(false, () => { throw new Error("toggle must not run"); }, {
      configPath: path,
      heldConfigWriteLock: handle,
    });
    expect(result).toEqual({ ok: false, error: CONFIG_WRITE_LOCKED_MESSAGE });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("scalar writers run under a caller-held lock (route batch)", () => {
    const path = fixtureConfig("[agents]\nmax_threads = 2\n");
    const handle = holdLock(path);
    try {
      // The management PUT hands its single acquired lock to every scalar
      // writer — each must apply under it instead of refusing itself.
      expect(setAgentsEnabled(false, path, handle)).toEqual({ ok: true, changed: true });
      expect(readFileSync(path, "utf8")).toContain("enabled = false");
    } finally {
      release(handle);
    }
  });
});
