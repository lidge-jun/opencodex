/**
 * Per-body zstd for Remote Link requests from a Child to its Home (#3023).
 *
 * A Home that decodes zstd request bodies on the link's data routes advertises
 * `LINK_REQUEST_ZSTD_FEATURE` in its peer features (`GET /readyz`) and, on every relay-auth answer,
 * in `LINK_HOME_FEATURES_HEADER`. A Child compresses a body only for a Home whose last verified
 * answer named the feature, and confirms it again on the connection that carries the body; an older
 * Home never names it and gets identity bodies exactly as before. Each body is compressed on its
 * own: no dictionary, no context shared across requests or links, and the link key travels in a
 * header, outside the compressed bytes. The SSH tunnel itself is never compressed.
 */
import { parseFeatureList } from "./peer-report";

export const LINK_REQUEST_ZSTD_VERSION = "1";
export const LINK_REQUEST_ZSTD_FEATURE = `link-request-zstd/${LINK_REQUEST_ZSTD_VERSION}`;
/** The Home's served peer features, on its relay-auth answer. Not covered by the proof, and needs not be: see above. */
export const LINK_HOME_FEATURES_HEADER = "x-opencodex-link-home-features";
/** Bodies at or below this size are sent as they are. */
export const LINK_REQUEST_COMPRESSION_MIN_BYTES = 1024;
/** The most a Child buffers to compress one body; a larger declared body streams unchanged. */
export const LINK_REQUEST_COMPRESSION_MAX_BYTES = 16 * 1024 * 1024;
/** Routes whose Home handler decodes Content-Encoding through the shared JSON body reader. */
export const LINK_REQUEST_COMPRESSIBLE_PATHS: ReadonlySet<string> = new Set([
  "/v1/responses", "/v1/responses/compact", "/v1/messages", "/v1/chat/completions",
]);

/** Read the header the way a peer report is read; anything malformed is no list. */
export function parseLinkHomeFeatures(value: string | null): string[] | null {
  return parseFeatureList(value);
}
