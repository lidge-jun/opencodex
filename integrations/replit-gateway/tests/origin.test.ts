import { describe, expect, test } from "bun:test";
import {
  canonicalizePublicOrigin,
  isAllowedPublicOrigin,
  validateUpstreamBaseUrl,
} from "../src/origin";

describe("origin validation", () => {
  test("accepts https deployment origins", () => {
    expect(isAllowedPublicOrigin("https://my-app.replit.app")).toBe(true);
    expect(isAllowedPublicOrigin("https://custom.example.com")).toBe(true);
  });

  test("rejects non-https origins", () => {
    expect(isAllowedPublicOrigin("http://my-app.replit.app")).toBe(false);
    expect(isAllowedPublicOrigin("ftp://my-app.replit.app")).toBe(false);
  });

  test("rejects origins with credentials or fragments", () => {
    expect(isAllowedPublicOrigin("https://user:pass@my-app.replit.app")).toBe(false);
    expect(isAllowedPublicOrigin("https://my-app.replit.app#frag")).toBe(false);
  });

  test("rejects upstream base URLs with queries, fragments, or extra slashes", () => {
    expect(() => validateUpstreamBaseUrl("https://integrations.replit.com/openai/v1?tenant=a")).toThrow(/query/i);
    expect(() => validateUpstreamBaseUrl("https://integrations.replit.com/openai/v1#frag")).toThrow(/hash/i);
    expect(validateUpstreamBaseUrl("https://integrations.replit.com/openai/v1///")).toBe(
      "https://integrations.replit.com/openai/v1",
    );
  });

  test("rejects origins with paths or queries", () => {
    expect(isAllowedPublicOrigin("https://my-app.replit.app/gateway")).toBe(false);
    expect(isAllowedPublicOrigin("https://my-app.replit.app?x=y")).toBe(false);
    expect(() => canonicalizePublicOrigin("https://my-app.replit.app/gateway")).toThrow();
  });

  test("canonicalizes valid origins without trailing slash", () => {
    expect(canonicalizePublicOrigin("https://my-app.replit.app/")).toBe(
      "https://my-app.replit.app",
    );
    expect(canonicalizePublicOrigin("https://my-app.replit.app")).toBe(
      "https://my-app.replit.app",
    );
  });
});
