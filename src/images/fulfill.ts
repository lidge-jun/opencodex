import type { ImageBridgePlan, ImageCallResult } from "./types";
import { callXaiImages } from "./xai-client";
import { materializeInlineImage, downloadImageToArtifact, type ImageBudget } from "./artifacts";

/**
 * Fulfill ONE image-generation tool call end-to-end: parse args, call xAI, materialize the returned
 * images to disk, and return a structured result. NEVER throws — all errors become `{ ok: false }`
 * so the caller can inject the error as a tool result and let the model respond gracefully.
 */
export async function fulfillImageCall(
  call: { id: string; name: string; arguments: string },
  plan: ImageBridgePlan,
  budget: ImageBudget,
  signal?: AbortSignal,
): Promise<ImageCallResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "invalid arguments JSON" };
  }

  const prompt =
    typeof args.prompt === "string" ? args.prompt : typeof args.input === "string" ? args.input : "";
  if (!prompt) {
    return { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "missing prompt" };
  }

  const n = typeof args.n === "number" ? Math.max(1, Math.min(4, Math.floor(args.n))) : 1;
  const imageUrl =
    typeof args.image_url === "string" ? args.image_url : typeof args.image === "string" ? args.image : undefined;

  let result;
  try {
    result = await callXaiImages({ prompt, model: plan.model, n, imageUrl }, plan.auth, signal);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, model: plan.model, prompt, files: [], count: 0, error };
  }

  const files: string[] = [];
  for (const img of result.images ?? []) {
    try {
      if (img.b64_json) {
        files.push(await materializeInlineImage("image/png", img.b64_json, budget));
      } else if (img.url) {
        files.push(await downloadImageToArtifact(img.url, budget, signal));
      }
    } catch (e) {
      // Partial success is OK — silently skip this image and continue.
      console.warn(`[images] failed to materialize image: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (files.length === 0) {
    return { ok: false, model: plan.model, prompt, files: [], count: 0, error: "image generation returned no usable images" };
  }

  const primary = files[0];
  return {
    ok: true,
    model: plan.model,
    prompt,
    path: primary,
    files,
    count: files.length,
    markdown: `![image](${primary})`,
  };
}
