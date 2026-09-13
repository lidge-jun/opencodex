import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../../src/config";
import { clearKeyCooldowns } from "../../../src/providers/key-failover";
import { startServer } from "../../../src/server";
import { resetNormalizeStateForTests } from "../../../src/adapters/anthropic-image-normalize";
import type { OcxConfig } from "../../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

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

async function postImageRequest(serverUrl: string, dataUrl: string, count = 1): Promise<Response> {
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
            ...Array.from({ length: count }, () => ({ type: "input_image", image_url: dataUrl })),
          ],
        },
      ],
    }),
  });
}

describe("Anthropic image admission and upstream 413", () => {
  test("upstream 413 is terminal instead of degrading old images and retrying", async () => {
    const seen: SeenRequest[] = [];
    upstream = scriptedUpstream([413, 200], seen);
    saveConfig(anthropicConfig(upstream.url.toString().replace(/\/$/, "")));
    const server = startServer(0);
    try {
      const res = await postImageRequest(String(server.url), await realPngDataUrl(1500, 1000));
      expect(res.status).toBe(413);
      await res.text();
      expect(seen).toHaveLength(1);
      expect(firstImageSource(seen[0].body)?.media_type).toBe("image/png");
    } finally {
      await server.stop(true);
    }
  });

  test("local image-count overflow returns 413 before any upstream request", async () => {
    const seen: SeenRequest[] = [];
    upstream = scriptedUpstream([200], seen);
    saveConfig(anthropicConfig(upstream.url.toString().replace(/\/$/, "")));
    const server = startServer(0);
    try {
      const res = await postImageRequest(String(server.url), `data:image/png;base64,${ONE_PX_PNG}`, 101);
      expect(res.status).toBe(413);
      const errorBody = await res.json();
      expect(errorBody.error).toMatchObject({
        type: "request_too_large",
        code: "anthropic_image_count_exceeded",
      });
      expect(seen).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("429 rotates the key without changing images; a following 413 is terminal", async () => {
    const seen: SeenRequest[] = [];
    upstream = scriptedUpstream([429, 413, 200], seen);
    saveConfig(anthropicConfig(upstream.url.toString().replace(/\/$/, ""), true));
    const server = startServer(0);
    try {
      const res = await postImageRequest(String(server.url), await realPngDataUrl(1500, 1000));
      expect(res.status).toBe(413);
      await res.text();
      expect(seen).toHaveLength(2);
      expect(seen[1].apiKey).not.toBe(seen[0].apiKey);
      expect(firstImageSource(seen[1].body)).toEqual(firstImageSource(seen[0].body));
    } finally {
      await server.stop(true);
    }
  });
});
