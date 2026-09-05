/**
 * A Kiro bearer is useless without the region and profile ARN that were issued with it. The
 * bounded terminal continuation dispatches a SHALLOW CLONE of the parsed request, so a rotation
 * that writes `_kiroAuthContext` onto the outer request only leaves the clone carrying the
 * FAILED account's routing metadata — a new token paired with an old identity, which is the
 * exact mixed-identity failure the shared snapshot helper exists to prevent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../../src/adapters/base";
import { clearAnthropicAccountPoolState } from "../../../src/oauth/anthropic-routing";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";
let handleResponses: typeof import("../../../src/server/responses")["handleResponses"];
let kiroBuilds: Array<{ key: string; profileArn?: string; apiRegion?: string }> = [];

function kiroContinuationEvents(phase: string): AdapterEvent[] {
  if (phase === "plan") {
    return [
      { type: "text_delta", text: "I will modify the file now." },
      { type: "done", stopReason: "end_turn" },
    ];
  }
  if (phase === "complete") {
    return [
      { type: "tool_call_start", id: "call_read", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use" },
    ];
  }
  throw new Error(`unexpected phase: ${phase}`);
}

function kiroFixtureAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    // Anthropic enables the bounded terminal continuation, while the provider id remains
    // Kiro so generic OAuth snapshot pairing is exercised.
    name: "anthropic",
    buildRequest(parsed: OcxParsedRequest) {
      kiroBuilds.push({
        key: provider.apiKey ?? "",
        ...(parsed._kiroAuthContext?.profileArn
          ? { profileArn: parsed._kiroAuthContext.profileArn }
          : {}),
        ...(parsed._kiroAuthContext?.apiRegion
          ? { apiRegion: parsed._kiroAuthContext.apiRegion }
          : {}),
      });
      return {
        url: provider.baseUrl,
        method: "POST",
        headers: { authorization: `Bearer ${provider.apiKey ?? ""}` },
        body: "{}",
      };
    },
    async *parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      yield* kiroContinuationEvents(response.headers.get("x-test-phase") ?? "");
    },
  };
}

beforeAll(async () => {
  const actualResolver = await import("../../../src/server/adapter-resolve");
  const actualResolveAdapter = actualResolver.resolveAdapter;
  mock.module("../../../src/server/adapter-resolve", () => ({
    ...actualResolver,
    resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
      if (
        provider.adapter === "test-kiro-continuation"
        || (provider.adapter === "kiro" && provider.apiKey?.startsWith("kiro-access-"))
      ) return kiroFixtureAdapter(provider);
      return actualResolveAdapter(provider, cacheRetention);
    },
  }));

  ({ handleResponses } = await import("../../../src/server/responses"));
});

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-kiro-continuation-auth-"));
  process.env.OPENCODEX_HOME = testHome;
  kiroBuilds = [];
  clearAnthropicAccountPoolState();
  clearGenericFailoverHealth();
});

afterEach(() => {
  clearAnthropicAccountPoolState();
  clearGenericFailoverHealth();
  removeTreeWithRetry(testHome);
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  mock.restore();
});

test("Kiro continuation 429 keeps the rotated bearer and routing metadata together", async () => {
  const profiles = [
    "arn:aws:codewhisperer:us-east-1:123456789012:profile/account-a",
    "arn:aws:codewhisperer:eu-west-1:123456789012:profile/account-b",
  ];
  const regions = ["us-east-1", "eu-west-1"];
  for (let index = 0; index < 2; index += 1) {
    await saveCredential("kiro", {
      access: `kiro-access-${index}`,
      refresh: `kiro-refresh-${index}`,
      expires: Date.now() + 3_600_000,
      accountId: `kiro-account-${index}`,
      kiro: {
        profileArn: profiles[index],
        apiRegion: regions[index],
        ssoRegion: regions[index],
      },
    } as never, { addAccount: true });
  }
  const ids = getAccountSet("kiro")!.accounts.map(account => account.id);
  await setActiveAccount("kiro", ids[0]!);

  const config = {
    port: 0,
    defaultProvider: "kiro",
    providers: {
      kiro: {
        adapter: "test-kiro-continuation",
        baseUrl: "https://kiro-continuation.test/v1",
        authMode: "oauth",
        models: ["model"],
      },
    },
  } as unknown as OcxConfig;

  const phases = ["plan", "rate-limit", "complete"];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const phase = phases.shift();
    if (phase === "rate-limit") {
      return Response.json(
        { error: { message: "rate limited" } },
        { status: 429, headers: { "retry-after": "30" } },
      );
    }
    if (!phase) throw new Error("unexpected extra request");
    return new Response("", { status: 200, headers: { "x-test-phase": phase } });
  }) as typeof fetch;

  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kiro/model",
        input: "Please modify the file",
        stream: true,
        tools: [{
          type: "function",
          name: "read_file",
          description: "Read one file",
          parameters: { type: "object", properties: {} },
        }],
      }),
    }), config, { model: "", provider: "" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("read_file");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The third build is the continuation retry: it must carry the ROTATED account's bearer and
  // that same account's region/profile, not account 0's routing metadata.
  expect(kiroBuilds).toEqual([
    { key: "kiro-access-0", profileArn: profiles[0], apiRegion: regions[0] },
    { key: "kiro-access-0", profileArn: profiles[0], apiRegion: regions[0] },
    { key: "kiro-access-1", profileArn: profiles[1], apiRegion: regions[1] },
  ]);
  expect(phases).toEqual([]);
});
