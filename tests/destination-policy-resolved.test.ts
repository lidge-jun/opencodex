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

describe("providerDestinationConfigError — NAT64 well-known prefix (RFC 6052)", () => {
  // On an IPv6-only/DNS64 network every IPv4-only peer is synthesized into 64:ff9b::<ipv4>.
  // 0x64 sits below the 2000::/3 global-unicast window, so the wrapper alone read as
  // "non-global address" and rejected ordinary public destinations for anyone behind NAT64.
  test("a wrapped public IPv4 is accepted", () => {
    for (const host of ["64:ff9b::d25:c62c", "64:ff9b::0fe0:7748", "64:ff9b::13.37.198.44"]) {
      expect(providerDestinationConfigError("p", provider(`https://[${host}]/v1`))).toBeNull();
    }
  });

  // The embedded address is what gets classified, so the decode cannot become an SSRF bypass.
  test("a wrapped private, loopback, or link-local IPv4 stays blocked", () => {
    const cases: [string, string][] = [
      ["64:ff9b::7f00:1", "loopback"],
      ["64:ff9b::a00:1", "private-network"],
      ["64:ff9b::c0a8:1", "private-network"],
      ["64:ff9b::ac10:1", "private-network"],
      // 169.254.169.254 is the cloud metadata IP, so the wrapped form lands on the stronger
      // metadata blocklist rather than the generic link-local rule.
      ["64:ff9b::a9fe:a9fe", "blocked metadata endpoint"],
      ["64:ff9b::127.0.0.1", "loopback"],
    ];
    for (const [host, detail] of cases) {
      expect(providerDestinationConfigError("p", provider(`https://[${host}]/v1`))).toContain(detail);
    }
  });

  // RFC 8215 reserves 64:ff9b:1::/48 for local-use translation, which is not the well-known
  // prefix and keeps its non-global treatment.
  test("the RFC 8215 local-use prefix is not decoded", () => {
    expect(providerDestinationConfigError("p", provider("https://[64:ff9b:1::d25:c62c]/v1")))
      .toContain("non-global");
  });

  test("unrelated IPv6 classification is unchanged", () => {
    expect(providerDestinationConfigError("p", provider("https://[2606:4700::6812:1250]/v1"))).toBeNull();
    expect(providerDestinationConfigError("p", provider("https://[::1]/v1"))).toContain("loopback");
    expect(providerDestinationConfigError("p", provider("https://[fd00::1]/v1"))).toContain("private-network");
    expect(providerDestinationConfigError("p", provider("https://[fe80::1]/v1"))).toContain("link-local");
    expect(providerDestinationConfigError("p", provider("https://[2001:db8::1]/v1"))).toContain("documentation");
  });
});

/**
 * Issue #2810: a fake-IP resolver answers `::ffff:0:c612:1b` — the explicit-zero spelling of
 * `198.18.0.27`. That assesses as `non-global address`, never `benchmark address`, so the
 * `allowBenchmarkAddresses` opt-in could not reach it and Clash/Surge users behind fake-IP were
 * refused.
 *
 * The fix is deliberately NOT an equivalence in `classifyIpv6`. Under RFC 4291 the mapped prefix
 * is `::ffff:0:0/96`, so `::ffff:0:<hi>:<lo>` is a RESERVED address whose tail merely looks like
 * an IPv4. Declaring them equal would admit `::ffff:0:5db8:d822` (tail `93.184.216.34`) as a
 * public destination — the blocker a maintainer raised on #2812. Both directions are pinned here.
 */
describe("#2810 explicit-zero mapped benchmark answers under the fake-IP opt-in", () => {
  const OPT_IN = { context: "p", allowBenchmarkAddresses: true } as const;

  test("the reported answer is accepted and stays non-private", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "::ffff:0:c612:1b", family: 6 }]);
    const resolved = await resolvePublicAddresses("https://api.example.com/v1", OPT_IN);
    expect(resolved.addresses).toEqual([{ address: "::ffff:0:c612:1b", family: 6 }]);
    expect(resolved.privateNetwork).toBe(false);
  });

  test("both benchmark range boundaries are accepted", async () => {
    // 198.18.0.0 and 198.19.255.255
    for (const address of ["::ffff:0:c612:0", "::ffff:0:c613:ffff"]) {
      lookupMock.mockResolvedValueOnce([{ address, family: 6 }]);
      const resolved = await resolvePublicAddresses("https://api.example.com/v1", OPT_IN);
      expect(resolved.addresses).toEqual([{ address, family: 6 }]);
    }
  });

  test("THE BLOCKER: a public-looking tail is still refused", async () => {
    // ::ffff:0:5db8:d822 has the tail 93.184.216.34. If the classifier treated the explicit-zero
    // form as a mapped IPv4, this reserved address would be admitted as a public destination.
    lookupMock.mockResolvedValueOnce([{ address: "::ffff:0:5db8:d822", family: 6 }]);
    await expect(resolvePublicAddresses("https://api.example.com/v1", OPT_IN)).rejects.toThrow("non-global");
  });

  test("loopback-, metadata-, and out-of-range tails are refused", async () => {
    const refused = [
      "::ffff:0:7f00:1",      // 127.0.0.1
      "::ffff:0:a9fe:a9fe",   // 169.254.169.254
      "::ffff:0:c611:ffff",   // 198.17.255.255, just below the range
      "::ffff:0:c614:0",      // 198.20.0.0, just above the range
      "::ffff:0:a00:5",       // 10.0.0.5
    ];
    for (const address of refused) {
      lookupMock.mockResolvedValueOnce([{ address, family: 6 }]);
      await expect(resolvePublicAddresses("https://api.example.com/v1", OPT_IN)).rejects.toThrow("non-global");
    }
  });

  test("without the opt-in the reported answer is refused", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "::ffff:0:c612:1b", family: 6 }]);
    await expect(resolvePublicAddresses("https://api.example.com/v1", "p")).rejects.toThrow("non-global");
  });

  test("a literal URL is still refused, opt-in or not", () => {
    // The opt-in is a DNS-answer exception. A user-configured literal never reaches it.
    expect(providerDestinationConfigError("p", provider("https://[::ffff:0:c612:1b]/v1")))
      .toContain("non-global");
    expect(providerDestinationConfigError("p", provider("https://[::ffff:0:5db8:d822]/v1")))
      .toContain("non-global");
  });

  test("a prefix that is one hextet off is not decoded", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "::ffff:1:c612:1b", family: 6 }]);
    await expect(resolvePublicAddresses("https://api.example.com/v1", OPT_IN)).rejects.toThrow("non-global");
  });

  test("one accepted answer cannot smuggle a private companion answer", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "::ffff:0:c612:1b", family: 6 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(resolvePublicAddresses("https://api.example.com/v1", OPT_IN)).rejects.toThrow();
  });

  test("the canonical spelling and ordinary IPv4 benchmark answers still work", async () => {
    for (const address of ["::ffff:198.18.0.27", "198.18.0.27"]) {
      lookupMock.mockResolvedValueOnce([{ address, family: address.includes(":") ? 6 : 4 }]);
      const resolved = await resolvePublicAddresses("https://api.example.com/v1", OPT_IN);
      expect(resolved.privateNetwork).toBe(false);
    }
  });
});
