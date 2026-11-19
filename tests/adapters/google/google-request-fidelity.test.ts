/**
 * Google request fidelity: Vertex multi-region hosts, inline audio and tool error results
 * (devlog/_plan/261115_google_protocol_cpa_parity/060).
 */
import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { vertexHostForLocation, vertexInferenceUrl } from "../../../src/adapters/google-vertex-endpoint";
import type { OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const aiStudio = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key", googleMode: "ai-studio" } as OcxProviderConfig;
const vertex = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", apiKey: "key", googleMode: "vertex" } as OcxProviderConfig;
const cca = { adapter: "google", baseUrl: "https://cloudcode-pa.googleapis.com", apiKey: "key", googleMode: "cloud-code-assist", project: "test-project" } as OcxProviderConfig;

type Part = Record<string, unknown>;

async function contents(provider: OcxProviderConfig, modelId: string, messages: OcxMessage[]): Promise<Array<{ role: string; parts: Part[] }>> {
  const built = await createGoogleAdapter(provider).buildRequest({ modelId, stream: false, options: {}, context: { messages } } as OcxParsedRequest);
  const body = JSON.parse(built.body);
  return (body.request ?? body).contents;
}

const audio: OcxContentPart = { type: "audio", data: "UklGRg==", format: "wav", text: "[audio: wav]" };

describe("Vertex multi-region hosts", () => {
  test.each([
    ["global", "aiplatform.googleapis.com"],
    ["us-central1", "us-central1-aiplatform.googleapis.com"],
    ["europe-west4", "europe-west4-aiplatform.googleapis.com"],
    ["us", "aiplatform.us.rep.googleapis.com"],
    ["eu", "aiplatform.eu.rep.googleapis.com"],
  ])("%s uses %s", (location, host) => {
    expect(vertexHostForLocation(location)).toBe(host);
    const url = new URL(vertexInferenceUrl({ kind: "project", project: "p", location }, "gemini-3-pro", "generateContent", ""));
    expect(url.host).toBe(host);
    expect(url.pathname).toBe(`/v1/projects/p/locations/${location}/publishers/google/models/gemini-3-pro:generateContent`);
  });

  test("an invalid location still fails before any authority is formed", () => {
    expect(() => vertexInferenceUrl({ kind: "project", project: "p", location: "us.evil.com" }, "m", "generateContent", "")).toThrow();
  });
});

describe("inline audio", () => {
  test.each([[aiStudio, "gemini-3-pro"], [vertex, "gemini-3-pro"], [cca, "gemini-3.6-flash"]] as const)("audio is inline_data on %#", async (provider, model) => {
    const turns = await contents(provider, model, [{ role: "user", content: [{ type: "text", text: "listen" }, audio], timestamp: 0 } as OcxMessage]);
    expect(turns.at(-1)!.parts).toEqual([{ text: "listen" }, { inline_data: { mime_type: "audio/wav", data: "UklGRg==" } }]);
  });

  test("mp3 uses audio/mp3", async () => {
    const turns = await contents(aiStudio, "gemini-3-pro", [{ role: "user", content: [{ ...audio, format: "mp3" }], timestamp: 0 } as OcxMessage]);
    expect(turns.at(-1)!.parts).toEqual([{ inline_data: { mime_type: "audio/mp3", data: "UklGRg==" } }]);
  });

  test("Claude on Antigravity keeps the text marker", async () => {
    const turns = await contents(cca, "claude-sonnet-4-6", [{ role: "user", content: [{ type: "text", text: "listen" }, audio], timestamp: 0 } as OcxMessage]);
    expect(JSON.stringify(turns)).not.toContain("UklGRg==");
    expect(turns.at(-1)!.parts).toEqual([{ text: "listen" }, { text: "[audio: wav]" }]);
  });
});

describe("tool error results", () => {
  const history = (isError: boolean): OcxMessage[] => [
    { role: "user", content: "go", timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "shell", arguments: {} }], timestamp: 0 } as OcxMessage,
    { role: "toolResult", toolCallId: "call_1", toolName: "shell", content: "permission denied", isError, timestamp: 0 } as OcxMessage,
  ];

  test.each([[aiStudio, "gemini-3-pro"], [vertex, "gemini-3-pro"], [cca, "claude-sonnet-4-6"]] as const)("an error result uses response.error on %#", async (provider, model) => {
    const failed = (await contents(provider, model, history(true))).at(-1)!.parts[0]!.functionResponse;
    expect(failed).toMatchObject({ name: "shell", id: "call_1", response: { error: "permission denied" } });
    expect((failed as { response: object }).response).not.toHaveProperty("result");
    const ok = (await contents(provider, model, history(false))).at(-1)!.parts[0]!.functionResponse;
    expect(ok).toMatchObject({ response: { result: "permission denied" } });
  });
});
