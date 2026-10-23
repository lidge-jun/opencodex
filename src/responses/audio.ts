import type { OcxAudioContent } from "../types";

export type ChatAudioFormat = OcxAudioContent["format"];

const MIME_FORMATS: Readonly<Record<string, ChatAudioFormat>> = {
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
};

function normalizedFormat(value: unknown): ChatAudioFormat | undefined {
  if (typeof value !== "string") return undefined;
  const format = value.trim().toLowerCase();
  return format === "mp3" || format === "wav" ? format : undefined;
}

function validBase64(value: string): boolean {
  return value.length > 0
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * Parse the inline audio shape Codex puts in a Responses content block. Chat Completions
 * needs bare base64 plus `wav`/`mp3`, while Codex supplies an RFC 2397 data URL. A raw
 * base64 value with an explicit supported format is accepted as well; remote URLs are not.
 */
export function audioContentFromRaw(audioUrl: unknown, declaredFormat?: unknown): OcxAudioContent | undefined {
  if (typeof audioUrl !== "string" || audioUrl.length === 0) return undefined;
  const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/.exec(audioUrl);
  let data: string;
  let format: ChatAudioFormat | undefined;
  if (dataUrl) {
    const declared = normalizedFormat(declaredFormat);
    const mime = dataUrl[1].trim().toLowerCase();
    format = MIME_FORMATS[mime] ?? (mime === "application/octet-stream" ? declared : undefined);
    data = dataUrl[2].replace(/\s+/g, "");
  } else {
    format = normalizedFormat(declaredFormat);
    data = audioUrl.replace(/\s+/g, "");
  }
  if (!format || !validBase64(data)) return undefined;
  return { type: "audio", data, format, text: `[audio: ${format}]` };
}
