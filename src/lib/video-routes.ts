/**
 * Path matching for the public OpenAI Videos routes (#9110), kept free of handler imports so the
 * listener allowlists (loopback, Remote Link) can share it.
 */
export type VideoRoute =
  | { kind: "create" }
  | { kind: "retrieve"; handle: string }
  | { kind: "content"; handle: string };

/** The video route a request names, or undefined (other methods and subpaths reach the JSON 404). */
export function matchVideoRoute(method: string, pathname: string): VideoRoute | undefined {
  if (pathname === "/v1/videos") return method === "POST" ? { kind: "create" } : undefined;
  const match = /^\/v1\/videos\/([^/]+)(\/content)?$/.exec(pathname);
  if (!match || method !== "GET") return undefined;
  let handle: string;
  try { handle = decodeURIComponent(match[1]!); } catch { return undefined; }
  return match[2] ? { kind: "content", handle } : { kind: "retrieve", handle };
}
