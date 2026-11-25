import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { rememberArtifactSourceUrl, resolveVideoImageInput } from "../../src/images/video-image-input";

const path = "/tmp/ocx-video-test/image-123.png";
const url = "https://cdn.x.ai/image.png";

test("accepts safe remote and inline images, never arbitrary paths", () => {
  expect(resolveVideoImageInput(url)).toBe(url);
  expect(resolveVideoImageInput("data:image/png;base64,YQ==")).toBe("data:image/png;base64,YQ==");
  for (const value of ["http://example.com/a", "relative.png", "/tmp/other/image-123.png", "/v1/opencodex/artifacts/unknown.png", "data:image/png;base64," + "A".repeat(14_000_016)]) {
    expect(() => resolveVideoImageInput(value)).toThrow();
  }
});

test("only remembered exact paths and artifact IDs resolve, with expiry and a bound", () => {
  rememberArtifactSourceUrl(path, url, 1000);
  expect(resolveVideoImageInput(path, 1001)).toBe(url);
  expect(resolveVideoImageInput(pathToFileURL(path).href, 1001)).toBe(url);
  expect(resolveVideoImageInput("/v1/opencodex/artifacts/image-123.png", 1001)).toBe(url);
  expect(() => resolveVideoImageInput("/tmp/else/image-123.png", 1001)).toThrow();
  expect(() => resolveVideoImageInput(path, 3_601_001)).toThrow();
  for (let i = 0; i < 257; i++) rememberArtifactSourceUrl(`/tmp/ocx-video-test/bounded-${i}.png`, url, 5000);
  expect(() => resolveVideoImageInput("/tmp/ocx-video-test/bounded-0.png", 5001)).toThrow();
  expect(resolveVideoImageInput("/tmp/ocx-video-test/bounded-256.png", 5001)).toBe(url);
});

test("artifact references are refused for custom video providers", () => {
  rememberArtifactSourceUrl(path, url, 8000);
  expect(() => resolveVideoImageInput(path, 8001, false)).toThrow();
  expect(() => resolveVideoImageInput("/v1/opencodex/artifacts/image-123.png", 8001, false)).toThrow();
  expect(resolveVideoImageInput("https://example.com/own.png", 8001, false)).toBe("https://example.com/own.png");
});
