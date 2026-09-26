import { describe, expect, test } from "bun:test";
import { isLocalUpstream } from "../../src/lib/local-upstream";

describe("isLocalUpstream", () => {
  describe("loopback", () => {
    test("classifies localhost (any case, with or without a port)", () => {
      expect(isLocalUpstream("localhost")).toBe(true);
      expect(isLocalUpstream("LOCALHOST")).toBe(true);
      expect(isLocalUpstream("http://localhost:1234/v1")).toBe(true);
      expect(isLocalUpstream("localhost:1234")).toBe(true);
    });

    test("classifies the IPv4 loopback block", () => {
      expect(isLocalUpstream("127.0.0.1")).toBe(true);
      expect(isLocalUpstream("127.8.9.10")).toBe(true);
      expect(isLocalUpstream("http://127.0.0.1:8080")).toBe(true);
    });

    test("classifies the IPv6 loopback", () => {
      expect(isLocalUpstream("::1")).toBe(true);
      expect(isLocalUpstream("http://[::1]:8080")).toBe(true);
      // Full-form loopback.
      expect(isLocalUpstream("0:0:0:0:0:0:0:1")).toBe(true);
    });

    test("classifies the unspecified address", () => {
      expect(isLocalUpstream("0.0.0.0")).toBe(true);
    });
  });

  describe("private and link-local ranges", () => {
    test("classifies RFC 1918 private ranges", () => {
      expect(isLocalUpstream("10.1.2.3")).toBe(true);
      expect(isLocalUpstream("172.16.0.1")).toBe(true);
      expect(isLocalUpstream("172.31.255.255")).toBe(true);
      expect(isLocalUpstream("192.168.1.50")).toBe(true);
    });

    test("classifies IPv4 link-local", () => {
      expect(isLocalUpstream("169.254.10.10")).toBe(true);
    });

    test("classifies IPv6 link-local and unique-local", () => {
      expect(isLocalUpstream("fe80::1")).toBe(true);
      expect(isLocalUpstream("fd12:3456:789a::1")).toBe(true);
      // A zone id does not defeat classification.
      expect(isLocalUpstream("fe80::1%eth0")).toBe(true);
    });

    test("classifies IPv4-mapped IPv6 loopback", () => {
      expect(isLocalUpstream("::ffff:127.0.0.1")).toBe(true);
    });
  });

  describe("local multicast-name suffixes", () => {
    test("classifies .local and .lan names", () => {
      expect(isLocalUpstream("lm-studio.local")).toBe(true);
      expect(isLocalUpstream("ollama.lan")).toBe(true);
      expect(isLocalUpstream("http://vllm.local:8000/v1")).toBe(true);
    });
  });

  describe("public destinations", () => {
    test("does not classify public IP ranges as local", () => {
      expect(isLocalUpstream("8.8.8.8")).toBe(false);
      // Just outside 172.16/12.
      expect(isLocalUpstream("172.32.0.1")).toBe(false);
      expect(isLocalUpstream("172.15.0.1")).toBe(false);
      // Carrier-grade NAT and documentation ranges are not trusted local.
      expect(isLocalUpstream("100.64.0.1")).toBe(false);
      expect(isLocalUpstream("203.0.113.10")).toBe(false);
    });

    test("does not classify public IPv6 as local", () => {
      expect(isLocalUpstream("2606:4700::1111")).toBe(false);
    });

    test("does not classify public hostnames as local", () => {
      expect(isLocalUpstream("api.openai.com")).toBe(false);
      expect(isLocalUpstream("https://api.anthropic.com/v1")).toBe(false);
      expect(isLocalUpstream("example.com")).toBe(false);
    });

    test("a public hostname that merely contains 'local' is not local", () => {
      expect(isLocalUpstream("localization.example.com")).toBe(false);
      expect(isLocalUpstream("notlocalhost.example.com")).toBe(false);
    });
  });

  describe("degenerate input", () => {
    test("returns false for empty, null, and undefined", () => {
      expect(isLocalUpstream("")).toBe(false);
      expect(isLocalUpstream("   ")).toBe(false);
      expect(isLocalUpstream(null)).toBe(false);
      expect(isLocalUpstream(undefined)).toBe(false);
    });

    test("returns false for hosts it cannot parse", () => {
      expect(isLocalUpstream("not a url at all")).toBe(false);
      expect(isLocalUpstream("300.300.300.300")).toBe(false);
    });
  });
});
