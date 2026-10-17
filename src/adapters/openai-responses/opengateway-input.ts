import { isPlainObject } from "./internal";
import { normalizeResponsesToolResultAdjacency } from "./tool-output-recovery";

function normalizeImageDetail(part: unknown): unknown {
  return isPlainObject(part) && part.type === "input_image" && part.detail === "original"
    ? { ...part, detail: "high" }
    : part;
}

/** OpenGateway requires string tool results and auto/low/high image detail. */
export function normalizeOpenGatewayResponsesInput(body: unknown, url: string): unknown {
  const destination = new URL(url);
  if (destination.origin !== "https://apis.opengateway.ai" || destination.pathname !== "/v1/responses"
    || !isPlainObject(body) || !Array.isArray(body.input)) return body;

  let changed = false;
  const input: unknown[] = [];
  const pendingImages: unknown[] = [];
  for (const item of body.input) {
    if (!isPlainObject(item) || item.type !== "function_call_output") {
      input.push(...pendingImages);
      pendingImages.length = 0;
    }
    if (!isPlainObject(item)) { input.push(item); continue; }
    if (item.type === "function_call_output" && Array.isArray(item.output)) {
      const content: Record<string, unknown>[] = [];
      const text: string[] = [];
      let supported = true;
      let hasImage = false;
      for (const part of item.output) {
        if (!isPlainObject(part)) { supported = false; break; }
        switch (part.type) {
          case "text":
          case "input_text":
          case "output_text":
            if (typeof part.text !== "string") { supported = false; break; }
            text.push(part.text);
            content.push({ type: "input_text", text: part.text });
            break;
          case "refusal":
            if (typeof part.refusal !== "string") { supported = false; break; }
            text.push(`[refusal] ${part.refusal}`);
            content.push({ type: "input_text", text: `[refusal] ${part.refusal}` });
            break;
          case "input_image":
            if (typeof part.image_url !== "string" && typeof part.file_id !== "string") { supported = false; break; }
            content.push({ ...part, ...(part.detail === "original" ? { detail: "high" } : {}) });
            hasImage = true;
            break;
          default:
            supported = false;
        }
        if (!supported) break;
      }
      // Opaque or unsupported parts must remain visible to validation, never disappear.
      if (supported) {
        changed = true;
        input.push({ ...item, output: text.join("\n") });
        if (hasImage) pendingImages.push({ type: "message", role: "user", content: [
          { type: "input_text", text: `[tool output for ${item.call_id}]` }, ...content,
        ] });
        continue;
      }
    }
    if (Array.isArray(item.content)) {
      const originalContent = item.content;
      const content = originalContent.map(normalizeImageDetail);
      if (content.some((part, index) => part !== originalContent[index])) {
        changed = true;
        input.push({ ...item, content });
        continue;
      }
    }
    input.push(item);
  }
  input.push(...pendingImages);
  return changed ? normalizeResponsesToolResultAdjacency({ ...body, input }) : body;
}
