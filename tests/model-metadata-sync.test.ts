import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `src/generated/model-metadata.ts` is generated from the vendored snapshot
 * `scripts/model-metadata.source.json`, and until now nothing checked that the committed file
 * still matched its source. It drifted by 95 models — 148 price fields, 36 context windows, 45
 * maxTokens, and 36 entirely new models — which meant a routine regeneration would sweep all of
 * that into cost accounting alongside whatever the author actually intended to change.
 *
 * This guard closes that. It regenerates into a temp directory and byte-compares, so it can never
 * clobber the committed file. The snapshot ships in this repository, so the guard runs
 * everywhere, including CI. Refreshing the metadata is one deliberate commit: replace the
 * snapshot and rerun `bun run generate:model-metadata`.
 */
const GENERATED = resolve(import.meta.dir, "../src/generated/model-metadata.ts");
// Mirror the generator's fixed source: the vendored snapshot next to the script, so the guard is
// deterministic in worktrees and CI.
const SOURCE = resolve(import.meta.dir, "../scripts/model-metadata.source.json");

describe("generated model metadata stays in sync with its source", () => {
  test.skipIf(!existsSync(SOURCE))(
    "regenerating reproduces the committed file byte for byte",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "model-metadata-sync-"));
      const outPath = join(outDir, "model-metadata.ts");

      const proc = Bun.spawn(
        ["bun", resolve(import.meta.dir, "../scripts/generate-model-metadata.ts")],
        {
          cwd: resolve(import.meta.dir, ".."),
          env: { ...process.env, MODEL_METADATA_OUT: outPath },
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
