import { spyOn } from "bun:test";
import * as proxyEnvModule from "../../src/lib/proxy-env";
import { recoverySse } from "./agent-task-recovery";

const originalFetch = globalThis.fetch;
let configuredFetchSpy: ReturnType<typeof spyOn> | undefined;

type Harness = {
  sends: string[];
  refreshes: string[];
  recoveryAuths: string[];
  backupAuths: string[];
  backupBodies: string[];
  canonicalAliasSends: number;
};

/**
 * Upstream rejects the old bearer once, the token endpoint rotates, and the replay with the
 * new bearer succeeds — the reporter's deterministic harness.
 */
export function installHarness(options: {
  refresh?: () => Response;
  responseForSend?: (authorization: string, sendNumber: number, url: URL) => Response | undefined;
  recovery?: (authorization: string, init?: RequestInit) => Response | Promise<Response>;
} = {}): Harness {
  const sends: string[] = [];
  const refreshes: string[] = [];
  const recoveryAuths: string[] = [];
  const backupAuths: string[] = [];
  const backupBodies: string[] = [];
  let canonicalAliasSends = 0;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (url.hostname === "auth.openai.com") {
      refreshes.push((JSON.parse(String(init?.body)) as { refresh_token?: string }).refresh_token ?? "");
      if (options.refresh) return options.refresh();
      return Response.json({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    }
    if (body.includes("capture_assignment")) {
      recoveryAuths.push(authorization);
      if (options.recovery) return await options.recovery(authorization, init);
      return new Response(recoverySse("RECOVERED-POOL-PLAINTEXT-SENTINEL"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (!url.pathname.endsWith("/responses") && !url.pathname.endsWith("/responses/compact")) {
      return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    }
    if (url.hostname === "backup.example" || url.hostname === "spare.example") {
      backupAuths.push(authorization);
      backupBodies.push(body);
    }
    if (
      url.hostname === "chatgpt.com"
      && authorization !== "Bearer rejected-access"
      && authorization !== "Bearer refreshed-access"
      && authorization !== "Bearer other-access"
    ) {
      canonicalAliasSends += 1;
    }
    sends.push(authorization);
    const customResponse = options.responseForSend?.(authorization, sends.length, url);
    if (customResponse) return customResponse;
    if (authorization === "Bearer rejected-access") {
      return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
    }
    return Response.json({ id: "resp_replayed", object: "response", status: "completed", output: [] });
  }) as typeof fetch;
  globalThis.fetch = mockFetch;
  // SOCKS routing can select its own transport before global fetch is reached. Intercept
  // that boundary too so this memory fixture never opens a socket under inherited proxies.
  configuredFetchSpy?.mockRestore();
  configuredFetchSpy = spyOn(proxyEnvModule, "configuredOutboundFetch").mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) => mockFetch(input, init),
  );
  return { sends, refreshes, recoveryAuths, backupAuths, backupBodies, get canonicalAliasSends() { return canonicalAliasSends; } };
}

export function restorePool401Fetch(): void {
  configuredFetchSpy?.mockRestore();
  configuredFetchSpy = undefined;
  globalThis.fetch = originalFetch;
}
