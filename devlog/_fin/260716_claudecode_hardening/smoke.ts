// One-shot isolated smoke (040 cr5). Run with OPENCODEX_HOME + CODEX_HOME pre-set to tmpdirs:
//   OPENCODEX_HOME=$(mktemp -d) CODEX_HOME=$(mktemp -d) bun devlog/_plan/260716_claudecode_hardening/smoke.ts
import { saveConfig } from "../../../src/config";
import { startServer } from "../../../src/server";
import type { OcxConfig } from "../../../src/types";

let upstreamCalls = 0;
const upstream = Bun.serve({
  port: 0,
  fetch() {
    upstreamCalls++;
    if (upstreamCalls === 1) {
      return Response.json({ error: { message: "transient blip" } }, { status: 502, headers: { "Retry-After": "0" } });
    }
    const frames = [
      `event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_smoke", status: "in_progress" } })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "smoke ok" })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`,
    ];
    return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
  },
});

saveConfig({
  port: 0,
  defaultProvider: "native",
  providers: {
    native: { adapter: "openai-responses", baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`, authMode: "forward", allowPrivateNetwork: true },
  },
} as OcxConfig);

const server = startServer(0);
const healthz = await fetch(new URL("/healthz", server.url));
const messages = await fetch(new URL("/v1/messages", server.url), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "native/gpt-test", max_tokens: 32, messages: [{ role: "user", content: "ping" }] }),
});
const body = await messages.json() as { content?: Array<{ text?: string }> };
console.log(JSON.stringify({
  healthz: healthz.status,
  messagesStatus: messages.status,
  upstreamCalls,
  text: body.content?.[0]?.text ?? null,
}));
server.stop(true);
upstream.stop(true);
process.exit(0);
