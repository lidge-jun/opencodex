import { afterEach, expect, test } from "bun:test";
import { postLocalChatCompletion } from "../../src/lib/local-chat-completion";
import { describeImageRouted } from "../../src/vision/routed-describe";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(async () => {
  await server?.stop(true);
  server = null;
});

const CONFIG = { port: 0, hostname: "127.0.0.1", apiKeys: [] };

function completion(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
}

function serve(respond: () => Response): string {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
  return `http://127.0.0.1:${server.port}`;
}

function send(baseUrlOverride: string, maxResponseBytes: number) {
  return postLocalChatCompletion({
    config: CONFIG,
    body: { model: "m", messages: [] },
    label: "role sizing",
    logTag: "role-sizing",
    timeoutMs: 5_000,
    maxResponseBytes,
    boundWhileStreaming: true,
    baseUrlOverride,
  });
}

test("returns the completion text when the body fits the byte bound", async () => {
  const base = serve(() => new Response(completion("small")));
  expect(await send(base, 1024)).toEqual({ text: "small" });
});

test("stops reading an endless body at the byte bound and cancels it", async () => {
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
  const base = serve(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  })));
  const outcome = await send(base, 64 * 1024);
  expect(outcome).toEqual({ text: "", error: "role sizing response exceeded byte bound" });
  for (let i = 0; i < 50 && !cancelled; i += 1) await Bun.sleep(20);
  expect(cancelled).toBe(true);
});

test("counts UTF-8 bytes, not UTF-16 units, against the bound", async () => {
  const body = completion("가".repeat(1_000));
  expect(body.length).toBeLessThan(2_048);
  expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2_048);
  const base = serve(() => new Response(body));
  expect(await send(base, 2_048)).toEqual({ text: "", error: "role sizing response exceeded byte bound" });
});

test("the routed vision describer keeps its upstream UTF-16 length bound", async () => {
  const caption = "가".repeat(2 * 1024 * 1024);
  const body = completion(caption);
  expect(body.length).toBeLessThan(4 * 1024 * 1024);
  expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(4 * 1024 * 1024);
  const base = serve(() => new Response(body));
  const outcome = await describeImageRouted(
    "data:image/png;base64,aGVsbG8=",
    undefined,
    "",
    "vlm/qwen-vl",
    CONFIG,
    { model: "vlm/qwen-vl", reasoning: "low", timeoutMs: 10_000 },
    undefined,
    base,
  );
  expect(outcome.error).toBeUndefined();
  expect(outcome.text.length).toBe(caption.length);
});
