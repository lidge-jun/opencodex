/**
 * Upstream response shapes for the combo failover suite.
 *
 * Moved verbatim out of tests/server/server-combo-failover-e2e.test.ts: that file is one line
 * under its file-size cap and needed room to take the spend-journal lease. These builders
 * decide nothing; each returns exactly the payload its callers were already constructing.
 */
export function chatSuccess(text: string, model = "model"): Response {
  return Response.json({
    id: `chatcmpl-${model}`,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

export function chatStream(text: string): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(frames, { headers: { "content-type": "text/event-stream" } });
}

export function chatTruncatedZeroOutputStream(): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`,
  ].join("");
  return new Response(frames, { headers: { "content-type": "text/event-stream" } });
}

export function chatErrorStream(message: string, prefix?: string): Response {
  const frames = [
    ...(prefix
      ? [`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: prefix }, finish_reason: null }] })}\n\n`]
      : []),
    `data: ${JSON.stringify({ error: { type: "server_error", code: "upstream_server_error", message } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(frames, { headers: { "content-type": "text/event-stream" } });
}

export function responsesSuccess(text: string, model = "responses-model"): Record<string, unknown> {
  return {
    id: `resp-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_backup",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}
