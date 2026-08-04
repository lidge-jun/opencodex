import { rm } from "node:fs/promises";
import { describe, expect, mock, test } from "bun:test";

// Mock DNS before importing destination-policy — it binds `lookup` at load time.
const lookupMock = mock(async (_hostname: string, _opts: unknown): Promise<{ address: string; family: number }[]> => []);
mock.module("node:dns/promises", () => ({ lookup: lookupMock }));

const { assessUrlDestination, assertUrlResolvesPublic, resolvePublicAddresses } = await import("../../src/lib/destination-policy");
const { downloadImageToArtifact } = await import("../../src/images/artifacts");

const MIN_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("SSRF: assessUrlDestination", () => {
  test("loopback IPv4 → loopback", () => {
    expect(assessUrlDestination("http://127.0.0.1/test")?.kind).toBe("loopback");
  });
  test("link-local → link-local", () => {
    expect(assessUrlDestination("http://169.254.1.1/latest")?.kind).toBe("link-local");
  });
  test("private 10.x → private", () => {
    expect(assessUrlDestination("http://10.0.0.1/test")?.kind).toBe("private");
  });
  test("private 192.168 → private", () => {
    expect(assessUrlDestination("http://192.168.1.1/test")?.kind).toBe("private");
  });
  test("private 172.16 → private", () => {
    expect(assessUrlDestination("http://172.16.0.1/test")?.kind).toBe("private");
  });
  test("metadata endpoint → metadata", () => {
    expect(assessUrlDestination("http://169.254.170.2/test")?.kind).toBe("metadata");
  });
  test("localhost → localhost", () => {
    expect(assessUrlDestination("http://localhost/test")?.kind).toBe("localhost");
  });
  test("shorthand / decimal IPv4 literals normalize via URL and stay non-public", () => {
    // WHATWG URL expands these before our classifier runs (e.g. 127.1 → 127.0.0.1).
    expect(assessUrlDestination("https://127.1/image.png")?.kind).toBe("loopback");
    expect(assessUrlDestination("https://127.0.1/image.png")?.kind).toBe("loopback");
    expect(assessUrlDestination("https://0x7f.0.0.1/image.png")?.kind).toBe("loopback");
    expect(assessUrlDestination("https://2130706433/image.png")?.kind).toBe("loopback");
    expect(assessUrlDestination("https://10.1/image.png")?.kind).toBe("private");
  });
  test("IPv6 site-local [fec0::1] → private", () => {
    expect(assessUrlDestination("https://[fec0::1]/image.png")?.kind).toBe("private");
    expect(assessUrlDestination("https://[fec0::1]/image.png")?.detail).toContain("site-local");
  });
  test("IPv6 multicast [ff02::1] → private", () => {
    expect(assessUrlDestination("https://[ff02::1]/image.png")?.kind).toBe("private");
    expect(assessUrlDestination("https://[ff02::1]/image.png")?.detail).toContain("multicast");
  });
  test("IPv6 documentation [2001:db8::1] → private", () => {
    expect(assessUrlDestination("https://[2001:db8::1]/image.png")?.kind).toBe("private");
    expect(assessUrlDestination("https://[2001:db8::1]/image.png")?.detail).toContain("documentation");
  });
  test("IPv6 global unicast [2001:4860:4860::8888] → public", () => {
    expect(assessUrlDestination("https://[2001:4860:4860::8888]/image.png")?.kind).toBe("public");
  });
  test("public HTTPS → hostname or public", () => {
    const kind = assessUrlDestination("https://example.com/image.png")?.kind;
    expect(kind === "hostname" || kind === "public").toBe(true);
  });
  test("public IP → public", () => {
    expect(assessUrlDestination("https://8.8.8.8/image.png")?.kind).toBe("public");
  });
  test("IPv4-mapped IPv6 dotted-decimal [::ffff:127.0.0.1] → loopback", () => {
    expect(assessUrlDestination("https://[::ffff:127.0.0.1]/image.png")?.kind).toBe("loopback");
  });
  test("IPv4-mapped IPv6 hex [::ffff:7f00:1] → loopback", () => {
    expect(assessUrlDestination("https://[::ffff:7f00:1]/image.png")?.kind).toBe("loopback");
  });
  test("IPv4-mapped IPv6 hex private [::ffff:0a00:1] (10.0.0.1) → private", () => {
    expect(assessUrlDestination("https://[::ffff:0a00:1]/image.png")?.kind).toBe("private");
  });
  test("invalid URL → null", () => {
    expect(assessUrlDestination("not a url")).toBeNull();
  });
});

describe("SSRF: assertUrlResolvesPublic", () => {
  test("loopback IP → throws", async () => {
    await expect(assertUrlResolvesPublic("http://127.0.0.1/x")).rejects.toThrow();
  });
  test("metadata endpoint → throws", async () => {
    await expect(assertUrlResolvesPublic("http://169.254.169.254/x")).rejects.toThrow();
  });
  test("private 10.x → throws", async () => {
    await expect(assertUrlResolvesPublic("http://10.0.0.1/x")).rejects.toThrow();
  });
  test("invalid URL → throws", async () => {
    await expect(assertUrlResolvesPublic("not-a-url")).rejects.toThrow();
  });
});

describe("SSRF: resolvePublicAddresses", () => {
  test("hostname with public A record → returns that address", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    try {
      const resolved = await resolvePublicAddresses("https://public-host/img.png");
      expect(resolved.hostname).toBe("public-host");
      expect(resolved.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    } finally {
      lookupMock.mockClear();
    }
  });

  test("hostname that also resolves private → throws (fail closed on any unsafe answer)", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    try {
      await expect(resolvePublicAddresses("https://mixed-host/img.png")).rejects.toThrow(/loopback|127\.0\.0\.1/);
    } finally {
      lookupMock.mockClear();
    }
  });

  test("hostname resolving to IPv6 site-local → throws", async () => {
    lookupMock.mockResolvedValue([{ address: "fec0::1", family: 6 }]);
    try {
      await expect(resolvePublicAddresses("https://v6-site.example/img.png")).rejects.toThrow(/site-local|fec0/);
    } finally {
      lookupMock.mockClear();
    }
  });

  test("hostname resolving to IPv6 multicast → throws", async () => {
    lookupMock.mockResolvedValue([{ address: "ff02::1", family: 6 }]);
    try {
      await expect(resolvePublicAddresses("https://v6-mcast.example/img.png")).rejects.toThrow(/multicast|ff02/);
    } finally {
      lookupMock.mockClear();
    }
  });
});

describe("SSRF: downloadImageToArtifact scheme enforcement", () => {
  test("http:// → rejects (non-HTTPS)", async () => {
    await expect(downloadImageToArtifact("http://public-host/path")).rejects.toThrow(/HTTPS/);
  });

  test("ftp:// → rejects", async () => {
    await expect(downloadImageToArtifact("ftp://host/path")).rejects.toThrow(/HTTPS/);
  });

  test("gopher:// → rejects (non-HTTPS)", async () => {
    await expect(downloadImageToArtifact("gopher://host/path")).rejects.toThrow(/HTTPS/);
  });

  test("private 10.x via download helper → rejects", async () => {
    await expect(downloadImageToArtifact("https://10.0.0.1/img.png")).rejects.toThrow();
  });

  test("shorthand IPv4 (127.1 / decimal) via download helper → rejects", async () => {
    await expect(downloadImageToArtifact("https://127.1/img.png")).rejects.toThrow(/loopback/);
    await expect(downloadImageToArtifact("https://2130706433/img.png")).rejects.toThrow(/loopback/);
  });

  test("IPv4-mapped IPv6 [::ffff:127.0.0.1] via download helper → rejects", async () => {
    await expect(downloadImageToArtifact("https://[::ffff:127.0.0.1]/image.png")).rejects.toThrow();
  });

  test("IPv4-mapped IPv6 hex [::ffff:7f00:1] via download helper → rejects", async () => {
    await expect(downloadImageToArtifact("https://[::ffff:7f00:1]/image.png")).rejects.toThrow();
  });

  test(`3xx redirect response → rejects without following`, async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    try {
      await expect(downloadImageToArtifact("https://public-host/redirect-img", undefined, undefined, {
        pinnedDownload: async () => new Response("", {
          status: 301,
          headers: { Location: "https://evil.example/redirect" },
        }),
      })).rejects.toThrow(/301|failed/);
    } finally {
      lookupMock.mockClear();
    }
  });

  test("https:// public host → succeeds with pinned download", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    let downloadedPath: string | undefined;
    let seenPinned: { address: string; family: number } | undefined;
    try {
      downloadedPath = await downloadImageToArtifact("https://public-host/valid-image", undefined, undefined, {
        pinnedDownload: async (_url, pinned) => {
          seenPinned = pinned;
          return new Response(MIN_PNG, { status: 200 });
        },
      });
      expect(downloadedPath).toMatch(/dl-.*\.png$/);
      expect(seenPinned).toEqual({ address: "93.184.216.34", family: 4 });
    } finally {
      lookupMock.mockClear();
      if (downloadedPath) await rm(downloadedPath).catch(() => {});
    }
  });

  test("empty 200 body → rejects", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    try {
      await expect(downloadImageToArtifact("https://public-host/empty", undefined, undefined, {
        pinnedDownload: async () => new Response(new Uint8Array(0), { status: 200 }),
      })).rejects.toThrow(/empty/);
    } finally {
      lookupMock.mockClear();
    }
  });

  test("non-image 200 body (HTML/JSON) → rejects", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    try {
      await expect(downloadImageToArtifact("https://public-host/not-image", undefined, undefined, {
        pinnedDownload: async () => new Response("<html>error</html>", { status: 200 }),
      })).rejects.toThrow(/recognized image/);
    } finally {
      lookupMock.mockClear();
    }
  });

  test("DNS rebinding: connection uses the validated public address, not a later private resolve", async () => {
    // Validation lookup returns public; any subsequent OS resolve would return loopback.
    // The download must pin the first answer and must not call dns.lookup again.
    // (Transport lookup-shape + byte-cap coverage lives in pinned-https-get.test.ts.)
    let lookups = 0;
    lookupMock.mockImplementation(async () => {
      lookups += 1;
      if (lookups === 1) return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "127.0.0.1", family: 4 }];
    });

    let downloadedPath: string | undefined;
    let seenPinned: { address: string; family: number } | undefined;
    try {
      downloadedPath = await downloadImageToArtifact("https://rebind.example/img.png", undefined, undefined, {
        pinnedDownload: async (_url, pinned) => {
          // Still only one DNS resolve at connect time — pin came from validation.
          expect(lookups).toBe(1);
          seenPinned = pinned;
          expect(pinned.address).toBe("93.184.216.34");
          expect(pinned.address).not.toBe("127.0.0.1");
          return new Response(MIN_PNG, { status: 200 });
        },
      });
      expect(downloadedPath).toMatch(/dl-.*\.png$/);
      expect(seenPinned?.address).toBe("93.184.216.34");
      expect(lookups).toBe(1);
    } finally {
      lookupMock.mockClear();
      if (downloadedPath) await rm(downloadedPath).catch(() => {});
    }
  });
});
