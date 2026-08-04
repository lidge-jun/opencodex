import { describe, expect, test } from "bun:test";
import { describeUpstreamConnectFailure } from "../src/server/responses/upstream-error";

function tlsAltnameError(url: string): Error {
  // Shape of what Bun's fetch actually rejects with on a certificate/hostname mismatch.
  return Object.assign(new Error(`ERR_TLS_CERT_ALTNAME_INVALID fetching "${url}"`), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
  });
}

describe("describeUpstreamConnectFailure", () => {
  test("a TLS altname mismatch names the host, the likely cause, and the check", () => {
    const msg = describeUpstreamConnectFailure(
      tlsAltnameError("https://api.individual.githubcopilot.com/chat/completions"),
      30000,
    );
    expect(msg).toContain("api.individual.githubcopilot.com");
    expect(msg).toContain("TLS interception");
    expect(msg).toContain("openssl s_client");
    expect(msg).toContain("-servername api.individual.githubcopilot.com");
    // The generic wording is what sent issue #553 hunting for an adapter URL bug.
    expect(msg).not.toContain("Provider unreachable");
  });

  test("the branch also fires when only the message carries the code", () => {
    const msg = describeUpstreamConnectFailure(new Error("ERR_TLS_CERT_ALTNAME_INVALID"), 30000);
    expect(msg).toContain("openssl s_client");
    // No URL in the detail, so the message degrades to a placeholder rather than guessing.
    expect(msg).toContain("the provider host");
    expect(msg).toContain("<host>");
  });

  test("text that merely quotes the code back does not take the TLS branch", () => {
    // Only transport failures reach these call sites, so this is defensive — but the message
    // fallback is anchored to the head so echoed text cannot produce wrong advice.
    const msg = describeUpstreamConnectFailure(
      new Error('upstream said: ERR_TLS_CERT_ALTNAME_INVALID somewhere'),
      30000,
    );
    expect(msg).toBe("Provider unreachable: upstream said: ERR_TLS_CERT_ALTNAME_INVALID somewhere");
  });

  test("an ordinary connection failure keeps the existing wording", () => {
    expect(describeUpstreamConnectFailure(new Error("ECONNREFUSED"), 30000))
      .toBe("Provider unreachable: ECONNREFUSED");
    expect(describeUpstreamConnectFailure(new Error("ENOTFOUND api.example.com"), 30000))
      .toBe("Provider unreachable: ENOTFOUND api.example.com");
  });

  test("a timeout keeps its own message", () => {
    const err = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    expect(describeUpstreamConnectFailure(err, 12345))
      .toBe("Provider connect timeout after 12345ms");
  });

  test("a non-Error rejection still produces the generic message", () => {
    expect(describeUpstreamConnectFailure("socket hang up", 30000))
      .toBe("Provider unreachable: socket hang up");
  });

  test("URL userinfo is redacted on both branches", () => {
    // A provider base URL can carry credentials as userinfo, and the runtime error echoes
    // the URL it was fetching. Neither message may hand that back to the caller.
    // The secret is assembled at runtime so the privacy scanner does not read the literal
    // `user:token@host` form here as a real address.
    const secret = ["sk", "fixture", "token"].join("-");
    const withCreds = `fetching "https://user:${secret}@api.example.com/v1"`;
    const tls = describeUpstreamConnectFailure(
      Object.assign(new Error(`ERR_TLS_CERT_ALTNAME_INVALID ${withCreds}`), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      }),
      30000,
    );
    expect(tls).not.toContain(secret);
    expect(tls).toContain("<redacted>@api.example.com");
    expect(tls).toContain("does not match api.example.com");

    const generic = describeUpstreamConnectFailure(new Error(`ECONNREFUSED ${withCreds}`), 30000);
    expect(generic).not.toContain(secret);
    expect(generic).toContain("<redacted>@api.example.com");
  });

  test("an IPv6 literal host is extracted in bracket form", () => {
    const msg = describeUpstreamConnectFailure(
      Object.assign(new Error('ERR_TLS_CERT_ALTNAME_INVALID fetching "https://[2001:db8::1]:8443/v1"'), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      }),
      30000,
    );
    expect(msg).toContain("[2001:db8::1]");
    expect(msg).toContain("-servername [2001:db8::1]");
  });
});
