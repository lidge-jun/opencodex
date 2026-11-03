/**
 * Rebuilding `opencodex.config.toml` keeps the operator's unmanaged root keys
 * (#8066). These cases pin the parts that can corrupt the file: original bytes
 * survive values Bun cannot decode, a carried key never collides with a table the
 * generated profile writes, the plan reads the real profile path, and an edit that
 * lands before the write lock is not overwritten.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

// The profile path is fixed when src/codex/paths first loads, so own a Codex home before the
// path-dependent modules are imported. A run without the repository preload (an absolute test
// path from another directory) must never touch the developer's real profile.
const isolatedHome = installIsolatedCodexHome("ocx-profile-preservation-");
const { buildProfileFileForTarget, preserveUnmanagedProfileKeys } = await import("../../src/codex/inject/config-toml");
const { deriveCodexInjectionPlan } = await import("../../src/codex/inject/plan");
const { CODEX_PROFILE_PATH } = await import("../../src/codex/paths");
const within = (root: string, path: string) => {
  const rel = relative(realpathSync(root), realpathSync(join(path, "..")));
  return !rel.startsWith("..") && !isAbsolute(rel);
};
// Only this test's own home, or a preload sandbox HOME distinct from the account's real home.
const sandboxHome = process.env.HOME && process.env.HOME !== userInfo().homedir ? process.env.HOME : null;
if (!within(isolatedHome.path, CODEX_PROFILE_PATH) && !(sandboxHome && within(sandboxHome, CODEX_PROFILE_PATH))) {
  throw new Error("codex-profile-preservation: refusing to run against a Codex profile outside a test home");
}
afterAll(() => { isolatedHome.restore(); });

const loopback = { baseUrl: "http://127.0.0.1:10100/v1", requiresAdmissionToken: false, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" as const };
const remote = { baseUrl: "http://10.20.30.40:10100/v1", requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" as const };
const WIDE = "9223372036854775807";

afterEach(() => { rmSync(CODEX_PROFILE_PATH, { force: true }); });

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

describe("the injection plan", () => {
  test("reads the profile on disk and keeps its unmanaged keys", () => {
    const existing = 'stream_idle_timeout_ms = 60000\nfeatures = { fast_mode = false }\n\n[features]\nfast_mode = false\n';
    writeFileSync(CODEX_PROFILE_PATH, existing);
    const plan = deriveCodexInjectionPlan('model = "fixture-model"\n', {
      config: { fastMode: true } as OcxConfig, routingTarget: loopback, catalogPathOption: null, journalReadOnly: true,
    });
    if (plan.kind !== "ok") throw new Error(plan.message);
    expect(plan.profileSource).toBe(existing);
    const parsed = Bun.TOML.parse(plan.profileContent) as Record<string, unknown>;
    expect(parsed.stream_idle_timeout_ms).toBe(60000);
    expect(parsed.features).toEqual({ fast_mode: true });
  });

  test("refuses retryably when the profile changes before the write lock is held", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-profile-window-")));
    try {
      writeFileSync(join(home, "config.toml"), 'model = "fixture-model"\n');
      writeFileSync(join(home, "opencodex.config.toml"), "stream_idle_timeout_ms = 1\n");
      const child = Bun.spawnSync([process.execPath, "-e", `
        const fs=require('node:fs'),{spyOn}=require('bun:test');
        const locks=require('./src/codex/config-write-lock'),paths=require('./src/codex/paths');
        const original=locks.acquireConfigWriteLock;let edited=false;
        const spy=spyOn(locks,'acquireConfigWriteLock').mockImplementation(async (...args)=>{
          if(!edited){edited=true;fs.writeFileSync(paths.CODEX_PROFILE_PATH,'stream_max_retries = 9\\n');}
          return original(...args);
        });
        let result;try{result=await require('./src/codex/inject').injectCodexConfig(10100);}finally{spy.mockRestore();}
        console.log(JSON.stringify({result,profile:fs.readFileSync(paths.CODEX_PROFILE_PATH,'utf8')}));
      `], { cwd: repoRoot(), env: { ...process.env, CODEX_HOME: home, OPENCODEX_HOME: join(home, ".ocx-fixture") },
        stdout: "pipe", stderr: "pipe", timeout: SPAWN_BUDGET_MS - 5_000 });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
      expect(out.result).toMatchObject({ success: false, retryable: true });
      expect(out.result.message).toContain("opencodex.config.toml changed");
      expect(out.profile).toBe("stream_max_retries = 9\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, SPAWN_BUDGET_MS);
});
