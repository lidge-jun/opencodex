/**
 * A video the Chat conversion cannot carry is refused at the Chat endpoint with the same
 * `unsupported_input_modality` code the Responses core uses, on the bridge and on the direct
 * (Chat -> IR) lane, before anything is sent upstream.
 *
 * Two cases: a `video_url` outside user content (no conversion carries it; it used to be
 * dropped in silence), and an inline clip over the 50 MiB cap (refused before translation makes
 * request-sized copies, including the Cursor/Kiro usage estimate that serializes the messages).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { saveCredential } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { MAX_INLINE_VIDEO_BYTES } from "../../src/responses/video-input";
import { handleChatCompletions } from "../../src/server/chat-completions";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
let originalFetch: typeof fetch;
let upstreamSends = 0;

beforeEach(async () => {
  clearGenericFailoverHealth();
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-video-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-video-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  upstreamSends = 0;
  await saveCredential("google-antigravity", {
    access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
    accountId: "antigravity-fixture-account", projectId: "fixture-project", source: "oauth",
  });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(input, init);
    upstreamSends++;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearGenericFailoverHealth();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function config(direct: boolean): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth",
        googleMode: "cloud-code-assist", project: "fixture-project", models: ["gemini-3.8-flash"],
      },
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth", models: ["auto"] },
    },
    protocols: { rollout: { antigravityDirect: direct } },
  } as OcxConfig;
}

async function send(direct: boolean, model: string, messages: unknown[]) {
  const cfg = config(direct);
  saveConfig(cfg);
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages }),
  }), cfg, { model: "", provider: "" }, { requestId: `chat-video-${crypto.randomUUID()}`, start: Date.now() });
  return { status: response.status, body: await response.json() as { error?: { code?: string; message?: string } } };
}

const INLINE = "data:video/mp4;base64,AAAAIGZ0eXBpc29t";
const oversized = () => `data:video/mp4,${"A".repeat(MAX_INLINE_VIDEO_BYTES + 1)}`;

for (const direct of [true, false]) {
  test(`an assistant-position video_url is refused with unsupported_input_modality (direct=${direct})`, async () => {
    const { status, body } = await send(direct, "google-antigravity/gemini-3.8-flash", [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "earlier" }, { type: "video_url", video_url: { url: INLINE } }] },
      { role: "user", content: "and now?" },
    ]);
    expect(status).toBe(400);
    expect(body.error?.code).toBe("unsupported_input_modality");
    expect(body.error?.message).not.toContain("AAAAIGZ0eXBpc29t");
    expect(upstreamSends).toBe(0);
  });

  test(`an over-cap inline clip is refused before any send (direct=${direct})`, async () => {
    const { status, body } = await send(direct, "google-antigravity/gemini-3.8-flash", [
      { role: "user", content: [{ type: "text", text: "describe" }, { type: "video_url", video_url: { url: oversized() } }] },
    ]);
    expect(status).toBe(400);
    expect(body.error?.code).toBe("unsupported_input_modality");
    expect(upstreamSends).toBe(0);
  });
}

test("a Cursor-routed over-cap clip is refused before the usage estimate serializes it", async () => {
  const { status, body } = await send(true, "cursor/auto", [
    { role: "user", content: [{ type: "video_url", video_url: { url: oversized() } }] },
  ]);
  expect(status).toBe(400);
  expect(body.error?.code).toBe("unsupported_input_modality");
  expect(upstreamSends).toBe(0);
});
