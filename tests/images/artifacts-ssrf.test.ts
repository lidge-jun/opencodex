import { rm } from "node:fs/promises";
import { describe, expect, mock, test } from "bun:test";

// Mock DNS before importing destination-policy — it binds `lookup` at load time.
const lookupMock = mock(async (_hostname: string, _opts: unknown): Promise<{ address: string; family: number }[]> => []);
mock.module("node:dns/promises", () => ({ lookup: lookupMock }));

const { assessUrlDestination, assertUrlResolvesPublic } = await import("../../src/lib/destination-policy");
const { downloadImageToArtifact } = await import("../../src/images/artifacts");

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

  test("IPv4-mapped IPv6 [::ffff:127.0.0.1] via download helper → rejects", async () => {
    await expect(downloadImageToArtifact("https://[::ffff:127.0.0.1]/image.png")).rejects.toThrow();
  });

  test("IPv4-mapped IPv6 hex [::ffff:7f00:1] via download helper → rejects", async () => {
    await expect(downloadImageToArtifact("https://[::ffff:7f00:1]/image.png")).rejects.toThrow();
  });

  test(`3xx redirect response → rejects (redirect: 'error')`, async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response("", { status: 301, headers: { Location: "https://evil.example/redirect" } });
      }) as typeof fetch;
      await expect(downloadImageToArtifact("https://public-host/redirect-img")).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      lookupMock.mockClear();
    }
  });

  test("https:// public host → succeeds with mocked fetch", async () => {
    // Stub DNS so public-host resolves to a public address.
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const originalFetch = globalThis.fetch;
    let downloadedPath: string | undefined;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!raw.startsWith("https://")) throw new Error("fetch must only be called over HTTPS");
        // Minimal PNG signature so guessExtFromMagic returns "png".
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        return new Response(pngBytes, { status: 200 });
      }) as typeof fetch;

      downloadedPath = await downloadImageToArtifact("https://public-host/valid-image");
      expect(downloadedPath).toMatch(/dl-.*\.png$/);
    } finally {
      globalThis.fetch = originalFetch;
      lookupMock.mockClear();
      if (downloadedPath) await rm(downloadedPath).catch(() => {});
    }
  });
});
