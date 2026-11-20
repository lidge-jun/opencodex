import { readDisplaySafeErrorPayloadText } from "../adapters/upstream-http-error";

const QUALITY = new Set(["low", "medium", "high", "auto"]);
const FIELD = new Set(["image", "last_frame", "keyframes", "reference_images", "reference_audios", "quality", "aspect_ratio", "resolution", "duration"]);
const RESOLUTION = new Set(["480p", "720p", "1080p"]);
const VIDEO_CODES = new Set(["invalid_argument", "permission_denied", "failed_precondition", "service_unavailable", "internal_error"]);

/** Rebuild only known validation sentences; never expose arbitrary upstream text. */
export function safeXaiErrorDetail(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const text = message.trim();
  let m = /^This model only supports the following quality value\(s\): ([a-z]+(?:, [a-z]+)*)\.$/.exec(text);
  if (m && m[1]!.split(", ").every(token => QUALITY.has(token))) return `This model only supports the following quality value(s): ${m[1]!.split(", ").join(", ")}.`;
  m = /^`([a-z_]+)` is not supported for this model\.$/.exec(text);
  if (m && FIELD.has(m[1]!)) return `\`${m[1]}\` is not supported for this model.`;
  m = /^(\d{3,4}p) video resolution is not available for this model\.$/.exec(text);
  if (m && RESOLUTION.has(m[1]!)) return `${m[1]} video resolution is not available for this model.`;
  m = /^Too many keyframes: (\d{1,2})\. Maximum allowed is (\d{1,2})\.$/.exec(text);
  if (m) return `Too many keyframes: ${m[1]}. Maximum allowed is ${m[2]}.`;
  m = /^`keyframes` timestamp (\d{1,3}(?:\.\d{1,3})?)s must be strictly inside the clip \(0 < t < (\d{1,3}(?:\.\d{1,3})?)s\)\.$/.exec(text);
  if (m) return `\`keyframes\` timestamp ${m[1]}s must be strictly inside the clip (0 < t < ${m[2]}s).`;
  return undefined;
}

export async function readSafeXaiErrorDetail(resp: Response, signal?: AbortSignal): Promise<string | undefined> {
  const text = await readDisplaySafeErrorPayloadText(resp, signal);
  try {
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const obj = payload as Record<string, unknown>;
    const nested = obj.error && typeof obj.error === "object" && !Array.isArray(obj.error) ? (obj.error as Record<string, unknown>).message : undefined;
    return safeXaiErrorDetail(obj.error) ?? safeXaiErrorDetail(nested) ?? safeXaiErrorDetail(obj.message);
  } catch { return undefined; }
}

export function safeVideoFailureCode(code: unknown): string | undefined {
  return typeof code === "string" && VIDEO_CODES.has(code) ? code : undefined;
}
