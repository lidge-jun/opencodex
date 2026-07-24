import { describe, expect, test } from "bun:test";
import { assessUrlDestination, assertUrlResolvesPublic } from "../../src/lib/destination-policy";

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
