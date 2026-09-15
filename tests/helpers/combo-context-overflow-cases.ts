import { expect, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

interface ComboHarness<Server> {
  serve(handler: () => Response | Promise<Response>): Server;
  baseUrl(server: Server): string;
  chatSuccess(text: string, model?: string): Response;
  provider(adapter: string, url: string, apiKey: string, extra?: Partial<OcxProviderConfig>): OcxProviderConfig;
  comboConfig(providers: OcxConfig["providers"]): OcxConfig;
  post(config: OcxConfig, raw?: Record<string, unknown>): Promise<Response>;
  chatStream(text: string): Response;
  collectSse(response: Response): Promise<unknown[]>;
}

/** Register under the caller's isolated homes, mock state and server cleanup hooks. */
export function registerComboContextOverflowCases<Server>({
  serve, baseUrl, chatSuccess, provider, comboConfig, post, chatStream, collectSse,
}: ComboHarness<Server>): void {
  test("context overflow advances while exhausted retryable targets return the sanitized last status", async () => {
    let stopBackupHits = 0;
    const context = serve(() => Response.json({ error: { code: "context_length_exceeded", message: "too many tokens" } }, { status: 400 }));
    const unused = serve(() => {
      stopBackupHits += 1;
      return chatSuccess("larger context fallback");
    });
    const stopConfig = comboConfig({
      a: provider("openai-chat", baseUrl(context), "key-a"),
      b: provider("openai-chat", baseUrl(unused), "key-b"),
    });
    const stopped = await post(stopConfig);
    expect(stopped.status).toBe(200);
    expect(stopBackupHits).toBe(1);
    expect(await stopped.text()).toContain("larger context fallback");

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
    const capped = serve(() => new Response([
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_context","status":"in_progress"}}',
      "",
      "event: response.failed",
      'data: {"type":"response.failed","response":{"id":"resp_context","status":"failed","error":{"type":"server_error","code":"upstream_server_error","message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}}',
      "",
      "",
    ].join("\n"), { headers: { "content-type": "text/event-stream" } }));
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
}
