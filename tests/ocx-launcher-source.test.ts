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
  test("Windows npm spawns use the trusted absolute invocation without shell lookup", () => {
    expect(source).toContain("const latestInvocation = npmInvocation(");
    expect(source).toContain("const installInvocation = npmInvocation(");
    expect(source).toContain("spawnSync(latestInvocation.file, latestInvocation.args");
    expect(source).toContain("spawnSync(installInvocation.file, installInvocation.args");
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
  test("the Bun child receives the pre-Bun Anthropic provenance marker", () => {
    expect(source).toContain("const preBunAnthropicSlots = [\"ANTHROPIC_API_KEY\", \"ANTHROPIC_AUTH_TOKEN\"]");
    expect(source).toContain("OCX_PRE_BUN_ANTHROPIC_ENV: preBunAnthropicSlots.join(\",\")");
    // The marker must be computed from the launcher's OWN env, before Bun's dotenv load.
    expect(source).toContain("typeof process.env[name] === \"string\" && process.env[name] !== \"\"");
  });

  test("valid Bun overrides are selected before the bundled runtime", () => {
    expect(source).toContain('const BUN_OVERRIDE_ENV = "OPENCODEX_BUN_PATH";');
    expect(source).toContain("const overridePath = resolve(override);");
    expect(source).toContain("if (isRealBunBinary(overridePath)) return overridePath;");

    const resolveStart = source.indexOf("function resolveBun() {");
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
