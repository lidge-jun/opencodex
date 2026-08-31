import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * bin/ocx.mjs is the Node bin launcher — it executes top-level logic on import, so it
 * cannot be imported by tests. Guard its Windows-critical invariants at the source level.
 */
const source = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
const runtimeSource = readFileSync(join(import.meta.dir, "..", "src", "lib", "bun-runtime.ts"), "utf8");
const validatorSource = readFileSync(
  join(import.meta.dir, "..", "src", "lib", "bun-binary-validator.mjs"),
  "utf8",
);

describe("ocx.mjs npm launcher (source invariants)", () => {
  test("the Bun child receives the runtime provenance the launcher actually selected (#848)", () => {
    // The launcher is a plain-Node bin script executing at import time, so this is
    // asserted at the source level: the marker must reach the spawn env, and it must
    // carry the source resolved alongside the chosen binary rather than a literal.
    expect(source).toContain('const BUN_RUNTIME_SOURCE_ENV = "OCX_BUN_RUNTIME_SOURCE";');
    expect(source).toContain("[BUN_RUNTIME_SOURCE_ENV]: bunRuntime.source,");

    // The stamp must sit inside the spawn's env object, not merely somewhere in the file.
    const spawnStart = source.indexOf("const child = spawn(bun, [cliPath");
    expect(spawnStart).toBeGreaterThanOrEqual(0);
    const spawnCall = source.slice(spawnStart, source.indexOf("});", spawnStart));
    expect(spawnCall).toContain("[BUN_RUNTIME_SOURCE_ENV]: bunRuntime.source");

    // Path and source come from one resolution, so the marker cannot describe another binary.
    expect(source).toContain("const bunRuntime = resolveBun({ allowInstall: !codexCliUpdateInspection });");
    expect(source).toContain("const bun = bunRuntime.path;");
    expect(source).toContain('return { path: bin, source: "bundled" };');

    // The launcher's literal name must match the TypeScript constant it mirrors.
    expect(runtimeSource).toContain('export const BUN_RUNTIME_SOURCE_ENV = "OCX_BUN_RUNTIME_SOURCE";');
  });

  test("the updater inspection namespace rejects direct Bun execution of the Node launcher", () => {
    expect(source).toContain('codexCliUpdateInspection && typeof process.versions.bun === "string"');
    expect(source).toContain("codex-cli-update inspection must use the published Node launcher");
  });

  test("the Node launcher proof-binds the bounded version-manager root allowlist", () => {
    expect(source).toContain("CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS");
    expect(source).toContain("managerRoots: preBunCodexCliManagerRoots");
  });

  test("the long-running Bun child stays hidden under a headless Windows launcher (#1236)", () => {
    const spawnStart = source.indexOf("const child = spawn(bun, [cliPath");
    expect(spawnStart).toBeGreaterThanOrEqual(0);
    const spawnCall = source.slice(spawnStart, source.indexOf("});", spawnStart));

    // Scope this to the final Node-to-Bun launch. Other helper spawns already hide
    // their windows, but they do not cover the child that owns the proxy lifetime.
    expect(spawnCall).toContain('stdio: "inherit"');
    expect(spawnCall).toContain("windowsHide: true");
  });

  test("Windows npm spawns use the trusted absolute invocation without shell lookup", () => {
    expect(source).toContain("const latestInvocation = npmInvocation(");
    expect(source).toContain("const installInvocation = npmInvocation(");
    expect(source).toContain("spawnSync(latestInvocation.file, latestInvocation.args");
    // #1942: the staged install spawns through the same hardened npmInvocation resolver
    // inside the transactional runNpm callback.
    expect(source).toContain("const invocation = npmInvocation(args);");
    expect(source).toContain("spawnSync(invocation.file, invocation.args");
    expect(source).not.toContain("shell: true");
    expect(source).not.toContain('"npm.cmd"');
  });

  test("--tag is allowlisted before reaching package-manager arguments", () => {
    expect(source).toContain('if (explicit === "preview" || explicit === "latest") return explicit;');
    expect(source).not.toMatch(/if \(tagIndex !== -1 && process\.argv\[tagIndex \+ 1\]\) return process\.argv/);
  });

  // #701: the launcher is the only place that still knows whether an Anthropic credential
  // came from a real shell export or from a project dotenv, because Node does not
  // auto-load `.env` while the Bun child does. Losing this half silently returns the
  // proxy to billing a subscriber's API key from an ambient file, and the runtime half in
  // src/cli/claude.ts would keep passing its own unit tests while doing nothing.
  test("the Bun child receives proof-bound pre-Bun Anthropic provenance", () => {
    expect(source).toContain("const preBunAnthropicSlots = [\"ANTHROPIC_API_KEY\", \"ANTHROPIC_AUTH_TOKEN\", \"ANTHROPIC_BASE_URL\"]");
    expect(source).toContain("const launchProof = randomBytes(32).toString(\"base64url\")");
    expect(source).toContain("[NODE_LAUNCH_CONTEXT_ENV]: launchContext");
    expect(source).toContain("`${NODE_LAUNCH_PROOF_PREFIX}${launchProof}`");
    expect(source).not.toContain("OCX_PRE_BUN_ANTHROPIC_ENV: preBunAnthropicSlots");
    // The snapshot must be computed from the launcher's OWN env, before Bun's dotenv load.
    expect(source).toContain("typeof process.env[name] === \"string\" && process.env[name] !== \"\"");
  });

  /**
   * Windows caps a process environment block at 32,767 characters. The inspection snapshot
   * already carries PATH, PATHEXT, and the manager-root slots as proof-bound values, and
   * `inspectCodexCliInstall` reads them from that snapshot rather than the live environment.
   * Inheriting them again spends the budget twice, so a large-but-valid shell environment
   * could stop the Bun child from spawning and fail the command before it reports anything.
   */
  test("the inspection child does not inherit a duplicate copy of the snapshotted values", () => {
    expect(source).toContain("const inheritedEnv = { ...process.env };");
    expect(source).toContain("...inheritedEnv,");
    // Windows spells the variable `Path` in practice, so an upper-case-only delete would
    // leave the duplicate behind. The match must be on the lowercase form of every key.
    expect(source).toContain("if (snapshotted.has(name.toLowerCase())) delete inheritedEnv[name];");
    expect(source).toContain('["PATH", "PATHEXT", ...CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS].map(name => name.toLowerCase())');

    // The de-duplication is scoped to the one-shot inspection launch; every other launch
    // must still inherit PATH, or the long-running proxy child loses its tooling lookup.
    const guard = source.indexOf("if (codexCliUpdateInspection) {", source.indexOf("const inheritedEnv"));
    expect(guard).toBeGreaterThan(-1);

    // The spawn must no longer splat the raw environment, or the deletes above are pointless.
    const spawnStart = source.indexOf("const child = spawn(bun, [cliPath,");
    expect(spawnStart).toBeGreaterThan(-1);
    expect(source.slice(spawnStart)).not.toContain("...process.env,");
  });

  /**
   * A bare `CODEX_CLI_PATH` such as `codex` is an executable-lookup name, not a relative
   * path. Resolving it against the launch cwd would make the inspector treat it as an
   * explicit path and stop searching the proof-captured PATH, so a working configuration
   * would report as unavailable.
   */
  test("only separator-bearing configured Codex paths are resolved against the launch cwd", () => {
    expect(source).toContain("const preBunCodexCliPath = configuredCodexCliPath !== null");
    expect(source).toContain('configuredCodexCliPath.includes("/") || configuredCodexCliPath.includes("\\\\") || /^[A-Za-z]:/.test(configuredCodexCliPath)');
    expect(source).toContain("? resolve(configuredCodexCliPath)");
    expect(source).toContain(": configuredCodexCliPath;");
  });

  test("valid Bun overrides are selected before the bundled runtime", () => {
    expect(source).toContain('const BUN_OVERRIDE_ENV = "OPENCODEX_BUN_PATH";');
    expect(source).toContain("const overridePath = resolve(override);");
    expect(source).toContain('if (isRealBunBinary(overridePath)) return { path: overridePath, source: "override" };');

    const resolveStart = source.indexOf("function resolveBun({ allowInstall = true } = {}) {");
    const overrideCheck = source.indexOf("process.env[BUN_OVERRIDE_ENV]?.trim()", resolveStart);
    const overrideResolve = source.indexOf("resolve(override)", overrideCheck);
    const bundledLookup = source.indexOf("bunDir = bunBinDir()", resolveStart);
    expect(resolveStart).toBeGreaterThanOrEqual(0);
    expect(overrideCheck).toBeGreaterThan(resolveStart);
    expect(overrideResolve).toBeGreaterThan(overrideCheck);
    expect(bundledLookup).toBeGreaterThan(overrideResolve);
  });

  test("invalid Bun overrides warn safely and fall back without throwing", () => {
    expect(source).toContain('import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";');
    expect(source).toContain("is missing, unreadable, or not a complete Bun binary; falling back to the bundled runtime.");
    expect(source).not.toContain('${override} is missing, unreadable');
  });

  test("shares the Node-safe Bun binary validator across both runtime paths", () => {
    expect(source).toContain('import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";');
    expect(runtimeSource).toContain('import { isRealBunBinary } from "./bun-binary-validator.mjs";');
    expect(runtimeSource).toContain("export { isRealBunBinary };");
    expect(validatorSource).toContain("export const REAL_BUN_MIN_BYTES = 1_000_000;");
    expect(validatorSource).toMatch(/export function isRealBunBinary\(path\) \{[\s\S]*?try \{[\s\S]*?statSync\(path\)[\s\S]*?catch \{[\s\S]*?return false;/);
  });
});
