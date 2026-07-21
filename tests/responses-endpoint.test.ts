import { describe, expect, test } from "bun:test";
import { responsesEndpoint, imagesEndpoint, stripVersionSegment, compactEndpoint } from "../src/adapters/openai-responses";

describe("stripVersionSegment", () => {
  test("strips trailing /v1", () => {
    expect(stripVersionSegment("https://api.openai.com/v1")).toEqual({
      base: "https://api.openai.com",
      version: "v1",
    });
  });

  test("strips trailing /v1/ (trailing slash)", () => {
    expect(stripVersionSegment("https://api.openai.com/v1/")).toEqual({
      base: "https://api.openai.com",
      version: "v1",
    });
  });

  test("strips trailing /v3", () => {
    expect(stripVersionSegment("https://ark.cn-beijing.volces.com/api/plan/v3")).toEqual({
      base: "https://ark.cn-beijing.volces.com/api/plan",
      version: "v3",
    });
  });

  test("returns null version for bare URL without trailing slash", () => {
    expect(stripVersionSegment("https://some.proxy.example")).toEqual({
      base: "https://some.proxy.example",
      version: null,
    });
  });

  test("returns null version for bare URL with trailing slash", () => {
    expect(stripVersionSegment("https://some.proxy.example/")).toEqual({
      base: "https://some.proxy.example",
      version: null,
    });
  });

  test("does not match path segments that merely contain v", () => {
    expect(stripVersionSegment("https://example.com/verify")).toEqual({
      base: "https://example.com/verify",
      version: null,
    });
  });
});

describe("responsesEndpoint", () => {
  test("OpenAI /v1 -> /v1/responses (unchanged)", () => {
    expect(responsesEndpoint("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/responses",
    );
  });

  test("OpenAI /v1/ -> /v1/responses (trailing slash, unchanged)", () => {
    expect(responsesEndpoint("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/responses",
    );
  });

  test("Ark /api/plan/v3 -> /api/plan/v3/responses (fix)", () => {
    expect(responsesEndpoint("https://ark.cn-beijing.volces.com/api/plan/v3")).toBe(
      "https://ark.cn-beijing.volces.com/api/plan/v3/responses",
    );
  });

  test("Ark /api/v3 -> /api/v3/responses (fix)", () => {
    expect(responsesEndpoint("https://ark.cn-beijing.volces.com/api/v3")).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/responses",
    );
  });

  test("bare proxy -> /v1/responses (legacy fallback)", () => {
    expect(responsesEndpoint("https://some.proxy.example")).toBe(
      "https://some.proxy.example/v1/responses",
    );
  });

  test("bare proxy with trailing slash -> /v1/responses (legacy fallback)", () => {
    expect(responsesEndpoint("https://some.proxy.example/")).toBe(
      "https://some.proxy.example/v1/responses",
    );
  });

  test("double-digit version /v12 -> /v12/responses", () => {
    expect(responsesEndpoint("https://example.com/v12")).toBe(
      "https://example.com/v12/responses",
    );
  });
});

describe("imagesEndpoint", () => {
  test("OpenAI /v1 -> /v1/images/generations (unchanged)", () => {
    expect(imagesEndpoint("https://api.openai.com/v1", "generations")).toBe(
      "https://api.openai.com/v1/images/generations",
    );
  });

  test("OpenAI /v1 -> /v1/images/edits (unchanged)", () => {
    expect(imagesEndpoint("https://api.openai.com/v1", "edits")).toBe(
      "https://api.openai.com/v1/images/edits",
    );
  });

  test("Ark /api/plan/v3 -> /api/plan/v3/images/generations (fix)", () => {
    expect(imagesEndpoint("https://ark.cn-beijing.volces.com/api/plan/v3", "generations")).toBe(
      "https://ark.cn-beijing.volces.com/api/plan/v3/images/generations",
    );
  });

  test("bare proxy -> /v1/images/generations (legacy fallback)", () => {
    expect(imagesEndpoint("https://some.proxy.example", "generations")).toBe(
      "https://some.proxy.example/v1/images/generations",
    );
  });

  test("bare proxy trailing slash -> /v1/images/edits (legacy fallback)", () => {
    expect(imagesEndpoint("https://some.proxy.example/", "edits")).toBe(
      "https://some.proxy.example/v1/images/edits",
    );
  });
});

describe("compactEndpoint", () => {
  test("OpenAI /v1 -> /v1/responses/compact (unchanged)", () => {
    expect(compactEndpoint("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/responses/compact",
    );
  });

  test("Ark /api/plan/v3 -> /api/plan/v3/responses/compact (fix)", () => {
    expect(compactEndpoint("https://ark.cn-beijing.volces.com/api/plan/v3")).toBe(
      "https://ark.cn-beijing.volces.com/api/plan/v3/responses/compact",
    );
  });

  test("bare proxy -> /v1/responses/compact (legacy fallback)", () => {
    expect(compactEndpoint("https://some.proxy.example")).toBe(
      "https://some.proxy.example/v1/responses/compact",
    );
  });
});
