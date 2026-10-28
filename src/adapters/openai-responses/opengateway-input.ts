import { isPlainObject } from "./internal";
import { normalizeResponsesToolResultAdjacency } from "./tool-output-recovery";

export class OpenGatewayInputCompatibilityError extends Error {
  constructor() {
    super("OpenGateway cannot preserve this tool result; use text or valid input_image parts with a call_id.");
    this.name = "OpenGatewayInputCompatibilityError";
  }
}

const TOOL_ROUND_TYPES = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "local_shell_call_output",
]);

function normalizeImageDetail(part: unknown): unknown {
  return isPlainObject(part) && part.type === "input_image" && part.detail === "original"
    ? { ...part, detail: "high" }
    : part;
}

function isToolRound(item: unknown): boolean {
  return isPlainObject(item) && typeof item.type === "string" && TOOL_ROUND_TYPES.has(item.type);
}

function pairedCallId(item: Record<string, unknown>): string | undefined {
  return typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : undefined;
}

type ProjectedInput = { readonly changed: boolean; readonly input: unknown[] };

function projectOpenGatewayInput(input: readonly unknown[]): ProjectedInput {
  let changed = false;
  const projected: unknown[] = [];
  const pendingImages: unknown[] = [];
  const flushImages = (): void => {
    if (pendingImages.length === 0) return;
    projected.push(...pendingImages);
    pendingImages.length = 0;
  };
  for (const item of input) {
    if (!isToolRound(item)) flushImages();
    if (!isPlainObject(item)) {
      projected.push(item);
      continue;
    }
    if (item.type === "function_call_output" && Array.isArray(item.output)) {
      const callId = pairedCallId(item);
      const content: Record<string, unknown>[] = [];
      const text: string[] = [];
      let supported = callId !== undefined;
      let hasImage = false;
      if (supported) {
        for (const part of item.output) {
          if (!isPlainObject(part)) {
            supported = false;
            break;
          }
          switch (part.type) {
            case "text":
            case "input_text":
            case "output_text":
              if (typeof part.text !== "string") {
                supported = false;
                break;
              }
              text.push(part.text);
              content.push({ type: "input_text", text: part.text });
              break;
            case "input_image":
              if (!((typeof part.image_url === "string" && part.image_url.length > 0)
                || (typeof part.file_id === "string" && part.file_id.length > 0))
                || (part.image_url !== undefined && typeof part.image_url !== "string")
                || (part.file_id !== undefined && typeof part.file_id !== "string")
                || (part.detail !== undefined && (typeof part.detail !== "string"
                  || !["auto", "low", "high", "original"].includes(part.detail)))) {
                supported = false;
                break;
              }
              content.push({ ...part, ...(part.detail === "original" ? { detail: "high" } : {}) });
              hasImage = true;
              break;
            default:
              supported = false;
          }
          if (!supported) break;
        }
      }
      if (supported && callId !== undefined) {
        changed = true;
        const marker = `[tool output for ${callId}]`;
        projected.push({
          ...item,
          output: text.length > 0 ? text.join("\n") : hasImage ? marker : "",
        });
        if (hasImage) {
          pendingImages.push({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: marker }, ...content],
          });
        }
        continue;
      }
      throw new OpenGatewayInputCompatibilityError();
    }
    if (Array.isArray(item.content)) {
      const originalContent = item.content;
      const content = originalContent.map(normalizeImageDetail);
      if (content.some((part, index) => part !== originalContent[index])) {
        changed = true;
        projected.push({ ...item, content });
        continue;
      }
    }
    projected.push(item);
  }
  flushImages();
  return { changed, input: projected };
}

/** OpenGateway requires string tool results and auto/low/high image detail. */
export function normalizeOpenGatewayResponsesInput(body: unknown, url: string): unknown {
  // Same exact-URL boundary as completion recovery; a query-routed variant is a different destination.
  if (url !== "https://apis.opengateway.ai/v1/responses" || !isPlainObject(body) || !Array.isArray(body.input)) return body;

  const direct = projectOpenGatewayInput(body.input);
  if (!direct.changed) return body;
  const aligned = normalizeResponsesToolResultAdjacency(body);
  if (!isPlainObject(aligned) || !Array.isArray(aligned.input) || aligned === body) {
    return { ...body, input: direct.input };
  }
  const paired = projectOpenGatewayInput(aligned.input);
  return { ...aligned, input: paired.changed ? paired.input : direct.input };
}
