import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixturePath, helperPath, repoRoot } from "./repo-root";
import { messagesSseCaseHash, SSE_BASE, SSE_SENTINEL } from "./messages-sse-cases";
import { messagesSseCases } from "./messages-sse-cases";
import { pinnedMessagesObservation } from "./messages-sse-observer";
const golden = JSON.parse(readFileSync(fixturePath("messages-sse-895a85989.json"), "utf8"));
export function registerSseLane(lane: string) {
  const inputs = messagesSseCases.filter(row => lane === "fold" ? row.fold : !row.fold);
  for (let offset = 0; offset < inputs.length; offset += 12) test(`${lane}: 895a85989 rows ${offset}-${Math.min(offset + 12, inputs.length)}`, async () => {
    expect(golden.baseCommit).toBe(SSE_BASE);
    expect(golden.caseTableSha256).toBe(messagesSseCaseHash());
    const scratch = mkdtempSync(join(tmpdir(), "ocx-sse-slice-"));
    try {
      mkdirSync(join(scratch, "ocx")); mkdirSync(join(scratch, "codex"));
      const output = join(scratch, "head.json");
      const child = Bun.spawn([process.execPath, helperPath("messages-sse-differential.ts"), "head", scratch, output, lane, String(offset), "12"], {
        cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(scratch, "ocx"), CODEX_HOME: join(scratch, "codex") }, stdout: "pipe", stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (exit !== 0) throw new Error(`SSE slice exited ${exit}\n${stdout}\n${stderr}`);
      const head = JSON.parse(readFileSync(output, "utf8")).outcomes;
      for (const input of inputs.slice(offset, offset + 12)) {
        const key = `${lane}/${input.id}`;
        const values = golden.outcomes[key];
        const before = values && { status: values[0], bodySha256: values[1], bodyLength: values[2], chunks: golden.dictionaries.traces[values[3]], readTurn: values[4], sends: values[5], internal: golden.dictionaries.internals[values[6]], clientRecognizes: values[7], wirePhrase: values[8] };
        const after = head[key];
        expect(before, key).toBeDefined(); expect(after, key).toBeDefined();
        const { body, ...facts } = after;
        const bytes = Buffer.from(body, "base64");
        const text = bytes.toString("utf8");
        if (input.fault === "cancel") expect(bytes.length).toBe(0);
        else expect(bytes.length, key).toBeGreaterThan(0);
        expect(facts.sends, key).toBe(before.sends);
        const status = input.kind === "FOLD-502" ? 502 : before.status;
        expect(after.status, key).toBe(status);
        // A cancel now keeps the usage it already received (#7374 review); the base dropped it.
        const internal = (row: any) => input.fault === "cancel" ? { ...row, usage: "cancel" } : row;
        if (lane === "fold") {
          expect(after.internal.settlements, key).toEqual(before.internal.settlements.map((row: any) => ({ ...row, status: row.status === 200 ? 502 : row.status })));
          expect(internal({ ...after.internal, settlements: [] }), key).toEqual(internal({ ...before.internal, settlements: [] }));
        } else expect(internal(after.internal), key).toEqual(internal(before.internal));
        const ordinary = input.kind === "non-error" || input.kind === "rename" || lane === "tap";
        if (ordinary) {
          expect(after.bodySha256, key).toBe(before.bodySha256);
          expect(after.bodyLength, key).toBe(before.bodyLength);
          if (input.kind === "non-error" || lane === "tap") {
            expect(after.chunks, key).toEqual(before.chunks);
            expect(after.readTurn, key).toBe(before.readTurn);
          }
        } else if (lane !== "fold") {
          if (input.kind !== "local" || input.fault?.startsWith("read")) expect(text.includes(SSE_SENTINEL), key).toBe(false);
          if (input.kind === "OVERSIZE-1M") {
            expect(text.includes('"message":"The provider stream reported an error."'), key).toBe(true);
            expect(text.includes('"code":'), key).toBe(false);
            expect(after.clientRecognizes, key).toBe(false);
          }
        }
        if (input.kind !== "OVERSIZE-1M" || lane === "tap") expect(after.clientRecognizes, key).toBe(before.clientRecognizes);
        const observed = pinnedMessagesObservation(bytes);
        expect(observed.clientRecognizes, key).toBe(after.clientRecognizes);
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
