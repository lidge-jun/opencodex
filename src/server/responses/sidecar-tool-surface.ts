import type { OcxParsedRequest, OcxTool } from "../../types";
import { namespacedToolName } from "../../types";
import { buildWebSearchTool } from "../../web-search/synthetic-tool";
import { buildImageTool, buildVideoTool, IMAGE_GEN_TOOL_NAME, VIDEO_GEN_TOOL_NAME } from "../../images/synthetic-tool";

type MediaToolPlan = { toolNames: ReadonlySet<string> };

export type SidecarToolSurface =
  | { kind: "none" }
  | { kind: "web-search" }
  | { kind: "media"; image?: MediaToolPlan; video?: MediaToolPlan }
  | { kind: "advisor"; tool: OcxTool };

export function applySidecarToolSurface(parsed: OcxParsedRequest, surface: SidecarToolSurface): void {
  if (surface.kind === "none") return;
  if (surface.kind === "web-search") {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    return;
  }
  if (surface.kind === "advisor") {
    parsed.context.tools = [
      ...(parsed.context.tools ?? []).filter(tool => !tool.advisor && tool.name !== surface.tool.name),
      surface.tool,
    ];
    return;
  }
  const { image, video } = surface;
  const tools = (parsed.context.tools ?? []).filter(tool => {
    if (tool.imageGeneration || tool.videoGeneration) return false;
    if (image?.toolNames.has(tool.name)) return false;
    if (image && tool.namespace && image.toolNames.has(namespacedToolName(tool.namespace, tool.name))) return false;
    if (video && !tool.namespace && video.toolNames.has(tool.name)) return false;
    return true;
  });
  const names = new Set(tools.map(tool => tool.name));
  if (image && !names.has(IMAGE_GEN_TOOL_NAME)) tools.push(buildImageTool());
  if (video && !names.has(VIDEO_GEN_TOOL_NAME)) tools.push(buildVideoTool());
  parsed.context.tools = tools;
  const choice = parsed.options.toolChoice;
  if (image && choice && typeof choice === "object" && "allowedTools" in choice && Array.isArray(choice.allowedTools)) {
    const mapped = choice.allowedTools.map(name =>
      name === "image_generation" || name === "image_gen" || image.toolNames.has(name) ? IMAGE_GEN_TOOL_NAME : name);
    parsed.options.toolChoice = { ...choice, allowedTools: [...new Set(mapped)] };
  } else if (image && choice && typeof choice === "object" && "name" in choice && typeof choice.name === "string"
    && (choice.name === "image_generation" || image.toolNames.has(choice.name))) {
    parsed.options.toolChoice = { ...choice, name: IMAGE_GEN_TOOL_NAME };
  }
}
