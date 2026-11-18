import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { directLocalHttpFetch } from "../../src/server/direct-local-http";

export function localConnectTimeoutFetch(
  outcome: (hostname: string) => "timeout" | "refused" | "connected" = () => "timeout",
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => directLocalHttpFetch(input, init, {
    connect(hostname) {
      const socket = Object.assign(new EventEmitter(), {
        setTimeout() { return socket; },
        write() { return true; },
        destroy() { queueMicrotask(() => socket.emit("close")); return socket; },
      });
      const result = outcome(hostname);
      if (result === "connected") queueMicrotask(() => socket.emit("connect"));
      if (result === "refused") queueMicrotask(() => socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
      return socket as unknown as Socket;
    },
    scheduleDeadline(onTimeout) {
      let cancelled = false;
      queueMicrotask(() => { if (!cancelled) onTimeout(); });
      return () => { cancelled = true; };
    },
  })) as typeof fetch;
}
