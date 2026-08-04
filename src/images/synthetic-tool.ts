import type { OcxTool } from "../types";

/** The function name the chat model sees + the name the loop intercepts. */
export const IMAGE_GEN_TOOL_NAME = "image_gen";

/** Client function aliases collected only when a hosted image tool is also present. */
const IMAGE_GEN_ALIASES = new Set([
  "imagegen",
  "generate_image",
  "generateimage",
  IMAGE_GEN_TOOL_NAME,
  "image_generation",
]);

export function isImageGenName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === IMAGE_GEN_TOOL_NAME || lower === "image_generation";
}

function isImageGenClientAlias(name: string): boolean {
  return IMAGE_GEN_ALIASES.has(name.toLowerCase());
}

/**
 * Scan a Responses request's `tools[]` for hosted image-generation entries
 * (`{type:"image_generation"}` or `{type:"image_gen"}`). Ordinary `type:"function"`
 * tools never activate the bridge by name alone — they are only collected as conflicting
 * aliases to strip/replace when a hosted entry is present.
 */
export function extractHostedImageGeneration(
  tools: unknown[] | undefined,
): { toolNames: Set<string>; originalTool?: Record<string, unknown> } | undefined {
  if (!Array.isArray(tools)) return undefined;
  let hasHostedEntry = false;
  let originalTool: Record<string, unknown> | undefined;
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const obj = t as Record<string, unknown>;
    if (obj.type === "image_generation" || obj.type === "image_gen") {
      hasHostedEntry = true;
      if (!originalTool) originalTool = obj;
    }
  }
  if (!hasHostedEntry) return undefined;

  const toolNames = new Set<string>();
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const obj = t as Record<string, unknown>;
    if (obj.type === "image_generation" || obj.type === "image_gen") {
      const name = typeof obj.name === "string" ? obj.name : (obj.type as string);
      toolNames.add(name);
    } else if (obj.type === "function") {
      // Responses API function tools have a flat shape: {type:"function", name:"...", parameters:{...}}.
      // Also handle the nested Chat Completions shape {type:"function", function:{name:"..."}} for safety.
      const fnName =
        typeof obj.name === "string" ? obj.name : (obj as { function?: { name?: string } }).function?.name;
      if (fnName && isImageGenClientAlias(fnName)) {
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
      "Generate an image from a text prompt. Returns absolute local filesystem path(s). " +
      "Use when the user asks to create or draw an image.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed image generation prompt. Required." },
        n: { type: "integer", minimum: 1, maximum: 4 },
      },
      required: ["prompt"],
    },
    imageGeneration: true,
  };
}

/** The function name the chat model sees for video generation. */
export const VIDEO_GEN_TOOL_NAME = "video_gen";

const VIDEO_GEN_NAMES = new Set([
  "video_gen",
  "video_generation",
  "videogen",
  "generate_video",
  "generatevideo",
]);

export function isVideoGenName(name: string): boolean {
  return VIDEO_GEN_NAMES.has(name.toLowerCase());
}

/**
 * The synthetic function tool exposed to a chat/anthropic model for video generation.
 * Unlike image_generation, there is no hosted OpenAI tool type for video — this tool is
 * unconditionally injected when the video bridge is enabled. `videoGeneration:true` flags it
 * so the forced-final pass can drop it.
 */
export function buildVideoTool(): OcxTool {
  return {
    name: VIDEO_GEN_TOOL_NAME,
    description:
      "Generate a short video (1-15 seconds) from a text prompt. Returns an absolute local filesystem path. " +
      "Use when the user asks to create, animate, or generate a video.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed video generation prompt. Required." },
        duration: { type: "integer", minimum: 1, maximum: 15, description: "Video length in seconds. Default 6." },
        resolution: { type: "string", enum: ["480p", "720p"], description: "Video resolution. Default 720p." },
        aspect_ratio: {
          type: "string",
          enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
          description: "Aspect ratio. Default 16:9.",
        },
      },
      required: ["prompt"],
    },
    videoGeneration: true,
  };
}
