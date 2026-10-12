import { expect, test } from "bun:test";
import { isComboTargetInCooldown } from "../../src/combos";
import { responsesSuccess } from "./combo-failover-upstream";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

interface Harness<Server> {
  serve(handler: (request: Request) => Response | Promise<Response>): Server;
  baseUrl(server: Server): string;
  provider(adapter: string, url: string, apiKey: string, extra?: Partial<OcxProviderConfig>): OcxProviderConfig;
  comboConfig(providers: OcxConfig["providers"], targets?: Array<{ provider: string; model: string }>,
    extra?: Partial<NonNullable<OcxConfig["combos"]>[string]>): OcxConfig;
  post(config: OcxConfig, raw?: Record<string, unknown>): Promise<Response>;
}

/**
 * Register inside the parent describe: its isolated homes, mocks and cleanup still apply.
 *
 * Split out of tests/server/server-combo-failover-e2e.test.ts when that file crossed its
 * file-size ratchet cap. The case is unchanged; only its home moved, following the same
 * register-cases seam the forced-effort and context-overflow groups already use.
 */
export function registerComboToolRoutingCases<Server>({
  serve, baseUrl, provider, comboConfig, post,
}: Harness<Server>): void {
for (const stream of [false, true]) {
  test(`Responses tool-routing mismatch advances to a healthy target, stream=${stream}`, async () => {
    const hits: string[] = [];
    const toolResult = { type: "function_call_output", call_id: "call_exec", output: "tool result" };
    const incompatible = serve(async request => {
      hits.push("incompatible");
      const raw = await request.json() as { input?: unknown[] };
      expect(raw.input).toEqual([toolResult]);
      return Response.json({ error: {
        type: "invalid_request_error", code: null, param: "reasoning_effort",
        message: "Function tools with reasoning_effort are not supported for gpt-6-astra-2026-09-03 in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
      } }, { status: 400 });
    });
    const backup = serve(async request => {
      hits.push("backup");
      const raw = await request.json() as { input?: unknown[] };
      expect(raw.input).toEqual([toolResult]);
      const response = responsesSuccess("recovered tool request", "m2");
      return stream
        ? new Response([
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "recovered tool request", item_id: "msg_backup", output_index: 0, content_index: 0 })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
        ].join(""), { headers: { "content-type": "text/event-stream" } })
        : Response.json(response);
    });
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(incompatible), "key-a"),
      b: provider("openai-responses", baseUrl(backup), "key-b"),
    });
    const response = await post(config, { stream, input: [toolResult], reasoning: { effort: "high" }, tools: [{
      type: "function", name: "exec", description: "Run a command",
      parameters: { type: "object", properties: {} },
    }] });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("recovered tool request");
    expect(text).not.toContain("chat/completions");
    expect(hits).toEqual(["incompatible", "backup"]);
    expect(isComboTargetInCooldown("free", { provider: "a", model: "m1" })).toBe(false);
  });
}
}
