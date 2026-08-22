import { SAFE_UPSTREAM_RESPONSE_HEADERS } from "./relay-constants";

export function collectForwardableResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (SAFE_UPSTREAM_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

export function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("text/event-stream");
}

export function mergeForwardableRequestHeaders(
  source: Headers,
  target: Headers,
  allowed: ReadonlySet<string>,
): void {
  source.forEach((value, key) => {
    if (allowed.has(key.toLowerCase())) {
      target.set(key, value);
    }
  });
}
