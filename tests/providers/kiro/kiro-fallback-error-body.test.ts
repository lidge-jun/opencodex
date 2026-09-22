import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter as createKiroAdapterProduction } from "../../../src/adapters/kiro";
import { resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import { clearDebugSetting, getDebugSettings, setDebugSettings } from "../../../src/lib/debug-settings";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const realFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalRegion = process.env.KIRO_REGION;
const originalApiRegion = process.env.KIRO_API_REGION;
const originalArn = process.env.KIRO_PROFILE_ARN;
const originalCredsFile = process.env.KIRO_CREDS_FILE;
const originalCredentialsFile = process.env.KIRO_CREDENTIALS_FILE;
let originalDebug: string | undefined;
let originalDebugFrames: string | undefined;
let originalDebugOverride: boolean | undefined;
let tempHome: string;
beforeEach(() => {
  originalDebug = process.env.OCX_DEBUG;
  originalDebugFrames = process.env.OCX_DEBUG_FRAMES;
  originalDebugOverride = getDebugSettings().runtimeOverride.debug;
  tempHome = mkdtempSync(join(tmpdir(), "kiro-fallback-error-"));
  process.env.HOME = tempHome;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_API_REGION;
  delete process.env.KIRO_PROFILE_ARN;
  delete process.env.KIRO_CREDS_FILE;
  delete process.env.KIRO_CREDENTIALS_FILE;
  delete process.env.OCX_DEBUG;
  delete process.env.OCX_DEBUG_FRAMES;
  clearDebugSetting("debug");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  resetKiroThrottleStateForTests();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = originalRegion;
  if (originalApiRegion === undefined) delete process.env.KIRO_API_REGION; else process.env.KIRO_API_REGION = originalApiRegion;
  if (originalArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = originalArn;
  if (originalCredsFile === undefined) delete process.env.KIRO_CREDS_FILE; else process.env.KIRO_CREDS_FILE = originalCredsFile;
  if (originalCredentialsFile === undefined) delete process.env.KIRO_CREDENTIALS_FILE; else process.env.KIRO_CREDENTIALS_FILE = originalCredentialsFile;
  if (originalDebug === undefined) delete process.env.OCX_DEBUG; else process.env.OCX_DEBUG = originalDebug;
  if (originalDebugFrames === undefined) delete process.env.OCX_DEBUG_FRAMES; else process.env.OCX_DEBUG_FRAMES = originalDebugFrames;
  if (originalDebugOverride === undefined) clearDebugSetting("debug");
  else setDebugSettings({ debug: originalDebugOverride });
  removeTreeWithRetry(tempHome);
});

const provider = { adapter: "kiro", baseUrl: "https://127.0.0.1", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;
const bashTool = { name: "bash", description: "Run a shell command", parameters: { type: "object" } };
function createKiroAdapter(...args: Parameters<typeof createKiroAdapterProduction>) {
  return withTestTranslatorBudget(createKiroAdapterProduction(...args));
}
function parsedWith(messages: unknown[], tools?: unknown[]): OcxParsedRequest {
  return { modelId: "claude-sonnet-4.5", stream: true, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
}
const eventFrame = (obj: unknown) => encodeMessage(
  { ":message-type": "event", ":event-type": "assistantResponseEvent" },
  new TextEncoder().encode(JSON.stringify(obj)),
);
function streamOf(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(frames[i++]);
      else controller.close();
    },
  });
}
async function collectAdapterEvents(events: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("fallback HTTP errors stop reading oversized upstream bodies", async () => {
  const chunk = new TextEncoder().encode("A".repeat(32 * 1024));
  let pulls = 0;
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status: 400,
    headers: { "content-type": "text/plain" },
  })) as typeof fetch;
  const adapter = createKiroAdapter(provider);
  await adapter.buildRequest(parsedWith([{ role: "user", content: "do it" }], [bashTool]));

  const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
    eventFrame({ content: "I am checking." }),
  ))));

  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(10);
  expect(events.at(-1)).toMatchObject({
    type: "error",
    status: 400,
    retryable: false,
  });
  expect(events.some(event => event.type === "done")).toBe(false);
});
