import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `src/generated/jawcode-model-metadata.ts` is generated from the jawcode `models.json`, and until
 * now nothing checked that the committed file still matched its source. It drifted by 95 models —
 * 148 price fields, 36 context windows, 45 maxTokens, and 36 entirely new models — which meant a
 * routine regeneration would sweep all of that into cost accounting alongside whatever the author
 * actually intended to change.
 *
 * This guard closes that. It regenerates into a temp directory and byte-compares, so it can never
 * clobber the committed file.
 *
 * It SKIPS when the jawcode checkout is absent, which is the normal case for contributors and for
 * CI: `scripts/generate-jawcode-metadata.ts` throws without it, so asserting unconditionally would
 * turn every external run red. The drift can only be introduced by someone who has the source, so
 * that is exactly where the check needs to fire.
 */
const GENERATED = resolve(import.meta.dir, "../src/generated/jawcode-model-metadata.ts");
// Resolve the default exactly the way the generator does — relative to cwd, not to this file — so a
// git worktree does not silently point at a sibling that happens to share the parent directory.
const SOURCE = process.env.JAWCODE_MODELS_JSON
  ? resolve(process.env.JAWCODE_MODELS_JSON)
  : resolve(process.cwd(), "../jawcode/packages/ai/src/models.json");

describe("generated jawcode metadata stays in sync with its source", () => {
  test.skipIf(!existsSync(SOURCE))(
    "regenerating reproduces the committed file byte for byte",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "jawcode-sync-"));
      const outPath = join(outDir, "jawcode-model-metadata.ts");

      const proc = Bun.spawn(
        ["bun", resolve(import.meta.dir, "../scripts/generate-jawcode-metadata.ts")],
        {
          cwd: resolve(import.meta.dir, ".."),
          env: { ...process.env, JAWCODE_MODELS_JSON: SOURCE, JAWCODE_METADATA_OUT: outPath },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await proc.exited;
      expect(exitCode, await new Response(proc.stderr).text()).toBe(0);

      expect(readFileSync(outPath, "utf-8")).toBe(readFileSync(GENERATED, "utf-8"));
    },
    30_000,
  );
});
