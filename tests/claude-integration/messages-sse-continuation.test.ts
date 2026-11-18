import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONTINUATION_STARTUP_MS, CONTINUATION_STREAM_MS, runContinuationFixture } from "../helpers/continuation-fixture-run";
import { continuationLanes, continuationTails, continuationExpected } from "../helpers/messages-sse-continuation-cases";
for (const lane of continuationLanes) for (const tail of continuationTails) test(`${lane}: split error delimiter resumes ${tail[0]} and EOF`, async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-sse-continuation-"));
  try {
    mkdirSync(join(home, "ocx")); mkdirSync(join(home, "codex"));
    const output = join(home, "result.json");
    const { exit, stdout, stderr, timedOut } = await runContinuationFixture([lane, tail[0], output], { OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") });
    if (timedOut === "startup") throw new Error(`Split-CRLF fixture did not load within ${CONTINUATION_STARTUP_MS}ms\n${stderr}`);
    if (timedOut === "stream") throw new Error(`The client did not receive the later ${tail[0]} and EOF within ${CONTINUATION_STREAM_MS}ms`);
    if (exit !== 0) throw new Error(`Split-CRLF fixture exited ${exit}\n${stdout}\n${stderr}`);
    {
      const result = JSON.parse(readFileSync(output, "utf8"));
      const bytes = Buffer.from(result.body, "base64");
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.toString()).toContain(tail[1]);
      expect(bytes).toEqual(Buffer.from(continuationExpected(lane, tail)));
      expect(result.readTurn).toBe(lane === "native" || lane === "builtin" ? 5 : 4);
      expect(result.status).toBe(lane === "count-tokens" ? 201 : 200);
      expect(result.sends).toBe(1);
      expect(result.sawEof).toBe(true);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
