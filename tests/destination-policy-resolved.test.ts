import { describe, expect, mock, test } from "bun:test";

// mock BEFORE importing the module under test: destination-policy binds `lookup` at load.
const lookupMock = mock(async (_hostname: string, _opts: unknown): Promise<{ address: string; family: number }[]> => []);
mock.module("node:dns/promises", () => ({ lookup: lookupMock }));

const { providerDestinationConfigError, providerDestinationResolvedError, resolvePublicAddresses } = await import("../src/lib/destination-policy");

const provider = (baseUrl: string, allowPrivateNetwork?: boolean) => ({ baseUrl, allowPrivateNetwork });

describe("providerDestinationConfigError — reserved IPv4 ranges (review finding, PR #96)", () => {
  const cases: [string, string][] = [
    ["192.0.0.8", "reserved"],
    ["192.0.2.10", "reserved"],
    ["198.18.0.1", "benchmark"],
    ["198.19.255.1", "benchmark"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.251", "multicast/reserved"],
    ["255.255.255.255", "multicast/reserved"],
  ];
  for (const [ip, label] of cases) {
    test(`rejects literal ${ip} (${label})`, () => {
      expect(providerDestinationConfigError("custom", provider(`http://${ip}/v1`))).toContain("allowPrivateNetwork");
    });
  }

  test("still passes ordinary public literals", () => {
    expect(providerDestinationConfigError("custom", provider("https://93.184.216.34/v1"))).toBeNull();
  });

  test("rejects IPv6 site-local and multicast literals", () => {
    expect(providerDestinationConfigError("custom", provider("http://[fec0::1]/v1"))).toContain("allowPrivateNetwork");
    expect(providerDestinationConfigError("custom", provider("http://[ff02::1]/v1"))).toContain("allowPrivateNetwork");
  });
});

describe("providerDestinationResolvedError — DNS-resolved SSRF check (activation)", () => {
  test("blocks a hostname resolving to loopback", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const error = await providerDestinationResolvedError("custom", provider("https://evil.example.com/v1"));
    expect(error).toContain("resolves to a loopback address (127.0.0.1)");
  });

  test("blocks a hostname resolving to RFC1918 space", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    const error = await providerDestinationResolvedError("custom", provider("https://rebind.example.com/v1"));
    expect(error).toContain("private-network address (10.0.0.5)");
  });

  test("blocks a hostname resolving to a metadata endpoint", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const error = await providerDestinationResolvedError("custom", provider("https://meta.example.com/v1"));
    expect(error).toContain("blocked metadata endpoint (169.254.169.254)");
  });

  test("blocks a hostname resolving to IPv6 unique-local space", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "fd00::1", family: 6 }]);
    const error = await providerDestinationResolvedError("custom", provider("https://v6.example.com/v1"));
    expect(error).toContain("private-network address (fd00::1)");
  });

  test("blocks a hostname resolving to IPv6 site-local space", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "fec0::1", family: 6 }]);
    const error = await providerDestinationResolvedError("custom", provider("https://v6-site.example.com/v1"));
    expect(error).toMatch(/site-local address \(fec0::1\)/);
  });

  test("blocks a hostname resolving to IPv6 multicast space", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "ff02::1", family: 6 }]);
    const error = await providerDestinationResolvedError("custom", provider("https://v6-mcast.example.com/v1"));
    expect(error).toMatch(/multicast address \(ff02::1\)/);
  });

  test("passes a hostname resolving only to public addresses", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    expect(await providerDestinationResolvedError("custom", provider("https://api.example.com/v1"))).toBeNull();
  });

  test("respects allowPrivateNetwork opt-in (no DNS enforcement)", async () => {
    lookupMock.mockClear();
    expect(await providerDestinationResolvedError("custom", provider("https://lan.example.com/v1", true))).toBeNull();
    expect(lookupMock).not.toHaveBeenCalled(); // opt-in short-circuits before DNS
  });

  test("treats DNS failure as advisory pass (offline startup must not break)", async () => {
    lookupMock.mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    expect(await providerDestinationResolvedError("custom", provider("https://gone.example.com/v1"))).toBeNull();
  });

  test("skips DNS for literal IPs (sync path owns them)", async () => {
    lookupMock.mockClear();
    expect(await providerDestinationResolvedError("custom", provider("https://93.184.216.34/v1"))).toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("providerDestinationResolvedError — canonical openai Clash fake-IP exception", () => {
  test("allows pure 198.18.0.0/15 benchmark answers when opted in", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "198.18.0.30", family: 4 },
      { address: "198.19.1.2", family: 4 },
    ]);
    expect(await providerDestinationResolvedError(
      "openai",
      provider("https://chatgpt.com/backend-api/codex"),
      { allowBenchmarkAddresses: true },
    )).toBeNull();
  });

  test("still rejects loopback, RFC1918, and metadata even with the opt-in", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    expect(await providerDestinationResolvedError(
      "openai",
      provider("https://chatgpt.com/backend-api/codex"),
      { allowBenchmarkAddresses: true },
    )).toContain("loopback address (127.0.0.1)");

    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    expect(await providerDestinationResolvedError(
      "openai",
      provider("https://chatgpt.com/backend-api/codex"),
      { allowBenchmarkAddresses: true },
    )).toContain("private-network address (10.0.0.5)");

    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    expect(await providerDestinationResolvedError(
      "openai",
      provider("https://chatgpt.com/backend-api/codex"),
      { allowBenchmarkAddresses: true },
    )).toContain("blocked metadata endpoint (169.254.169.254)");
  });

  test("rejects mixed benchmark plus private or metadata answers", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "198.18.0.30", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    expect(await providerDestinationResolvedError(
      "openai",
      provider("https://chatgpt.com/backend-api/codex"),
      { allowBenchmarkAddresses: true },
    )).toContain("private-network address (10.0.0.5)");

    lookupMock.mockResolvedValueOnce([
      { address: "198.18.0.30", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    expect(await providerDestinationResolvedError(
      "openai",
      provider("https://chatgpt.com/backend-api/codex"),
      { allowBenchmarkAddresses: true },
    )).toContain("blocked metadata endpoint (169.254.169.254)");
  });

  test("without the opt-in, benchmark answers are still rejected", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "198.18.0.30", family: 4 }]);
    expect(await providerDestinationResolvedError(
      "openai",
      provider("https://chatgpt.com/backend-api/codex"),
    )).toContain("benchmark address (198.18.0.30)");
  });
});

describe("resolvePublicAddresses — caller-specific diagnostics", () => {
  test("provider callers do not receive image-URL DNS errors", async () => {
    lookupMock.mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));

    await expect(resolvePublicAddresses(
      "https://unresolvable.example/v1/models",
      { context: "provider URL" },
    )).rejects.toThrow("provider URL hostname unresolvable.example could not be resolved");
  });

  test("DNS resolution failures have a distinct error type for proxy degradation", async () => {
    lookupMock.mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));

    let error: unknown;
    try {
      await resolvePublicAddresses("https://proxy-only.example/v1/models", { context: "provider URL" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("DestinationDnsResolutionError");
  });

  test("provider private-network opt-in returns classified private addresses", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "192.168.1.50", family: 4 }]);

    const resolved = await resolvePublicAddresses(
      "http://ollama.lan:11434/v1/models",
      { context: "provider URL", allowPrivateNetwork: true },
    );

    expect(resolved.privateNetwork).toBe(true);
    expect(resolved.addresses).toEqual([{ address: "192.168.1.50", family: 4 }]);
  });

  test("hostname Clash fake-IP answers are accepted only under the explicit benchmark opt-in (#1748)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "198.18.56.214", family: 4 }]);

    const resolved = await resolvePublicAddresses(
      "https://www.packyapi.com/v1/models",
      { context: "provider URL", allowBenchmarkAddresses: true },
    );

    expect(resolved.privateNetwork).toBe(false);
    expect(resolved.addresses).toEqual([{ address: "198.18.56.214", family: 4 }]);
  });

  test("hostname Clash fake-IP answers still reject without the benchmark opt-in", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "198.18.56.214", family: 4 }]);

    await expect(resolvePublicAddresses(
      "https://www.packyapi.com/v1/models",
      { context: "provider URL" },
    )).rejects.toThrow("benchmark address (198.18.56.214)");
  });

  test("benchmark opt-in mixed with RFC1918 still requires the private-network opt-in", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "198.18.56.214", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    await expect(resolvePublicAddresses(
      "https://rebind.example.com/v1/models",
      { context: "provider URL", allowBenchmarkAddresses: true },
    )).rejects.toThrow("private-network address (10.0.0.5)");
  });

  test("benchmark opt-in does not admit a literal 198.18.x URL", async () => {
    await expect(resolvePublicAddresses(
      "https://198.18.56.214/v1/models",
      { context: "provider URL", allowBenchmarkAddresses: true },
    )).rejects.toThrow("benchmark address");
  });

  test("image/Lab fetch (no opt-in) still rejects hostnames resolving to 198.18.x (#1748 SSRF guard)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "198.18.4.2", family: 4 }]);
    await expect(resolvePublicAddresses("https://fakeip.example.com/img.png"))
      .rejects.toThrow("image URL hostname fakeip.example.com resolves to benchmark address (198.18.4.2)");

    lookupMock.mockResolvedValueOnce([{ address: "198.19.7.9", family: 4 }]);
    await expect(resolvePublicAddresses(
      "https://fakeip.example.com/v1/models",
      { context: "Lab provider destination", allowPrivateNetwork: false },
    )).rejects.toThrow("benchmark address (198.19.7.9)");
  });
});
