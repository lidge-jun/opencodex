/** The exact detached Responses envelope, shared by quota sizing and the invoker. */
export const JEV_MODEL_MAX_OUTPUT_TOKENS = 1024;
export interface JevModelRequestBody {
  model: string;
  instructions: string;
  input: string;
}
/** Serialize the streaming decision-model request body, adding the reasoning effort only when one is given. */
export function serializeJevModelRequest(request: JevModelRequestBody, effort?: string): string {
  return JSON.stringify({
    model: request.model,
    stream: true,
    store: false,
    instructions: request.instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: request.input }] }],
    tools: [],
    max_output_tokens: JEV_MODEL_MAX_OUTPUT_TOKENS,
    ...(effort ? { reasoning: { effort } } : {}),
  });
}
