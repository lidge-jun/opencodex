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
 * Copy-on-write, and genuinely lazy: replacement arrays are allocated only after a
 * part actually needs rewriting. An ordinary text or native-Chat request walks the
 * messages and allocates nothing, and the original object reference is returned.
 * An earlier revision mapped every message and content array eagerly and only then
 * compared — identity was preserved, but the transient arrays were not, so the
 * "only rewritten paths are rebuilt" claim was false for the common path.
 *
 * Every sibling part, every other message field and every top-level body field keep
 * their exact value: the native path is a whitelist passthrough, so an incidental
 * deep clone would itself be a behavior change.
 *
 * Each rewritten Pi/Anthropic base64 part costs one copy of its payload string,
 * bounded by the inbound body limit `readChatBody` already enforces.
 */
export function normalizeChatImageParts(rawBody: Rec): Rec {
  const messages = rawBody.messages;
  if (!Array.isArray(messages)) return rawBody;
  let nextMessages: unknown[] | undefined;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (!isRec(message) || !Array.isArray(message.content)) continue;
    const content = message.content;
    let nextContent: unknown[] | undefined;
    for (let partIndex = 0; partIndex < content.length; partIndex++) {
      const part = content[partIndex];
      // Already-OpenAI parts are left byte-identical; only foreign shapes are rewritten.
      if (!isRec(part) || part.type === "image_url") continue;
      const url = chatImageUrlFromPart(part);
      if (url === null) continue;
      const detail = chatImageDetailFromPart(part);
      nextContent ??= content.slice();
      nextContent[partIndex] = { type: "image_url", image_url: { url, ...(detail ? { detail } : {}) } };
    }
    if (!nextContent) continue;
    nextMessages ??= messages.slice();
    nextMessages[messageIndex] = { ...message, content: nextContent };
  }
  return nextMessages ? { ...rawBody, messages: nextMessages } : rawBody;
}

/**
 * True when a `role: "tool"` message carries a recognized image, in any accepted shape.
 *
 * Shape normalization alone does NOT make such a request safe on the native fast path.
 * A standard Chat tool message accepts a string or text parts only — not `image_url` —
 * so rewriting a Pi/Anthropic tool image into `image_url` still leaves an image part
 * inside a tool message, which a standard-enforcing endpoint rejects.
 *
 * The translated openai-chat adapter already solves placement: it collects tool-result
 * images and flushes them into a following `user` carrier after the complete paired
 * tool-result batch. Diverting these requests there is narrower than reimplementing
 * that carrier on the native path, and it leaves ordinary user images and text-only
 * tool results on the native fast path untouched.
 */
export function chatBodyCarriesToolResultImage(rawBody: Rec): boolean {
  const messages = rawBody.messages;
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    // The legacy `function` role carries a tool result under the same schema constraint,
    // so it needs the same diversion.
    if (!isRec(message) || (message.role !== "tool" && message.role !== "function")) continue;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isRec(part) && chatImageUrlFromPart(part) !== null) return true;
    }
  }
  return false;
}
