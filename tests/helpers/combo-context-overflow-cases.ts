import { expect, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

interface ComboHarness<Server> {
  serve(handler: () => Response | Promise<Response>): Server;
  baseUrl(server: Server): string;
  chatSuccess(text: string, model?: string): Response;
  chatStream(text: string): Response;
  provider(adapter: string, url: string, apiKey: string, extra?: Partial<OcxProviderConfig>): OcxProviderConfig;
  comboConfig(providers: OcxConfig["providers"]): OcxConfig;
  post(config: OcxConfig, raw?: Record<string, unknown>): Promise<Response>;
  collectSse(response: Response): Promise<unknown[]>;
}

const OVERFLOW_PROSE =
  "Your input exceeds the context window of this model. Please adjust your input and try again.";

function sse(frames: Array<[string, Record<string, unknown>]>): Response {
  const body = frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Register under the caller's isolated homes, mock state and server cleanup hooks. */
export function registerComboContextOverflowCases<Server>({
  serve, baseUrl, chatSuccess, chatStream, provider, comboConfig, post, collectSse,
}: ComboHarness<Server>): void {
  test("context overflow advances while exhausted retryable targets return the sanitized last status", async () => {
    let backupHits = 0;
    const context = serve(() => Response.json(
      { error: { code: "context_length_exceeded", message: "too many tokens" } },
      { status: 400 },
    ));
    const larger = serve(() => {
      backupHits += 1;
      return chatSuccess("larger context fallback");
    });
    const advanced = await post(comboConfig({
      a: provider("openai-chat", baseUrl(context), "key-a"),
      b: provider("openai-chat", baseUrl(larger), "key-b"),
    }));
    expect(advanced.status).toBe(200);
    expect(backupHits).toBe(1);
    expect(await advanced.text()).toContain("larger context fallback");

    const order: string[] = [];
    const first = serve(() => {
      order.push("a");
      return new Response("secret sk-a-should-redact", { status: 503 });
    });
    const last = serve(() => {
      order.push("b");
      return Response.json({ error: { message: "missing model" } }, { status: 404 });
    });
    const exhausted = await post(comboConfig({
      a: provider("openai-chat", baseUrl(first), "key-a"),
      b: provider("openai-chat", baseUrl(last), "key-b"),
    }));
    expect(exhausted.status).toBe(404);
    expect(order).toEqual(["a", "b"]);
    expect(await exhausted.text()).not.toContain("sk-a-should-redact");
  });

  test("zero-output context overflow 502 hops to a healthy combo target", async () => {
    let backupHits = 0;
    const capped = serve(() => sse([
      ["response.created", { type: "response.created", response: { id: "resp_context", status: "in_progress" } }],
      ["response.failed", { type: "response.failed", response: {
        id: "resp_context",
        status: "failed",
        error: { type: "server_error", code: "upstream_server_error", message: OVERFLOW_PROSE },
      } }],
    ]));
    const backup = serve(() => {
      backupHits += 1;
      return chatStream("larger context backup");
    });
    const response = await post(comboConfig({
      a: provider("openai-responses", baseUrl(capped), "key-a"),
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    }), { stream: true });
    expect(response.status).toBe(200);
    expect(backupHits).toBe(1);
    expect(JSON.stringify(await collectSse(response))).toContain("larger context backup");
  });

  test("context overflow after committed output never replays on another target", async () => {
    // The boundary the hop verdict depends on. Once any text or tool call has reached the
    // client, the stream preflight commits the child and the failure never becomes a combo
    // classification at all -- so the same context prose that hops above must not hop here.
    let backupHits = 0;
    const committed = serve(() => sse([
      ["response.created", { type: "response.created", response: { id: "resp_committed", status: "in_progress" } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: {
        id: "msg_committed", type: "message", role: "assistant", status: "in_progress", content: [],
      } }],
      ["response.output_text.delta", {
        type: "response.output_text.delta", item_id: "msg_committed", output_index: 0, content_index: 0,
        delta: "already visible",
      }],
      ["response.failed", { type: "response.failed", response: {
        id: "resp_committed",
        status: "failed",
        error: { type: "server_error", code: "upstream_server_error", message: OVERFLOW_PROSE },
      } }],
    ]));
    const backup = serve(() => {
      backupHits += 1;
      return chatStream("must not run");
    });
    const response = await post(comboConfig({
      a: provider("openai-responses", baseUrl(committed), "key-a"),
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    }), { stream: true });
    expect(response.status).toBe(200);
    const frames = JSON.stringify(await collectSse(response));
    expect(backupHits).toBe(0);
    expect(frames).toContain("already visible");
    expect(frames).not.toContain("must not run");
  });
}

