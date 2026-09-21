import type { OcxDocumentContent } from "../types";

const DATA_URL = /^data:([^;,]+)((?:;[^;,]*)*),(.*)$/s;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;

/** The one marker vocabulary for an attached document, derived from what the part knows. */
export function inlineDocumentMarker(filename: string | undefined): string {
  return filename !== undefined && filename.length > 0 ? `[document: ${filename}]` : "[document]";
}

/**
 * An inline document part from a `data:` URL, or `undefined` when there are no usable bytes.
 *
 * A reference with no payload — a `file_id`, a bare filename — is deliberately not a document:
 * there is nothing to carry, and minting a part for it would claim an attachment the request
 * never contained. Those keep the marker path they already had.
 */
export function inlineDocumentFromDataUrl(
  fileData: string | undefined,
  filename: string | undefined,
): OcxDocumentContent | undefined {
  if (typeof fileData !== "string" || fileData.length === 0) return undefined;
  const match = DATA_URL.exec(fileData);
  if (!match) return undefined;
  const mediaType = match[1]!;
  const payload = match[3]!;
  if (!hasBase64Parameter(match[2] ?? "") || !BASE64_PAYLOAD.test(payload)) return undefined;
  return {
    type: "document",
    text: inlineDocumentMarker(filename),
    mediaType,
    data: payload,
    ...(filename !== undefined && filename.length > 0 ? { filename } : {}),
  };
}

/** The `data:` URL spelling of a document part, for wires whose counterpart takes one. */
export function inlineDocumentDataUrl(part: OcxDocumentContent): string {
  return `data:${part.mediaType};base64,${part.data}`;
}

/**
 * Whether this string is a `data:` URL this module would actually decode.
 *
 * The media-type scanner and this parser have to agree exactly. A looser scanner would exempt an
 * attachment from the untranslated-media refusal that the parser then reduces to a marker, which
 * is the silent drop the refusal exists to prevent. `;base64` must be a whole parameter token,
 * not a substring of one: `;notbase64,` and `;x=base64,` are not base64 payloads.
 */
export function isInlineDocumentDataUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const match = DATA_URL.exec(value);
  return match !== null && hasBase64Parameter(match[2] ?? "") && BASE64_PAYLOAD.test(match[3]!);
}

function hasBase64Parameter(parameters: string): boolean {
  return parameters.split(";").includes("base64");
}
