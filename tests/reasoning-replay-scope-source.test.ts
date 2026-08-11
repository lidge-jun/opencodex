import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (relative: string): string =>
  readFileSync(join(import.meta.dir, "..", "src", ...relative.split("/")), "utf8");

describe("reasoning replay scope propagation", () => {
  test("every production bridge call passes only the explicit client thread scope", () => {
    const core = source("server/responses/core.ts");
    const images = source("images/loop.ts");
    const webSearch = source("web-search/loop.ts");
    expect(core.match(/replayCacheScope: parsed\._clientThreadId,/g)).toHaveLength(4);
    expect(images.match(/replayCacheScope: parsed\._clientThreadId,/g)).toHaveLength(1);
    expect(webSearch.match(/replayCacheScope: parsed\._clientThreadId,/g)).toHaveLength(1);
  });

  test("bridge, adapter, and cache contain no process-wide fallback", () => {
    const bridge = source("bridge.ts");
    const adapter = source("adapters/openai-chat.ts");
    const cache = source("responses/reasoning-replay-cache.ts");
    expect(bridge.match(/const replayCacheScope = options\?\.replayCacheScope;/g)).toHaveLength(2);
    expect(adapter.match(/const replayCacheScope = parsed\._clientThreadId;/g)).toHaveLength(1);
    expect(cache).not.toContain('scope ?? "global"');
    expect(`${bridge}\n${adapter}`).not.toContain('replayCacheScope ?? "global"');
  });
});
