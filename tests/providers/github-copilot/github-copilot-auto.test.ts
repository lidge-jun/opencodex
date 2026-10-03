import { beforeEach, describe, expect, test } from "bun:test";
import { clearCopilotAutoModelsForTests, copilotPickerModels, copilotRequiresAuto, resolveCopilotAuto } from "../../../src/providers/github-copilot-auto";
import { waitForProviderRequestSlot, releaseProviderRequestSlot } from "../../../src/providers/request-pacing";
import { redactHeaders, redactSecrets, redactSecretString } from "../../../src/lib/redact";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const parsed: OcxParsedRequest = { modelId: "auto", stream: true, options: {}, context: {
  messages: [{ role: "user", content: "Implement the requested change", timestamp: 0 }],
} };
beforeEach(clearCopilotAutoModelsForTests);
describe("Copilot Auto permissions and negotiation", () => {
  test("initial negotiation honors the provider concurrency cap", async () => {
    let sends = 0;
    const provider = { authMode: "oauth", baseUrl: "https://api.githubcopilot.com",
      requestPacing: { enabled: true, maxConcurrentRequests: 1 }, fetch: (async () => {
        sends++; return Response.json({ data: [{ id: "named", model_picker_enabled: true }] });
      }) as typeof fetch } as OcxProviderConfig;
    const held = await waitForProviderRequestSlot("github-copilot", provider, "named");
    const pending = resolveCopilotAuto(provider, "named", parsed);
    try { await Bun.sleep(10); expect(sends).toBe(0); }
    finally { releaseProviderRequestSlot(held); }
    expect((await pending).modelId).toBe("named");
    expect(sends).toBe(1);
  });
  test("a redirect cannot forward negotiation credentials to its Location", async () => {
    const calls: string[] = [];
    const provider = { authMode: "oauth", apiKey: "opaque-bearer", baseUrl: "https://api.githubcopilot.com", fetch: (async url => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/collect" } });
    }) as typeof fetch } as OcxProviderConfig;
    await expect(resolveCopilotAuto(provider, "auto", parsed)).rejects.toThrow("failed (302)");
    expect(calls).toEqual(["https://api.githubcopilot.com/models"]);
  });
  test("session credentials are redacted in headers, JSON fields, and provider echoes", () => {
    const secret = "opaque-session-value";
    expect(redactHeaders({ "Copilot-Session-Token": secret })).toEqual({ "copilot-session-token": "[REDACTED]" });
    expect(redactSecrets({ session_token: secret })).toEqual({ session_token: "[REDACTED]" });
    for (const echo of [`Copilot-Session-Token: ${secret}`, `session_token=${secret}`, JSON.stringify({ session_token: secret })])
      expect(redactSecretString(echo)).not.toContain(secret);
  });
  test("expired session is rejected before sending the intent or any inference", async () => {
    let intentSent = false;
    const provider = { authMode: "oauth", baseUrl: "https://api.githubcopilot.com", fetch: (async url => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "eligible", supported_endpoints: ["/responses"] }] });
      if (String(url).endsWith("/intent")) intentSent = true;
      return Response.json({ session_token: "expired-session", expires_at: Math.floor(Date.now() / 1000) - 1, available_models: ["eligible"] });
    }) as typeof fetch } as OcxProviderConfig;
    await expect(resolveCopilotAuto(provider, "auto", parsed)).rejects.toThrow("session is already expired");
    expect(intentSent).toBe(false);
  });
  test("inventory existence does not grant picker permission; missing metadata retains legacy", () => {
    expect(copilotRequiresAuto({}, [{ id: "gpt-4.1", model_picker_enabled: false }])).toBe(true);
    expect(copilotRequiresAuto({}, [{ id: "gpt-4.1" }])).toBe(false);
    expect(copilotPickerModels({}, [{ id: "a", model_picker_enabled: true }, { id: "b", model_picker_enabled: false }])).toEqual([{ id: "a", model_picker_enabled: true }]);
    expect(copilotPickerModels({ copilotModelSelection: "auto" }, [{ id: "a", model_picker_enabled: true }])).toEqual([{ id: "auto" }]);
  });
  test("sessions are account-bound, ephemeral, and choose wire from returned endpoint metadata", async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const executor = (async (url, init) => {
      const headers = new Headers(init?.headers);
      const account = headers.get("authorization")?.endsWith("account-b") ? "b" : "a";
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url: String(url), headers, body });
      if (path === "/models") return Response.json({ data: [{ id: `model-${account}`, model_picker_enabled: false,
        supported_endpoints: [account === "a" ? "/chat/completions" : "/responses"] }] });
      if (path === "/models/session") return Response.json({ session_token: `session-${account}`, available_models: [`model-${account}`] });
      expect(headers.get("copilot-session-token")).toBe(`session-${account}`);
      return Response.json({ candidate_models: ["not-in-session", `model-${account}`] });
    }) as typeof fetch;
    const provider = (account: string): OcxProviderConfig => ({ authMode: "oauth", apiKey: `account-${account}`,
      baseUrl: `https://${account}.githubcopilot.com`, fetch: executor } as OcxProviderConfig);
    const a = await resolveCopilotAuto(provider("a"), "stale-model", parsed);
    const b = await resolveCopilotAuto({ ...provider("b"), headers: a.provider.headers }, "auto", parsed);
    expect(a.modelId).toBe("model-a");
    expect(a.provider.adapter).toBe("openai-chat");
    expect(b.modelId).toBe("model-b");
    expect(b.provider.adapter).toBe("openai-responses");
    expect(calls.every(call => call.headers.get("x-github-api-version") === "2026-08-01")).toBe(true);
    expect(calls.filter(call => !call.url.endsWith("/intent")).every(call => !call.headers.has("copilot-session-token"))).toBe(true);
    expect(calls.find(call => call.url.endsWith("/intent"))?.body).toEqual({ prompt: "Implement the requested change", available_models: ["model-a"] });
  });
  test("out-of-pool candidates and secret-bearing error bodies never become client errors", async () => {
    let rejectSession = false;
    const executor = (async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/models") return Response.json({ data: [{ id: "eligible", supported_endpoints: ["/responses"] }] });
      if (path === "/models/session") return rejectSession ? Response.json({ token: "private-session-material" }, { status: 403 })
        : Response.json({ session_token: "private-session-material", available_models: ["eligible"] });
      return Response.json({ candidate_models: ["unapproved"] });
    }) as typeof fetch;
    const provider = { authMode: "oauth", apiKey: "account-a", baseUrl: "https://a.githubcopilot.com", fetch: executor } as OcxProviderConfig;
    await expect(resolveCopilotAuto(provider, "auto", parsed)).rejects.toThrow("no eligible model");
    rejectSession = true;
    await expect(resolveCopilotAuto(provider, "auto", parsed)).rejects.toThrow("Auto negotiation failed (403)");
  });
  test("malformed session token is rejected without echoing its value", async () => {
    const privateValue = "private-session-material\r\ninvalid";
    const provider = { authMode: "oauth", baseUrl: "https://api.githubcopilot.com", fetch: (async url => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "eligible", supported_endpoints: ["/responses"] }] });
      return Response.json({ session_token: privateValue, available_models: ["eligible"] });
    }) as typeof fetch } as OcxProviderConfig;
    const error = await resolveCopilotAuto(provider, "auto", parsed).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("private-session-material");
    expect(error.message).toBe("GitHub Copilot Auto session omitted its routing credentials");
  });
  test("transport exceptions cannot expose reflected session headers", async () => {
    const secret = "reflected-session-value";
    const provider = { authMode: "oauth", baseUrl: "https://api.githubcopilot.com", fetch: (async url => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "eligible", supported_endpoints: ["/responses"] }] });
      if (String(url).endsWith("/models/session")) return Response.json({ session_token: secret, available_models: ["eligible"] });
      throw new Error(secret);
    }) as typeof fetch } as OcxProviderConfig;
    const error = await resolveCopilotAuto(provider, "auto", parsed).catch(error => error as Error);
    expect(error.message).not.toContain(secret);
    expect(error.message).toBe("GitHub Copilot Auto negotiation transport failed");
  });
  test.each(["malformed-pool", "unsupported-endpoint"])("%s is refused before inference", async scenario => {
    const provider = { authMode: "oauth", baseUrl: "https://api.githubcopilot.com", fetch: (async url => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "eligible", supported_endpoints: ["/unrecognized"] }] });
      if (String(url).endsWith("/models/session")) return Response.json({ session_token: "private-session", available_models:
        scenario === "malformed-pool" ? ["eligible", {}] : ["eligible"] });
      return Response.json({ candidate_models: ["eligible"] });
    }) as typeof fetch } as OcxProviderConfig;
    await expect(resolveCopilotAuto(provider, "auto", parsed)).rejects.toThrow(scenario === "malformed-pool"
      ? "omitted its routing credentials" : "no supported inference endpoint");
  });
  test("manual named requests make no discovery calls, detect outage preserves legacy route", async () => {
    let calls = 0;
    const provider = { authMode: "oauth", baseUrl: "https://api.githubcopilot.com", fetch: (async () => {
      calls++; throw new Error("network unavailable");
    }) as typeof fetch } as OcxProviderConfig;
    expect((await resolveCopilotAuto({ ...provider, copilotModelSelection: "manual" }, "named", parsed)).modelId).toBe("named");
    expect(calls).toBe(0);
    expect((await resolveCopilotAuto(provider, "named", parsed)).modelId).toBe("named");
    expect(calls).toBe(1);
  });
  test("cancellation and authority guard prevent negotiation sends", async () => {
    let sends = 0;
    const provider = { authMode: "oauth", baseUrl: "https://api.githubcopilot.com", fetch: (async () => {
      sends++; return Response.json({});
    }) as typeof fetch } as OcxProviderConfig;
    await expect(resolveCopilotAuto(provider, "auto", parsed, AbortSignal.abort())).rejects.toThrow();
    await expect(resolveCopilotAuto(provider, "auto", parsed, undefined, () => false)).rejects.toThrow();
    expect(sends).toBe(0);
  });
});
