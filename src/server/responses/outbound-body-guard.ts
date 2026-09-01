/**
 * The measured upstream failure starts around 16.7 MB, but that ceiling is unpublished and may
 * vary by deployment. Keep the default at 15 MiB to leave room for transport overhead instead of
 * rounding the observed failure point up into the unsafe range.
 */
export const DEFAULT_MAX_UPSTREAM_BODY_BYTES = 15 * 1024 * 1024;

export interface OutboundBodyGuardResult {
  admitted: boolean;
  /** Serialized UTF-8 bytes. Zero when the guard is disabled before measurement. */
  bytes: number;
  limit: number;
  imageCount: number;
  /** Approximate decoded bytes represented by embedded input_image data URIs. */
  imageBytes: number;
}

const MAX_DIAGNOSTIC_DEPTH = 64;

function decodedDataUriBytes(value: unknown): number {
  if (typeof value !== "string" || !value.startsWith("data:")) return 0;
  const comma = value.indexOf(",");
  if (comma < 0) return 0;
  const payload = value.length - comma - 1;
  return payload > 0 ? Math.floor((payload * 3) / 4) : 0;
}

function imageDiagnostics(value: unknown): { imageCount: number; imageBytes: number } {
  let imageCount = 0;
  let imageBytes = 0;
  const seen = new WeakSet<object>();

  const visit = (entry: unknown, depth: number): void => {
    if (depth > MAX_DIAGNOSTIC_DEPTH || entry === null || typeof entry !== "object") return;
    if (seen.has(entry)) return;
    seen.add(entry);

    if (!Array.isArray(entry) && (entry as Record<string, unknown>).type === "input_image") {
      imageCount += 1;
      imageBytes += decodedDataUriBytes((entry as Record<string, unknown>).image_url);
      return;
    }

    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    for (const item of Object.values(entry)) visit(item, depth + 1);
  };

  visit(value, 0);
  return { imageCount, imageBytes };
}

export function checkOutboundBodySize(
  body: string,
  limitBytes: number | undefined,
): OutboundBodyGuardResult {
  const limit = limitBytes ?? DEFAULT_MAX_UPSTREAM_BODY_BYTES;
  if (limit === 0) {
    return { admitted: true, bytes: 0, limit, imageCount: 0, imageBytes: 0 };
  }

  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes <= limit) {
    return { admitted: true, bytes, limit, imageCount: 0, imageBytes: 0 };
  }

  try {
    const diagnostics = imageDiagnostics(JSON.parse(body) as unknown);
    return { admitted: false, bytes, limit, ...diagnostics };
  } catch {
    return { admitted: false, bytes, limit, imageCount: 0, imageBytes: 0 };
  }
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function describeOutboundBodyRefusal(result: OutboundBodyGuardResult): string {
  const imageDetail = result.imageCount > 0
    ? ` It contains ${result.imageCount} input_image item${result.imageCount === 1 ? "" : "s"} `
      + `representing about ${megabytes(result.imageBytes)} MB of decoded embedded image data; `
      + "accumulated replayed images are the likely cause."
    : " Large inputs accumulated across replayed turns can cause this."
  return `The serialized outbound request is ${megabytes(result.bytes)} MB, `
    + `above the configured ${megabytes(result.limit)} MB limit.${imageDetail} `
    + "Start a new session or compact the conversation before retrying."
}
