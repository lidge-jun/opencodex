import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #701 transport proof.
 *
 * The dotenv-provenance fix rests on one runtime assumption: an EMPTY-STRING environment
 * value survives a spawn and stays distinguishable from an absent variable. The whole
 * design hinges on it, because "the launcher ran and saw zero pre-existing Anthropic
 * slots" is encoded as `OCX_PRE_BUN_ANTHROPIC_ENV=""` while "no launcher at all, change
 * nothing" is encoded as the variable being absent.
 *
 * The unit tests in claude-auth-mode.test.ts inject that marker directly into a plain
 * object, so they would stay green even if a platform collapsed `""` to unset in real
 * process spawning — and the production fix would silently become a no-op for exactly
 * the case that matters most. This test spawns real processes instead, so the assumption
 * is proven by execution on whatever platform CI runs (Linux, Windows, macOS).
 */
describe("empty-string env transport across a real spawn (#701)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-dotenv-provenance-"));
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    'const v = process.env.OCX_PRE_BUN_ANTHROPIC_ENV;\n'
      + 'process.stdout.write(JSON.stringify({ type: typeof v, value: v ?? null, own: "OCX_PRE_BUN_ANTHROPIC_ENV" in process.env }));\n',
  );

  function probeWith(env: NodeJS.ProcessEnv | undefined): { type: string; value: string | null; own: boolean } {
    const result = spawnSync(process.execPath, [probe], {
      encoding: "utf8",
      ...(env ? { env } : {}),
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as { type: string; value: string | null; own: boolean };
  }

  test("an empty marker arrives as an own property whose value is the empty string", () => {
    const seen = probeWith({ ...process.env, OCX_PRE_BUN_ANTHROPIC_ENV: "" });
    expect(seen.type).toBe("string");
    expect(seen.value).toBe("");
    expect(seen.own).toBe(true);
  });

  test("a populated marker arrives verbatim", () => {
    const seen = probeWith({ ...process.env, OCX_PRE_BUN_ANTHROPIC_ENV: "ANTHROPIC_API_KEY" });
    expect(seen.value).toBe("ANTHROPIC_API_KEY");
  });

  // The distinction the fix depends on: absent is NOT the same as empty.
  test("an absent marker stays absent rather than becoming an empty string", () => {
    const inherited = { ...process.env };
    delete inherited.OCX_PRE_BUN_ANTHROPIC_ENV;
    const seen = probeWith(inherited);
    expect(seen.type).toBe("undefined");
    expect(seen.own).toBe(false);
  });
});
