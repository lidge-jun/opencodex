/**
 * Cheap request-side evidence extraction for policy routing (RI-05).
 *
 * Extracts only what the request body can prove: whether the caller asked for
 * tools and whether the input contains image parts. Context-window size is
 * left unknown at routing time (documented limitation) - the dry-run API/CLI
 * remains the evidence-inspection surface for context-sensitive profiles.
 */

import type { OcxConfig } from "../types";
import type { PolicyRequestEvidence } from "./evaluator";
import { getRoutingProfile, resolvePolicyProfileId } from "./profile";
import { classifyPromptComplexity, reasoningEffortFromBody } from "./prompt-classifier";

/**
 * Walk a body fragment for image parts. Real request shapes nest image blocks:
 * Responses puts them under `input[].content[]` (type `input_image`), Chat
 * Completions under `messages[].content[]` (type `image_url`), and Claude
 * Messages under `messages[].content[]` (type `image`), so the scan recurses
 * into arrays and `content` fields instead of only checking the top level.
 */
function containsImagePart(value: unknown): boolean {
  if (typeof value === "string") return false;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsImagePart);
  const record = value as Record<string, unknown>;
  if (record.type === "image" || record.type === "input_image") return true;
  if (record.image_url !== undefined || record.image !== undefined) return true;
  if (record.content !== undefined && containsImagePart(record.content)) return true;
  return false;
}

function inputContainsImage(input: unknown): boolean {
  if (typeof input === "string") return false;
  if (!Array.isArray(input)) return false;
  return input.some(containsImagePart);
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n");
  const record = value as Record<string, unknown>;
  if ((record.type === "input_text" || record.type === "text") && typeof record.text === "string") {
    return record.text;
  }
  return "";
}

function latestUserPrompt(record: Record<string, unknown>): string {
  if (typeof record.input === "string") return record.input;
  for (const collection of [record.input, record.messages]) {
    if (!Array.isArray(collection)) continue;
    for (let index = collection.length - 1; index >= 0; index--) {
      const item = collection[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const message = item as Record<string, unknown>;
      if (message.role !== "user") continue;
      const text = textFromContent(message.content);
      if (text.trim()) return text;
    }
  }
  return "";
}

export function evidenceFromBody(
  body: unknown,
  options: { classifyPrompt?: boolean } = {},
): PolicyRequestEvidence {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const tools = Array.isArray(record.tools) && record.tools.length > 0;
  const image = inputContainsImage(record.input) || inputContainsImage(record.messages);
  const prompt = options.classifyPrompt ? latestUserPrompt(record) : "";
  const taskTier = options.classifyPrompt
    ? prompt
      ? classifyPromptComplexity(prompt, reasoningEffortFromBody(record)).tier
      : "balanced"
    : undefined;
  return {
    ...(tools ? { toolsRequired: true } : {}),
    ...(image ? { imageInputRequired: true } : {}),
    ...(taskTier ? { taskTier } : {}),
  };
}

/**
 * Request evidence for one requested model. Prompt classification is opt-in
 * and runs only when that model resolves to a prompt-routing profile.
 */
export function evidenceForModelRequest(
  config: Pick<OcxConfig, "routingProfiles">,
  modelId: string,
  body: unknown,
): PolicyRequestEvidence {
  const profileId = resolvePolicyProfileId(config, modelId);
  const profile = profileId ? getRoutingProfile(config, profileId) : undefined;
  return evidenceFromBody(body, { classifyPrompt: profile?.promptRouting?.enabled === true });
}
