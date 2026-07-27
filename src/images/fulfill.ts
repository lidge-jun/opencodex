import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ImageBridgePlan, ImageCallResult } from "./types";
import { callXaiImages } from "./xai-client";
import {
  materializeInlineImage,
  downloadImageToArtifact,
  pruneArtifacts,
  type ImageBudget,
} from "./artifacts";

/** Serialize write→prune→retain across concurrent fulfillments sharing artifacts/. */
let retentionTail: Promise<void> = Promise.resolve();

async function retainAfterBatch(paths: string[], keepCount?: number): Promise<string[]> {
  const run = retentionTail.then(() => {
    pruneArtifacts(keepCount);
    return paths.filter((p) => existsSync(p));
  });
  retentionTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "invalid arguments JSON" };
  }
  if (typeof args !== "object" || args === null) {
    return { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "invalid arguments JSON" };
  }
  const obj = args as Record<string, unknown>;

  const prompt =
    typeof obj.prompt === "string" ? obj.prompt : typeof obj.input === "string" ? obj.input : "";
  if (!prompt) {
    return { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "missing prompt" };
  }

  const n = typeof obj.n === "number" ? Math.max(1, Math.min(4, Math.floor(obj.n))) : 1;
  const imageUrl =
    typeof obj.image_url === "string" ? obj.image_url : typeof obj.image === "string" ? obj.image : undefined;
  const size = typeof obj.size === "string" ? obj.size : plan.defaultSize;
  const quality = typeof obj.quality === "string" ? obj.quality : plan.defaultQuality;

  let result;
  try {
    result = await callXaiImages(
      { prompt, model: plan.model, n, imageUrl, size, quality },
      plan.auth,
      signal,
      plan.timeoutMs,
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, model: plan.model, prompt, files: [], count: 0, error };
  }

  const files: string[] = [];
  for (const img of result.images ?? []) {
    try {
      if (img.b64_json) {
        files.push(await materializeInlineImage(img.b64_json, budget));
      } else if (img.url) {
        files.push(await downloadImageToArtifact(img.url, budget, signal));
      }
    } catch {
      // Keep warnings URL-free — error messages may embed provider CDN URLs.
      // Partial success is OK — silently skip this image and continue.
      console.warn("[images] failed to materialize image");
    }
  }

  // Prune only after the full batch is on disk so a tight keepCount cannot delete
  // an earlier image from this same call before we return its path. Concurrent
  // fulfillments share one retention chain so they cannot prune each other's
  // just-written paths mid-filter.
  const retained = await retainAfterBatch(files, plan.artifactsKeepCount);

  if (retained.length === 0) {
    return { ok: false, model: plan.model, prompt, files: [], count: 0, error: "image generation returned no usable images" };
  }

  const primary = retained[0]!;
  return {
    ok: true,
    model: plan.model,
    prompt,
    path: primary,
    files: retained,
    count: retained.length,
    // Keep path/files as native FS paths; Markdown needs a file: URI so Windows
    // backslashes are not treated as escapes by renderers.
    markdown: `![image](${pathToFileURL(primary).href})`,
  };
}
