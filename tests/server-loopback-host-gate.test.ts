import { describe, expect, test } from "bun:test";
import { isAllowedRequestOrigin, isLoopbackRequestHost } from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";

// A loopback bind: isApiAuthRequired() is false, so admission runs through the
// Host/Origin branch these tests exercise.
const loopbackConfig = { hostname: "127.0.0.1" } as OcxConfig;

function request(host: string, origin?: string): Request {
  const headers: Record<string, string> = { Host: host };
  if (origin) headers.Origin = origin;
  return new Request("http://x/v1/models", { headers });
}

describe("isLoopbackRequestHost", () => {
  test("a forwarded loopback port is still loopback (ssh -L 20100:localhost:10100)", () => {
    // Regression: coupling loopback identity to port equality 403'd the entire /v1/*
    // data plane whenever the client reached the proxy through a forwarded port.
    expect(isLoopbackRequestHost("localhost:20100")).toBe(true);
    expect(isLoopbackRequestHost("127.0.0.1:20100")).toBe(true);
    expect(isLoopbackRequestHost("[::1]:20100")).toBe(true);
  });

  test("the proxy's own port, a bare host, and a missing Host stay allowed", () => {
    expect(isLoopbackRequestHost("localhost:10100")).toBe(true);
    expect(isLoopbackRequestHost("localhost")).toBe(true);
    expect(isLoopbackRequestHost("127.0.0.1")).toBe(true);
    expect(isLoopbackRequestHost(null)).toBe(true);
  });

  test("a non-loopback hostname is refused on every port", () => {
    // The hostname check is the real DNS-rebinding boundary; it must not depend on
    // which port the attacker names.
    expect(isLoopbackRequestHost("attacker.test:10100")).toBe(false);
    expect(isLoopbackRequestHost("attacker.test:20100")).toBe(false);
    expect(isLoopbackRequestHost("192.168.1.5:10100")).toBe(false);
    expect(isLoopbackRequestHost("example.com")).toBe(false);
  });

  test("names that merely look loopback are refused", () => {
    // These are the DNS-rebinding shapes that matter: a hostname the attacker controls
    // which either embeds "localhost"/"127.0.0.1" as a label or resolves to loopback.
    expect(isLoopbackRequestHost("localhost.attacker.com")).toBe(false);
    expect(isLoopbackRequestHost("127.0.0.1.attacker.com")).toBe(false);
    expect(isLoopbackRequestHost("127.0.0.1.nip.io")).toBe(false);
    expect(isLoopbackRequestHost("localtest.me")).toBe(false);
    // Cyrillic "о" in "lоcalhost" — the URL parser punycodes it, so it must not match.
    expect(isLoopbackRequestHost("l\u043Ecalhost:20100")).toBe(false);
    // Not loopback despite the shape.
    expect(isLoopbackRequestHost("0.0.0.0:20100")).toBe(false);
    expect(isLoopbackRequestHost("127.0.0.2:20100")).toBe(false);
  });

  test("alternative spellings of real loopback are accepted (URL normalization)", () => {
    expect(isLoopbackRequestHost("127.1:20100")).toBe(true);
    expect(isLoopbackRequestHost("2130706433:20100")).toBe(true);
    expect(isLoopbackRequestHost("LOCALHOST:20100")).toBe(true);
    // `curl http://localhost.:20100/` sends the FQDN form; it is the same host.
    expect(isLoopbackRequestHost("localhost.:20100")).toBe(true);
    expect(isLoopbackRequestHost("localhost.")).toBe(true);
  });

  test("characterization: an unparseable Host still fails open", () => {
    // Pre-existing behavior of `if (!parsed) return true`, unchanged by the port-check
    // removal and not browser-reachable (a browser composes Host from its own connection).
    // Pinned here so tightening it is a deliberate change with a failing test, not a
    // silent drift. See the scope note in isLoopbackRequestHost.
    expect(isLoopbackRequestHost("attacker.test:99999")).toBe(true);
    expect(isLoopbackRequestHost("attacker test:80")).toBe(true);
  });
});

describe("isAllowedRequestOrigin over a forwarded port", () => {
  test("a CLI with no Origin reaches the data plane through the forward", () => {
    // Codex CLI, Claude Code and curl send no Origin at all, so this path — not CORS —
    // is what made a forwarded proxy look completely dead.
    expect(isAllowedRequestOrigin(request("localhost:20100"), loopbackConfig)).toBe(true);
  });

  test("a browser Origin on the forwarded port is allowed", () => {
    expect(
      isAllowedRequestOrigin(request("localhost:20100", "http://localhost:20100"), loopbackConfig),
    ).toBe(true);
  });

  test("a non-loopback Host is still refused with and without an Origin", () => {
    expect(isAllowedRequestOrigin(request("attacker.test:20100"), loopbackConfig)).toBe(false);
    expect(
      isAllowedRequestOrigin(request("attacker.test:20100", "http://attacker.test:20100"), loopbackConfig),
    ).toBe(false);
  });

  test("a loopback Host with a non-loopback Origin is still refused", () => {
    expect(
      isAllowedRequestOrigin(request("localhost:20100", "http://attacker.test"), loopbackConfig),
    ).toBe(false);
  });
});

describe("isAllowedRequestOrigin with extension origins", () => {
  test("admits only the configured browser extension authority", () => {
    const config = {
      ...loopbackConfig,
      corsAllowOrigins: ["chrome-extension://modkelfkcfjpgbfmnbnllalkiogfofh"],
    } as OcxConfig;

    expect(
      isAllowedRequestOrigin(
        request("localhost:10100", "chrome-extension://modkelfkcfjpgbfmnbnllalkiogfofh"),
        config,
      ),
    ).toBe(true);
    expect(
      isAllowedRequestOrigin(
        request("localhost:10100", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        config,
      ),
    ).toBe(false);
    expect(
      isAllowedRequestOrigin(
        request("localhost:10100", "moz-extension://modkelfkcfjpgbfmnbnllalkiogfofh"),
        config,
      ),
    ).toBe(false);

    expect(
      isAllowedRequestOrigin(
        request("localhost:10100", "chrome-extension://modkelfkcfjpgbfmnbnllalkiogfofh"),
        { ...loopbackConfig, corsAllowOrigins: ["*"] } as OcxConfig,
      ),
    ).toBe(false);
  });
});
