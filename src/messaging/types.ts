export class LocalMessagingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalMessagingError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
