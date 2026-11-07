import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { helperPath, repoPath, repoRoot } from "../helpers/repo-root";
import { encodeAdapterEventStream, isEncoderTransportFailure } from "../../src/protocols/encoders/adapter-events";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
for (const kind of ["sink", "sink-direct", "deep", "usage"]) test(`Messages delivery ${kind}`, async () => {
  const d = mkdtempSync(join(tmpdir(), "ocx-message-review-")); mkdirSync(join(d, "ocx")); mkdirSync(join(d, "codex"));
  try {
    const red = kind === "sink-direct" ? join(d, "red") : undefined;
    if (red) {
      const source = "src/claude/failure-verdict.ts";
      const target = join(red, source);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "// L7_RED_SOURCE_MARKER\n" + readFileSync(repoPath(source), "utf8"));
    }
    const env = { ...process.env, OPENCODEX_HOME: join(d, "ocx"), CODEX_HOME: join(d, "codex") };
    delete env.MESSAGES_RED_SOURCE;
    if (red) env.MESSAGES_RED_SOURCE = red;
    const child = Bun.spawn([process.execPath, helperPath("messages-proxy-refusal-case.ts"), kind], { cwd: repoRoot(), env, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Delivery fixture failed ${exit}: ${stderr}`);
    const result = JSON.parse(stdout.split("REFUSAL_RESULT ").at(-1)!);
    if (!red) expect(result.hooks.redInputs).toEqual([]);
    expect(result.status).toBe(200); expect(result.text.length).toBeGreaterThan(0);
    if (kind.startsWith("sink")) {
      expect(result.retained).toBe(0);
      expect(result.hooks.verdictLoads).toBeGreaterThan(0);
      expect(result.streaming.admissions).toContain(false);
      expect(result.streaming.retained).toBe(0);
      expect(result.filterChecks).toEqual({
        upstream: { forward: true, backward: true },
        native: { forward: true, backward: true },
        verdict: { forward: true, backward: true },
      });
      if (kind === "sink") {
        expect(result.collected.status).toBe(502);
        expect(result.collected.textLength).toBeGreaterThan(0);
        expect(result.hooks.admissions).toContain(true);
        expect(result.hooks.admittedRecords).toBeGreaterThan(0);
        expect(result.hooks.collectedMatches).toBeGreaterThan(0);
      }
      if (kind === "sink-direct") expect(result.hooks.redInputs).toContainEqual({ path: "src/claude/failure-verdict.ts", marker: true });
    }
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

for (const source of ["reader", "processor"] as const) for (const overflow of [false, true]) test(`converter ${source} fault overflow=${overflow}`, async () => {
  const { responsesSseToAnthropicSse } = await import("../../src/claude/outbound");
  const { CLIENT_ERROR_CONTRACTS, CLAUDE_CONTEXT_OVERFLOW_MESSAGE } = await import("../../src/lib/client-error-body");
  const diagnostic = `${overflow ? "prompt is too long" : "fixture fault"} zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e`;
  let processed = 0;
  const upstream = source === "reader" ? new ReadableStream<Uint8Array>({ pull() { throw new Error(diagnostic); } })
    : new Response('event: response.output_item.done\ndata: {"item":{"type":"reasoning","id":"r_fixture","encrypted_content":"fixture-opaque"}}\n\n').body!;
  const response = new Response(responsesSseToAnthropicSse(upstream, "fixture", { translatorBudget: createTestTranslatorBudget(), pingIntervalMs: 0,
    nativeReasoningTagFor() { if (processed++ === 0) throw new Error(diagnostic); return undefined; } }));
  const text = await response.text();
  expect(response.status).toBe(200); expect(text.length).toBeGreaterThan(0);
  expect(text).not.toContain("zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e");
  const payload = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(row => row.type === "error");
  expect(payload.error.type).toBe("api_error");
  expect(payload.error.message).toBe(overflow ? CLAUDE_CONTEXT_OVERFLOW_MESSAGE : source === "reader" ? CLIENT_ERROR_CONTRACTS.transport_failed : "The provider failed to complete the request.");
  expect(payload.error.message.toLowerCase().includes("prompt is too long")).toBe(overflow);
  if (source === "processor") expect(processed).toBeGreaterThan(0);
});
