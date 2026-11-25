import { expect, spyOn, test } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import { markEgressTransparentExecutor } from "../../src/lib/provider-egress";
import { providerTlsFetch } from "../../src/lib/provider-tls-profile";
import { configuredOutboundFetch } from "../../src/lib/proxy-env";
import { Socks5FetchError } from "../../src/lib/socks5-fetch";
import { listen, TunnelFixtureScope } from "../helpers/opaque-proxy-tunnel";

type TlsInit = RequestInit & { proxy?: string; tls?: Record<string, unknown> };
const target = "https://destination.invalid/responses";

// The peer completes only SOCKS CONNECT. Capture the production TLS call, then stop
// before TLS or HTTP bytes can reach a destination; lifecycle tests cover real TLS.
async function handshakeOptions(
  send: (proxy: string, signal: AbortSignal) => Promise<Response>,
): Promise<tls.ConnectionOptions> {
  const scope = new TunnelFixtureScope();
  const server = net.createServer(socket => {
    let stage: "greeting" | "connect" | "done" = "greeting";
    let pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (stage === "greeting") {
        if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
        pending = pending.subarray(2 + pending[1]!);
        socket.write(Buffer.from([5, 0]));
        stage = "connect";
      }
      if (stage === "connect") {
        if (pending.length < 5 || pending.length < 7 + pending[4]!) return;
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        stage = "done";
      }
    });
  });
  const controller = new AbortController();
  try {
    const port = await listen(scope, server);
    scope.later(() => controller.abort(new Error("TLS options fixture watchdog")), 2_000);
    const stopped = new Error("TLS option boundary reached");
    let observed: tls.ConnectionOptions | undefined;
    const connect = spyOn(tls, "connect").mockImplementation((options: tls.ConnectionOptions) => {
      observed = options;
      throw stopped;
    });
    scope.after(() => { connect.mockRestore(); });
    await expect(send(`socks5://127.0.0.1:${port}`, controller.signal)).rejects.toBe(stopped);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(observed).toBeDefined();
    expect(observed!.socket?.destroyed).toBe(true);
    return observed!;
  } finally {
    controller.abort();
    await scope.close();
  }
}

test("Azure's numeric TLS ceiling survives configured outbound SOCKS dispatch", async () => {
  const provider = { adapter: "azure-openai", baseUrl: "https://fixture.services.ai.azure.com/openai/v1" };
  const fetch = providerTlsFetch("azure-openai", provider, markEgressTransparentExecutor(
    ((input, init) => configuredOutboundFetch(input, init)) as typeof globalThis.fetch,
  ));
  const observed = await handshakeOptions((proxy, signal) => fetch(`${provider.baseUrl}/responses`, { proxy, signal } as TlsInit));
  expect(observed.maxVersion).toBe("TLSv1.2");
  expect(observed.servername).toBe("fixture.services.ai.azure.com");
  expect(observed.rejectUnauthorized).toBe(true);
});

for (const [maxVersion, expected] of [[771, "TLSv1.2"], [772, "TLSv1.3"], ["TLSv1.2", "TLSv1.2"], ["TLSv1.3", "TLSv1.3"]] as const) {
  test(`SOCKS TLS validates and translates maxVersion ${maxVersion}`, async () => {
    const observed = await handshakeOptions((proxy, signal) => configuredOutboundFetch(target, {
      proxy, signal, tls: { maxVersion, rejectUnauthorized: false, servername: "wrong.invalid", ca: "untrusted" },
    } as TlsInit));
    expect(observed.maxVersion).toBe(expected);
    expect(observed.rejectUnauthorized).toBe(true);
    expect(observed.servername).toBe("destination.invalid");
    expect(Object.keys(observed).sort()).toEqual(["maxVersion", "rejectUnauthorized", "servername", "socket"]);
  });
}

test("ordinary SOCKS HTTPS requests leave the runtime TLS ceiling untouched", async () => {
  const observed = await handshakeOptions((proxy, signal) => configuredOutboundFetch(target, { proxy, signal } as TlsInit));
  expect(Object.hasOwn(observed, "maxVersion")).toBe(false);
  expect(observed.rejectUnauthorized).toBe(true);
  expect(observed.servername).toBe("destination.invalid");
});

test("unsupported TLS ceilings are refused before opening a SOCKS connection", async () => {
  const connect = spyOn(net, "createConnection").mockImplementation(() => { throw new Error("unexpected TCP connection"); });
  try {
    for (const maxVersion of [0, 770, 773, "771", "TLSv1.1", "TLSv1.4", null, false, {}]) {
      await expect(configuredOutboundFetch(target, {
        proxy: "socks5://127.0.0.1:1080", tls: { maxVersion },
      } as TlsInit)).rejects.toThrow(Socks5FetchError);
    }
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
  }
});
