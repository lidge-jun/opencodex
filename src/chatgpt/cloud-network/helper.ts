import { createServer, type Socket } from "node:net";
import { chmodSync, chownSync, lstatSync, unlinkSync } from "node:fs";
import { CLOUD_NETWORK_PROTOCOL, CloudNetworkError, type CloudHelperReply, type CloudMappingState } from "./contract";

export interface CloudMappingOperations {
  /** Recovers any abandoned mapping before acquiring a new one. */
  apply(): void;
  recover(): void;
}

/** One connection owns the mapping. Kernel disconnect is the proxy-crash recovery signal. */
export async function serveCloudMapping(options: {
  socketPath: string;
  mapping: CloudMappingOperations;
  uid: number;
  gid: number;
}) {
  let owner: Socket | undefined;
  let reason: string | undefined;
  const state = (): CloudMappingState => reason ? "recovery_required" : owner ? "active" : "idle";
  let closing = false;
  const clients = new Set<Socket>();
  const recover = () => {
    try { options.mapping.recover(); reason = undefined; }
    catch (error) { reason = error instanceof CloudNetworkError ? error.message : "mapping_io_failed"; }
  };
  recover(); // launchd restart/boot recovery runs before accepting a new owner.
  const stale = lstatSync(options.socketPath, { throwIfNoEntry: false });
  if (stale) {
    if (!stale.isSocket()) throw new CloudNetworkError("helper_socket_conflict");
    unlinkSync(options.socketPath);
  }
  const reply = (socket: Socket, ok: boolean, error?: string) => {
    const message: CloudHelperReply = { protocol: CLOUD_NETWORK_PROTOCOL, ok, state: state(), ...(error ? { error } : {}) };
    socket.write(`${JSON.stringify(message)}\n`);
  };
  const server = createServer(socket => {
    clients.add(socket);
    let buffer = "";
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clients.delete(socket);
      if (owner === socket) { owner = undefined; recover(); }
    });
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request: { protocol?: unknown; action?: unknown };
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!request || request.protocol !== CLOUD_NETWORK_PROTOCOL || closing) { reply(socket, false, "protocol_mismatch"); socket.end(); return; }
        const action = request.action;
        if (action === "status") { reply(socket, !reason, reason); socket.end(); return; }
        if (action === "release" && owner === socket) {
          owner = undefined; recover(); reply(socket, !reason, reason); socket.end(); return;
        }
        if (action !== "acquire" && action !== "recover") { reply(socket, false, "invalid_action"); socket.end(); return; }
        if (owner) { reply(socket, false, "mapping_busy"); socket.end(); return; }
        if (action === "recover") { recover(); reply(socket, !reason, reason); socket.end(); return; }
        try {
          options.mapping.apply();
          reason = undefined; owner = socket; socket.setTimeout(0); reply(socket, true);
        } catch (error) {
          const failure = error instanceof CloudNetworkError ? error.message : "mapping_io_failed";
          recover(); reply(socket, false, reason ?? failure); socket.end(); return;
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => { server.off("error", reject); resolve(); });
  });
  try {
    chmodSync(options.socketPath, 0o600);
    if (process.getuid?.() === 0) chownSync(options.socketPath, options.uid, options.gid);
  } catch (error) { server.close(); throw error; }
  let stopping: Promise<void> | undefined;
  return {
    state,
    stop(): Promise<void> {
      return stopping ??= (async () => {
        closing = true;
        owner = undefined;
        recover();
        for (const socket of clients) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        if (reason) throw new CloudNetworkError(reason);
      })();
    },
  };
}
