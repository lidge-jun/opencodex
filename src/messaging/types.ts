/** Typed failure whose message is safe for CLI receipts, never raw daemon or helper output. */
export class LocalMessagingError extends Error {
  /** Attach a stable failure code to caller-authored, sanitized explanatory text. */
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalMessagingError";
  }
}

/** Narrow an untrusted RPC value to a non-null, non-array object before field validation. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept UUID-shaped thread/correlation IDs, not names or command fragments. */
export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

export interface LocalThread {
  id: string;
  name: string | null;
  status: "idle" | "active" | "systemError" | "notLoaded";
}

export interface LocalMetadataClient {
  loadedPage(cursor?: string): Promise<{ data: string[]; nextCursor: string | null }>;
  readThread(id: string): Promise<LocalThread>;
}
