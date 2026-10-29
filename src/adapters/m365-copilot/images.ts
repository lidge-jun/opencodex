import type { OcxMessage, OcxProviderConfig } from "../../types";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { providerOutboundPost } from "../../lib/provider-outbound";
import { fetchPublicHttpsImage, sniffImageExtension } from "../../images/artifacts";
import { M365_COPILOT_BASE_URL, m365CopilotScenario } from "../../providers/m365-copilot-models";
import { M365CopilotTurnError } from "./transport";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;
const MAX_IMAGE_BATCH_BYTES = MAX_IMAGE_BYTES * MAX_IMAGES;
export interface M365ImageAnnotation {
  id: string;
  messageAnnotationMetadata: { "@type": "File"; annotationType: "File"; fileType: string; fileName: string };
  messageAnnotationType: "ImageFile";
}

/** Read the IR so image-bearing tool results are preserved before Chat text lowering. */
export function m365ImageUrls(messages: OcxMessage[]): string[] {
  return messages.flatMap(m => m.role !== "assistant" && Array.isArray(m.content)
    ? m.content.flatMap(p => p.type === "image" ? [p.imageUrl] : []) : []);
}

async function imageData(url: string, signal: AbortSignal): Promise<{ dataUrl: string; fileType: string; bytes: number }> {
  let bytes: Uint8Array;
  if (url.startsWith("data:")) {
    if (url.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100) throw new M365CopilotTurnError("Microsoft 365 Copilot image exceeds the 5 MiB limit", 413);
    const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
    if (!m || m[2].length % 4 === 1) throw new M365CopilotTurnError("Microsoft 365 Copilot requires a valid PNG, JPEG, GIF or WebP image", 400);
    bytes = Buffer.from(m[2], "base64");
    if (Buffer.from(bytes).toString("base64").replace(/=+$/, "") !== m[2].replace(/=+$/, "")) throw new M365CopilotTurnError("Microsoft 365 Copilot image contains invalid base64", 400);
  } else {
    if (url.length > 8192) throw new M365CopilotTurnError("Microsoft 365 Copilot image URL exceeds its limit", 400);
    // Shared public-only pinned download sends no Microsoft credential and follows no redirects.
    const response = await fetchPublicHttpsImage(url, { signal, maxBytes: MAX_IMAGE_BYTES });
    const read = await readBoundedResponseBytes(response, { maxBytes: MAX_IMAGE_BYTES, signal });
    if (read.oversized) throw new M365CopilotTurnError("Microsoft 365 Copilot image exceeds the 5 MiB limit", 413);
    bytes = read.bytes;
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new M365CopilotTurnError("Microsoft 365 Copilot image exceeds the 5 MiB limit", 413);
  const fileType = sniffImageExtension(bytes);
  if (!fileType) throw new M365CopilotTurnError("Microsoft 365 Copilot received invalid image bytes", 400);
  const mime = fileType === "jpg" ? "jpeg" : fileType;
  return { dataUrl: "data:image/" + mime + ";base64," + Buffer.from(bytes).toString("base64"), fileType, bytes: bytes.byteLength };
}

export async function uploadM365Images(urls: string[], token: string, model: string, conversationId: string, provider: OcxProviderConfig, signal?: AbortSignal, budget?: TranslatorBudget, beforeUpload?: () => void): Promise<M365ImageAnnotation[]> {
  if (provider.baseUrl.replace(/\/+$/, "") !== M365_COPILOT_BASE_URL) throw new M365CopilotTurnError("Microsoft 365 Copilot image uploads require the fixed Microsoft endpoint", 400);
  if (urls.length > MAX_IMAGES) throw new M365CopilotTurnError("Microsoft 365 Copilot supports at most four new images per turn", 413);
  const annotations: M365ImageAnnotation[] = [];
  let total = 0;
  for (const url of urls) {
    const uploadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    uploadSignal.throwIfAborted();
    beforeUpload?.();
    try {
      const image = await imageData(url, uploadSignal);
      if ((total += image.bytes) > MAX_IMAGE_BATCH_BYTES) throw new M365CopilotTurnError("Microsoft 365 Copilot image batch exceeds the 20 MiB limit", 413);
      const release = budget?.observeExternallyCapped("provider_image_upload", 4 * image.dataUrl.length);
      try {
        const form = new URLSearchParams({ scenario: "UploadImage", conversationId, FileBase64: image.dataUrl });
        for (const value of ["cwcgptvsan", "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch"]) form.append("optionsSets", value);
        const response = await providerOutboundPost("m365-copilot", provider, M365_COPILOT_BASE_URL + "/UploadFile", {
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/x-www-form-urlencoded", "X-Scenario": m365CopilotScenario(model).scenario,
            "X-Variants": "feature.EnableImageSupportInUploadFile", Origin: "https://m365.cloud.microsoft" },
          body: form.toString(), signal: uploadSignal,
        }, { beforeSend: () => { beforeUpload?.(); return true; } });
        if (!response.ok) { await response.body?.cancel(); throw new M365CopilotTurnError("Microsoft 365 Copilot image upload failed", response.status === 429 ? 429 : 502); }
        const read = await readBoundedResponseBytes(response, { maxBytes: 64 * 1024, signal: uploadSignal });
        if (read.oversized) throw new M365CopilotTurnError("Microsoft 365 Copilot image upload response exceeds its limit", 502);
        const result = JSON.parse(new TextDecoder().decode(read.bytes));
        if (typeof result?.docId !== "string" || !result.docId || result.docId.length > 2048 || /[\x00-\x20\x7f]/.test(result.docId)) throw new M365CopilotTurnError("Microsoft 365 Copilot returned an invalid image reference", 502);
        annotations.push({ id: result.docId, messageAnnotationType: "ImageFile", messageAnnotationMetadata: {
          "@type": "File", annotationType: "File", fileType: image.fileType, fileName: "image-" + (annotations.length + 1) + "." + image.fileType,
        } });
      } finally { release?.(); }
    } catch (error) {
      if (error instanceof M365CopilotTurnError || uploadSignal.aborted) throw error;
      throw new M365CopilotTurnError("Microsoft 365 Copilot could not read or upload the image", 502);
    }
  }
  return annotations;
}
