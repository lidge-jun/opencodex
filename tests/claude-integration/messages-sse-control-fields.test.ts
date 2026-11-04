import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperPath, repoRoot } from "../helpers/repo-root";
import { SSE_SENTINEL } from "../helpers/messages-sse-cases";
import { messagesSseControlLanes, messagesSseControlFields, messagesSseControlVariants, messagesSseControlCase, messagesSseControlRename, messagesSseControlRenameBytes } from "../helpers/messages-sse-control-cases";
const scratch = mkdtempSync(join(tmpdir(), "ocx-sse-controls-"));
const outcomes: Record<string, Record<string, any>> = {};
beforeAll(async () => {
  await Promise.all(messagesSseControlLanes.map(async lane => {
    const home = join(scratch, lane); mkdirSync(join(home, "ocx"), { recursive: true }); mkdirSync(join(home, "codex"));
    const output = join(home, "outcomes.json");
    const child = Bun.spawn([process.execPath, helperPath("messages-sse-control-run.ts"), lane, output], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Control fixture exited ${exit}\n${stdout}\n${stderr}`);
    outcomes[lane] = JSON.parse(readFileSync(output, "utf8"));
  }));
});
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
for (const lane of messagesSseControlLanes) for (const field of messagesSseControlFields) for (const variant of messagesSseControlVariants) {
  test(`${lane}: ${field[0]} ${variant} error-response normalization`, () => {
    const result = outcomes[lane]![messagesSseControlCase(field, variant).id];
    const text = Buffer.from(result.body, "base64").toString();
    expect(text.length).toBeGreaterThan(0);
    expect(text.includes(SSE_SENTINEL)).toBe(false);
    expect(result.status).toBe(lane === "count-tokens" ? 201 : 200);
    expect(result.sends).toBe(1);
    expect(result.clientRecognizes).toBe(variant === "recovery");
    expect(text.match(/^event: error$/gm)?.length).toBe(variant === "empty" ? 2 : 1);
  });
}
for (const lane of messagesSseControlLanes) test(`${lane}: within-bound rename replays id/comment bytes unchanged`, () => {
  const result = outcomes[lane]![messagesSseControlRename.id];
  const body = Buffer.from(result.body, "base64");
  expect(body.length).toBeGreaterThan(0); expect(body.toString()).toContain(SSE_SENTINEL);
  expect(body).toEqual(Buffer.from(messagesSseControlRenameBytes(lane)));
  expect(result.status).toBe(lane === "count-tokens" ? 201 : 200);
  expect(result.clientRecognizes).toBe(false);
});
