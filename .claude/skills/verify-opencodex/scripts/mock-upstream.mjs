#!/usr/bin/env bun
const port = Number(process.env.OPENCODEX_VERIFY_MOCK_PORT ?? "19102");
const completed = {
  id: "resp_verify",
  object: "response",
  status: "completed",
  model: "fixture-model",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "fixture-model", object: "model" }] });
    }
    if (req.method === "POST" && url.pathname.endsWith("/responses/compact")) {
      return Response.json({
        output: [{ type: "message", role: "user", content: [{ type: "input_text", text: "pong compact" }] }],
      });
    }
    if (req.method === "POST" && url.pathname.endsWith("/responses")) {
      return Response.json(completed);
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock-upstream ${port}`);
