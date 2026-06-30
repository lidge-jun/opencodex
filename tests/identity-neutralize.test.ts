import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_GPT5_IDENTITY_LINE, NEUTRAL_IDENTITY_LINE, neutralizeIdentity } from "../src/adapters/identity";
import { createGoogleAdapter } from "../src/adapters/google";
import { createKiroAdapter } from "../src/adapters/kiro";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const SYS = CODEX_GPT5_IDENTITY_LINE;

function parsed(modelId: string, adapter: string, extra?: Partial<OcxParsedRequest>): OcxParsedRequest {
  return {
    modelId, stream: false, options: {},
    context: { systemPrompt: [SYS], messages: [{ role: "user", content: "hi" }] },
    ...extra,
  } as unknown as OcxParsedRequest;
}

describe("identity neutralization — central helper", () => {
  test("replaces the Codex GPT-5 line with the proxy-neutral line", () => {
    expect(neutralizeIdentity(SYS)).toBe(NEUTRAL_IDENTITY_LINE);
  });

  test("never emits the opencodex proxy identity", () => {
    const out = neutralizeIdentity(`${SYS}\n\nmore context`);
    expect(out).not.toMatch(/opencodex proxy/i);
    expect(out).not.toMatch(/served through/i);
    expect(out).not.toMatch(/running via/i);
  });

  test("leaves text without the GPT-5 line unchanged", () => {
    expect(neutralizeIdentity("plain system text")).toBe("plain system text");
  });

  test("neutral line still forbids GPT-5 / OpenAI self-reporting", () => {
    expect(NEUTRAL_IDENTITY_LINE).toMatch(/not claim to be GPT-5/i);
    expect(NEUTRAL_IDENTITY_LINE).toMatch(/made by OpenAI/i);
  });
});

describe("identity neutralization — adapters never leak proxy identity", () => {
  test("openai-chat: system message is neutralized, no proxy mention", async () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://api.example.invalid", apiKey: "key" } as unknown as OcxProviderConfig;
    const { body } = await createOpenAIChatAdapter(provider).buildRequest(parsed("some/routed-model", "openai-chat"));
    const messages = JSON.parse(body).messages as { role: string; content: string }[];
    const sys = messages.find(m => m.role === "system")!;
    expect(sys.content).toContain(NEUTRAL_IDENTITY_LINE);
    expect(sys.content).not.toMatch(/opencodex proxy/i);
    expect(sys.content).not.toContain(SYS);
  });

  test("google/antigravity: systemInstruction is neutralized, no proxy mention", async () => {
    const provider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" };
    const { body } = await createGoogleAdapter(provider).buildRequest(parsed("gemini-3-pro", "google"));
    const sysText = JSON.parse(body).systemInstruction.parts.map((p: { text: string }) => p.text).join("");
    expect(sysText).toContain(NEUTRAL_IDENTITY_LINE);
    expect(sysText).not.toMatch(/opencodex proxy/i);
    expect(sysText).not.toContain(SYS);
  });

  describe("kiro", () => {
    const origHome = process.env.HOME;
    const origRegion = process.env.KIRO_REGION;
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "kiro-identity-"));
      process.env.HOME = tmp;
      process.env.KIRO_REGION = "us-east-1";
    });
    afterEach(() => {
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
      if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
      rmSync(tmp, { recursive: true, force: true });
    });

    test("system prefix is neutralized, no proxy mention", () => {
      const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;
      const { body } = createKiroAdapter(provider).buildRequest(parsed("claude-sonnet-4.5", "kiro"));
      const serialized = typeof body === "string" ? body : JSON.stringify(body);
      expect(serialized).not.toMatch(/opencodex proxy/i);
      expect(serialized).not.toContain(SYS);
    });
  });
});
