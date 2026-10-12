import { afterEach, describe, expect, test } from "bun:test";
import {
  getProviderTlsProfileStatus,
  isCanonicalAntigravityUrl,
  providerTlsProfileConfigError,
  providerTlsFetch,
  providerTlsProfileDiagnostic,
  resetProviderTlsProfileForTests,
  setProviderTlsRuntimeForTest,
} from "../../src/lib/provider-tls-profile";
import { isEgressTransparentExecutor } from "../../src/lib/provider-egress";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../src/types";

afterEach(() => resetProviderTlsProfileForTests());

describe("provider TLS profile", () => {
  test("accepts only canonical Antigravity HTTPS origins", () => {
    expect(
      isCanonicalAntigravityUrl("https://cloudcode-pa.googleapis.com"),
    ).toBe(true);
    expect(
      isCanonicalAntigravityUrl("https://cloudcode-pa.googleapis.com:443"),
    ).toBe(true);
    expect(
      isCanonicalAntigravityUrl("http://cloudcode-pa.googleapis.com"),
    ).toBe(false);
    expect(isCanonicalAntigravityUrl("https://evil.example")).toBe(false);
  });

  test("rejects malformed profiles before fallback dispatch", async () => {
    const provider = {
      adapter: "openai-chat",
      authMode: "key",
      googleMode: undefined,
      baseUrl: "https://evil.example",
      tlsProfile: "antigravity-browser" as const,
    };
    expect(providerTlsProfileConfigError("evil", provider)).toBeString();
    const fetcher = providerTlsFetch(
      "evil",
      provider,
      async () => new Response("sent"),
    );
    await expect(fetcher("https://evil.example")).rejects.toThrow(
      "invalid provider TLS profile",
    );
  });

  test("uses manual redirects, browser profile, and caller abort signal", async () => {
    let seen: RequestInit | undefined;
    setProviderTlsRuntimeForTest({
      env: {},
      fetch: async (_input, init) => {
        seen = init;
        return new Response("ok");
      },
    });
    const signal = new AbortController().signal;
    const provider = {
      adapter: "google",
      authMode: "oauth",
      googleMode: "cloud-code-assist",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      tlsProfile: "antigravity-browser" as const,
    };
    await providerTlsFetch(
      "google-antigravity",
      provider,
      fetch,
    )("https://cloudcode-pa.googleapis.com/v1", { signal });
    expect(seen?.redirect).toBe("manual");
    expect(seen?.signal).toBe(signal);
    expect((seen as any)?.browser).toBe("chrome_142");
    expect(getProviderTlsProfileStatus("google-antigravity")).toBe("active");
  });

  test("passes supported proxy semantics to the TLS transport", async () => {
    let seen: RequestInit | undefined;
    setProviderTlsRuntimeForTest({
      env: {},
      fetch: async (_input, init) => {
        seen = init;
        return new Response("ok");
      },
      resolveProxyRoute: () => ({
        kind: "proxy",
        proxy: "http://127.0.0.1:9191",
      }),
    });
    const provider = {
      adapter: "google",
      authMode: "oauth",
      googleMode: "cloud-code-assist",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      tlsProfile: "antigravity-browser" as const,
    };
    await providerTlsFetch(
      "google-antigravity",
      provider,
      fetch,
    )("https://cloudcode-pa.googleapis.com/v1");
    expect((seen as RequestInit & { proxy?: string }).proxy).toBe(
      "http://127.0.0.1:9191",
    );
    expect(getProviderTlsProfileStatus("google-antigravity")).toBe("active");
  });

  test("fails closed when configured proxy semantics cannot be preserved", async () => {
    let called = false;
    setProviderTlsRuntimeForTest({
      env: {},
      fetch: async () => {
        called = true;
        return new Response("unexpected");
      },
      resolveProxyRoute: () => ({ kind: "fallback" }),
    });
    const provider = {
      adapter: "google",
      authMode: "oauth",
      googleMode: "cloud-code-assist",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      tlsProfile: "antigravity-browser" as const,
    };
    const fetcher = providerTlsFetch("google-antigravity", provider, fetch);
    await expect(
      fetcher("https://cloudcode-pa.googleapis.com/v1"),
    ).rejects.toThrow("cannot preserve configured proxy semantics");
    expect(called).toBe(false);
    expect(getProviderTlsProfileStatus("google-antigravity")).toBe("failed");
  });

  test("redacts credential text from transport errors", async () => {
    setProviderTlsRuntimeForTest({
      env: {},
      fetch: async () => {
        throw new Error("Authorization: Bearer super-secret");
      },
    });
    const provider = {
      adapter: "google",
      authMode: "oauth",
      googleMode: "cloud-code-assist",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      tlsProfile: "antigravity-browser" as const,
    };
    await expect(
      providerTlsFetch(
        "google-antigravity",
        provider,
        fetch,
      )("https://cloudcode-pa.googleapis.com/v1"),
    ).rejects.toThrow("[REDACTED]");
    await expect(
      providerTlsFetch(
        "google-antigravity",
        provider,
        fetch,
      )("https://cloudcode-pa.googleapis.com/v1"),
    ).rejects.not.toThrow("super-secret");
  });
  test("preserves exact abort reason identity when transport rejects with active signal reason", async () => {
    const customReason = new Error("caller-owned cancel");
    const controller = new AbortController();
    controller.abort(customReason);

    setProviderTlsRuntimeForTest({
      env: {},
      fetch: async () => {
        throw customReason;
      },
    });

    const provider = {
      adapter: "google",
      authMode: "oauth",
      googleMode: "cloud-code-assist",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      tlsProfile: "antigravity-browser" as const,
    };

    const fetcher = providerTlsFetch("google-antigravity", provider, fetch);
    let caught: unknown;
    try {
      await fetcher("https://cloudcode-pa.googleapis.com/v1", {
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(customReason);
    expect(getProviderTlsProfileStatus("google-antigravity")).not.toBe("failed");
  });

  test("strips proxy userinfo from transport errors", async () => {
    setProviderTlsRuntimeForTest({
      env: {},
      fetch: async () => {
        throw new Error("proxy connect failed: http://alice:hunter2@127.0.0.1:8080");
      },
    });
    const provider = {
      adapter: "google",
      authMode: "oauth",
      googleMode: "cloud-code-assist",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      tlsProfile: "antigravity-browser" as const,
    };
    let caught: unknown;
    try {
      await providerTlsFetch("google-antigravity", provider, fetch)("https://cloudcode-pa.googleapis.com/v1");
    } catch (err) {
      caught = err;
    }
    expect(String((caught as Error).message)).not.toContain("hunter2");
    expect(String((caught as Error).message)).toContain("//<redacted>@127.0.0.1:8080");
  });

  const canonical = {
    adapter: "google",
    authMode: "oauth",
    googleMode: "cloud-code-assist",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    tlsProfile: "antigravity-browser" as const,
  };

  function captureRuntime(env: Record<string, string | undefined>) {
    const seen: { init?: RequestInit & { proxy?: unknown }; calls: number } = { calls: 0 };
    setProviderTlsRuntimeForTest({
      env,
      fetch: async (_input, init) => {
        seen.calls += 1;
        seen.init = init;
        return new Response("ok");
      },
    });
    return seen;
  }

  test("carries a per-provider proxy route decided at the physical send", async () => {
    const seen = captureRuntime({ HTTPS_PROXY: "http://global.invalid:1" });
    const fetcher = providerTlsFetch("google-antigravity", canonical, fetch);
    await fetcher("https://cloudcode-pa.googleapis.com/v1", { proxy: "socks5://127.0.0.1:1080" } as RequestInit);
    expect(seen.init?.proxy).toBe("socks5://127.0.0.1:1080");
  });

  test("honours a direct route only when no proxy environment exists", async () => {
    const clean = captureRuntime({});
    await providerTlsFetch("google-antigravity", canonical, fetch)(
      "https://cloudcode-pa.googleapis.com/v1", { proxy: false } as RequestInit);
    expect(clean.calls).toBe(1);
    expect(clean.init !== undefined && Object.hasOwn(clean.init, "proxy")).toBe(false);

    const proxied = captureRuntime({ HTTP_PROXY: "http://global.invalid:1" });
    await expect(providerTlsFetch("google-antigravity", canonical, fetch)(
      "https://cloudcode-pa.googleapis.com/v1", { proxy: false } as RequestInit))
      .rejects.toThrow("cannot force a direct connection");
    expect(proxied.calls).toBe(0);
    expect(getProviderTlsProfileStatus("google-antigravity", true)).toBe("failed");
  });

  test("refuses a NO_PROXY bypass the native transport would not honour", async () => {
    const seen = captureRuntime({ HTTPS_PROXY: "http://global.invalid:1", NO_PROXY: "cloudcode-pa.googleapis.com" });
    await expect(providerTlsFetch("google-antigravity", canonical, fetch)("https://cloudcode-pa.googleapis.com/v1"))
      .rejects.toThrow("cannot force a direct connection");
    expect(seen.calls).toBe(0);
  });

  test("refuses a decided proxy scheme the native transport cannot carry", async () => {
    const seen = captureRuntime({});
    await expect(providerTlsFetch("google-antigravity", canonical, fetch)(
      "https://cloudcode-pa.googleapis.com/v1", { proxy: "ftp://127.0.0.1:21" } as RequestInit))
      .rejects.toThrow("cannot preserve configured proxy semantics");
    expect(seen.calls).toBe(0);
  });

  test("carries an inherited SOCKS5 ALL_PROXY route like the ordinary outbound path", async () => {
    for (const socks of ["socks5://127.0.0.1:1080", "socks5h://127.0.0.1:1080"]) {
      const seen = captureRuntime({ ALL_PROXY: socks });
      await providerTlsFetch("google-antigravity", canonical, fetch)("https://cloudcode-pa.googleapis.com/v1");
      expect(seen.calls).toBe(1);
      expect(seen.init?.proxy).toBe(socks);
    }
  });

  test("still refuses an inherited route when an HTTPS proxy variable outranks the SOCKS fallback", async () => {
    const seen = captureRuntime({ HTTPS_PROXY: "ftp://global.invalid:21", ALL_PROXY: "socks5://127.0.0.1:1080" });
    await expect(providerTlsFetch("google-antigravity", canonical, fetch)("https://cloudcode-pa.googleapis.com/v1"))
      .rejects.toThrow("cannot preserve configured proxy semantics");
    expect(seen.calls).toBe(0);
  });

  test("the management write boundary refuses a row that keeps tlsProfile after leaving eligibility", () => {
    const keyAuth = providerManagementConfigError("google-antigravity", { ...canonical, authMode: "key" });
    expect(keyAuth).toContain("tlsProfile antigravity-browser requires");
    const moved = providerManagementConfigError("google-antigravity", { ...canonical, baseUrl: "https://example.com" });
    expect(moved).toContain("tlsProfile antigravity-browser requires");
    const renamed = providerManagementConfigError("antigravity-copy", canonical);
    expect(renamed).toContain("tlsProfile antigravity-browser requires");
    const eligible = providerManagementConfigError("google-antigravity", canonical);
    expect(eligible ?? "").not.toContain("tlsProfile");
  });

  test("is transparent to provider egress and reports pending before its first send", () => {
    const fetcher = providerTlsFetch("google-antigravity", canonical, fetch);
    expect(isEgressTransparentExecutor(fetcher)).toBe(true);
    expect(getProviderTlsProfileStatus("google-antigravity", true)).toBe("pending");
    expect(getProviderTlsProfileStatus("google-antigravity", false)).toBe("disabled");
    expect(providerTlsProfileDiagnostic("google-antigravity", canonical)).toEqual({
      tlsProfile: { profile: "antigravity-browser", status: "pending" },
    });
    expect(providerTlsProfileDiagnostic("gemini", {})).toEqual({});
  });

  test("providerFetch routes the profile through the per-provider egress decision", async () => {
    const seen = captureRuntime({});
    const provider = { ...canonical, proxy: "http://provider-proxy.invalid:3128" } as unknown as OcxProviderConfig;
    const response = await providerFetch(provider, undefined, { providerName: "google-antigravity" })(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
      { method: "POST", body: "{}" },
    );
    expect(await response.text()).toBe("ok");
    expect(seen.calls).toBe(1);
    expect(seen.init?.proxy).toBe("http://provider-proxy.invalid:3128/");
    expect(seen.init?.redirect).toBe("manual");
    expect(getProviderTlsProfileStatus("google-antigravity", true)).toBe("active");
  });

  test("providerFetch leaves providers without the profile on their own executor", async () => {
    const seen = captureRuntime({});
    let baseCalls = 0;
    const provider = {
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      fetch: async () => { baseCalls += 1; return new Response("base"); },
    } as unknown as OcxProviderConfig;
    await providerFetch(provider, undefined, { providerName: "gemini" })("https://generativelanguage.googleapis.com/v1beta/models");
    expect(baseCalls).toBe(1);
    expect(seen.calls).toBe(0);
    expect(getProviderTlsProfileStatus("gemini")).toBe("disabled");
  });
});
