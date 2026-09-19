import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";
import { createLabAuthorizedPinnedSender } from "../../src/lib/lab-live-pinned-sender";
import { TransportError, classifyTransportError } from "../../src/lab/live/transport";
import type { LabCredentialLeaseV1, LabDestinationV1, LiveRunConfig } from "../../src/lab/live/types";

const SERVERS: Server[] = [];

afterEach(async () => {
  for (const server of SERVERS.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer(handler);
    SERVERS.push(server);
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback test server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

const BASE_LIMITS: LiveRunConfig = {
  totalTimeoutMs: 1_000,
  connectTimeoutMs: 250,
  firstByteTimeoutMs: 30,
  inactivityTimeoutMs: 30,
  maxRequests: 2,
  maxInputBytes: 1024,
  maxOutputBytes: 1024,
  maxOutputTokens: 1024,
  maxToolCalls: 8,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxChildProcesses: 0,
  maxArtifacts: 4,
  perArtifactBytes: 64 * 1024,
  aggregateArtifactBytes: 256 * 1024,
};

function destination(port: number): LabDestinationV1 {
  return {
    scheme: "http",
    host: "lab-timeout.invalid",
    port,
    basePath: "",
    sniHost: "lab-timeout.invalid",
    addresses: [{ address: "127.0.0.1", family: 4 }],
    privateNetwork: true,
    fingerprint: "a".repeat(64),
  };
}

async function send(port: number, limitOverrides: Partial<LiveRunConfig> = {}) {
  const sender = createLabAuthorizedPinnedSender(() => ({}));
  return await sender(
    {} as LabCredentialLeaseV1,
    destination(port),
    { address: "127.0.0.1", family: 4 },
    { method: "POST", path: "/", body: "{}" },
    new AbortController().signal,
    { ...BASE_LIMITS, ...limitOverrides },
  );
}

describe("CL-03 pinned live transport failure classification", () => {
  test("preserves first-byte timeout as a transport timeout", async () => {
    const port = await listen((_req, res) => {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 150);
    });

    await expect(send(port, { firstByteTimeoutMs: 30, inactivityTimeoutMs: 250 })).rejects.toMatchObject({
      name: "TransportError",
      code: "first_byte_timeout",
    });
  });

  test("preserves response inactivity as inactivity_timeout", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{\"ok\":");
      setTimeout(() => {
        if (!res.destroyed) res.end("true}");
      }, 150);
    });

    await expect(send(port, { firstByteTimeoutMs: 250, inactivityTimeoutMs: 30 })).rejects.toMatchObject({
      name: "TransportError",
      code: "inactivity_timeout",
    });
  });

  test("preserves the output byte ceiling as output_byte_limit", async () => {
    const port = await listen((_req, res) => {
      // Fault injection: the neighboring 30ms timeout fixture must not decide
      // this byte-limit case before its oversized response can arrive.
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(128));
      }, 150);
    });

    await expect(send(port, {
      maxOutputBytes: 16,
      firstByteTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
    })).rejects.toMatchObject({
      name: "TransportError",
      code: "output_byte_limit",
    });
  });

  // An answer the transport cannot read is the peer's doing. Before this was classified, it
  // reached Lab as an unrecognized error, and the executor's fallback reported it as
  // harness_failure / execution_error - the runner blamed for what the upstream sent.
  test("reports a coding this transport cannot undo as an unreadable response", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "br" });
      res.end("not really brotli");
    });

    // Classify the error the sender actually rejected with. Building a second TransportError and
    // classifying that would pass even if the sender raised something else entirely.
    const error = await send(port, { firstByteTimeoutMs: 1_000, inactivityTimeoutMs: 1_000 })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ name: "TransportError", code: "unreadable_response" });
    expect(classifyTransportError(error)).toEqual({
      classification: "protocol_failure",
      secondaryCode: "unreadable_response",
    });
  });

  test("reports coded bytes that do not decode as an unreadable response", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end("this is not gzip at all");
    });

    const error = await send(port, { firstByteTimeoutMs: 1_000, inactivityTimeoutMs: 1_000 })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ name: "TransportError", code: "unreadable_response" });
    expect(classifyTransportError(error)).toEqual({
      classification: "protocol_failure",
      secondaryCode: "unreadable_response",
    });
  });

  test("allows a response exactly at the output byte ceiling", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(16));
    });

    await expect(send(port, {
      maxOutputBytes: 16,
      firstByteTimeoutMs: 1_000,
      inactivityTimeoutMs: 1_000,
    })).resolves.toMatchObject({
      status: 200,
      body: "x".repeat(16),
    });
  });
});
