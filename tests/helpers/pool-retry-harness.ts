import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const originalGlobalFetch = globalThis.fetch;

// A per-run directory, not a fixed path, for the same reason server-auth.test.ts gives:
// `bun test --isolate` gives each file its own module registry but all files share one
// filesystem, so a literal here would collide with whichever file imported this harness.
export const POOL_RETRY_TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-pool-retry-"));

export const canonicalDirect = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "direct",
} as const;

export function redirectCanonicalCodexTo(baseUrl: string): void {
  const prefix = "/backend-api/codex";
  const currentWebSocket = globalThis.WebSocket;
  // These fixtures serve HTTP/SSE only. Refuse the native upstream upgrade
  // deterministically so its existing SSE fallback stays on the mocked fetch;
  // downstream loopback WebSockets and other destinations remain real.
  globalThis.WebSocket = new Proxy(currentWebSocket, {
    construct(target, args, newTarget) {
      const url = new URL(String(args[0]));
      if (url.protocol === "wss:" && url.hostname === "chatgpt.com"
        && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
        throw new Error("HTTP-only Codex fixture rejects native upstream WebSocket");
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
      const target = new URL(`${url.pathname.slice(prefix.length)}${url.search}`, baseUrl);
      return originalGlobalFetch(target, init);
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;
}
