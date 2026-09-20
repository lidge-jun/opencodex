/**
 * Rewrite an xAI-style HTTP 403 model refusal into a Chat Completions 200 that
 * the openai-chat adapter already knows how to terminate as content_filter.
 * Codex then records an assistant turn instead of a transport error.
 */
export function syntheticOpenAIChatRefusalResponse(message: string, stream: boolean): Response {
  const content = message.trim() || "I can't help with that request.";
  if (!stream) {
    const body = {
      id: "chatcmpl-policy-refusal",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "content_filter",
      }],
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const roleChunk = {
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  };
  const doneChunk = {
    choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
  };
  const sse = `data: ${JSON.stringify(roleChunk)}\n\ndata: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`;
  return new Response(sse, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
