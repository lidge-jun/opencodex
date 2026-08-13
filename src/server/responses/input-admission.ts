import { walkJsonTree } from "../../lib/json-walk";
import { estimateTokenFraction } from "../../lib/token-estimate";
import type { OcxParsedRequest } from "../../types";

export const ADMISSION_ESTIMATE_HEADROOM_RATIO = 0.1;
// Raw base64 length is unrelated to model input tokens. This fixed reserve also
// dominates the vision sidecar's bounded per-image text replacement.
const IMAGE_TOKEN_ESTIMATE = 1_024;

export interface InputAdmissionEstimateOptions {
  extraText?: readonly string[];
}

export function hardAdmissionThreshold(inputLimit: number): number {
  return Math.ceil(inputLimit * (1 + ADMISSION_ESTIMATE_HEADROOM_RATIO));
}

export function shouldRejectEstimatedInput(estimatedTokens: number, inputLimit: number): boolean {
  return estimatedTokens > hardAdmissionThreshold(inputLimit);
}

/**
 * Estimate prompt-bearing parsed input without materializing another serialized request.
 * The caller supplies a hard scan cap, normally `hardAdmissionThreshold(limit)`.
 */
export function estimateAdmissionInput(
  parsed: OcxParsedRequest,
  modelId: string,
  scanCap: number,
  options: InputAdmissionEstimateOptions = {},
): number {
  let estimatedTokens = 0;
  const isDone = () => estimatedTokens > scanCap;
  const countText = (text: string) => {
    estimatedTokens += estimateTokenFraction(text, modelId);
  };
  const countJsonTokens = (value: unknown): void => {
    walkJsonTree(value, {
      isDone,
      onValue: current => {
        if (typeof current === "string") countText(current);
        else if (typeof current === "number" || typeof current === "boolean") countText(String(current));
      },
      onObjectKey: countText,
    });
  };

  for (const text of options.extraText ?? []) {
    if (text.length > 0) countText(text);
    if (isDone()) return Math.ceil(estimatedTokens);
  }
  for (const message of parsed.context.messages) {
    if (isDone()) break;
    if (typeof message.content === "string") {
      countText(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === "text") countText(part.text);
        else if (part.type === "image") estimatedTokens += IMAGE_TOKEN_ESTIMATE;
        else countJsonTokens(part);
        if (isDone()) break;
      }
    }
    for (const [key, value] of Object.entries(message)) {
      if (key === "content" || value === undefined) continue;
      countText(key);
      countJsonTokens(value);
      if (isDone()) break;
    }
  }
  for (const prompt of parsed.context.systemPrompt ?? []) {
    if (isDone()) break;
    countText(prompt);
  }
  for (const tool of parsed.context.tools ?? []) {
    if (isDone()) break;
    countJsonTokens(tool);
  }
  if (!isDone() && parsed.options.textFormat !== undefined) countJsonTokens(parsed.options.textFormat);
  if (!isDone() && parsed._webSearch !== undefined) countJsonTokens(parsed._webSearch);
  if (!isDone() && parsed._imageGeneration?.originalTool !== undefined) {
    countJsonTokens(parsed._imageGeneration.originalTool);
  }
  return Math.ceil(estimatedTokens);
}
