import { describe, expect, test } from "bun:test";
import { socks5Credentials, socks5Handshake, Socks5HandshakeError } from "../../src/lib/socks5-handshake";

/**
 * Byte-level contract of the SOCKS5 handshake both raw transports ride: method
 * negotiation, RFC 1929 subnegotiation, CONNECT framing, and reply parsing.
 * `tests/lib/socks5-fetch.test.ts` and `tests/chatgpt-unblock/unblock-ws-relay.test.ts`
 * pin each transport end to end; these cases drive the handshake alone so every reply
 * shape is reachable without a socket.
 */

/** A reader fed pre-scripted proxy replies; records what the handshake writes. */
class ScriptedReader {
  private sent: Buffer = Buffer.alloc(0);
  private replies: Buffer[] = [];
  private failure: Error | undefined;
  private waiter: { bytes: number; resolve: (value: Buffer) => void; reject: (error: Error) => void } | null = null;

  takeWritten(): Buffer {
    const value = this.sent;
    this.sent = Buffer.alloc(0);
    return value;
  }

  reply(...chunks: number[][]): void {
    for (const chunk of chunks) this.replies.push(Buffer.from(chunk));
    this.flush();
  }

  fail(error: Error): void {
    this.failure = error;
    this.flush();
  }

  private flush(): void {
    if (!this.waiter) return;
    if (this.failure) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(this.failure);
      return;
    }
    const available = this.replies.reduce((total, reply) => total + reply.byteLength, 0);
    if (available >= this.waiter.bytes) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(this.consume(waiter.bytes));
    }
  }

  private consume(bytes: number): Buffer {
    const out: Buffer[] = [];
    let remaining = bytes;
    while (remaining > 0) {
      const next = this.replies[0]!;
      if (next.byteLength <= remaining) {
        this.replies.shift();
        out.push(next);
        remaining -= next.byteLength;
      } else {
        out.push(next.subarray(0, remaining));
        this.replies[0] = next.subarray(remaining);
        remaining = 0;
      }
    }
    return Buffer.concat(out);
  }

  write(bytes: Uint8Array): void {
    this.sent = Buffer.concat([this.sent, Buffer.from(bytes)]);
  }

  readExact(bytes: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    const available = this.replies.reduce((total, reply) => total + reply.byteLength, 0);
    if (available >= bytes) return Promise.resolve(this.consume(bytes));
    return new Promise((resolve, reject) => {
      this.waiter = { bytes, resolve, reject };
    });
  }
}

const AUTH = socks5Credentials(new URL("socks5://user:pass@proxy.example.test:1080"));
const NO_AUTH = socks5Credentials(new URL("socks5://proxy.example.test:1080"));
const TARGET = { host: "chatgpt.com", port: 443 };
const CONNECT_REPLY = [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];

function connectRequest(host: string, port: number): Buffer {
  const hostBytes = Buffer.from(host, "utf8");
  return Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.byteLength, ...hostBytes, port >> 8, port & 0xff]);
}

describe("shared socks5 handshake", () => {
  test("offers no-auth only without credentials, user-pass alongside them with credentials", async () => {
    const plain = new ScriptedReader();
    plain.reply([0x05, 0x00], CONNECT_REPLY);
    await socks5Handshake(plain, TARGET, NO_AUTH);
    expect([...plain.takeWritten()]).toEqual([0x05, 0x01, 0x00, ...connectRequest(TARGET.host, TARGET.port)]);

    const credentialed = new ScriptedReader();
    credentialed.reply([0x05, 0x00], CONNECT_REPLY);
    await socks5Handshake(credentialed, TARGET, AUTH);
    // Two methods offered: NO-AUTH keeps a proxy that ignores credentials usable.
    // NO-AUTH picked: no credential bytes are ever sent unasked.
    expect([...credentialed.takeWritten()]).toEqual([
      0x05, 0x02, 0x00, 0x02, ...connectRequest(TARGET.host, TARGET.port),
    ]);
  });

  test("performs the RFC 1929 subnegotiation when the proxy picks user-pass", async () => {
    const reader = new ScriptedReader();
    reader.reply([0x05, 0x02], [0x01, 0x00], CONNECT_REPLY);
    await socks5Handshake(reader, TARGET, AUTH);
    const written = reader.takeWritten();
    // After the 4-byte greeting: version-1 subnegotiation, ulen uname plen passwd.
    const subnegotiation = written.subarray(4, 4 + 1 + 1 + "user".length + 1 + "pass".length);
    expect([...subnegotiation]).toEqual([
      0x01, 4, ...Buffer.from("user"), 4, ...Buffer.from("pass"),
    ]);
  });

  test("a failure reply to the subnegotiation is an authentication failure", async () => {
    const reader = new ScriptedReader();
    reader.reply([0x05, 0x02], [0x01, 0xff]);
    await expect(socks5Handshake(reader, TARGET, AUTH))
      .rejects.toThrow("SOCKS5 proxy authentication failed");
  });

  test("a proxy picking a method we did not offer is refused before CONNECT", async () => {
    const reader = new ScriptedReader();
    reader.reply([0x05, 0x80]);
    await expect(socks5Handshake(reader, TARGET, NO_AUTH))
      .rejects.toThrow("does not accept an offered authentication method");
    // Refusal must not be followed by a CONNECT request into a dead conversation.
    expect(reader.takeWritten()).toEqual(Buffer.from([0x05, 0x01, 0x00]));
  });

  test("connect failures carry the proxy's reply code", async () => {
    const reader = new ScriptedReader();
    reader.reply([0x05, 0x00], [0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    await expect(socks5Handshake(reader, TARGET, NO_AUTH))
      .rejects.toThrow("refused the connection (code 1)");
  });

  test("malformed replies are named errors: bad version, reserved byte, unknown address type", async () => {
    const badVersion = new ScriptedReader();
    badVersion.reply([0x04, 0x00]);
    await expect(socks5Handshake(badVersion, TARGET, NO_AUTH))
      .rejects.toThrow("invalid greeting");

    const badReserved = new ScriptedReader();
    badReserved.reply([0x05, 0x00], [0x05, 0x00, 0x01, 0x01, 0, 0, 0, 0, 0, 0]);
    await expect(socks5Handshake(badReserved, TARGET, NO_AUTH))
      .rejects.toThrow("invalid address type or reserved byte");

    const badAddress = new ScriptedReader();
    badAddress.reply([0x05, 0x00], [0x05, 0x00, 0x00, 0x07, 0, 0, 0, 0, 0, 0]);
    await expect(socks5Handshake(badAddress, TARGET, NO_AUTH))
      .rejects.toThrow("invalid address type or reserved byte");
  });

  test("consumes the bound-address tail for every address type", async () => {
    // IPv4: 4 address bytes + 2 port bytes. A shorter reply left unread would corrupt
    // the stream the TLS layer inherits.
    const ipv4 = new ScriptedReader();
    ipv4.reply([0x05, 0x00], [0x05, 0x00, 0x00, 0x01, 10, 1, 2, 3, 0x01, 0xbb]);
    await socks5Handshake(ipv4, TARGET, NO_AUTH);

    const domain = new ScriptedReader();
    domain.reply([0x05, 0x00], [0x05, 0x00, 0x00, 0x03, 9, ...Buffer.from("proxy.example"), 0x01, 0xbb]);
    await socks5Handshake(domain, TARGET, NO_AUTH);

    const ipv6 = new ScriptedReader();
    ipv6.reply([0x05, 0x00], [0x05, 0x00, 0x00, 0x04, ...Array.from({ length: 16 }, (_, i) => i), 0x01, 0xbb]);
    await socks5Handshake(ipv6, TARGET, NO_AUTH);
  });

  test("a reader that stops answering rejects the pending step", async () => {
    const reader = new ScriptedReader();
    const pending = socks5Handshake(reader, TARGET, NO_AUTH);
    reader.fail(new Error("handshake timeout"));
    await expect(pending).rejects.toThrow("handshake timeout");
  });

  test("a domain target longer than one length byte is refused before anything is written", async () => {
    const reader = new ScriptedReader();
    await expect(socks5Handshake(reader, { host: "a".repeat(256), port: 443 }, NO_AUTH))
      .rejects.toThrow("target hostname is too long");
    expect(reader.takeWritten().byteLength).toBe(0);
  });

  test("credentials with invalid percent encoding or oversized parts are refused", () => {
    expect(() => socks5Credentials(new URL("socks5://%zz@proxy.example.test:1080")))
      .toThrow("invalid percent encoding");
    expect(() => socks5Credentials(new URL(`socks5://${"u".repeat(256)}@proxy.example.test:1080`)))
      .toThrow("must each fit in 255 UTF-8 bytes");
  });

  test("errors are the named handshake type", async () => {
    const reader = new ScriptedReader();
    reader.reply([0x05, 0x80]);
    await expect(socks5Handshake(reader, TARGET, NO_AUTH)).rejects.toBeInstanceOf(Socks5HandshakeError);
  });

  test("writes the CONNECT request in the expected domain framing", async () => {
    const reader = new ScriptedReader();
    reader.reply([0x05, 0x00], CONNECT_REPLY);
    await socks5Handshake(reader, TARGET, NO_AUTH);
    const written = reader.takeWritten();
    // 3-byte greeting (05, nmethods, one method) precedes the CONNECT request.
    expect([...written.subarray(3)]).toEqual([...connectRequest("chatgpt.com", 443)]);
  });
});
