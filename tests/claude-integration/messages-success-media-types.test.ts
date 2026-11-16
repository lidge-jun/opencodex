import { expect, test } from "bun:test";
import { handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig } from "../../src/types";
const sentinel = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
for (const count of [false, true]) for (const [type, expected] of [
  ["text/plain", "text/plain"], ["application/json", "application/json"],
  ["TEXT/PLAIN; charset=UTF-8", "text/plain; charset=utf-8"],
  ["text/plain; charset=us-ascii", "text/plain; charset=us-ascii"],
  ["application/x-fixture", "application/octet-stream"],
  [`application/json; fixture=${sentinel}`, "application/json"],
  [`text/plain; charset=${sentinel}`, "text/plain"],
]) test(`${count ? "count_tokens" : "Messages"}: success media type ${type}`, async () => {
  const body = type.toLowerCase().startsWith("application/json") ? '{"fixture":true}' : "fixture response";
  const upstream = Bun.serve({ port: 0, fetch: () => new Response(body, { headers: { "content-type": type } }) });
  try {
    const config = { providers: {}, claudeCode: { anthropicBaseUrl: upstream.url.toString() } } as OcxConfig;
    const request = new Request(`http://localhost/v1/messages${count ? "/count_tokens" : ""}`, { method: "POST", headers: { authorization: "Bearer sk-ant-oat01-fixture" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, stream: false, messages: [{ role: "user", content: "fixture" }] }) });
    const response = count ? await handleClaudeCountTokens(request, config) : await handleClaudeMessages(request, config, { model: "fixture", provider: "fixture" });
    expect(response.status).toBe(200); expect(await response.text()).toBe(body);
    const headers = JSON.stringify([...response.headers]); expect(headers.length).toBeGreaterThan(0); expect(headers).not.toContain(sentinel);
    expect(response.headers.get("content-type")).toBe(expected);
  } finally { await upstream.stop(true); }
});
