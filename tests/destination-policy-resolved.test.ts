import { describe, expect, mock, test } from "bun:test";

// mock BEFORE importing the module under test: destination-policy binds `lookup` at load.
const lookupMock = mock(async (_hostname: string, _opts: unknown): Promise<{ address: string; family: number }[]> => []);
mock.module("node:dns/promises", () => ({ lookup: lookupMock }));

const { providerDestinationConfigError, providerDestinationResolvedError } = await import("../src/lib/destination-policy");

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
