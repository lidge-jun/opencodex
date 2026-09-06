import { afterEach, describe, expect, test } from "bun:test";
import { isCanonicalAntigravityUrl, providerTlsProfileConfigError, providerTlsFetch, resetProviderTlsProfileForTests, setProviderTlsRuntimeForTest } from "../../src/lib/provider-tls-profile";

afterEach(() => resetProviderTlsProfileForTests());

describe("provider TLS profile", () => {
  test("accepts only canonical Antigravity HTTPS origins", () => {
    expect(isCanonicalAntigravityUrl("https://cloudcode-pa.googleapis.com")).toBe(true);
    expect(isCanonicalAntigravityUrl("https://cloudcode-pa.googleapis.com:443")).toBe(true);
    expect(isCanonicalAntigravityUrl("http://cloudcode-pa.googleapis.com")).toBe(false);
    expect(isCanonicalAntigravityUrl("https://evil.example")).toBe(false);
  });

  test("rejects malformed profiles before fallback dispatch", async () => {
    const provider = { adapter: "openai-chat", authMode: "key", googleMode: undefined, baseUrl: "https://evil.example", tlsProfile: "antigravity-browser" as const };
    expect(providerTlsProfileConfigError("evil", provider)).toBeString();
    const fetcher = providerTlsFetch("evil", provider, async () => new Response("sent"));
    await expect(fetcher("https://evil.example")).rejects.toThrow("invalid provider TLS profile");
  });

  test("uses manual redirects, browser profile, and caller abort signal", async () => {
    let seen: RequestInit | undefined;
    setProviderTlsRuntimeForTest({ fetch: async (_input, init) => { seen = init; return new Response("ok"); } });
    const signal = new AbortController().signal;
    const provider = { adapter: "google", authMode: "oauth", googleMode: "cloud-code-assist", baseUrl: "https://cloudcode-pa.googleapis.com", tlsProfile: "antigravity-browser" as const };
    await providerTlsFetch("google-antigravity", provider, fetch)("https://cloudcode-pa.googleapis.com/v1", { signal });
    expect(seen?.redirect).toBe("manual");
    expect(seen?.signal).toBe(signal);
    expect((seen as any)?.browser).toBe("chrome_142");
  });

  test("redacts credential text from transport errors", async () => {
    setProviderTlsRuntimeForTest({ fetch: async () => { throw new Error("Authorization: Bearer super-secret"); } });
    const provider = { adapter: "google", authMode: "oauth", googleMode: "cloud-code-assist", baseUrl: "https://cloudcode-pa.googleapis.com", tlsProfile: "antigravity-browser" as const };
    await expect(providerTlsFetch("google-antigravity", provider, fetch)("https://cloudcode-pa.googleapis.com/v1")).rejects.toThrow("[REDACTED]");
    await expect(providerTlsFetch("google-antigravity", provider, fetch)("https://cloudcode-pa.googleapis.com/v1")).rejects.not.toThrow("super-secret");
  });
});
