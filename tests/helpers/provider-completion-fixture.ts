import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { runProviderCompletionTest, type ProviderCompletionTestDependencies } from "../../src/server/management/provider-completion-test";
import { handleManagementAPI } from "../../src/server/management-api";
export const frame = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
export const chat = (model: string | undefined = "test-model", content = "OK") => frame({ model, choices: [{ delta: { content }, finish_reason: "stop" }] }) + frame("[DONE]");
export function fixture(overrides: Partial<OcxProviderConfig> = {}, respond: (init?: RequestInit) => Response | Promise<Response> = () => new Response(chat())) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const row: OcxProviderConfig & { fetch?: typeof fetch } = {
    adapter: "openai-chat", baseUrl: "https://provider.example/v1", authMode: "key", apiKey: "opaque-fixture-key", liveModels: false,
    fetch: (async (url, init) => { calls.push({ url: String(url), init }); return respond(init); }) as typeof fetch,
    ...overrides,
  };
  const config = { port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", providers: { fixture: row } } as OcxConfig;
  const run = (model = "test-model", deps?: ProviderCompletionTestDependencies, signal?: AbortSignal) => runProviderCompletionTest({ config, name: "fixture", model, signal }, deps);
  const route = async (body: unknown = { model: "test-model", confirm: true }, name = "fixture", signal?: AbortSignal) => {
    const req = new Request(`http://127.0.0.1/api/providers/test-completion?name=${name}`, { method: "POST", headers: { Host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const response = await handleManagementAPI(req, new URL(req.url), config, {});
    if (!response) throw new Error("missing route");
    return { status: response.status, body: await response.json() as any };
  };
  return { row, config, calls, run, route };
}
