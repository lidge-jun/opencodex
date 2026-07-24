import type { OcxTool } from "../types";

/** The function name the chat model sees + the name the loop intercepts. */
export const IMAGE_GEN_TOOL_NAME = "image_gen";

const IMAGE_GEN_NAMES = new Set([
  "image_gen", "image_generation", "imagegen",
  "generate_image", "generateimage",
]);

export function isImageGenName(name: string): boolean {
  return IMAGE_GEN_NAMES.has(name.toLowerCase());
}

/**
 * Scan a Responses request's `tools[]` for hosted image-generation entries (`{type:"image_generation"}` or
 * `{type:"image_gen"}`) and function entries whose name matches `isImageGenName`. Returns the set of all
 * matched tool names plus the first matched raw tool object (so its config can be replayed), or undefined
 * when image generation isn't enabled.
 */
export function extractHostedImageGeneration(
  tools: unknown[] | undefined,
): { toolNames: Set<string>; originalTool?: Record<string, unknown> } | undefined {
  if (!Array.isArray(tools)) return undefined;
  const toolNames = new Set<string>();
  let originalTool: Record<string, unknown> | undefined;
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const obj = t as Record<string, unknown>;
    if (obj.type === "image_generation" || obj.type === "image_gen") {
      if (!originalTool) originalTool = obj;
      const name = typeof obj.name === "string" ? obj.name : (obj.type as string);
      toolNames.add(name);
    } else if (obj.type === "function") {
      const fnName = (obj as { function?: { name?: string } }).function?.name;
      if (fnName && isImageGenName(fnName)) {
        if (!originalTool) originalTool = obj;
        toolNames.add(fnName);
      }
    }
  }
  if (toolNames.size === 0) return undefined;
  return { toolNames, originalTool };
}

/**
 * The synthetic function tool exposed to a chat/anthropic model in place of the dropped hosted
 * image_generation. The model calls it like any function; the proxy intercepts the call and runs the
 * real generation via the sidecar (the call is never relayed to Codex). `imageGeneration:true` flags it.
 */
export function buildImageTool(): OcxTool {
  return {
    name: IMAGE_GEN_TOOL_NAME,
    description:
      "Generate or edit an image. Returns absolute local filesystem path(s). " +
      "Use when the user asks to create, draw, or edit an image.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed image generation prompt. Required." },
        n: { type: "integer", minimum: 1, maximum: 4 },
        size: { type: "string" },
        quality: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["prompt"],
    },
    imageGeneration: true,
  };
}
