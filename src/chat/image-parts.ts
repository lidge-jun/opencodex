/**
 * Inbound Chat Completions image parts, recognized once for every consumer.
 *
 * Two call sites used to answer "does this body carry an image?" independently and
 * gave different answers: the translated path understood Pi/MCP and Anthropic-shaped
 * parts, while the native fast path's route-eligibility predicate matched only
 * `image_url`. A text-only routed model therefore kept an image-bearing body and
 * forwarded a non-OpenAI part verbatim to an OpenAI-compatible upstream.
 *
 * Normalization runs before route selection so the diversion decision and the
 * forwarded wire see the same parts. This module deliberately imports nothing: it is
 * shared by `src/chat/` and `src/server/` and must not create an edge between them.
 */

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The image reference a Chat content part carries, as a URL or data URI.
 *
 * Accepts OpenAI `image_url` (string or `{url}`), Pi/MCP-style
 * `{type:"image", data, mimeType}` (Aside read_file tool results), and
 * Anthropic-shaped `{type:"image", source:{...}}` in both base64 and url form.
 * Returns null for anything else — including a part with no usable reference, which
 * must be left alone rather than turned into a claim of an attachment.
 */
export function chatImageUrlFromPart(part: Rec): string | null {
  if (part.type === "image_url") {
    const imageUrl = part.image_url;
    if (typeof imageUrl === "string" && imageUrl.length > 0) return imageUrl;
    if (isRec(imageUrl) && typeof imageUrl.url === "string" && imageUrl.url.length > 0) return imageUrl.url;
    return null;
  }
  if (part.type === "image") {
    const data = part.data;
    if (typeof data === "string" && data.length > 0) {
      if (data.startsWith("data:")) return data;
      const media = typeof part.mimeType === "string" && part.mimeType.length > 0 ? part.mimeType
        : typeof part.mediaType === "string" && part.mediaType.length > 0 ? part.mediaType
        : "image/png";
      return "data:" + media + ";base64," + data;
    }
    const source = part.source;
    if (isRec(source)) {
      if (source.type === "base64" && typeof source.data === "string" && source.data.length > 0) {
        const media = typeof source.media_type === "string" && source.media_type.length > 0 ? source.media_type : "image/png";
        return "data:" + media + ";base64," + source.data;
      }
      if (source.type === "url" && typeof source.url === "string" && source.url.length > 0) return source.url;
    }
  }
  return null;
}

/** The fidelity hint a recognized part carries, when it is one the wire accepts. */
export function chatImageDetailFromPart(part: Rec): "auto" | "low" | "high" | undefined {
  const raw = isRec(part.image_url) ? part.image_url.detail : part.detail;
  return raw === "auto" || raw === "low" || raw === "high" ? raw : undefined;
}

/**
 * True when any `messages[].content[]` part carries a recognized image, in any of
 * the accepted shapes. This is the predicate native-route eligibility depends on, so
 * widening `chatImageUrlFromPart` widens the text-only diversion with it.
 */
export function chatBodyCarriesImage(rawBody: Rec): boolean {
  const messages = rawBody.messages;
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isRec(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isRec(part) && chatImageUrlFromPart(part) !== null) return true;
    }
  }
  return false;
}

/**
 * Rewrite every recognized non-OpenAI image part into `image_url` form.
 *
 * Returns the SAME object reference when nothing needed rewriting, so a body with no
 * image — and a body whose images are already `image_url` — is passed through
 * untouched. The native path is a whitelist passthrough, so an incidental deep clone
 * would itself be a behavior change: only the `messages` array, the messages holding
 * a rewritten part, and their `content` arrays are rebuilt. Every sibling part,
 * every other message field and every top-level body field keep their exact value.
 *
 * Each rewritten Pi/Anthropic base64 part costs one copy of its payload string. On
 * the translated path that copy already happened inside the old recognizer; on the
 * native path it is new peak memory, bounded by the inbound body limit that
 * `readChatBody` already enforces.
 */
export function normalizeChatImageParts(rawBody: Rec): Rec {
  const messages = rawBody.messages;
  if (!Array.isArray(messages)) return rawBody;
  let bodyChanged = false;
  const nextMessages = messages.map(message => {
    if (!isRec(message) || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const nextContent = message.content.map(part => {
      // Already-OpenAI parts are left byte-identical; only foreign shapes are rewritten.
      if (!isRec(part) || part.type === "image_url") return part;
      const url = chatImageUrlFromPart(part);
      if (url === null) return part;
      messageChanged = true;
      const detail = chatImageDetailFromPart(part);
      return { type: "image_url", image_url: { url, ...(detail ? { detail } : {}) } };
    });
    if (!messageChanged) return message;
    bodyChanged = true;
    return { ...message, content: nextContent };
  });
  if (!bodyChanged) return rawBody;
  return { ...rawBody, messages: nextMessages };
}
