import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { helperPath, repoRoot } from "../helpers/repo-root";
import { encodeAdapterEventStream, isEncoderTransportFailure } from "../../src/protocols/encoders/adapter-events";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
for (const kind of ["sink", "sink-direct", "deep", "usage"]) test(`Messages delivery ${kind}`, async () => {
  const d = mkdtempSync(join(tmpdir(), "ocx-message-review-")); mkdirSync(join(d, "ocx")); mkdirSync(join(d, "codex"));
  try {
    const child = Bun.spawn([process.execPath, helperPath("messages-proxy-refusal-case.ts"), kind], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(d, "ocx"), CODEX_HOME: join(d, "codex") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Delivery fixture failed ${exit}: ${stderr}`);
    const result = JSON.parse(stdout.split("REFUSAL_RESULT ").at(-1)!);
    expect(result.status).toBe(200); expect(result.text.length).toBeGreaterThan(0);
    if (kind.startsWith("sink")) expect(result.retained).toBe(0);
    else expect(result.text).toBe(result.expectedBody);
    if (kind === "usage") { expect(result.usage.inputTokens).toBe(42); expect(result.usage.outputTokens).toBe(7); }
  } finally { rmSync(d, { recursive: true, force: true }); }
}, 30000);
for (const source of ["writer", "reader", "hook"] as const) test(`adapter ${source} fault retains its origin`, async () => {
  let transport: boolean | undefined; let calls = 0;
  const events = (async function* () { if (source === "reader") throw new Error("fixture read fault"); yield { type: "text_delta", text: "fixture" } as any; yield { type: "done" } as any; })();
  const body = encodeAdapterEventStream(events, sink => new Proxy({
    text() { if (source === "writer") throw new Error("fixture writer fault"); },
    terminal(terminal: any) { transport = isEncoderTransportFailure(terminal); sink.emit("done"); },
  }, { get(target: any, name) { return target[name] ?? (() => {}); } }) as any, { translatorBudget: createTestTranslatorBudget(), hooks: { beforeTerminal() { if (source === "hook" && calls++ === 0) throw new Error("fixture hook fault"); } } });
  expect((await new Response(body).text()).length).toBeGreaterThan(0);
  expect(transport).toBe(source === "reader");
});
