import { afterAll, describe, expect, mock, test } from "bun:test";

// The default downloader inside connectPublicHttps is the production path for
// provider-returned image/video URLs (downloadImageToArtifact and
// downloadVideoToArtifact both go through it), while pinnedHttpsGet has no
// production callers. A connect deadline wired only into pinnedHttpsGet would
// therefore never arm in production — this suite pins the default path.

// `mock.module` outlives this file: Bun keeps both overrides below for every file that
// runs after this one in the same process, including download-cap-default's own capture of
// the "real" modules and tests/lib's pinned-http suites (#5439). Keep the real modules,
// captured before anything here is mocked, and put them back.
const realDns = { ...(await import("node:dns/promises")) };
const realPinnedHttp = { ...(await import("../../src/lib/pinned-http")) };
afterAll(() => {
  mock.module("node:dns/promises", () => realDns);
  mock.module("../../src/lib/pinned-http", () => realPinnedHttp);
});

const lookupMock = mock(async (): Promise<{ address: string; family: number }[]> => [
  { address: "93.184.216.34", family: 4 },
]);
mock.module("node:dns/promises", () => ({ lookup: lookupMock }));

const MIN_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const seenConnectTimeoutMs: Array<number | undefined> = [];

mock.module("../../src/lib/pinned-http", () => ({
  pinnedHttpGet: async (
    _url: string,
    _pinned: unknown,
    _signal?: AbortSignal,
    options?: { connectTimeoutMs?: number },
  ) => {
    seenConnectTimeoutMs.push(options?.connectTimeoutMs);
    return new Response(MIN_PNG, { status: 200 });
  },
  PinnedHttpError: class extends Error {},
}));

const { fetchPublicHttpsImage, DOWNLOAD_CONNECT_TIMEOUT_MS } = await import(
  `../../src/images/artifacts?connect-deadline=${Date.now()}`
);

describe("default image downloader connect deadline", () => {
  test("the production path schedules the 10s connect deadline", async () => {
    expect(DOWNLOAD_CONNECT_TIMEOUT_MS).toBe(10_000);
    seenConnectTimeoutMs.length = 0;
    const resp = await fetchPublicHttpsImage("https://public-host/image.png");
    expect(resp.status).toBe(200);
    expect(seenConnectTimeoutMs).toEqual([DOWNLOAD_CONNECT_TIMEOUT_MS]);
  });
});
