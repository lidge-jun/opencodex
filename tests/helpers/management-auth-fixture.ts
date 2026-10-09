import { expect, spyOn } from "bun:test";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";

export function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

export function hubConfig(publicOrigin = "https://hub.example.test"): OcxConfig {
  return {
    ...remoteConfig(),
    runtimeRole: "hub",
    hub: { managementPublicOrigin: publicOrigin },
    remoteGui: { allowedTailscaleUsers: ["alice@example.test"] },
    corsAllowOrigins: ["https://dashboard.example.test"],
  };
}

/** Keep real ingress/handlers while the kernel allocates both ports at the actual bind. */
export async function startEphemeralHubServer(deps: Parameters<typeof startServer>[1]) {
  const nativeServe = Bun.serve.bind(Bun);
  const listeners: Array<ReturnType<typeof Bun.serve>> = [];
  const hostnames: unknown[] = [];
  const serveSpy = spyOn(Bun, "serve").mockImplementation((options) => {
    const listener = nativeServe({ ...options, port: 0 } as Parameters<typeof Bun.serve>[0]);
    listeners.push(listener);
    hostnames.push("hostname" in options ? options.hostname : undefined);
    return listener;
  });
  try {
    let server: ReturnType<typeof startServer>;
    try {
      server = startServer(0, deps);
    } finally {
      // startServer is synchronous; restore before requests or any awaited cleanup.
      serveSpy.mockRestore();
    }
    expect(listeners).toHaveLength(2);
    expect(listeners[0]).toBe(server);
    expect(hostnames).toEqual(["0.0.0.0", "127.0.0.1"]);
    const managementPort = listeners[1]?.port;
    if (!managementPort || managementPort === server.port) throw new Error("expected distinct live ingress ports");
    return { server, managementPort };
  } catch (error) {
    await Promise.allSettled(listeners.map(async listener => { await listener.stop(true); }));
    throw error;
  }
}

export function websocketHandshakeOpens(url: URL, token: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const target = new URL("/v1/responses", url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(target, {
      headers: { "X-OpenCodex-API-Key": token },
    } as unknown as string[]);
    let settled = false, opened = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(opened);
    };
    const close = () => {
      try { socket.close(); } catch { /* already closed */ }
      if (socket.readyState === WebSocket.CLOSED) finish();
    };
    socket.addEventListener("open", () => { opened = true; close(); });
    socket.addEventListener("error", close);
    socket.addEventListener("close", finish);
    const timer = setTimeout(() => {
      close();
      if (!settled) { settled = true; reject(new Error("fixture WebSocket did not close within 5000ms")); }
    }, 5_000);
  });
}
