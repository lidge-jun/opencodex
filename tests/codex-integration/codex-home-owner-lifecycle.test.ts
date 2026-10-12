import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_HOME_JOURNAL_FILE } from "../../src/codex/codex-home-owner";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);
let root: string, codexHome: string, ownHome: string, otherHome: string;
const original = 'model = "gpt-6.1-sol"\n';
const injected = '# opencodex injected\nopenai_base_url = "http://127.0.0.1:10100/v1"\n';
const profile = "# generated profile\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function snapshot(home?: string): string {
  return JSON.stringify({ version: 1, originalConfig: Buffer.from(original).toString("base64"),
    originalProfile: null, injectedConfigHash: hash(injected), injectedProfileHash: hash(profile),
    injectedOpenaiBaseUrl: "http://127.0.0.1:10100/v1", pid: 99999999,
    timestamp: "2026-10-04T00:00:00.000Z", ...(home === undefined ? {} : { opencodexHome: home }) });
}
function seed(bytes: string, config = injected): void {
  writeFileSync(join(codexHome, "config.toml"), config);
  writeFileSync(join(codexHome, "opencodex.config.toml"), profile);
  writeFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), bytes);
  writeFileSync(join(codexHome, "opencodex-catalog.json"), '{"models":[]}');
  writeFileSync(join(codexHome, "models_cache.json"), "cache-before");
}
function bytes(): Record<string, string | null> {
  return Object.fromEntries(["config.toml", "opencodex.config.toml", CODEX_HOME_JOURNAL_FILE,
    "opencodex-catalog.json", "models_cache.json"].map(file => [file,
    existsSync(join(codexHome, file)) ? readFileSync(join(codexHome, file), "utf8") : null]));
}
function run(script: string): Record<string, unknown> {
  const child = spawnSync(process.execPath, ["--eval", script], { cwd: repoRoot(),
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "", OPENCODEX_HOME: ownHome },
    encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000 });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}");
}
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-owner-lifecycle-")));
  codexHome = join(root, "codex"); ownHome = join(root, "own"); otherHome = join(root, "other");
  for (const home of [codexHome, ownHome, otherHome]) mkdirSync(home);
  writeFileSync(join(ownHome, "config.json"), '{"providers":{}}');
});
afterEach(() => removeTreeWithRetry(root));

for (const external of [false, true]) {
  for (const owner of ["foreign", "unknown"] as const) {
    test(`${owner} injection preflight and full apply preserve ${external ? "external" : "native"} configuration`, () => {
      seed(owner === "foreign" ? snapshot(otherHome) : "{corrupt", external ? 'model_provider = "external"\n' : original);
      const before = bytes();
      const result = run(`const {injectCodexConfig}=require("./src/codex/inject");
        const preflight=await injectCodexConfig(10100, {}, {validateOnly:true});
        const applied=await injectCodexConfig(10100, {});
        console.log(JSON.stringify({preflight,applied}));`);
      const reason = owner === "foreign" ? "foreign-owner" : "owner-unknown";
      expect(result.preflight).toMatchObject({ success: false, ownershipRefusal: reason });
      expect(result.applied).toMatchObject({ success: false, ownershipRefusal: reason });
      expect(JSON.stringify(result)).not.toContain(otherHome);
      expect(bytes()).toEqual(before);
    });
    test(`${owner} synchronous and asynchronous restore refuse before ${external ? "external cleanup" : "native writes"}`, () => {
      seed(owner === "foreign" ? snapshot(otherHome) : "{corrupt", external ? 'model_provider = "external"\n' : injected);
      const before = bytes();
      const result = run(`const r=require("./src/codex/inject/restore");
        console.log(JSON.stringify({sync:r.restoreNativeCodex({skipHistory:true}),async:await r.restoreNativeCodexAsync()}));`);
      for (const mode of ["sync", "async"]) {
        expect(result[mode]).toMatchObject({ success: false, ownershipRefusal: owner === "foreign" ? "foreign-owner" : "owner-unknown",
          artifacts: { config: { state: "skipped" }, catalog: { state: "skipped" }, history: { state: "skipped" } } });
      }
      expect(JSON.stringify(result)).not.toContain(otherHome);
      expect(bytes()).toEqual(before);
    });
  }
}

test("direct reconciliation, snapshot restore and cleanup preserve foreign/unknown evidence", () => {
  for (const binding of [snapshot(otherHome), "{corrupt"]) {
    seed(binding); const before = bytes();
    const result = run(`const j=require("./src/codex/journal");
      const reconciled=j.reconcileJournal(); const restored=j.restoreJournalState();
      let cleanup;try {j.removeJournal();} catch(e) {cleanup=e.reason;}
      console.log(JSON.stringify({reconciled,restored,cleanup}));`);
    expect(result.reconciled).toBe(false);
    expect(result.restored).toMatchObject({ complete: false, unverified: true });
    expect(result.cleanup).toBe(binding.startsWith("{corrupt") ? "owner-unknown" : "foreign-owner");
    expect(bytes()).toEqual(before);
  }
});

for (const mode of ["sync", "async"] as const) {
  test(`${mode} restore rechecks a newly foreign binding before first artifact write`, () => {
    seed(snapshot(ownHome));
    const foreign = snapshot(otherHome);
    const before = bytes();
    const result = run(`const r=require("./src/codex/inject/restore");const j=require("./src/codex/journal");
      r.setBeforeRestoreConfigForTests(()=>require("node:fs").writeFileSync(j.JOURNAL_PATH,${JSON.stringify(foreign)}));
      const result=${mode === "sync" ? 'r.restoreNativeCodex({skipHistory:true})' : 'await r.restoreNativeCodexAsync()'};
      console.log(JSON.stringify(result));`);
    expect(result).toMatchObject({ success: false, ownershipRefusal: "foreign-owner" });
    expect(bytes()).toEqual({ ...before, [CODEX_HOME_JOURNAL_FILE]: foreign });
  });
}

test("injection final guard preserves newly foreign evidence rather than compensating it away", () => {
  writeFileSync(join(codexHome, "config.toml"), original);
  const foreign = snapshot(otherHome);
  const result = run(`const i=require("./src/codex/inject");const j=require("./src/codex/journal");
    i.setBeforeHistoryArtifactCommitForTests(()=>require("node:fs").writeFileSync(j.JOURNAL_PATH,${JSON.stringify(foreign)}));
    console.log(JSON.stringify(await i.injectCodexConfig(10100,{})));`);
  expect(result).toMatchObject({ success: false, ownershipRefusal: "foreign-owner" });
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  expect(readFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), "utf8")).toBe(foreign);
  expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
});

test("owned injection failures retain the existing compensation", () => {
  writeFileSync(join(codexHome, "config.toml"), original);
  const result = run(`const i=require("./src/codex/inject");
    i.setHistoryArtifactStageForTests(stage=>{if(stage==="after-config")throw new Error("fixture write failure");});
    let failed=false;try {await i.injectCodexConfig(10100,{});} catch(e) {failed=e.message==="fixture write failure";}
    console.log(JSON.stringify({failed}));`);
  expect(result.failed).toBe(true);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  expect(existsSync(join(codexHome, CODEX_HOME_JOURNAL_FILE))).toBe(false);
  expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
});

test("owner and legacy journal restores release binding after native config/profile restoration", () => {
  for (const binding of [ownHome, undefined]) {
    seed(snapshot(binding));
    const result = run(`const j=require("./src/codex/journal");console.log(JSON.stringify(j.restoreJournalState()));`);
    expect(result).toMatchObject({ complete: true, configRestored: true, profileRestored: true });
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(codexHome, CODEX_HOME_JOURNAL_FILE))).toBe(false);
    expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
  }
});

test("hashless legacy restore remains unverified and preserves its snapshot", () => {
  const legacy = JSON.parse(snapshot()); delete legacy.injectedConfigHash; delete legacy.injectedProfileHash;
  seed(JSON.stringify(legacy)); const before = bytes();
  const result = run(`console.log(JSON.stringify(require("./src/codex/journal").restoreJournalState()));`);
  expect(result).toMatchObject({ complete: false, unverified: true });
  expect(bytes()).toEqual(before);
});

test("successful native restore retains its release point even when catalog K is busy", () => {
  seed(snapshot(ownHome));
  const result = run(`const {withCatalogWriteSerialization}=require("./src/codex/catalog-write-serialization");
    const {restoreNativeCodex}=require("./src/codex/inject/restore");
    const outer=withCatalogWriteSerialization(process.env.CODEX_HOME,()=>restoreNativeCodex({skipHistory:true}),
      {intent:"restore",writer:"test-owner-release"});
    if(outer.kind!=="completed") throw new Error(JSON.stringify(outer));
    console.log(JSON.stringify(outer.value));`);
  expect(result).toMatchObject({ success: false, artifacts: { config: { state: "ok" }, catalog: { state: "failed" } } });
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  expect(existsSync(join(codexHome, CODEX_HOME_JOURNAL_FILE))).toBe(false);
  expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
});

test("catalog-only restoration retains the owner binding", () => {
  seed(snapshot(ownHome)); const before = readFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), "utf8");
  run(`require("./src/codex/catalog/restore").restoreCodexCatalog();console.log("{}");`);
  expect(readFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), "utf8")).toBe(before);
});

test("proven stale binding reconciliation restores and releases the native snapshot", () => {
  seed(snapshot(otherHome)); rmSync(otherHome, { recursive: true });
  const result = run(`console.log(JSON.stringify({restored:require("./src/codex/journal").reconcileJournal()}));`);
  expect(result.restored).toBe(true);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  expect(existsSync(join(codexHome, CODEX_HOME_JOURNAL_FILE))).toBe(false);
});

for (const mode of ["sync", "async"] as const) {
  test(`${mode} owner restore after config edits releases binding for second-home admission`, () => {
    const journalBytes = snapshot(ownHome);
    const edited = injected + '# user edit after injection\nmodel = "user-edited-model"\n';
    seed(journalBytes, edited);
    const result = run(`const r=require("./src/codex/inject/restore");
      const fs=require("node:fs");const j=require("./src/codex/journal");
      const restored=${mode === "sync" ? 'r.restoreNativeCodex({skipHistory:true})' : 'await r.restoreNativeCodexAsync()'};
      const retained=JSON.parse(fs.readFileSync(j.JOURNAL_PATH,"utf8"));
      process.env.OPENCODEX_HOME=${JSON.stringify(otherHome)};
      const {withCatalogWriteSerialization}=require("./src/codex/catalog-write-serialization");
      const admission=withCatalogWriteSerialization(process.env.CODEX_HOME,()=>"second-home-admitted",
        {intent:"refresh",writer:"test-second-home"});
      console.log(JSON.stringify({restored,retained,admission}));`);
    expect(result.restored).toMatchObject({ success: true, artifacts: { config: { state: "ok", action: "owned-fields-stripped" } } });
    const recovery = JSON.parse(journalBytes); delete recovery.opencodexHome;
    expect(result.retained).toEqual(recovery);
    expect(result.admission).toEqual({ kind: "completed", value: "second-home-admitted" });
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model = "user-edited-model"');
    expect(config).not.toContain("openai_base_url");
    expect(existsSync(join(codexHome, "opencodex.config.toml"))).toBe(false);
  });
}

test("failed field-level binding release compensates the old binding and native files", () => {
  seed(snapshot(ownHome), injected + '# preserve user edit\n');
  const before = bytes();
  const result = run(`const {spyOn}=require("bun:test");const config=require("./src/config");
    const r=require("./src/codex/inject/restore");const j=require("./src/codex/journal");
    const originalWrite=config.atomicWriteFile;
    const spy=spyOn(config,"atomicWriteFile").mockImplementation((path,content,...rest)=>{
      const result=originalWrite(path,content,...rest);
      if(path===j.JOURNAL_PATH && JSON.parse(content).opencodexHome===undefined)
        throw new Error("fixture binding release failure");
      return result;
    });
    try {console.log(JSON.stringify(r.restoreNativeCodex({skipHistory:true})));} finally {spy.mockRestore();}`);
  expect(result).toMatchObject({ success: false, artifacts: { config: { state: "failed" } } });
  expect(bytes()).toEqual(before);
});

for (const mode of ["sync", "async"] as const) {
  for (const edited of [false, true]) {
    test(`${mode} generated-profile unlink EPERM retains binding and compensates ${edited ? "edited" : "unchanged"} config`, () => {
      seed(snapshot(ownHome), injected + (edited ? '# user edit after injection\n' : ""));
      const before = bytes();
      const result = run(`const {spyOn}=require("bun:test");const fs=require("node:fs");
        const CODEX_PROFILE_PATH=require("node:path").join(process.env.CODEX_HOME,"opencodex.config.toml");
        const originalUnlink=fs.unlinkSync;let denied=0;
        const spy=spyOn(fs,"unlinkSync").mockImplementation((path)=>{
          if(path===CODEX_PROFILE_PATH) {denied++;throw Object.assign(new Error("fixture profile unlink denied"),{code:"EPERM"});}
          return originalUnlink(path);
        });
        require("node:module").syncBuiltinESMExports();
        const r=require("./src/codex/inject/restore");
        try {
          const restored=${mode === "sync" ? 'r.restoreNativeCodex({skipHistory:true})' : 'await r.restoreNativeCodexAsync()'};
          console.log(JSON.stringify({restored,denied}));
        } finally {spy.mockRestore();}`);
      expect(result).toMatchObject({ denied: 1, restored: { success: false,
        artifacts: { config: { state: "failed", changed: false }, catalog: { state: "skipped" }, history: { state: "skipped" } } } });
      expect(bytes()).toEqual(before);
    });
  }
}

test("deliberately preserved user-edited profile still permits successful native restore and release", () => {
  seed(snapshot(ownHome), injected + '# user config edit\n');
  const editedProfile = profile + '# user profile edit\n';
  writeFileSync(join(codexHome, "opencodex.config.toml"), editedProfile);
  const result = run(`const r=require("./src/codex/inject/restore");
    console.log(JSON.stringify(r.restoreNativeCodex({skipHistory:true})));`);
  expect(result).toMatchObject({ success: true, artifacts: { config: { state: "ok" } } });
  expect(readFileSync(join(codexHome, "opencodex.config.toml"), "utf8")).toBe(editedProfile);
  const retained = JSON.parse(readFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), "utf8"));
  expect(retained.opencodexHome).toBeUndefined();
});
