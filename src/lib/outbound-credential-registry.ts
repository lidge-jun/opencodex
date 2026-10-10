/**
 * Process-local record of header values this process has handed to an upstream.
 *
 * Upstream diagnostics (error codes, request ids) are provider-controlled. A gateway can echo a
 * credential it received back into those fields, and a configured credential with no recognizable
 * format slips past pattern redaction. An upstream can only echo what it was sent, so recording the
 * final sent headers lets the request log refuse any diagnostic that equals or contains one.
 *
 * Every header is recorded except a short denylist of names that never carry credentials, so
 * operator-configured and plugin-added headers are covered without knowing their names. Values are
 * held in memory only: nothing here is serialized, persisted or exposed. When the bounds force a
 * value out (or a value is too large to keep), coverage is no longer complete, and callers must
 * fail closed for the rest of the process.
 */

const NON_CREDENTIAL_HEADER = /^(?:content-.*|accept.*|user-agent|host|connection|origin|referer|traceparent|tracestate|x-stainless-.*|openai-beta|anthropic-version|anthropic-beta|originator|version|.*request-id)$/;
/** Substring matching only for credentials long enough that a diagnostic cannot contain one by chance. */
const SUBSTRING_MIN_LENGTH = 12;
const BASIC_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PRINTABLE_USER_PASS = /^[\x20-\x7e]*:[\x20-\x7e]*$/;

export interface OutboundCredentialRegistryOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxValueBytes?: number;
}

export class OutboundCredentialRegistry {
  private readonly values = new Map<string, number>();
  private totalBytes = 0;
  private coverageComplete = true;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxValueBytes: number;

  constructor(options: OutboundCredentialRegistryOptions = {}) {
    this.maxEntries = options.maxEntries ?? 4096;
    this.maxBytes = options.maxBytes ?? 1 << 20;
    this.maxValueBytes = options.maxValueBytes ?? 16_384;
  }

  /** Record every credential-capable value in headers that are about to be sent. */
  remember(headers: HeadersInit | Headers | undefined): void {
    if (!headers) return;
    new Headers(headers).forEach((value, name) => {
      const lower = name.toLowerCase();
      if (NON_CREDENTIAL_HEADER.test(lower)) return;
      if (lower === "authorization" || lower === "proxy-authorization") {
        this.add(value);
        const space = value.indexOf(" ");
        const token = space > 0 ? value.slice(space + 1).trim() : "";
        if (token) this.add(token);
        if (space > 0 && value.slice(0, space).toLowerCase() === "basic" && BASIC_BASE64.test(token)) {
          const decoded = Buffer.from(token, "base64").toString("utf8");
          if (PRINTABLE_USER_PASS.test(decoded) && Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") === token.replace(/=+$/, "")) {
            const colon = decoded.indexOf(":");
            this.add(decoded.slice(0, colon));
            this.add(decoded.slice(colon + 1));
          }
        }
        return;
      }
      if (lower === "cookie") {
        for (const part of value.split(";")) {
          const eq = part.indexOf("=");
          this.add((eq >= 0 ? part.slice(eq + 1) : part).trim());
        }
        return;
      }
      this.add(value);
    });
  }

  /** True when value equals a recorded credential, or contains one long enough to match safely. */
  matches(value: string): boolean {
    if (this.values.has(value)) return true;
    for (const secret of this.values.keys()) {
      if (secret.length >= SUBSTRING_MIN_LENGTH && value.includes(secret)) return true;
    }
    return false;
  }

  /** False once any value was dropped; callers must then treat diagnostics as unverifiable. */
  complete(): boolean {
    return this.coverageComplete;
  }

  private add(value: string): void {
    if (!value) return;
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > this.maxValueBytes) {
      this.coverageComplete = false;
      return;
    }
    if (this.values.has(value)) {
      this.values.delete(value);
      this.values.set(value, bytes);
      return;
    }
    this.values.set(value, bytes);
    this.totalBytes += bytes;
    while (this.values.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.values.keys().next().value as string;
      this.totalBytes -= this.values.get(oldest)!;
      this.values.delete(oldest);
      this.coverageComplete = false;
    }
  }
}

let active = new OutboundCredentialRegistry();

/** The registry fed by the HTTP executor boundary and the Codex WebSocket dial. */
export function outboundCredentials(): OutboundCredentialRegistry {
  return active;
}

/** Swap the active registry for sequential in-file tests; returns the restore function. */
export function setOutboundCredentialRegistryForTests(registry: OutboundCredentialRegistry): () => void {
  const previous = active;
  active = registry;
  return () => { active = previous; };
}

