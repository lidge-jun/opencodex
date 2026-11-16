import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONTINUATION_STARTUP_MS, CONTINUATION_STREAM_MS, runContinuationFixture } from "../helpers/continuation-fixture-run";
import { ownedCrError, continuationTails } from "../helpers/messages-sse-continuation-cases";
for (const layer of ["rewrite", "tap", "reader"] as const) for (const [name, tail] of [...continuationTails, ["eof", ""]] as const) {
  test(`${layer}: suppressed late LF resumes ${name}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-rewrite-continuation-"));
    try {
      mkdirSync(join(home, "ocx")); mkdirSync(join(home, "codex"));
      const output = join(home, "result.json");
      const { exit, stdout, stderr, timedOut } = await runContinuationFixture([`direct-${layer}`, name, output], { OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") });
      if (timedOut === "startup") throw new Error(`Continuation fixture did not load within ${CONTINUATION_STARTUP_MS}ms\n${stderr}`);
      if (timedOut === "stream") throw new Error(`No later event/EOF after the suppressed LF within ${CONTINUATION_STREAM_MS}ms`);
      if (exit !== 0) throw new Error(`Continuation fixture exited ${exit}\n${stdout}\n${stderr}`);
      {
        const result = JSON.parse(readFileSync(output, "utf8"));
        const bytes = Buffer.from(result.body, "base64");
        expect(bytes.length).toBeGreaterThan(0);
        if (tail) expect(bytes.toString()).toContain(tail);
        expect(bytes).toEqual(Buffer.from(ownedCrError + tail));
        expect(result.sawEof).toBe(true);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
