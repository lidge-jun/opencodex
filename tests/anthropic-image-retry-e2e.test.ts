import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import { startServer } from "../src/server";
import { resetNormalizeStateForTests } from "../src/adapters/anthropic-image-normalize";
import { sniffImageDimensions } from "../src/adapters/anthropic-image-guard";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-imgretry-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-imgretry-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
  resetNormalizeStateForTests();
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
  clearKeyCooldowns();
});

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function realPngDataUrl(width: number, height: number): Promise<string> {
  const buf = await new Bun.Image(Buffer.from(ONE_PX_PNG, "base64")).resize(width, height).png().toBuffer();
  return `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
}

interface SeenRequest { body: AnthropicBody; apiKey: string | null }
interface AnthropicBody { messages: Array<{ content: unknown }> }

function firstImageSource(body: AnthropicBody): { media_type?: string; data?: string } | null {
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const b = block as { type?: string; source?: { media_type?: string; data?: string } };
      if (b?.type === "image" && b.source) return b.source;
    }
  }
  return null;
}

const ANTHROPIC_413 = JSON.stringify({ type: "error", error: { type: "request_too_large", message: "Request exceeds the maximum allowed number of bytes" } });
const ANTHROPIC_OK = { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 2 } };

/** Scripted anthropic upstream: returns statuses[i] for call i, recording every request. */
function scriptedUpstream(statuses: number[], seen: SeenRequest[]): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json() as AnthropicBody;
      seen.push({ body, apiKey: req.headers.get("x-api-key") });
      const status = statuses[Math.min(seen.length - 1, statuses.length - 1)];
      if (status === 413) return new Response(ANTHROPIC_413, { status: 413, headers: { "content-type": "application/json" } });
      if (status === 429) return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } }), { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } });
      return Response.json(ANTHROPIC_OK);
    },
  });
}

function anthropicConfig(baseUrl: string, pool = false): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic-test",
    providers: {
      "anthropic-test": {
        adapter: "anthropic",
        baseUrl,
        allowPrivateNetwork: true,
        authMode: "key",
        apiKey: "key-alpha-000111222333",
        ...(pool ? {
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        } : {}),
        defaultModel: "claude-fable-5",
      },
    },
  } as OcxConfig;
}

async function postImageRequest(serverUrl: string, dataUrl: string): Promise<Response> {
  return fetch(new URL("/v1/responses", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic-test/claude-fable-5",
      stream: false,
      input: [
        {
          type: "message", role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    }),
  });
}

describe("anthropic 413 tightened-retry (end-to-end)", () => {
  test("R1: upstream 413 then 200 — exactly one biased rebuild, images re-encoded a tier lower", async () => {
    const seen: SeenRequest[] = [];
    upstream = scriptedUpstream([413, 200], seen);
    saveConfig(anthropicConfig(upstream.url.toString().replace(/\/$/, "")));
    const server = startServer(0);
    try {
      const res = await postImageRequest(String(server.url), await realPngDataUrl(1500, 1000));
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(2);
      // First attempt: 1500px PNG rides tier-0 pass-through.
      const first = firstImageSource(seen[0].body);
      expect(first?.media_type).toBe("image/png");
      // Biased retry: tier 1 — re-encoded JPEG within 1024px.
      const second = firstImageSource(seen[1].body);
      expect(second?.media_type).toBe("image/jpeg");
      const dims = sniffImageDimensions(second?.data ?? "");
      expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(1024);
    } finally {
      await server.stop(true);
    }
  });

  test("R2: upstream 413 twice — exactly two calls, honest 413 surfaces, no spiral", async () => {
    const seen: SeenRequest[] = [];
    upstream = scriptedUpstream([413, 413], seen);
    saveConfig(anthropicConfig(upstream.url.toString().replace(/\/$/, "")));
    const server = startServer(0);
    try {
      const res = await postImageRequest(String(server.url), await realPngDataUrl(1500, 1000));
      expect(res.status).toBe(413);
      expect(seen).toHaveLength(2);
      const errorText = await res.text();
      expect(errorText).toContain("Provider error 413");
    } finally {
      await server.stop(true);
    }
  });

  test("R4: 413 → biased retry → 429 → key rotation keeps the tightened tiers", async () => {
    const seen: SeenRequest[] = [];
    upstream = scriptedUpstream([413, 429, 200], seen);
    saveConfig(anthropicConfig(upstream.url.toString().replace(/\/$/, ""), true));
    const server = startServer(0);
    try {
      const res = await postImageRequest(String(server.url), await realPngDataUrl(1500, 1000));
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(3);
      // Rotation happened after the biased 413 retry hit 429.
      expect(seen[2].apiKey).not.toBe(seen[1].apiKey);
      // And the rotated rebuild STILL carries the tightened tier (jpeg <= 1024px).
      const third = firstImageSource(seen[2].body);
      expect(third?.media_type).toBe("image/jpeg");
      const dims = sniffImageDimensions(third?.data ?? "");
      expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(1024);
    } finally {
      await server.stop(true);
    }
  });
});
