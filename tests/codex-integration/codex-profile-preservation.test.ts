/**
 * Rebuilding `opencodex.config.toml` keeps the operator's unmanaged root keys
 * (#8066). These cases pin the parts that can corrupt the file: original bytes
 * survive values Bun cannot decode, a carried key never collides with a table the
 * generated profile writes, the plan reads the real profile path, and an edit that
 * lands before the write lock is not overwritten.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotRealCodexHomeUnderTest, isTestHomeGuardArmed } from "../../src/lib/test-home-guard";
import { helperPath, repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

// The guard must remain armed even when this file is run outside the repository preload.
if (!isTestHomeGuardArmed()) throw new Error("test home guard is not armed");
if (process.env.OCX_REAL_HOME) {
  let refused = false;
  try { assertNotRealCodexHomeUnderTest(join(process.env.OCX_REAL_HOME, ".codex")); }
  catch (error) {
    if (/refusing to write the real Codex home/.test(String(error))) refused = true;
    else throw error;
  }
  if (!refused) throw new Error("real Codex home guard identity mismatch");
}
const { buildProfileFileForTarget, preserveUnmanagedProfileKeys } = await import("../../src/codex/inject/config-toml");

const loopback = { baseUrl: "http://127.0.0.1:10100/v1", requiresAdmissionToken: false, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" as const };
const remote = { baseUrl: "http://10.20.30.40:10100/v1", requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" as const };
const WIDE = "9223372036854775807";

describe("carried assignments keep their original bytes", () => {
  test.each([
    `limits = [${WIDE}]`,
    `limits = [\n  1,\n  -9_223_372_036_854_775_808, # floor\n]`,
    `limits = { ceiling = 0x7fff_ffff_ffff_ffff, label = "${WIDE}" }`,
  ])("an integer Bun cannot represent survives regeneration (%s)", assignment => {
    const generated = buildProfileFileForTarget(loopback, null, false, true);
    const merged = preserveUnmanagedProfileKeys(`${assignment}\nstream_max_retries = 8\n`, generated);
    expect(merged).toContain(`${assignment}\nstream_max_retries = 8\n`);
    expect(merged.indexOf("limits")).toBeLessThan(merged.indexOf("[features]"));
    // These are valid TOML 1.0 integers that Codex reads, but Bun cannot decode them (dev
    // already preserves wide scalars this way), so check the rest of the document with
    // them swapped for an in-range value.
    expect(() => Bun.TOML.parse(merged.replace(/-?(?:9_?223_?372_?036_?854_?775_?80[78]|0x7fff_ffff_ffff_ffff)/g, "0"))).not.toThrow();
  });

  test("a carried assignment keeps its trailing spaces and comment exactly", () => {
    const assignment = "stream_max_retries = 8   # keep   ";
    const merged = preserveUnmanagedProfileKeys(`${assignment}\n\n\n`, buildProfileFileForTarget(loopback, null));
    expect(merged).toContain(`${assignment}\n`);
    expect(Bun.TOML.parse(merged)).toMatchObject({ stream_max_retries: 8 });
  });

  test("an integer outside signed 64 bits is invalid TOML and is not carried", () => {
    const generated = buildProfileFileForTarget(loopback, null);
    const merged = preserveUnmanagedProfileKeys("limits = [9223372036854775808]\nstream_max_retries = 8\n", generated);
    expect(merged).not.toContain("limits");
    expect(Bun.TOML.parse(merged)).toMatchObject({ stream_max_retries: 8 });
  });

  test("a digit-only key beside a wide integer is a name and is kept", () => {
    const assignment = `limits = { 92233720368547758080 = 1, ceiling = ${WIDE} }`;
    const merged = preserveUnmanagedProfileKeys(`${assignment}\n`, buildProfileFileForTarget(loopback, null));
    expect(merged).toContain(assignment);
    expect(Bun.TOML.parse(merged.replace(WIDE, "0"))).toMatchObject({ limits: { "92233720368547758080": 1, ceiling: 0 } });
  });
});

describe("multiline strings that close with extra quotes", () => {
  test.each(["arr = [\"\"\"hello\"\"\"\"]","arr = [\"\"\"hello\"\"\"\"\"]","arr = ['''hello'''']","arr = ['''hello''''']","tbl = { s = \"\"\"x\"\"\"\" }","arr = [\n  \"\"\"a\nb\"\"\"\",\n]"])("the next root key survives (%s)", assignment => {
    const generated = buildProfileFileForTarget(loopback, null);
    const merged = preserveUnmanagedProfileKeys(`${assignment}\nstream_max_retries = 8\n`, generated);
    expect(merged).toContain(`${assignment}\nstream_max_retries = 8`);
    expect(Bun.TOML.parse(merged)).toMatchObject({ stream_max_retries: 8 });
  });
});

describe("a carried key never redefines a generated table", () => {
  // Every key that can collide with something a template writes, plus ordinary ones.
  const previous = [
    'model_provider = "elsewhere"',
    'openai_base_url = "https://fixture.invalid/v1"',
    'model_catalog_json = "/fixture/catalog.json"',
    "features = { fast_mode = false }",
    'model_providers = { other = { name = "x" } }',
    `limits = [${WIDE}]`,
    'notify = """first',
    'second"""',
    "stream_max_retries = 8",
    "stream_max_retries = 9",
    "",
    "[features]",
    "fast_mode = false",
    "",
  ].join("\n");
  const shapes = [loopback, remote].flatMap(target => [undefined, true, false].flatMap(fastMode =>
    [null, "/fixture/catalog.json"].map(catalog => ({ target, fastMode, catalog }))));

  test.each(shapes)("every template shape writes parseable TOML and regenerates stably (%o)", ({ target, fastMode, catalog }) => {
    const generated = buildProfileFileForTarget(target, catalog, false, fastMode);
    const merged = preserveUnmanagedProfileKeys(previous, generated);
    const parsed = Bun.TOML.parse(merged.replace(WIDE, "0")) as Record<string, unknown>;
    expect(parsed).toMatchObject({ stream_max_retries: 8, limits: [0], notify: "first\nsecond" });
    expect(parsed).toEqual({ ...(Bun.TOML.parse(generated) as Record<string, unknown>), ...parsed });
    expect(merged).toContain(`limits = [${WIDE}]`);
    // The generated table or root key wins every collision, so a second pass changes nothing.
    expect(preserveUnmanagedProfileKeys(merged, generated)).toBe(merged);
  });

  test("the generated [features] table wins over an inline features value", () => {
    const generated = buildProfileFileForTarget(loopback, null, false, true);
    const merged = preserveUnmanagedProfileKeys('features = { fast_mode = false }\n"stream_max_retries" = 8\n', generated);
    expect(merged).not.toContain("features = {");
    const parsed = Bun.TOML.parse(merged) as Record<string, unknown>;
    expect(parsed.features).toEqual({ fast_mode: true });
    expect(parsed.stream_max_retries).toBe(8);
  });

  test("a dotted root key is not carried", () => {
    const merged = preserveUnmanagedProfileKeys("features.fast_mode = false\nstream_max_retries = 8\n", buildProfileFileForTarget(loopback, null, false, true));
    expect(merged).not.toContain("features.fast_mode");
    expect(Bun.TOML.parse(merged)).toMatchObject({ features: { fast_mode: true }, stream_max_retries: 8 });
  });

  test("without a generated [features] table the inline value is kept", () => {
    const generated = buildProfileFileForTarget(loopback, null);
    const merged = preserveUnmanagedProfileKeys("features = { fast_mode = false }\n", generated);
    expect((Bun.TOML.parse(merged) as Record<string, unknown>).features).toEqual({ fast_mode: false });
  });

  test("the generated provider table wins over an inline model_providers value", () => {
    const generated = buildProfileFileForTarget(remote, null);
    const merged = preserveUnmanagedProfileKeys("'model_providers' = { other = { name = \"x\" } }\nstream_max_retries = 8\n", generated);
    expect(merged).not.toContain("'model_providers'");
    const parsed = Bun.TOML.parse(merged) as { model_providers: Record<string, unknown>; stream_max_retries: number };
    expect(Object.keys(parsed.model_providers)).toEqual(["opencodex"]);
    expect(parsed.stream_max_retries).toBe(8);
  });
});

// The preload can cache CODEX_PROFILE_PATH before this module loads. Disk cases therefore
// give a fresh child its own home before any path-dependent module is imported.
function runProfilePlanChild(scenario: string): Record<string, unknown> {
  const owned = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-profile-plan-")));
  let completed = false;
  try {
    const child = Bun.spawnSync([process.execPath, helperPath("profile-plan-case.ts"), scenario], {
      cwd: repoRoot(), env: { ...process.env, OCX_TEST_HOME_GUARD: "1", CODEX_HOME: owned,
        OCX_TEST_PROFILE_OWNED_HOME: owned, CODEX_SQLITE_HOME: owned, OPENCODEX_HOME: join(owned, "ocx") },
      stdout: "pipe", stderr: "pipe", timeout: 4_000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    completed = true;
    return result;
  } finally {
    // A timed-out child may still have descendants; retain its owned scratch root.
    if (completed) rmSync(owned, { recursive: true, force: true });
  }
}

// The injection children must resolve every mutable home inside their caller-owned root.
const injectionChildPrelude = `
  const fs=require('node:fs'),path=require('node:path');
  const paths=require('./src/codex/paths'),guard=require('./src/lib/test-home-guard');
  const owned=fs.realpathSync.native(process.env.OCX_TEST_PROFILE_OWNED_HOME);
  if(!guard.isTestHomeGuardArmed())throw new Error('test home guard is not armed');
  guard.assertNotRealCodexHomeUnderTest(owned);
  if(fs.realpathSync.native(paths.CODEX_HOME)!==owned ||
     fs.realpathSync.native(path.dirname(paths.CODEX_PROFILE_PATH))!==owned ||
     fs.realpathSync.native(process.env.CODEX_SQLITE_HOME)!==owned ||
     path.resolve(process.env.OPENCODEX_HOME)!==path.join(owned,'.ocx-fixture'))
    throw new Error('injection child escaped its owned home');
`;

describe("the injection plan", () => {
  test("reads the profile on disk and keeps its unmanaged keys", () => {
    const existing = 'stream_idle_timeout_ms = 60000\nfeatures = { fast_mode = false }\n\n[features]\nfast_mode = false\n';
    const plan = runProfilePlanChild("profile-source");
    expect(plan.kind).toBe("ok");
    expect(plan.profileSource).toBe(existing);
    const parsed = Bun.TOML.parse(plan.profileContent as string) as Record<string, unknown>;
    expect(parsed.stream_idle_timeout_ms).toBe(60000);
    expect(parsed.features).toEqual({ fast_mode: true });
  });

  test("treats a profile removed as it is read as absent", () => {
    const result = runProfilePlanChild("removed");
    expect(result.removed).toBe(true);
    const plan = result.plan as Record<string, unknown>;
    expect(plan.kind).toBe("ok");
    expect(plan.profileSource).toBeNull();
  });

  test("the shared profile reader used at plan and lock time treats only a missing file as absent", () => {
    const reader = runProfilePlanChild("reader");
    expect(reader.missing).toBeNull();
    expect(reader.present).toBe("stream_max_retries = 8\n");
    expect(reader.error).toMatch(/EISDIR|directory/i);
  });

  test("an unreadable profile other than a missing one still fails the plan", () => {
    const unreadable = runProfilePlanChild("unreadable");
    expect(unreadable.error).toMatch(/EISDIR|directory/i);
  });

  test("refuses retryably when the profile changes before the write lock is held", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-profile-window-")));
    try {
      writeFileSync(join(home, "config.toml"), 'model = "fixture-model"\n');
      writeFileSync(join(home, "opencodex.config.toml"), "stream_idle_timeout_ms = 1\n");
      const child = Bun.spawnSync([process.execPath, "-e", `
        ${injectionChildPrelude}
        const {spyOn}=require('bun:test');
        const locks=require('./src/codex/config-write-lock');
        const original=locks.acquireConfigWriteLock;let edited=false;
        const spy=spyOn(locks,'acquireConfigWriteLock').mockImplementation(async (...args)=>{
          if(!edited){edited=true;fs.writeFileSync(paths.CODEX_PROFILE_PATH,'stream_max_retries = 9\\n');}
          return original(...args);
        });
        let result;try{result=await require('./src/codex/inject').injectCodexConfig(10100);}finally{spy.mockRestore();}
        console.log(JSON.stringify({result,profile:fs.readFileSync(paths.CODEX_PROFILE_PATH,'utf8')}));
      `], { cwd: repoRoot(), env: { ...process.env, OCX_TEST_HOME_GUARD: "1", OCX_TEST_PROFILE_OWNED_HOME: home,
        CODEX_HOME: home, CODEX_SQLITE_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") },
        stdout: "pipe", stderr: "pipe", timeout: SPAWN_BUDGET_MS - 5_000 });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
      expect(out.result).toMatchObject({ success: false, retryable: true });
      expect(out.result.message).toContain("opencodex.config.toml changed");
      expect(out.profile).toBe("stream_max_retries = 9\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, SPAWN_BUDGET_MS);
});

// One injection scenario in a child process against its own Codex home. `script` runs with fs,
// paths, inject and coord in scope, after `before` holds the profile, and prints one JSON line.
// The coordinated case first injects once so the home has a coordinator row and a generated
// profile; the scenario then injects for another port so the profile it publishes differs. A
// fresh home holding an operator profile stays on the legacy uncoordinated path.
const homes = [
  { path: "coordinated", prime: true },
  { path: "legacy-uncoordinated", prime: false },
];
const EDIT = "stream_max_retries = 9\n";
function runInjectChild(prime: boolean, script: string): Record<string, any> {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-profile-rollback-")));
  try {
    writeFileSync(join(home, "config.toml"), 'model = "fixture-model"\n');
    if (!prime) writeFileSync(join(home, "opencodex.config.toml"), "stream_idle_timeout_ms = 1\n");
    const child = Bun.spawnSync([process.execPath, "-e", `
      ${injectionChildPrelude}
      const {spyOn}=require('bun:test');
      const coord=require('./src/codex/inject-coordination'),inject=require('./src/codex/inject');
      const read=()=>fs.readFileSync(paths.CODEX_PROFILE_PATH,'utf8');
      const run=async(port=10101)=>{try{return await inject.injectCodexConfig(port);}catch(error){return {threw:String(error&&error.message)};}};
      if(${prime}){const primed=await run(10100);if(!primed.success)throw new Error('priming failed: '+JSON.stringify(primed));}
      const before=read();const kinds=[];inject.setBeforeHistoryArtifactCommitForTests(kind=>kinds.push(kind));
      ${script}
    `], { cwd: repoRoot(), env: { ...process.env, OCX_TEST_HOME_GUARD: "1", OCX_TEST_PROFILE_OWNED_HOME: home,
      CODEX_HOME: home, CODEX_SQLITE_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") },
      stdout: "pipe", stderr: "pipe", timeout: SPAWN_BUDGET_MS - 5_000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe("rolling back a failed injection", () => {
  test.each(homes)("a refusal before the profile publish leaves an edit made after the preimage capture ($path)", ({ path, prime }) => {
    const out = runInjectChild(prime, `
      const original=coord.captureCodexPreImages;let edited=false;
      const spy=spyOn(coord,'captureCodexPreImages').mockImplementation(()=>{
        const pre=original();
        if(!edited){edited=true;fs.writeFileSync(paths.CODEX_PROFILE_PATH,${JSON.stringify(EDIT)}+before);}
        return pre;
      });
      let first;try{first=await run();}finally{spy.mockRestore();}
      const afterRefusal=read();
      const retry=await run();
      console.log(JSON.stringify({first,before,afterRefusal,retry,profile:read(),kinds}));
    `);
    expect(out.first).toMatchObject({ success: false, retryable: true });
    expect(out.first.message).toContain("opencodex.config.toml changed");
    expect(out.afterRefusal).toBe(EDIT + out.before);
    expect(out.retry).toMatchObject({ success: true });
    expect(out.kinds).toEqual([path]);
    expect((Bun.TOML.parse(out.profile) as Record<string, unknown>).stream_max_retries).toBe(9);
  }, SPAWN_BUDGET_MS);

  test.each(homes)("a failure after the profile publish restores the profile when nobody else wrote it ($path)", ({ path, prime }) => {
    const out = runInjectChild(prime, `
      let published;
      inject.setHistoryArtifactStageForTests(stage=>{if(stage==='after-artifacts'){published=read();throw new Error('fixture failure after publish');}});
      const result=await run();
      inject.setHistoryArtifactStageForTests(undefined);
      console.log(JSON.stringify({result,before,published,profile:read(),kinds}));
    `);
    expect(JSON.stringify(out.result)).toContain("fixture failure after publish");
    expect(out.kinds).toEqual([path]);
    expect(out.published).not.toBe(out.before);
    expect(out.profile).toBe(out.before);
  }, SPAWN_BUDGET_MS);

  test.each(homes)("a failure after the profile publish keeps a concurrent foreign write ($path)", ({ path, prime }) => {
    const out = runInjectChild(prime, `
      inject.setHistoryArtifactStageForTests(stage=>{if(stage==='after-artifacts'){
        fs.writeFileSync(paths.CODEX_PROFILE_PATH,'stream_max_retries = 4\\n');
        throw new Error('fixture failure after publish');
      }});
      const result=await run();
      inject.setHistoryArtifactStageForTests(undefined);
      console.log(JSON.stringify({result,profile:read(),kinds}));
    `);
    expect(JSON.stringify(out.result)).toContain("fixture failure after publish");
    expect(out.kinds).toEqual([path]);
    expect(out.profile).toBe("stream_max_retries = 4\n");
  }, SPAWN_BUDGET_MS);
});
