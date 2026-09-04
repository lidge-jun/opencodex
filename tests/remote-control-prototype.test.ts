import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  OpaqueRemoteControlRelay,
  RemoteControlClientHandshake,
  RemoteControlHost,
  acceptRemoteControlClientHello,
  decodeRemoteControlApplicationFrame,
  decodeRemoteControlRelayFrame,
  encodeRemoteControlApplicationFrame,
  encodeRemoteControlRelayFrame,
  generateRemoteControlIdentityKeyPair,
  serializeRemoteControlHello,
  type RemoteControlRelayPeer,
  type RemoteControlTerminal,
} from "../src/remote-control";

class Peer implements RemoteControlRelayPeer {
  buffered = 0;
  sent: Uint8Array[] = [];
  closed: Array<{ code: number; reason: string }> = [];

  bufferedAmount(): number { return this.buffered; }
  send(value: Uint8Array): void { this.sent.push(value.slice()); }
  close(code: number, reason: string): void { this.closed.push({ code, reason }); }
}

function handshakeFixture() {
  const account = generateRemoteControlIdentityKeyPair();
  const device = generateRemoteControlIdentityKeyPair();
  const sessionId = randomUUID();
  const deviceId = randomUUID();
  const client = RemoteControlClientHandshake.create({
    sessionId,
    deviceId,
    commandProfile: "codex",
    capabilities: ["terminal.input", "terminal.output", "terminal.resize"],
    accountPrivateKey: account.privateKey,
  });
  return { account, device, sessionId, deviceId, client };
}

describe("Paseo-style remote control prototype", () => {
  test("authenticates both endpoints, encrypts both directions, and rejects replay", () => {
    const fixture = handshakeFixture();
    const accepted = acceptRemoteControlClientHello(fixture.client.hello, {
      expectedSessionId: fixture.sessionId,
      expectedDeviceId: fixture.deviceId,
      devicePrivateKey: fixture.device.privateKey,
      accountPublicKey: fixture.account.publicKey,
      allowedCapabilities: ["terminal.input", "terminal.output", "terminal.resize"],
    });
    const clientCipher = fixture.client.complete(accepted.hello, fixture.device.publicKey);

    const first = clientCipher.encrypt(new TextEncoder().encode("private terminal input"));
    expect(new TextDecoder().decode(accepted.cipher.decrypt(first))).toBe("private terminal input");
    expect(() => accepted.cipher.decrypt(first)).toThrow("replayed or out-of-order");

    const authenticated = clientCipher.encrypt(new TextEncoder().encode("authenticated frame"));
    const tamperedCiphertext = Uint8Array.from(authenticated);
    tamperedCiphertext[tamperedCiphertext.length - 1]! ^= 1;
    expect(() => accepted.cipher.decrypt(tamperedCiphertext)).toThrow();
    expect(new TextDecoder().decode(accepted.cipher.decrypt(authenticated))).toBe("authenticated frame");

    const reply = accepted.cipher.encrypt(new TextEncoder().encode("private terminal output"));
    expect(new TextDecoder().decode(clientCipher.decrypt(reply))).toBe("private terminal output");

    const tampered = { ...fixture.client.hello, commandProfile: "claude" as const };
    expect(() => acceptRemoteControlClientHello(tampered, {
      expectedSessionId: fixture.sessionId,
      expectedDeviceId: fixture.deviceId,
      devicePrivateKey: fixture.device.privateKey,
      accountPublicKey: fixture.account.publicKey,
      allowedCapabilities: ["terminal.input"],
    })).toThrow("account identity verification failed");
  });

  test("does not start the local terminal until the first authenticated application frame", async () => {
    const fixture = handshakeFixture();
    const events: string[] = [];
    let output: ((value: Uint8Array) => void) | undefined;
    const terminal: RemoteControlTerminal = {
      write(value) { events.push(`input:${new TextDecoder().decode(value)}`); },
      resize(columns, rows) { events.push(`resize:${columns}x${rows}`); },
      close() { events.push("close"); },
    };
    const encryptedOutput: Uint8Array[] = [];
    const host = new RemoteControlHost({
      deviceId: fixture.deviceId,
      devicePrivateKey: fixture.device.privateKey,
      accountPublicKey: fixture.account.publicKey,
      terminalFactory: {
        create(options) {
          events.push(`start:${options.commandProfile}`);
          output = options.onOutput;
          return terminal;
        },
      },
    });
    const hostHelloPayload = host.open(
      fixture.sessionId,
      serializeRemoteControlHello(fixture.client.hello),
      value => encryptedOutput.push(value),
    );
    expect(events).toEqual([]);
    const clientCipher = fixture.client.complete(
      JSON.parse(new TextDecoder().decode(hostHelloPayload)),
      fixture.device.publicKey,
    );
    await host.receive(fixture.sessionId, clientCipher.encrypt(encodeRemoteControlApplicationFrame({
      kind: "resize",
      columns: 120,
      rows: 40,
    })));
    expect(events).toEqual(["start:codex", "resize:120x40"]);

    output!(new TextEncoder().encode("hello from local PTY"));
    expect(encryptedOutput).toHaveLength(1);
    const decoded = decodeRemoteControlApplicationFrame(clientCipher.decrypt(encryptedOutput[0]!));
    expect(decoded.kind).toBe("output");
    if (decoded.kind === "output") expect(new TextDecoder().decode(decoded.data)).toBe("hello from local PTY");
  });

  test("relay routes opaque bytes without parsing terminal plaintext", () => {
    const relay = new OpaqueRemoteControlRelay();
    const host = new Peer();
    const client = new Peer();
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    relay.registerHost(deviceId, host);

    const opaqueHello = Uint8Array.from([0, 255, 17, 33, 128]);
    relay.attachClient({ sessionId, deviceId, client, openPayload: opaqueHello });
    const open = decodeRemoteControlRelayFrame(host.sent.shift()!);
    expect(open.kind).toBe("open");
    expect(open.payload).toEqual(opaqueHello);

    const ciphertext = Uint8Array.from([222, 173, 190, 239, 0, 255]);
    relay.receiveFromHost(deviceId, host, encodeRemoteControlRelayFrame({
      kind: "data",
      sessionId,
      payload: ciphertext,
    }));
    expect(client.sent).toEqual([ciphertext]);
  });

  test("carries an encrypted terminal round trip through the opaque relay", async () => {
    const fixture = handshakeFixture();
    const relay = new OpaqueRemoteControlRelay();
    const hostSocket = new Peer();
    const browserSocket = new Peer();
    let terminalOutput: ((value: Uint8Array) => void) | undefined;
    const terminalInput: string[] = [];
    const localHost = new RemoteControlHost({
      deviceId: fixture.deviceId,
      devicePrivateKey: fixture.device.privateKey,
      accountPublicKey: fixture.account.publicKey,
      terminalFactory: {
        create(options) {
          terminalOutput = options.onOutput;
          return {
            write(value) { terminalInput.push(new TextDecoder().decode(value)); },
            resize() {},
            close() {},
          };
        },
      },
    });
    relay.registerHost(fixture.deviceId, hostSocket);
    relay.attachClient({
      sessionId: fixture.sessionId,
      deviceId: fixture.deviceId,
      client: browserSocket,
      openPayload: serializeRemoteControlHello(fixture.client.hello),
    });

    const open = decodeRemoteControlRelayFrame(hostSocket.sent.shift()!);
    const hostHello = localHost.open(open.sessionId, open.payload, ciphertext => {
      relay.receiveFromHost(fixture.deviceId, hostSocket, encodeRemoteControlRelayFrame({
        kind: "data",
        sessionId: fixture.sessionId,
        payload: ciphertext,
      }));
    });
    relay.receiveFromHost(fixture.deviceId, hostSocket, encodeRemoteControlRelayFrame({
      kind: "data",
      sessionId: fixture.sessionId,
      payload: hostHello,
    }));
    const clientCipher = fixture.client.complete(
      JSON.parse(new TextDecoder().decode(browserSocket.sent.shift()!)),
      fixture.device.publicKey,
    );

    relay.receiveFromClient(
      fixture.sessionId,
      browserSocket,
      clientCipher.encrypt(encodeRemoteControlApplicationFrame({
        kind: "input",
        data: new TextEncoder().encode("codex --help\n"),
      })),
    );
    const input = decodeRemoteControlRelayFrame(hostSocket.sent.shift()!);
    await localHost.receive(input.sessionId, input.payload);
    expect(terminalInput).toEqual(["codex --help\n"]);

    terminalOutput!(new TextEncoder().encode("local-only output"));
    const output = decodeRemoteControlApplicationFrame(clientCipher.decrypt(browserSocket.sent.shift()!));
    expect(output.kind).toBe("output");
    if (output.kind === "output") expect(new TextDecoder().decode(output.data)).toBe("local-only output");
  });

  test("enforces device session and backpressure bounds", () => {
    const relay = new OpaqueRemoteControlRelay({ maxSessionsPerDevice: 1, maxBufferedBytes: 8 });
    const host = new Peer();
    const deviceId = randomUUID();
    relay.registerHost(deviceId, host);
    relay.attachClient({ sessionId: randomUUID(), deviceId, client: new Peer(), openPayload: Uint8Array.of(1) });
    expect(() => relay.attachClient({
      sessionId: randomUUID(),
      deviceId,
      client: new Peer(),
      openPayload: Uint8Array.of(2),
    })).toThrow("session limit");

    const backpressured = new Peer();
    backpressured.buffered = 9;
    const secondDevice = randomUUID();
    relay.registerHost(secondDevice, backpressured);
    expect(() => relay.attachClient({
      sessionId: randomUUID(),
      deviceId: secondDevice,
      client: new Peer(),
      openPayload: Uint8Array.of(3),
    })).toThrow("backpressured");
    expect(backpressured.closed[0]?.code).toBe(1013);
  });
});
