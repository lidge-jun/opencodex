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
    expect(withConfigWriteLockHeld(path, handle, () => "no")).toEqual({ ok: false, error: "unsafe", detail: handle.path });
  });

  test("a handle minted on another config's lock is refused", () => {
    const path = fixtureConfig("x = 1\n");
    const other = fixtureConfig("y = 2\n");
    // Live handle, wrong lock path: running under it would leave `path`'s
    // writes unserialized while its own holders correctly believe it is free.
    const foreign = holdLock(other);
    try {
      expect(withConfigWriteLockHeld(path, foreign, () => "no")).toEqual({ ok: false, error: "unsafe", detail: foreign.path });
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
      const config=require('./src/codex/paths').CODEX_CONFIG_PATH,journal=path.join(path.dirname(config),'opencodex-journal.json');
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
    expect(result).toMatchObject({ ok: false, retryable: false });
    if (!result.ok) expect(result.error).toContain(handle.path);
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

describe("canonical destination hardening", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const locks = require("../../src/codex/config-write-lock") as typeof import("../../src/codex/config-write-lock");
  test("two symlink aliases contend and both sequential edits survive", async () => {
    const config = fixtureConfig("[agents]\nmax_threads = 2\n"), a = config + ".a", b = config + ".b";
    fs.symlinkSync(config, a); fs.symlinkSync(config, b);
    const held = await acquireConfigWriteLock(a, { timeoutMs: 0 }); expect(held.ok).toBe(true);
    if (!held.ok) throw Error("setup");
    expect(await acquireConfigWriteLock(b, { timeoutMs: 0 })).toEqual({ ok: false, error: "locked" });
    expect(setAgentsEnabled(false, a, held.handle).ok).toBe(true);
    releaseConfigWriteLock(held.handle);
    expect(setMultiAgentModeHintText("second-edit", b).ok).toBe(true);
    const content = readFileSync(config, "utf8");
    expect(content).toContain("enabled = false"); expect(content).toContain("second-edit");
    expect(fs.lstatSync(a).isSymbolicLink()).toBe(true); expect(fs.lstatSync(b).isSymbolicLink()).toBe(true);
  });
  test("retargeting between acquisition and publication refuses", () => {
    const first = fixtureConfig("first"), second = fixtureConfig("second"), alias = first + ".alias";
    fs.symlinkSync(first, alias);
    const result = withConfigWriteLock(alias, held => {
      fs.unlinkSync(alias); fs.symlinkSync(second, alias);
      expect(() => locks.publishConfigWrite(alias, held, path => writeFileSync(path, "clobber"))).toThrow("destination changed");
    });
    expect(result.ok).toBe(true); expect(readFileSync(first, "utf8")).toBe("first"); expect(readFileSync(second, "utf8")).toBe("second");
  });
  test("an identical-byte target swapped to a different inode refuses", () => {
    const config = fixtureConfig("same bytes"), replacement = config + ".replacement";
    withConfigWriteLock(config, held => {
      writeFileSync(replacement, "same bytes"); fs.renameSync(replacement, config);
      expect(() => locks.publishConfigWrite(config, held, path => writeFileSync(path, "clobber"))).toThrow("destination changed");
    });
    expect(readFileSync(config, "utf8")).toBe("same bytes");
  });
  test("timeout zero makes exactly one immediate attempt", async () => {
    const { spyOn } = await import("bun:test");
    const primitive = await import("../../src/codex/prompt-lock");
    const config = fixtureConfig("same"); holdLock(config);
    const spy = spyOn(primitive, "tryAcquire");
    try {
      const result = await acquireConfigWriteLock(config, { timeoutMs: 0, sleep: async () => { throw Error("must not wait"); } });
      expect(result).toEqual({ ok: false, error: "locked" }); expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  for (const timeoutMs of [NaN, Infinity, -1, 0.5, 10_001]) test(`invalid timeout ${timeoutMs} is rejected`, async () => {
    const config = fixtureConfig("same");
    await expect(acquireConfigWriteLock(config, { timeoutMs })).rejects.toThrow("Invalid config lock timeout");
  });
  test("wall-clock jumps cannot extend the monotonic deadline", async () => {
    const { spyOn } = await import("bun:test");
    const config = fixtureConfig("same"); holdLock(config);
    let monotonic = 0, waits = 0;
    const wall = spyOn(Date, "now").mockReturnValue(-1_000_000);
    const clock = spyOn(performance, "now").mockImplementation(() => monotonic);
    try {
      expect(await acquireConfigWriteLock(config, { timeoutMs: 10, sleep: async ms => { waits++; monotonic += ms; wall.mockReturnValue(-2_000_000); } })).toEqual({ ok: false, error: "locked" });
      expect(waits).toBe(1); expect(monotonic).toBe(10);
    } finally { clock.mockRestore(); wall.mockRestore(); }
  });
  test("config acquisition throwing releases the prompt store lock and the next commit succeeds", async () => {
    const { spyOn } = await import("bun:test");
    const configPath = fixtureConfig("model = \"fixture\"\n"), storePath = configPath + ".store";
    const paths = { configPath, storePath }, snapshot = readPromptLayers(paths);
    const spy = spyOn(locks, "withConfigWriteLockHeld").mockImplementation(() => { throw Error("injected acquisition failure"); });
    try { expect(() => setToggle("apps", false, snapshot.revision, paths)).toThrow("injected acquisition failure"); }
    finally { spy.mockRestore(); }
    expect(setToggle("apps", false, snapshot.revision, paths).ok).toBe(true);
  });
  test("retargeting during prompt recovery refuses and preserves the journal", async () => {
    const { spyOn } = await import("bun:test"), prompt = await import("../../src/codex/prompt-journal");
    const config = fixtureConfig("post"), other = fixtureConfig("post"), alias = config + ".alias", store = config + ".store", journal = config + ".journal";
    fs.symlinkSync(config, alias);
    writeFileSync(journal, prompt.encodeJournal({ configPath: alias, storePath: store,
      preConfig: prompt.hashBytes("pre"), postConfig: prompt.hashBytes("post"), preStore: prompt.hashBytes(null), postStore: prompt.hashBytes("store-post"),
      preConfigBytes: "pre", postConfigBytes: "post", preStoreBytes: null, postStoreBytes: "store-post" }));
    withConfigWriteLock(alias, held => {
      const original = locks.publishConfigWrite;
      const spy = spyOn(locks, "publishConfigWrite").mockImplementation((...args) => {
        fs.unlinkSync(alias); fs.symlinkSync(other, alias); return original(...args);
      });
      try { expect(prompt.recoverIfNeeded(journal, { configPath: alias, storePath: store }, held).ok).toBe(false); }
      finally { spy.mockRestore(); }
    });
    expect(readFileSync(other, "utf8")).toBe("post"); expect(existsSync(journal)).toBe(true);
  });
  test("retargeting during compensation refuses every artifact and retains the journal fallback", () => {
    const config = fixtureConfig("post"), home = join(config, "..");
    const child = Bun.spawnSync([process.execPath, "-e", `
      const fs=require('node:fs'),path=require('node:path');
      const locks=require('./src/codex/config-write-lock'),section=require('./src/codex/inject/config-write-section');
      const coordination=require('./src/codex/inject-coordination'),{spyOn}=require('bun:test');
      const config=path.join(process.env.CODEX_HOME,'config.toml'),target=config+'.target',replacement=config+'.replacement';
      const profile=path.join(process.env.CODEX_HOME,'opencodex.config.toml'),journal=path.join(process.env.CODEX_HOME,'opencodex-journal.json');
      fs.renameSync(config,target);fs.symlinkSync(target,config);fs.writeFileSync(replacement,'post');fs.writeFileSync(profile,'profile');fs.writeFileSync(journal,'retained-evidence');
      locks.withConfigWriteLock(config,held=>{section.beginCodexWriteSection(held);
        const original=section.publishCodexArtifact;let swapped=false;
        const spy=spyOn(section,'publishCodexArtifact').mockImplementation((...args)=>{if(!swapped){swapped=true;fs.unlinkSync(config);fs.symlinkSync(replacement,config);}return original(...args)});
        const result=coordination.restoreCodexPreImages({config:'pre',profile:null,journal:null},held);spy.mockRestore();
        console.log(JSON.stringify({result,config:fs.readFileSync(config,'utf8'),profile:fs.readFileSync(profile,'utf8'),journal:fs.readFileSync(journal,'utf8')}));});
    `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(out).toEqual({ result: { complete: false, unrestored: ["config", "profile", "journal"] }, config: "post", profile: "profile", journal: "retained-evidence" });
  });
});

describe("one config recovery section", () => {
  test("missing-config removal racing an injector publication preserves its profile", async () => {
    const config = fixtureConfig("placeholder"), home = join(config, "..");
    require("node:fs").unlinkSync(config);
    const initializer = Bun.spawn([process.execPath, "-e", `
      const fs=require('node:fs'),path=require('node:path'),locks=require('./src/codex/config-write-lock');
      const config=path.join(process.env.CODEX_HOME,'config.toml'),profile=path.join(process.env.CODEX_HOME,'opencodex.config.toml');
      locks.withConfigWriteLock(config,held=>{
        fs.writeFileSync(profile,'in-progress');console.log('held-missing');fs.readSync(0,Buffer.alloc(1),0,1,null);
        if(fs.readFileSync(profile,'utf8')!=='in-progress')throw Error('profile was removed');
        locks.publishConfigWrite(config,held,destination=>fs.writeFileSync(destination,'model = "published"\\n'));
        fs.writeFileSync(profile,'published-profile');
      });
    `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = initializer.stdout.getReader(); const ready = await reader.read(); reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("held-missing");
      const remover = Bun.spawnSync([process.execPath, "-e", `
        const {removeCodexConfig}=require('./src/codex/inject/remove');console.log(JSON.stringify(removeCodexConfig()));
      `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe" });
      expect(remover.exitCode, remover.stderr.toString()).toBe(0);
      expect(JSON.parse(remover.stdout.toString().trim()).success).toBe(false);
      initializer.stdin.write("g"); initializer.stdin.end(); expect(await initializer.exited).toBe(0);
      expect(readFileSync(join(home, "opencodex.config.toml"), "utf8")).toBe("published-profile");
      expect(readFileSync(config, "utf8")).toBe('model = "published"\n');
    } finally { initializer.kill(); }
  });
  test("a journal replaced between selection and cleanup survives", () => {
    const config = fixtureConfig('model = "native"\n'), home = join(config, "..");
    const child = Bun.spawnSync([process.execPath, "-e", `
      const fs=require('node:fs'),path=require('node:path'),{spyOn}=require('bun:test');
      const journal=require('./src/codex/journal'),section=require('./src/codex/inject/config-write-section');
      const config=path.join(process.env.CODEX_HOME,'config.toml'),jp=journal.JOURNAL_PATH;
      journal.writeJournal();fs.writeFileSync(config,'model = "routed"\\n');
      journal.markJournalInjectedState(fs.readFileSync(config,'utf8'),null,{injectedOpenaiBaseUrl:null,injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null});
      const replacement=JSON.stringify({...JSON.parse(fs.readFileSync(jp,'utf8')),replacement:true});
      const original=section.publishCodexArtifact;let swapped=false;
      const spy=spyOn(section,'publishCodexArtifact').mockImplementation((...args)=>{
        if(args[0]===jp&&!swapped){swapped=true;fs.writeFileSync(jp+'.replacement',replacement);fs.renameSync(jp+'.replacement',jp);}return original(...args);
      });
      try{const result=journal.restoreJournalState();console.log(JSON.stringify({swapped,result,retained:fs.readFileSync(jp,'utf8')===replacement}));}finally{spy.mockRestore();}
    `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(out.swapped).toBe(true); expect(out.result.complete).toBe(false); expect(out.retained).toBe(true);
  });
});

test("a successful feature toggle that atomically replaces config advances the held inode witness", () => {
  const config = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n");
  const result = transitionMultiAgentV2(false, () => {
    const replacement = config + ".toggle";
    writeFileSync(replacement, readFileSync(config, "utf8").replace("enabled = true", "enabled = false"));
    require("node:fs").renameSync(replacement, config);
  }, { configPath: config });
  expect(result).toMatchObject({ ok: true, changed: true, threadLimit: 63 });
  expect(readFileSync(config, "utf8")).toContain("max_threads = 63");
});

describe("SQLite order and retained recovery authority", () => {
  test("SQLite mutation-lock contention observes config first, fails fast and leaves no deadlock", async () => {
    const config = fixtureConfig('model = "fixture"\n'), home = require("node:fs").realpathSync.native(join(config, ".."));
    const env = { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") };
    const holder = Bun.spawn([process.execPath, "-e", `
      const {readSync}=require('node:fs'),{withConfigMutationLockSync}=require('./src/config');
      withConfigMutationLockSync(()=>{});
      withConfigMutationLockSync(()=>{console.log('sqlite-held');readSync(0,Buffer.alloc(1),0,1,null)});
    `], { cwd: repoRoot(), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = holder.stdout.getReader(); const ready = await reader.read(); reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("sqlite-held");
      const contender = Bun.spawnSync([process.execPath, "-e", `
        const {spyOn}=require('bun:test'),config=require('./src/config'),locks=require('./src/codex/config-write-lock');
        const primitive=require('./src/codex/prompt-lock'),paths=require('./src/codex/paths');
        const original=config.withConfigMutationLockSync;let sawConfigFirst=false;
        const spy=spyOn(config,'withConfigMutationLockSync').mockImplementation((...args)=>{
          const probe=primitive.tryAcquire(locks.configWriteLockPath(paths.CODEX_CONFIG_PATH));
          if(!probe.ok&&probe.error==='locked')sawConfigFirst=true;
          if(probe.ok)primitive.release(probe.handle);
          return original(...args);
        });
        try{let result;try{result=await require('./src/codex/inject').injectCodexConfig(20201,undefined,{lockTimeoutMs:0});}catch(error){result={code:error.code};}
          const freed=locks.withConfigWriteLock(paths.CODEX_CONFIG_PATH,()=>true);
          console.log(JSON.stringify({result,sawConfigFirst,freed:freed.ok}));}finally{spy.mockRestore();}
      `], { cwd: repoRoot(), env, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
      expect(contender.exitCode, contender.stderr.toString()).toBe(0);
      const out = JSON.parse(contender.stdout.toString().trim().split("\n").at(-1)!);
      expect(out.result).toEqual({ code: "CONFIG_MUTATION_LOCK_UNAVAILABLE" });
      expect(out.sawConfigFirst).toBe(true); expect(out.freed).toBe(true);
      expect(readFileSync(config, "utf8")).toBe('model = "fixture"\n');
      holder.stdin.write("g"); holder.stdin.end(); expect(await holder.exited).toBe(0);
      // Contention keeps its 5 s deadline. Successful cold-start injection also
      // creates ACL-protected state on Windows; bound that separate work to 15 s.
      const retried = Bun.spawnSync([process.execPath, "-e", `
        console.log(JSON.stringify(await require('./src/codex/inject').injectCodexConfig(20201,undefined,{lockTimeoutMs:0})));
      `], { cwd: repoRoot(), env, stdout: "pipe", stderr: "pipe", timeout: process.platform === "win32" ? 15_000 : 5_000 });
      expect(retried.exitCode, retried.stderr.toString()).toBe(0);
      expect(JSON.parse(retried.stdout.toString().trim().split("\n").at(-1)!).success).toBe(true);
    } finally { holder.kill(); }
  }, 30_000);
  test("post-publication commit and compensation failure retain a usable journal fallback", () => {
    const config = fixtureConfig('model = "native"\n'), home = require("node:fs").realpathSync.native(join(config, ".."));
    const child = Bun.spawnSync([process.execPath, "-e", `
      const fs=require('node:fs'),{spyOn}=require('bun:test');
      const section=require('./src/codex/inject/config-write-section'),paths=require('./src/codex/paths'),journal=require('./src/codex/journal');
      const {setBeforeCoordinatorCommitForTests}=require('./src/codex/codex-write-lock');
      let compensating=false,sawPublished=false,errorCode;
      setBeforeCoordinatorCommitForTests(()=>{sawPublished=fs.existsSync(paths.CODEX_PROFILE_PATH)&&fs.existsSync(journal.JOURNAL_PATH);compensating=true;throw Error('injected commit failure')});
      const original=section.publishCodexArtifact;
      const spy=spyOn(section,'publishCodexArtifact').mockImplementation((...args)=>{
        if(compensating&&args[0]===paths.CODEX_CONFIG_PATH)throw Error('injected compensation failure');return original(...args);
      });
      try{await require('./src/codex/inject').injectCodexConfig(20201);}catch(error){errorCode=error.code;}
      finally{spy.mockRestore();setBeforeCoordinatorCommitForTests(undefined);}
      const retained=fs.existsSync(journal.JOURNAL_PATH);
      const restored=retained?journal.restoreJournalState():null;
      console.log(JSON.stringify({sawPublished,errorCode,retained,restored,config:fs.readFileSync(paths.CODEX_CONFIG_PATH,'utf8'),removed:!fs.existsSync(journal.JOURNAL_PATH)}));
    `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(out).toMatchObject({ sawPublished: true, errorCode: "CODEX_PARTIAL_WRITE", retained: true, restored: { complete: true }, config: 'model = "native"\n', removed: true });
  });
});


describe("publication and unsafe caller regressions", () => {
  test("atomic preparation swaps the destination and refuses without advancing the witness", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const { atomicWriteFile } = require("../../src/config/atomic-write") as typeof import("../../src/config/atomic-write");
    const { publishConfigWrite, assertConfigWriteDestination } = require("../../src/codex/config-write-lock") as typeof import("../../src/codex/config-write-lock");
    const config = fixtureConfig("original"), replacement = config + ".replacement";
    withConfigWriteLock(config, held => {
      expect(() => publishConfigWrite(config, held, (destination, hooks) => atomicWriteFile(destination, "ours", undefined, {
        ...hooks, afterTempWrite() { writeFileSync(replacement, "external"); fs.renameSync(replacement, config); },
      }))).toThrow("destination changed");
      expect(() => assertConfigWriteDestination(config, held)).toThrow("destination changed");
      expect(readFileSync(config, "utf8")).toBe("external");
    });
  });
  test("durable preparation retargets an alias and refuses before rename", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const { durableWrite } = require("../../src/codex/prompt-journal") as typeof import("../../src/codex/prompt-journal");
    const { publishConfigWrite, assertConfigWriteDestination } = require("../../src/codex/config-write-lock") as typeof import("../../src/codex/config-write-lock");
    const config = fixtureConfig("original"), other = fixtureConfig("external"), alias = config + ".alias";
    fs.symlinkSync(config, alias);
    withConfigWriteLock(alias, held => {
      expect(() => publishConfigWrite(alias, held, (destination, hooks) => durableWrite(destination, "ours", {
        ...hooks, beforeRename() { fs.unlinkSync(alias); fs.symlinkSync(other, alias); },
      }))).toThrow("destination changed");
      expect(() => assertConfigWriteDestination(alias, held)).toThrow("destination changed");
      expect(readFileSync(config, "utf8")).toBe("original");
      expect(readFileSync(other, "utf8")).toBe("external");
    });
  });
  test("a confirmed rename advances the witness even if post-publication cleanup throws", () => {
    const { atomicWriteFile } = require("../../src/config/atomic-write") as typeof import("../../src/config/atomic-write");
    const { publishConfigWrite, assertConfigWriteDestination } = require("../../src/codex/config-write-lock") as typeof import("../../src/codex/config-write-lock");
    const config = fixtureConfig("original");
    withConfigWriteLock(config, held => {
      expect(() => publishConfigWrite(config, held, (destination, hooks) => atomicWriteFile(destination, "ours", undefined, {
        ...hooks, afterRename(path) { hooks.afterRename?.(path); throw Error("post-publication failure"); },
      }))).toThrow("post-publication failure");
      expect(assertConfigWriteDestination(config, held)).toBe(require("node:fs").realpathSync.native(config));
      expect(readFileSync(config, "utf8")).toBe("ours");
    });
  });
  test("hostless evidence is non-retryable through feature, prompt, injector and restore writers", () => {
    const config = fixtureConfig('model = "native"\n'), home = join(config, "..");
    const child = Bun.spawnSync([process.execPath, "-e", `
      const fs=require('node:fs'),path=require('node:path');
      const locks=require('./src/codex/config-write-lock'),features=require('./src/codex/features');
      const prompts=require('./src/codex/prompt-layers'),journal=require('./src/codex/journal');
      const config=require('./src/codex/paths').CODEX_CONFIG_PATH,store=path.join(path.dirname(config),'opencodex-prompt.json');
      const lock=locks.configWriteLockPath(config),evidence=JSON.stringify({pid:123,token:'legacy',acquiredAt:0});fs.writeFileSync(lock,evidence);
      const before=fs.readFileSync(config,'utf8');
      const feature=features.setAgentsEnabled(false,config);
      const snapshot=prompts.readPromptLayers({configPath:config,storePath:store});
      const prompt=prompts.setToggle('permissions',false,snapshot.revision,{configPath:config,storePath:store});
      const replay=journal.restoreJournalState();
      const restore=require('./src/codex/inject/restore').restoreNativeCodex({history:false});
      const inject=await require('./src/codex/inject').injectCodexConfig(19377,undefined,{lockTimeoutMs:0});
      const unchanged=fs.readFileSync(config,'utf8')===before;
      fs.writeFileSync(config,'model_provider = "external"\\n');
      const externalInject=await require('./src/codex/inject').injectCodexConfig(19377,undefined,{lockTimeoutMs:0});
      console.log(JSON.stringify({lock,feature,prompt,replay,restore,inject,externalInject,unchanged,evidencePreserved:fs.readFileSync(lock,'utf8')===evidence}));
    `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(out.feature).toMatchObject({ ok: false, retryable: false }); expect(out.feature.error).toContain(out.lock);
    expect(out.prompt).toMatchObject({ ok: false, error: "unsafe" }); expect(out.prompt.detail).toContain(out.lock);
    expect(out.replay.lockBusy).toBeUndefined(); expect(out.replay.lockUnsafe).toContain(out.lock);
    expect(out.restore.artifacts.config.message).toContain(out.lock);
    expect(out.inject).toMatchObject({ success: false, retryable: false }); expect(out.inject.message).toContain(out.lock);
    expect(out.externalInject).toMatchObject({ success: false, retryable: false }); expect(out.externalInject.message).toContain(out.lock);
    expect(out.unchanged).toBe(true); expect(out.evidencePreserved).toBe(true);
  });
  test("reconcile with a missing default Codex home creates nothing", () => {
    const config = fixtureConfig("fixture"), parent = join(config, "..");
    const child = Bun.spawnSync([process.execPath, "-e", `
      delete process.env.CODEX_HOME;
      const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
      const {spyOn}=require('bun:test');spyOn(os,'homedir').mockReturnValue(process.env.HOME);
      const home=path.join(process.env.HOME,'.codex'),journal=require('./src/codex/journal');
      const result=journal.reconcileJournal();console.log(JSON.stringify({result,exists:fs.existsSync(home)}));
    `], { cwd: repoRoot(), env: { ...process.env, HOME: parent, USERPROFILE: parent, OPENCODEX_HOME: join(parent, ".ocx-fixture") }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!)).toEqual({ result: false, exists: false });
  });
});


describe("native feature children stay bound to the held home", () => {
  for (const route of ["default-input", "v2"] as const) {
    for (const childThrows of [false, true]) test(`${route}: alias retarget during child execution preserves B and stops parent publication (throws=${childThrows})`, async () => {
      const fs = await import("node:fs");
      const { handleManagementAPI } = await import("../../src/server/management-api");
      const { catalogConvergenceFactory } = await import("../helpers/catalog-convergence");
      const original = route === "v2"
        ? "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n"
        : "[features]\ndefault_mode_request_user_input = false\n";
      const a = fixtureConfig(original), b = fixtureConfig(original);
      const aliasRoot = fs.mkdtempSync(join(tmpdir(), "ocx-child-alias-")); roots.push(aliasRoot);
      const alias = join(aliasRoot, "home"), canonicalA = fs.realpathSync.native(join(a, ".."));
      fs.symlinkSync(canonicalA, alias, "junction");
      // Windows treats Codex_Home as CODEX_HOME; setting it there would replace A with B.
      const caseSensitiveEnv = process.platform !== "win32";
      const previous = { CODEX_HOME: process.env.CODEX_HOME, ORCA_CODEX_HOME: process.env.ORCA_CODEX_HOME,
        ...(caseSensitiveEnv ? { Codex_Home: process.env.Codex_Home } : {}) };
      process.env.CODEX_HOME = alias; process.env.ORCA_CODEX_HOME = join(b, "..");
      if (caseSensitiveEnv) process.env.Codex_Home = join(b, "..");
      let received: NodeJS.ProcessEnv | undefined, lockedAtSpawn = false, converged = false;
      const childBytes = route === "v2" ? original.replace("enabled = true", "enabled = false") : original.replace("= false", "= true");
      const fakeChild = (_enabled: boolean, env: NodeJS.ProcessEnv) => {
        received = env;
        lockedAtSpawn = !withConfigWriteLock(a, () => true).ok;
        fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction");
        if (!env?.CODEX_HOME) return;
        const childPath = join(env.CODEX_HOME, "config.toml");
        fs.writeFileSync(childPath + ".child", childBytes); fs.renameSync(childPath + ".child", childPath);
        if (childThrows) throw new Error("synthetic child exit failure");
      };
      const config = { providers: [], multiAgentMode: "default" as const };
      const url = new URL(route === "v2" ? "http://localhost/api/v2" : "http://localhost/api/codex-auth/features/default-mode-request-user-input");
      try {
        const request = new Request(url, { method: "PUT", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(route === "v2"
          ? { enabled: false, multiAgentMode: "v1", agentsMaxDepth: 5 } : { enabled: true }) });
        const response = await handleManagementAPI(request, url, config, {
          toggleCodexMultiAgentV2: fakeChild, toggleDefaultModeRequestUserInput: fakeChild,
          createManagementConvergeCodex: catalogConvergenceFactory(() => { converged = true; }),
        });
        expect(received?.CODEX_HOME, JSON.stringify(await response?.clone().json())).toBe(canonicalA);
        expect(received?.ORCA_CODEX_HOME).toBeUndefined();
        if (caseSensitiveEnv) expect(received?.Codex_Home).toBeUndefined();
        expect(lockedAtSpawn).toBe(true);
        expect(response?.status).toBe(502);
        expect(await response?.json()).toMatchObject({ retryable: false, error: expect.stringContaining("destination changed") });
        expect(fs.readFileSync(a, "utf8")).toBe(original);
        expect(fs.readFileSync(b, "utf8")).toBe(original);
        expect(config.multiAgentMode).toBe("default"); expect(converged).toBe(false);
        expect(withConfigWriteLock(a, () => true).ok).toBe(true);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    });
  }
});


for (const route of ["default-input", "v2"] as const) test(`${route}: a home retarget after acquisition refuses before the child`, async () => {
  const fs = await import("node:fs"), locks = await import("../../src/codex/config-write-lock");
  const { spyOn } = await import("bun:test");
  const { handleManagementAPI } = await import("../../src/server/management-api");
  const { catalogConvergenceFactory } = await import("../helpers/catalog-convergence");
  const original = "[features.multi_agent_v2]\nenabled = true\n";
  const a = fixtureConfig(original), b = fixtureConfig(original), aliasRoot = fs.mkdtempSync(join(tmpdir(), "ocx-before-child-"));
  roots.push(aliasRoot); const alias = join(aliasRoot, "home");
  fs.symlinkSync(fs.realpathSync.native(join(a, "..")), alias, "junction");
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = alias;
  let children = 0;
  const acquire = locks.acquireConfigWriteLock;
  const spy = spyOn(locks, "acquireConfigWriteLock").mockImplementation(async (...args) => {
    const held = await acquire(...args);
    fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction");
    return held;
  });
  try {
    const url = new URL(route === "v2" ? "http://localhost/api/v2" : "http://localhost/api/codex-auth/features/default-mode-request-user-input");
    const request = new Request(url, { method: "PUT", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    const response = await handleManagementAPI(request, url, { providers: [] }, {
      toggleCodexMultiAgentV2: () => { children++; }, toggleDefaultModeRequestUserInput: () => { children++; },
      createManagementConvergeCodex: catalogConvergenceFactory(),
    });
    expect(response?.status).toBe(502); expect(await response?.json()).toMatchObject({ retryable: false });
    expect(children).toBe(0);
    expect(fs.readFileSync(a, "utf8")).toBe(original); expect(fs.readFileSync(b, "utf8")).toBe(original);
    expect(withConfigWriteLock(a, () => true).ok).toBe(true);
  } finally {
    spy.mockRestore(); if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test("CLI revalidates after executable resolution, immediately before spawning", async () => {
  const fs = await import("node:fs"), { cmdV2 } = await import("../../src/cli/v2");
  const original = "[features.multi_agent_v2]\nenabled = true\n";
  const a = fixtureConfig(original), b = fixtureConfig(original), aliasRoot = fs.mkdtempSync(join(tmpdir(), "ocx-cli-child-"));
  roots.push(aliasRoot); const alias = join(aliasRoot, "home");
  fs.symlinkSync(fs.realpathSync.native(join(a, "..")), alias, "junction");
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = alias;
  let children = 0, synced = false;
  try {
    const result = await cmdV2(["off"], {
      featuresInvocation: () => {
        fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction");
        return { file: "fake-codex", args: [], options: {} };
      },
      execFile: () => { children++; }, sync: async () => { synced = true; }, log: { log() {}, error() {} },
    });
    expect(result).toBe(1); expect(children).toBe(0); expect(synced).toBe(false);
    expect(fs.readFileSync(a, "utf8")).toBe(original); expect(fs.readFileSync(b, "utf8")).toBe(original);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test("CLI passes the held home after invocation options and stops sync on post-child drift", async () => {
  const fs = await import("node:fs"), { cmdV2 } = await import("../../src/cli/v2");
  const original = "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n";
  const a = fixtureConfig(original), b = fixtureConfig(original), aliasRoot = fs.mkdtempSync(join(tmpdir(), "ocx-cli-env-"));
  roots.push(aliasRoot); const alias = join(aliasRoot, "home"), canonicalA = fs.realpathSync.native(join(a, ".."));
  fs.symlinkSync(canonicalA, alias, "junction");
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = alias;
  let received: string | undefined, synced = false;
  const childBytes = original.replace("enabled = true", "enabled = false");
  try {
    const result = await cmdV2(["off"], {
      featuresInvocation: () => ({ file: "fake-codex", args: [], options: { env: { CODEX_HOME: join(b, "..") } } }),
      execFile: (_file, _args, options) => {
        received = options?.env?.CODEX_HOME;
        fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction");
        if (received) fs.writeFileSync(join(received, "config.toml"), childBytes);
      },
      sync: async () => { synced = true; }, log: { log() {}, error() {} },
    });
    expect(received).toBe(canonicalA); expect(result).toBe(1); expect(synced).toBe(false);
    expect(fs.readFileSync(a, "utf8")).toBe(original); expect(fs.readFileSync(b, "utf8")).toBe(original);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});


test("injector restores canonical preimage on non-retryable child drift without publishing artifacts", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const original = 'model = "native"\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n';
  const a = fixtureConfig(original), b = fixtureConfig(original), root = fs.mkdtempSync(join(tmpdir(), "ocx-inject-child-"));
  roots.push(root); const alias = join(root, "home"), canonicalA = fs.realpathSync.native(join(a, ".."));
  fs.symlinkSync(canonicalA, alias, "junction");
  // A differently cased inherited key can override the explicit alias in a Windows child.
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === "CODEX_HOME") delete childEnv[key];
  const child = Bun.spawnSync([process.execPath, "-e", `
    const fs=require('node:fs'),path=require('node:path'),{spyOn}=require('bun:test');
    const eligibility=require('./src/codex/inject-coordination');
    const spy=spyOn(eligibility,'codexWriteCoordinationEligibility').mockReturnValue({kind:'legacy-uncoordinated',reason:'synthetic fixture'});
    const {setCodexMultiAgentV2ToggleForTests}=require('./src/codex/inject/multi-agent-v2');
    let received;
    setCodexMultiAgentV2ToggleForTests((enabled,env)=>{
      received=env.CODEX_HOME;
      fs.unlinkSync(process.env.CODEX_HOME);fs.symlinkSync(process.env.FIXTURE_B,process.env.CODEX_HOME,'junction');
      fs.writeFileSync(path.join(received,'config.toml'),${JSON.stringify(original.replace("enabled = true", "enabled = false"))});
    });
    try{
      const result=await require('./src/codex/inject').injectCodexConfig(20201,{providers:[],multiAgentMode:'v1'},{lockTimeoutMs:0});
      const home=received??${JSON.stringify(canonicalA)};
      console.log(JSON.stringify({result,received:received??null,effectiveHome:require('./src/codex/paths').CODEX_HOME,profile:fs.existsSync(path.join(home,'opencodex.config.toml')),journal:fs.existsSync(path.join(home,'opencodex-journal.json'))}));
    }finally{spy.mockRestore();setCodexMultiAgentV2ToggleForTests(undefined);}
  `], { cwd: repoRoot(), env: { ...childEnv, CODEX_HOME: alias, OPENCODEX_HOME: join(root, ".ocx-fixture"), FIXTURE_B: fs.realpathSync.native(join(b, "..")) }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const output = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
  expect(output.received, JSON.stringify(output)).toBe(canonicalA);
  expect(output.result).toMatchObject({ success: false, retryable: false, message: expect.stringContaining("destination changed") });
  expect(output.profile).toBe(false); expect(output.journal).toBe(false);
  expect(fs.readFileSync(a, "utf8")).toBe(original);
  expect(fs.readFileSync(b, "utf8")).toBe(original);
});


test("a default .codex home alias is also bound to canonical A", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const original = "[features]\ndefault_mode_request_user_input = false\n";
  const a = fixtureConfig(original), b = fixtureConfig(original), root = fs.mkdtempSync(join(tmpdir(), "ocx-default-child-"));
  roots.push(root); const canonicalA = fs.realpathSync.native(join(a, ".."));
  fs.symlinkSync(canonicalA, join(root, ".codex"), "junction");
  const child = Bun.spawnSync([process.execPath, "-e", `
    const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spyOn}=require('bun:test');
    spyOn(os,'homedir').mockReturnValue(process.env.HOME);
    const {handleManagementAPI}=require('./src/server/management-api');
    const {catalogConvergenceFactory}=require('./tests/helpers/catalog-convergence');let received;
    const url=new URL('http://localhost/api/codex-auth/features/default-mode-request-user-input');
    const req=new Request(url,{method:'PUT',headers:{host:'localhost','content-type':'application/json'},body:JSON.stringify({enabled:true})});
    const response=await handleManagementAPI(req,url,{providers:[]},{
      createManagementConvergeCodex:catalogConvergenceFactory(),
      toggleDefaultModeRequestUserInput:(enabled,env)=>{
        received=env.CODEX_HOME;const alias=path.join(process.env.HOME,'.codex');
        fs.unlinkSync(alias);fs.symlinkSync(process.env.FIXTURE_B,alias,'junction');
        fs.writeFileSync(path.join(received,'config.toml'),${JSON.stringify(original.replace("= false", "= true"))});
      },
    });
    console.log(JSON.stringify({received,status:response.status,body:await response.json()}));
  `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: undefined, HOME: root, USERPROFILE: root, WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined, OPENCODEX_HOME: join(root, ".ocx-fixture"), FIXTURE_B: fs.realpathSync.native(join(b, "..")) }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const output = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
  expect(output.received).toBe(canonicalA); expect(output.status).toBe(502); expect(output.body.retryable).toBe(false);
  expect(fs.readFileSync(a, "utf8")).toBe(original); expect(fs.readFileSync(b, "utf8")).toBe(original);
});


for (const enabled of [false, true]) test(`native transition refuses differently named symlink before writes (enabled=${enabled})`, async () => {
  const fs = await import("node:fs");
  const original = enabled ? "[agents]\nmax_threads = 7\n" : "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n";
  const config = fixtureConfig(original), home = join(config, ".."), dotfiles = fs.mkdtempSync(join(tmpdir(), "ocx-dotfiles-"));
  roots.push(dotfiles); const target = join(dotfiles, "codex.toml");
  fs.renameSync(config, target); fs.symlinkSync(target, config);
  let children = 0;
  const result = transitionMultiAgentV2(enabled, (_enabled, env) => {
    children++; fs.writeFileSync(join(env.CODEX_HOME!, "config.toml"), "child write");
  }, { configPath: config });
  expect(result).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining("config.toml is a symlink to a differently named file") });
  expect(children).toBe(0); expect(fs.readFileSync(target, "utf8")).toBe(original);
  expect(fs.existsSync(join(dotfiles, "config.toml"))).toBe(false); expect(fs.lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(true);
});

test("default feature toggle refuses differently named symlink before spawning", async () => {
  const fs = await import("node:fs"), { handleManagementAPI } = await import("../../src/server/management-api");
  const original = "[features]\ndefault_mode_request_user_input = false\n", config = fixtureConfig(original);
  const dotfiles = fs.mkdtempSync(join(tmpdir(), "ocx-toggle-dotfiles-")); roots.push(dotfiles);
  const target = join(dotfiles, "codex.toml"); fs.renameSync(config, target); fs.symlinkSync(target, config);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = join(config, ".."); let children = 0;
  try {
    const url = new URL("http://localhost/api/codex-auth/features/default-mode-request-user-input");
    const response = await handleManagementAPI(new Request(url, { method: "PUT", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) }), url, { providers: [] }, {
      toggleDefaultModeRequestUserInput: (_enabled, env) => { children++; fs.writeFileSync(join(env.CODEX_HOME!, "config.toml"), "child write"); },
    });
    expect(response?.status).toBe(502); expect(await response?.json()).toMatchObject({ retryable: false, error: expect.stringContaining("differently named file") });
    expect(children).toBe(0); expect(fs.readFileSync(target, "utf8")).toBe(original); expect(fs.existsSync(join(dotfiles, "config.toml"))).toBe(false);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test("enable transition restores the original legacy limit rather than its staged migration on child drift", async () => {
  const fs = await import("node:fs");
  const original = "# preserve CRLF\r\n[agents]\r\nmax_threads = 7 # children\r\n", a = fixtureConfig(original), b = fixtureConfig("model = \"B\"\n");
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-enable-drift-")); roots.push(root); const alias = join(root, "home");
  fs.symlinkSync(fs.realpathSync.native(join(a, "..")), alias, "junction"); let staged = false;
  const result = transitionMultiAgentV2(true, (_enabled, env) => {
    const target = join(env.CODEX_HOME!, "config.toml"); staged = fs.readFileSync(target, "utf8") !== original;
    fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction");
    fs.writeFileSync(target, "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 8\n");
  }, { configPath: join(alias, "config.toml") });
  expect(staged).toBe(true); expect(result).toMatchObject({ ok: false, retryable: false });
  expect(fs.readFileSync(a)).toEqual(Buffer.from(original)); expect(fs.readFileSync(b, "utf8")).toBe("model = \"B\"\n");
});

for (const missing of [false, true]) test(`native child drift restores the immediate pre-spawn bytes or absence (missing=${missing})`, async () => {
  const fs = await import("node:fs"), { runConfigWriteChild } = await import("../../src/codex/config-write-lock");
  const a = fixtureConfig("initial"), b = fixtureConfig("B"), root = fs.mkdtempSync(join(tmpdir(), "ocx-child-preimage-")); roots.push(root);
  const alias = join(root, "home"); fs.symlinkSync(fs.realpathSync.native(join(a, "..")), alias, "junction"); if (missing) fs.unlinkSync(a);
  const bytes = Buffer.from([0xff, 0x0d, 0x0a, 0x00, 0x61]);
  withConfigWriteLock(join(alias, "config.toml"), held => {
    expect(() => runConfigWriteChild(join(alias, "config.toml"), held, (env, validate) => {
      if (!missing) fs.writeFileSync(a, bytes); // executable-resolution work precedes the actual spawn validator
      validate();
      fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction"); fs.writeFileSync(join(env.CODEX_HOME!, "config.toml"), "child bytes");
    })).toThrow("destination changed");
  });
  if (missing) expect(fs.existsSync(a)).toBe(false); else expect(fs.readFileSync(a)).toEqual(bytes);
  expect(fs.readFileSync(b, "utf8")).toBe("B");
});

test("canonical recovery refuses a subsequent writer even when its inode stays the same", async () => {
  const fs = await import("node:fs"), { spyOn } = await import("bun:test");
  const atomic = await import("../../src/config/atomic-write"), { runConfigWriteChild } = await import("../../src/codex/config-write-lock");
  const a = fixtureConfig("preimage"), b = fixtureConfig("B"), root = fs.mkdtempSync(join(tmpdir(), "ocx-recovery-race-")); roots.push(root);
  const alias = join(root, "home"); fs.symlinkSync(fs.realpathSync.native(join(a, "..")), alias, "junction");
  const writer = atomic.atomicWriteFileStreamed;
  const spy = spyOn(atomic, "atomicWriteFileStreamed").mockImplementation((path, write, hooks) => {
    if (path === fs.realpathSync.native(a)) fs.writeFileSync(path, "subsequent independent writer"); return writer(path, write, hooks);
  });
  try {
    withConfigWriteLock(join(alias, "config.toml"), held => {
      expect(() => runConfigWriteChild(join(alias, "config.toml"), held, env => {
        fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction"); fs.writeFileSync(join(env.CODEX_HOME!, "config.toml"), "child bytes");
      })).toThrow("canonical preimage recovery refused");
    });
    expect(fs.readFileSync(a, "utf8")).toBe("subsequent independent writer"); expect(fs.readFileSync(b, "utf8")).toBe("B");
  } finally { spy.mockRestore(); }
});


test("alias-only drift restores canonical bytes while holding the canonical lock", async () => {
  const fs = await import("node:fs"), { runConfigWriteChild } = await import("../../src/codex/config-write-lock");
  const original = Buffer.from("# original\r\n[features.multi_agent_v2]\r\nenabled = true\r\nmax_concurrent_threads_per_session = 64\r\n");
  const a = fixtureConfig(original.toString()), b = fixtureConfig("B"), root = fs.mkdtempSync(join(tmpdir(), "ocx-alias-only-")); roots.push(root);
  const alias = join(root, "home"); fs.symlinkSync(fs.realpathSync.native(join(a, "..")), alias, "junction");
  withConfigWriteLock(join(alias, "config.toml"), held => {
    expect(() => runConfigWriteChild(join(alias, "config.toml"), held, env => {
      fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction"); fs.writeFileSync(join(env.CODEX_HOME!, "config.toml"), "child bytes");
    })).toThrow("canonical preimage restored");
    expect(withConfigWriteLock(a, () => true).ok).toBe(false); expect(fs.readFileSync(a)).toEqual(original);
  });
  expect(fs.readFileSync(b, "utf8")).toBe("B");
});

test("canonical-target replacement refuses restore and retains byte-identical recovery evidence", async () => {
  const fs = await import("node:fs"), { spyOn } = await import("bun:test");
  const atomic = await import("../../src/config/atomic-write"), { runConfigWriteChild } = await import("../../src/codex/config-write-lock");
  const original = Buffer.from("# recovery\r\n[features.multi_agent_v2]\r\nenabled = true\r\nmax_concurrent_threads_per_session = 64\r\n");
  const a = fixtureConfig(original.toString()), b = fixtureConfig("B"), root = fs.mkdtempSync(join(tmpdir(), "ocx-canonical-replacement-")); roots.push(root);
  const alias = join(root, "home"), canonical = fs.realpathSync.native(a); fs.symlinkSync(fs.realpathSync.native(join(a, "..")), alias, "junction");
  const writer = atomic.atomicWriteFileStreamed; let lockedAtPublication = false;
  const spy = spyOn(atomic, "atomicWriteFileStreamed").mockImplementation((path, write, hooks) => writer(path, write, path === canonical ? {
    ...hooks, beforeRename: () => {
      lockedAtPublication = !withConfigWriteLock(a, () => true).ok;
      fs.writeFileSync(a + ".replacement", "independent replacement"); fs.renameSync(a + ".replacement", a);
    },
  } : hooks));
  try {
    withConfigWriteLock(join(alias, "config.toml"), held => {
      expect(() => runConfigWriteChild(join(alias, "config.toml"), held, env => {
        fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction"); fs.writeFileSync(join(env.CODEX_HOME!, "config.toml"), "child bytes");
      })).toThrow("canonical preimage recovery refused");
    });
    expect(lockedAtPublication).toBe(true); expect(fs.readFileSync(a, "utf8")).toBe("independent replacement"); expect(fs.readFileSync(b, "utf8")).toBe("B");
    const evidence = fs.readdirSync(join(a, "..")).filter(name => name.startsWith("config.toml.ocx-native-preimage."));
    expect(evidence.length).toBe(1); expect(fs.readFileSync(join(a, "..", evidence[0]!))).toEqual(original);
    if (process.platform !== "win32") expect(fs.statSync(join(a, "..", evidence[0]!)).mode & 0o777).toBe(0o600);
  } finally { spy.mockRestore(); }
});


test("canonical target redirected by the child refuses recovery without touching its new target", async () => {
  const fs = await import("node:fs"), { runConfigWriteChild } = await import("../../src/codex/config-write-lock");
  const original = "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n";
  const a = fixtureConfig(original), b = fixtureConfig("B"), canonical = fs.realpathSync.native(a);
  const journal = join(canonical, "..", "opencodex-journal.json"); fs.writeFileSync(journal, "retained journal authority");
  withConfigWriteLock(a, held => {
    expect(() => runConfigWriteChild(a, held, () => {
      fs.writeFileSync(canonical, "child bytes"); fs.renameSync(canonical, canonical + ".child-left"); fs.symlinkSync(fs.realpathSync.native(b), canonical);
    })).toThrow("canonical preimage recovery refused");
  });
  expect(fs.lstatSync(a).isSymbolicLink()).toBe(true); expect(fs.readFileSync(b, "utf8")).toBe("B");
  expect(fs.readFileSync(canonical + ".child-left", "utf8")).toBe("child bytes"); expect(fs.readFileSync(journal, "utf8")).toBe("retained journal authority");
  const evidence = fs.readdirSync(join(canonical, "..")).filter(name => name.startsWith("config.toml.ocx-native-preimage."));
  expect(evidence.length).toBe(1); expect(fs.readFileSync(join(canonical, "..", evidence[0]!), "utf8")).toBe(original);
});


test("canonical recovery validates the actual atomic destination before publication", async () => {
  const fs = await import("node:fs"), { spyOn } = await import("bun:test");
  const atomic = await import("../../src/config/atomic-write"), { runConfigWriteChild } = await import("../../src/codex/config-write-lock");
  const a = fixtureConfig("preimage"), b = fixtureConfig("B"), root = fs.mkdtempSync(join(tmpdir(), "ocx-recovery-target-")); roots.push(root);
  const alias = join(root, "home"), canonical = fs.realpathSync.native(a); fs.symlinkSync(fs.realpathSync.native(join(a, "..")), alias, "junction");
  const writer = atomic.atomicWriteFileStreamed;
  const spy = spyOn(atomic, "atomicWriteFileStreamed").mockImplementation((path, write, hooks) => writer(path === canonical ? fs.realpathSync.native(b) : path, write, hooks));
  try {
    withConfigWriteLock(join(alias, "config.toml"), held => {
      expect(() => runConfigWriteChild(join(alias, "config.toml"), held, env => {
        fs.unlinkSync(alias); fs.symlinkSync(fs.realpathSync.native(join(b, "..")), alias, "junction"); fs.writeFileSync(join(env.CODEX_HOME!, "config.toml"), "child bytes");
      })).toThrow("canonical preimage recovery refused");
    });
    expect(fs.readFileSync(a, "utf8")).toBe("child bytes"); expect(fs.readFileSync(b, "utf8")).toBe("B");
    const evidence = fs.readdirSync(join(canonical, "..")).filter(name => name.startsWith("config.toml.ocx-native-preimage."));
    expect(evidence.length).toBe(1); expect(fs.readFileSync(join(canonical, "..", evidence[0]!), "utf8")).toBe("preimage");
  } finally { spy.mockRestore(); }
});


test("canonical dangling symlink is a changed target rather than proven absence", async () => {
  const fs = await import("node:fs"), { runConfigWriteChild } = await import("../../src/codex/config-write-lock");
  const a = fixtureConfig("preimage"), canonical = fs.realpathSync.native(a), missingTarget = canonical + ".missing";
  withConfigWriteLock(a, held => {
    expect(() => runConfigWriteChild(a, held, () => { fs.unlinkSync(canonical); fs.symlinkSync(missingTarget, canonical); })).toThrow("canonical preimage recovery refused");
  });
  expect(fs.lstatSync(a).isSymbolicLink()).toBe(true); expect(fs.readlinkSync(a)).toBe(missingTarget); expect(fs.existsSync(missingTarget)).toBe(false);
  const evidence = fs.readdirSync(join(canonical, "..")).filter(name => name.startsWith("config.toml.ocx-native-preimage."));
  expect(evidence.length).toBe(1); expect(fs.readFileSync(join(canonical, "..", evidence[0]!), "utf8")).toBe("preimage");
});

for (const point of ["wrapper entry", "initial spawn validator"]) test(`transition recovers alias drift before ${point}`, async () => {
  const fs = await import("node:fs"), { spyOn } = await import("bun:test");
  const atomic = await import("../../src/config/atomic-write");
  const original = Buffer.from("# exact CRLF\r\n[agents]\r\nmax_threads = 7 # children\r\n");
  const a = fixtureConfig(original.toString()), b = fixtureConfig("model = \"B\"\n");
  const canonical = fs.realpathSync.native(a), home = join(canonical, ".."), root = fs.mkdtempSync(join(tmpdir(), "ocx-staged-entry-")); roots.push(root);
  const alias = join(root, "home"), bHome = fs.realpathSync.native(join(b, "..")); fs.symlinkSync(home, alias, "junction");
  const retarget = () => { fs.unlinkSync(alias); fs.symlinkSync(bHome, alias, "junction"); };
  const writer = atomic.atomicWriteFile, realpath = fs.realpathSync.native; let staged = false, homeReads = 0, children = 0;
  const publication = spyOn(atomic, "atomicWriteFile").mockImplementation((path, content, io, hooks) => {
    writer(path, content, io, hooks);
    if (path === canonical && content.includes("enabled = false")) {
      staged = true;
      expect(content).not.toContain("max_threads =");
      if (point === "wrapper entry") retarget();
    }
  });
  const resolution = spyOn(fs.realpathSync, "native").mockImplementation((path, options) => {
    const resolved = realpath(path, options);
    // The native assertion reads the home first; environment preparation reads it
    // again immediately before the wrapper's initial spawn validation.
    if (point === "initial spawn validator" && staged && path === home && ++homeReads === 2) retarget();
    return resolved;
  });
  try {
    const result = transitionMultiAgentV2(true, () => { children++; }, { configPath: join(alias, "config.toml") });
    expect(staged).toBe(true); expect(children).toBe(0);
    expect(fs.readFileSync(a)).toEqual(original); expect(fs.readFileSync(b, "utf8")).toBe("model = \"B\"\n");
    expect(result).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining("canonical preimage restored") });
  } finally { publication.mockRestore(); resolution.mockRestore(); }
});

for (const missing of [false, true]) test(`toggle initial spawn validator retains recovery protection (missing=${missing})`, async () => {
  const fs = await import("node:fs"), { spyOn } = await import("bun:test");
  const { runConfigWriteChild } = await import("../../src/codex/config-write-lock");
  const a = fixtureConfig("original\r\n"), b = fixtureConfig("B"), canonical = fs.realpathSync.native(a), home = join(canonical, "..");
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-initial-validator-")); roots.push(root);
  const alias = join(root, "home"), bHome = fs.realpathSync.native(join(b, "..")); fs.symlinkSync(home, alias, "junction");
  if (missing) fs.unlinkSync(a);
  const realpath = fs.realpathSync.native; let homeReads = 0, children = 0;
  const resolution = spyOn(fs.realpathSync, "native").mockImplementation((path, options) => {
    const resolved = realpath(path, options);
    if (path === home && ++homeReads === 2) { fs.unlinkSync(alias); fs.symlinkSync(bHome, alias, "junction"); }
    return resolved;
  });
  try {
    withConfigWriteLock(join(alias, "config.toml"), held => {
      expect(() => runConfigWriteChild(join(alias, "config.toml"), held, () => { children++; })).toThrow("canonical preimage restored");
    });
    expect(children).toBe(0); expect(fs.readFileSync(b, "utf8")).toBe("B");
    if (missing) expect(fs.existsSync(a)).toBe(false); else expect(fs.readFileSync(a)).toEqual(Buffer.from("original\r\n"));
  } finally { resolution.mockRestore(); }
});

for (const point of ["wrapper entry", "spawn revalidation"]) test(`changed canonical file before ${point} retains the original preimage`, async () => {
  const fs = await import("node:fs"), { spyOn } = await import("bun:test");
  const atomic = await import("../../src/config/atomic-write");
  const original = Buffer.from("# preserve bytes\r\n[agents]\r\nmax_threads = 7\r\n");
  const a = fixtureConfig(original.toString()), canonical = fs.realpathSync.native(a), writer = atomic.atomicWriteFile;
  const replace = () => { fs.writeFileSync(a + ".replacement", "independent replacement"); fs.renameSync(a + ".replacement", a); };
  let staged = false, children = 0;
  const publication = spyOn(atomic, "atomicWriteFile").mockImplementation((path, content, io, hooks) => {
    writer(path, content, io, hooks);
    if (path === canonical && content.includes("enabled = false")) { staged = true; if (point === "wrapper entry") replace(); }
  });
  try {
    const result = transitionMultiAgentV2(true, (_enabled, _env, validate) => {
      replace(); validate(); children++;
    }, { configPath: a });
    expect(staged).toBe(true); expect(children).toBe(0);
    expect(result).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining("canonical preimage recovery refused") });
    expect(fs.readFileSync(a, "utf8")).toBe("independent replacement");
    const evidence = fs.readdirSync(join(canonical, "..")).filter(name => name.startsWith("config.toml.ocx-native-preimage."));
    expect(evidence).toHaveLength(1); expect(fs.readFileSync(join(canonical, "..", evidence[0]!))).toEqual(original);
  } finally { publication.mockRestore(); }
});

test("failed standalone toggle restores its exact preimage", async () => {
  const fs = await import("node:fs"), { runConfigWriteChild } = await import("../../src/codex/config-write-lock");
  const original = Buffer.from([0xff, 0x0d, 0x0a, 0x00]), a = fixtureConfig(""); fs.writeFileSync(a, original);
  withConfigWriteLock(a, held => {
    expect(() => runConfigWriteChild(a, held, env => {
      fs.writeFileSync(join(env.CODEX_HOME!, "config.toml"), "partial toggle"); throw new Error("child failed");
    })).toThrow("child failed");
    expect(fs.readFileSync(a)).toEqual(original);
  });
});
