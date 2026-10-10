import { open } from "node:fs/promises";
import { MessageBudget } from "./budget";
import { RemoteCapacity, remoteError, validPort } from "./remote-contract";
import { runRemoteHelper, type RemoteHelperOptions } from "./remote-process";

type RemoteProcFile = {
  read(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};

/** Select a candidate only; actual forwarding and authenticated readiness must still succeed. */
export function remotePortCandidate(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) { socket.end(); } } });
  const port = listener.port; listener.stop(true);
  if (!validPort(port)) throw remoteError("invalid_port", "Cannot allocate an unprivileged messaging port candidate.");
  return port;
}
/** Refuse GatewayPorts/public binds; neither port existence nor this scan proves endpoint identity. */
export async function remotePortIsLoopback(port: number, budget: MessageBudget, capacity: RemoteCapacity,
  inspector: { platform?: NodeJS.Platform; helper?: RemoteHelperOptions;
    openProc?: (path: string) => Promise<RemoteProcFile> } = {}): Promise<boolean> {
  if (!validPort(port)) return false;
  budget.throwIfEnded();
  const platform = inspector.platform ?? process.platform;
  if (platform === "linux") {
    const found: string[] = [], hex = port.toString(16).toUpperCase().padStart(4, "0");
    for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let fd: RemoteProcFile;
      try { fd = await (inspector.openProc ?? (path => open(path, "r")))(path); }
      catch (error) {
        if (path === "/proc/net/tcp6" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const bytes = Buffer.alloc(4 * 1024 * 1024 + 1); let size = 0;
        while (size < bytes.length) {
          budget.throwIfEnded(); const next = await fd.read(bytes, size, bytes.length - size, null);
          if (!next.bytesRead) break; size += next.bytesRead;
        }
        if (size >= bytes.length) return false;
        for (const line of bytes.subarray(0, size).toString("utf8").split("\n").slice(1)) {
          const fields = line.trim().split(/\s+/), [address, fieldPort] = (fields[1] ?? "").split(":");
          if (fields[3] === "0A" && fieldPort === hex) found.push(address!);
        }
      } finally { await fd.close(); }
    }
    return found.length > 0 && found.every(address => address === "0100007F" || address === "00000000000000000000000001000000");
  }
  if (platform === "darwin") {
    const output = await runRemoteHelper(["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], budget, capacity,
      undefined, undefined, { ...inspector.helper, successCodes: [0, 1] });
    const addresses = output.split("\n").filter(line => line.startsWith("n"));
    return addresses.length > 0 && addresses.every(line => line === `n127.0.0.1:${port}` || line === `n[::1]:${port}`);
  }
  return false;
}
