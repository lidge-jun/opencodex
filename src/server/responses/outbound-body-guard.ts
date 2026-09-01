/**
 * Measure a built passthrough body before it is sent, so an operator can turn an opaque
 * upstream failure into a local, actionable refusal.
 *
 * There is deliberately no default limit. The one measured ceiling in this codebase belongs
 * to the WebSocket transport (`MAX_CODEX_WS_CREATE_FRAME_BYTES` in `ws-upstream.ts`), and the
 * comment recording that measurement says the same body still succeeds over HTTP SSE — #2426
 * observed an 18.2 MB HTTP 200. An implicit HTTP ceiling inferred from the WS number would
 * refuse requests that work today, on every passthrough destination including Azure and
 * custom Responses gateways whose limits were never measured at all. The operator who hit a
 * wall knows where their wall is; this guard is off until they say so.
 */

export interface OutboundBodyGuardResult {
  admitted: boolean;
  /** Serialized UTF-8 bytes. Zero when the guard is disabled before measurement. */
  bytes: number;
  /** The configured limit, or 0 when the guard is disabled. */
  limit: number;
  imageCount: number;
  /** Approximate decoded bytes represented by embedded `input_image` data URIs. */
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

/**
 * Walk the parsed body for `input_image` items. Bounded by depth and a seen-set because this
 * runs on a body that already failed the size check, which is exactly when a pathological
 * shape is most likely.
 */
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

/**
 * `limitBytes` undefined (unconfigured) or 0 (explicitly disabled) both admit without
 * measuring, so an unconfigured proxy does no work and sends exactly what it sends today.
 */
export function checkOutboundBodySize(
  body: string,
  limitBytes: number | undefined,
): OutboundBodyGuardResult {
  if (limitBytes === undefined || limitBytes === 0) {
    return { admitted: true, bytes: 0, limit: 0, imageCount: 0, imageBytes: 0 };
  }

  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes <= limitBytes) {
    return { admitted: true, bytes, limit: limitBytes, imageCount: 0, imageBytes: 0 };
  }

  try {
    const diagnostics = imageDiagnostics(JSON.parse(body) as unknown);
    return { admitted: false, bytes, limit: limitBytes, ...diagnostics };
  } catch {
    return { admitted: false, bytes, limit: limitBytes, imageCount: 0, imageBytes: 0 };
  }
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Name the likely cause rather than only the number. Accumulated replayed images are the
 * common way a thread crosses a byte ceiling while its token count still looks healthy, and
 * the remedy is not something the user can guess from a size alone.
 */
export function describeOutboundBodyRefusal(result: OutboundBodyGuardResult): string {
  const imageDetail = result.imageCount > 0
    ? ` It contains ${result.imageCount} input_image item${result.imageCount === 1 ? "" : "s"} `
      + `representing about ${megabytes(result.imageBytes)} MB of decoded embedded image data; `
      + "accumulated replayed images are the likely cause."
    : " Large inputs accumulated across replayed turns can cause this.";
  return `The serialized outbound request is ${megabytes(result.bytes)} MB, `
    + `above the configured ${megabytes(result.limit)} MB limit.${imageDetail} `
    + "Start a new session or compact the conversation before retrying.";
}
