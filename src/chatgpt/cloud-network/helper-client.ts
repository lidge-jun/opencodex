import { connect } from "node:net";
import { CLOUD_HELPER_SOCKET, CLOUD_NETWORK_PROTOCOL, CloudNetworkError, type CloudHelperReply } from "./contract";

/** Fixed-path local protocol; no hostname, file path, executable or credential is sent. */
function openHelper(socketPath: string) {
  const socket = connect(socketPath);
  let buffer = "";
  let pending: { resolve: (reply: CloudHelperReply) => void; reject: (error: Error) => void } | undefined;
  const closed = new Promise<void>(resolve => socket.once("close", () => {
    pending?.reject(new CloudNetworkError("helper_disconnected")); pending = undefined; resolve();
  }));
  socket.on("error", () => socket.destroy());
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 1024) { socket.destroy(); return; }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    try {
      const message = JSON.parse(buffer.slice(0, newline)) as CloudHelperReply;
      buffer = buffer.slice(newline + 1);
      if (message.protocol !== CLOUD_NETWORK_PROTOCOL || typeof message.ok !== "boolean"
        || !["idle", "active", "recovery_required"].includes(message.state)) throw new Error();
      pending?.resolve(message); pending = undefined;
    } catch { socket.destroy(); }
  });
  return {
    closed,
    close: () => socket.destroy(),
    async request(action: "acquire" | "release" | "status" | "recover"): Promise<CloudHelperReply> {
      if (socket.destroyed) throw new CloudNetworkError("helper_unavailable");
      const timer = setTimeout(() => socket.destroy(), 5_000);
      try {
        return await new Promise((resolve, reject) => {
          pending = { resolve, reject };
          socket.write(`${JSON.stringify({ protocol: CLOUD_NETWORK_PROTOCOL, action })}\n`);
        });
      } finally { clearTimeout(timer); }
    },
  };
}

export async function cloudHelperRequest(action: "status" | "recover", socketPath = CLOUD_HELPER_SOCKET): Promise<CloudHelperReply> {
  const connection = openHelper(socketPath);
  try { return await connection.request(action); } finally { connection.close(); }
}

export async function acquireCloudMapping(socketPath = CLOUD_HELPER_SOCKET) {
  const connection = openHelper(socketPath);
  try {
    const reply = await connection.request("acquire");
    if (!reply.ok) throw CloudNetworkError.fromReply(reply, "mapping_failed");
  } catch (error) { connection.close(); throw error; }
  return {
    closed: connection.closed,
    async release(): Promise<void> {
      try {
        const reply = await connection.request("release");
        if (!reply.ok) throw CloudNetworkError.fromReply(reply, "recovery_required");
      } finally { connection.close(); }
    },
  };
}
