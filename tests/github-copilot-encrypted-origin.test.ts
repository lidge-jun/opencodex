import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveCredential } from "../src/oauth/store";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let testHome: string;

// Structurally valid synthetic Fernet bytes; the payload is intentionally not decryptable.
const fernet = Buffer.alloc(73, 0x5a);
fernet[0] = 0x80;
fernet.writeBigUInt64BE(1_720_000_000n, 1);
const encoded = fernet.toString("base64url");
const FERNET_TASK = `${encoded}${"=".repeat((4 - (encoded.length % 4)) % 4)}`;

function encryptedAgentInput(): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content: [{ type: "encrypted_content", encrypted_content: FERNET_TASK }],
  }];
}

function copilotProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    ...providerConfigSeed(getProviderRegistryEntry("github-copilot")!),
    adapter: "openai-responses",
    baseUrl: "https://api.githubcopilot.com",
    allowEncryptedV2AgentTasks: true,
    ...overrides,
  };
}

function config(provider: OcxProviderConfig): OcxConfig {
  return { providers: { "github-copilot": provider } } as unknown as OcxConfig;
}

function comboConfig(): OcxConfig {
  return {
    providers: {
      "github-copilot": copilotProvider({ authMode: "oauth" }),
      relay: {
        adapter: "openai-responses",
        baseUrl: "https://relay.example.test",
        authMode: "key",
        apiKey: "relay-key-fixture",
        allowEncryptedV2AgentTasks: true,
      },
    },
    combos: {
      trusted: {
        strategy: "failover",
        targets: [
          { provider: "github-copilot", model: "gpt-5.6-luna" },
          { provider: "relay", model: "relay-model" },
        ],
      },
    },
    agentTaskRecovery: { enabled: true },
  } as unknown as OcxConfig;
}

async function seedCredential(apiBaseUrl: string): Promise<void> {
  await saveCredential("github-copilot", {
    access: "access-fixture",
    refresh: "refresh-fixture",
    expires: Date.now() + 3_600_000,
    accountId: "fixture-account",
    apiBaseUrl,
  });
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-copilot-origin-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe("encrypted Copilot tasks stay bound to the approved origin", () => {
  test("key auth never follows a stale stored credential endpoint", async () => {
    await seedCredential("https://api.individual.githubcopilot.com");
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "github-copilot/gpt-5.6-luna",
        input: encryptedAgentInput(),
        stream: true,
      }),
    }), config(copilotProvider({ authMode: "key", apiKey: "key-fixture" })), { model: "", provider: "" });

    expect(response.status).toBe(200);
    expect(urls).toEqual(["https://api.githubcopilot.com/responses"]);
    expect(urls.some(url => url.includes("api.individual.githubcopilot.com"))).toBe(false);
  });

  test("OAuth ciphertext is rejected before dispatch when the credential origin changes", async () => {
    await seedCredential("https://api.individual.githubcopilot.com");
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("unexpected upstream call", { status: 500 });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "github-copilot/gpt-5.6-luna",
        input: encryptedAgentInput(),
        stream: false,
      }),
    }), config(copilotProvider({ authMode: "oauth" })), { model: "", provider: "" });

    expect(response.status).toBe(400);
    expect((await response.json()).error?.code).toBe("unreadable_encrypted_agent_task");
    expect(urls).toEqual([]);
  });

  test("a stale Copilot origin is skipped before a later trusted combo fallback", async () => {
    await seedCredential("https://api.individual.githubcopilot.com");
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/trusted",
        input: encryptedAgentInput(),
        stream: true,
      }),
    }), comboConfig(), { model: "", provider: "" });

    expect(response.status).toBe(200);
    expect(urls).toEqual(["https://relay.example.test/responses"]);
    expect(urls.some(url => url.includes("api.individual.githubcopilot.com"))).toBe(false);
  });
});
