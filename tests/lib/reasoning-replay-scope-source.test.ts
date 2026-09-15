import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

const source = (relative: string): string =>
  readFileSync(repoPath("src", ...relative.split("/")), "utf8");

describe("reasoning replay scope propagation", () => {
  test("every production bridge call passes the provider-bound scope holder", () => {
    const core = source("server/responses/core.ts");
    const images = source("images/loop.ts");
    const webSearch = source("web-search/loop.ts");
    expect(core.match(/replayCacheScope: parsed\._reasoningReplayScope,/g)).toHaveLength(4);
    expect(images.match(/replayCacheScope: parsed\._reasoningReplayScope,/g)).toHaveLength(1);
    expect(webSearch.match(/replayCacheScope: parsed\._reasoningReplayScope,/g)).toHaveLength(1);
    expect(`${core}\n${images}\n${webSearch}`).not.toContain("replayCacheScope: parsed._clientThreadId");
    expect(core).toContain("reasoningReplayDestinationIdentity(provider.baseUrl)");
    expect(core).toMatch(/reasoningReplayOAuthCredentialIdentity\(\s*args\.oauthCredentialSnapshot,\s*provider\.headers,/);
    expect(core).toContain("accountId: resolved.accountId");
    expect(core).toContain("generation: resolved.generation");
    expect(core).toContain("accountId: refreshed.accountId");
    expect(core).toContain("generation: refreshed.generation");
    expect(core).toContain("reasoningReplayCodexCredentialIdentity({");
    expect(core).toContain("authorization: poolContext");
    expect(core).toContain("accountId: poolContext?.accountId");
    expect(core).toContain("credentialGeneration: poolContext?.kind === \"pool\"");
    expect(core).toContain("writerGeneration: poolContext?.writerGeneration");
  });

  test("bridge, adapter, and cache contain no process-wide fallback", () => {
    // src/bridge.ts is a facade now. The two declarations this pins moved into different
    // leaves -- one into the SSE path, one into the JSON builder -- so reading the facade
    // alone matches nothing and toHaveLength(2) fails on null. Read both leaves and keep
    // the count at 2, which is what the invariant has always been: each bridge entry point
    // binds the caller scope holder and neither falls back to a process-wide scope.
    const bridge = `${source("bridge/sse.ts")}\n${source("bridge/response-json.ts")}`;
    const adapter = source("adapters/openai-chat/messages.ts");
    const cache = source("responses/reasoning-replay-cache.ts");
    expect(bridge.match(/const replayCacheScope = options\?\.replayCacheScope;/g)).toHaveLength(2);
    expect(adapter.match(/const replayCacheScope = parsed\._reasoningReplayScope;/g)).toHaveLength(1);
    expect(adapter).not.toContain("const replayCacheScope = parsed._clientThreadId");
    expect(cache).not.toContain('scope ?? "global"');
    expect(cache).not.toContain("identity.providerBaseUrl");
    expect(`${bridge}\n${adapter}`).not.toContain('replayCacheScope ?? "global"');
  });
});
