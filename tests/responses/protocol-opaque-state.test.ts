/**
 * Opaque thinking state and credential domains (PF-10, src/protocols/opaque-state.ts): thinking
 * signatures and `redacted_thinking` blocks reach first-party Anthropic only, a copy without them
 * goes everywhere else, and the source is never touched so the next destination decides again.
 */
import { describe, expect, test } from "bun:test";
import { buildAnthropicMessagesPassthroughRequest } from "../../src/adapters/anthropic/passthrough";
import { createProtocolEnvelope } from "../../src/protocols/envelope";
import {
  anthropicProviderClass,
  credentialDomainFor,
  messagesBodyHasOpaqueState,
  opaqueStateForDestination,
  sameCredentialDomain,
} from "../../src/protocols/opaque-state";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { OcxProviderConfig } from "../../src/types";

const SIGNATURE = "fixture-signature-AAAAAAAAAAAAAAAAAAAA";
const REDACTED = "fixture-redacted-BBBBBBBBBBBBBBBBBBBB";

function body() {
  return {
    model: "selector",
    max_tokens: 64,
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [
      { role: "user", content: "fixture question" },
      { role: "assistant", content: [
        { type: "redacted_thinking", data: REDACTED },
        { type: "thinking", thinking: "fixture reasoning", signature: SIGNATURE },
        { type: "text", text: "fixture answer" },
      ] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: REDACTED }] },
      { role: "user", content: "fixture follow-up" },
    ],
  };
}

/** `https://api.anthropic.com` with userinfo, built so no literal credential URL sits in source. */
function withUserinfo(): string {
  const url = new URL("https://api.anthropic.com");
  url.username = "fixture";
  url.password = "fixture";
  return url.href;
}

const FIRST_PARTY = credentialDomainFor({ baseUrl: "https://api.anthropic.com/v1", authMode: "key" });
const COMPATIBLE = credentialDomainFor({ baseUrl: "https://compatible.example/anthropic", authMode: "key" });

describe("credential domains", () => {
  test("only HTTPS api.anthropic.com on the default port is first-party", () => {
    expect(FIRST_PARTY).toEqual({ host: "api.anthropic.com", authClass: "key", firstPartyAnthropic: true });
    for (const baseUrl of [
      "http://api.anthropic.com",
      "https://api.anthropic.com:444",
      "https://api.anthropic.com.example",
      "https://proxy.example/api.anthropic.com",
      withUserinfo(),
    ]) {
      expect(credentialDomainFor({ baseUrl, authMode: "key" })?.firstPartyAnthropic).toBe(false);
    }
    expect(credentialDomainFor({ baseUrl: "not a url", authMode: "key" })).toBeUndefined();
    expect(anthropicProviderClass({ baseUrl: "https://API.ANTHROPIC.COM", authMode: "oauth" })).toBe("first-party");
    expect(anthropicProviderClass({ baseUrl: "https://compatible.example", authMode: "key" })).toBe("compatible");
  });

  test("a domain is host plus credential class", () => {
    const oauth = credentialDomainFor({ baseUrl: "https://api.anthropic.com", authMode: "oauth" });
    expect(sameCredentialDomain(FIRST_PARTY, credentialDomainFor({ baseUrl: "https://api.anthropic.com/v1/messages", authMode: undefined })))
      .toBe(true);
    expect(sameCredentialDomain(FIRST_PARTY, oauth)).toBe(false);
    expect(sameCredentialDomain(FIRST_PARTY, COMPATIBLE)).toBe(false);
    expect(sameCredentialDomain(undefined, undefined)).toBe(false);
  });
});

describe("opaqueStateForDestination", () => {
  test("first-party keeps every signature and redacted block, by reference", () => {
    const source = body();
    const result = opaqueStateForDestination(source, FIRST_PARTY);
    expect(result).toEqual({ body: source, stripped: false });
  });

  test("any other destination gets a copy without them; the source is untouched", () => {
    const source = body();
    const snapshot = structuredClone(source);
    const result = opaqueStateForDestination(source, COMPATIBLE);
    expect(result.stripped).toBe(true);
    expect(result.body.messages).toEqual([
      { role: "user", content: "fixture question" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "fixture reasoning" },
        { type: "text", text: "fixture answer" },
      ] },
      // The assistant turn that held only a redacted block is dropped, not sent empty.
      { role: "user", content: "fixture follow-up" },
    ]);
    expect(JSON.stringify(result.body)).not.toContain(SIGNATURE);
    expect(JSON.stringify(result.body)).not.toContain(REDACTED);
    expect(source).toEqual(snapshot);
    // Unaffected messages are shared, not copied.
    expect((result.body.messages as unknown[])[0]).toBe(source.messages[0]);
  });

  test("an unknown destination is treated as foreign", () => {
    expect(opaqueStateForDestination(body(), undefined).stripped).toBe(true);
  });

  test("a body without opaque state is returned as is", () => {
    const plain = { messages: [{ role: "user", content: "fixture" }] };
    expect(messagesBodyHasOpaqueState(plain)).toBe(false);
    expect(opaqueStateForDestination(plain, COMPATIBLE)).toEqual({ body: plain, stripped: false });
  });
});

describe("a fallback to another credential domain rebuilds from the envelope", () => {
  test("each build decides from the full source, whatever an earlier build removed", () => {
    const envelope = createProtocolEnvelope({ inbound: "messages", body: body(), translatorBudget: createTranslatorBudget() });
    const key = (baseUrl: string) => ({ adapter: "anthropic", baseUrl, authMode: "key", apiKey: "fixture-key" }) as OcxProviderConfig;

    const first = buildAnthropicMessagesPassthroughRequest(key("https://compatible.example"), "m", envelope.freshBody());
    expect(first.strippedOpaqueState).toBe(true);
    expect(first.body).not.toContain(SIGNATURE);

    const fallback = buildAnthropicMessagesPassthroughRequest(key("https://api.anthropic.com"), "m", envelope.freshBody());
    expect(fallback.strippedOpaqueState).toBe(false);
    expect(fallback.body).toContain(SIGNATURE);
    expect(fallback.body).toContain(REDACTED);

    // The same source body reused across builds gives the same answer: the builder never mutates.
    const source = envelope.freshBody();
    buildAnthropicMessagesPassthroughRequest(key("https://compatible.example"), "m", source);
    expect(buildAnthropicMessagesPassthroughRequest(key("https://api.anthropic.com"), "m", source).body).toContain(SIGNATURE);
  });
});
