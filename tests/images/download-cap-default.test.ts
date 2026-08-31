import { describe, expect, mock, test } from "bun:test";

// The default downloader inside connectPublicHttps used to forward `maxBytes: undefined`
// to pinnedHttpGet, whose cap is optional — so a caller that omitted a limit removed the
// byte ceiling entirely instead of inheriting MAX_DOWNLOAD_BYTES. Both production callers
// happen to pass an explicit limit today, which is why the existing suites (they all
// inject `pinnedDownload` and bypass the default path) could not see it.

const lookupMock = mock(async (): Promise<{ address: string; family: number }[]> => [
  { address: "93.184.216.34", family: 4 },
]);
mock.module("node:dns/promises", () => ({ lookup: lookupMock }));

const MIN_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const seenMaxBytes: Array<number | undefined> = [];

mock.module("../../src/lib/pinned-http", () => ({
  pinnedHttpGet: async (
    _url: string,
    _pinned: unknown,
    _signal?: AbortSignal,
    options?: { maxBytes?: number },
  ) => {
    seenMaxBytes.push(options?.maxBytes);
    return new Response(MIN_PNG, { status: 200 });
  },
  PinnedHttpError: class extends Error {},
}));

const { fetchPublicHttpsImage, MAX_DOWNLOAD_BYTES } = await import(
  `../../src/images/artifacts?cap=${Date.now()}`
);

describe("default image downloader byte cap", () => {
  test("an omitted maxBytes inherits MAX_DOWNLOAD_BYTES instead of removing the cap", async () => {
    seenMaxBytes.length = 0;
    const resp = await fetchPublicHttpsImage("https://public-host/image.png");
    expect(resp.status).toBe(200);
    expect(seenMaxBytes).toEqual([MAX_DOWNLOAD_BYTES]);
    expect(seenMaxBytes[0]).not.toBeUndefined();
  });

  test("an explicit tighter limit is preserved", async () => {
    seenMaxBytes.length = 0;
    await fetchPublicHttpsImage("https://public-host/image.png", { maxBytes: 1024 });
    expect(seenMaxBytes).toEqual([1024]);
  });
});
