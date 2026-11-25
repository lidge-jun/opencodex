/** Fixed vocabulary only: the refusal never names the URL. */
export const GEMINI_UNFETCHABLE_VIDEO_MESSAGE = "OpenCodex cannot send this remote video to Gemini: Gemini fetches only YouTube and Files API URLs. "
  + "Send the video inline as a data URL or upload it to the Gemini Files API first.";

/**
 * A video URI Gemini fetches on its own behalf, as a `file_data` reference.
 *
 * Deliberately an allowlist of the forms Google documents, not "anything that is
 * not a data: URL". `file_data` tells Gemini to go and get the bytes; pointing it
 * at an arbitrary host would either fail upstream or make the proxy the reason a
 * caller's private URL got dereferenced by Google. Anything not matched here
 * is refused before send (GEMINI_UNFETCHABLE_VIDEO_MESSAGE).
 *
 * Returns the uri alone: the documented REST example for a YouTube part carries
 * `file_data.file_uri` and nothing else, and the Files API knows the type of what
 * it stored. An invented `mime_type` would be a guess on both paths.
 *
 * https://ai.google.dev/gemini-api/docs/generate-content/video-understanding
 */
export function geminiFetchableVideoUri(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase();
  const youtubeHosts = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtube-nocookie.com",
    "youtube-nocookie.com",
  ]);
  if (youtubeHosts.has(host)) return url;

  // The Files API resource form, https://generativelanguage.googleapis.com/v1beta/files/<id>.
  // Anchored at the start so the resumable-upload endpoint (/upload/v1beta/files/<id>) does
  // not match: that URL is not a readable resource, and passing it as `file_data.file_uri`
  // would have Gemini dereference something it cannot read. The version segment stays loose
  // because this service is reachable as v1, v1beta and v1alpha.
  if (host === "generativelanguage.googleapis.com" && /^\/v1[a-z0-9]*\/files\/[^/]+$/.test(parsed.pathname)) {
    return url;
  }

  return null;
}
