import type { OcxConfig } from "../types";
import { AuxiliaryListenerBindError } from "../server/ports";
import { createServer } from "node:net";

/**
 * Reject impossible auxiliary binds before startup creates private state. On Windows
 * that publication requires several synchronous ACL subprocesses. This is only an
 * early rejection: startServer still owns the actual bind and transactional rollback
 * if another process takes the port between this probe and startup.
 */
export async function assertAuxiliaryListenerPortsAvailable(config: OcxConfig): Promise<void> {
  const loopback = config.unauthenticatedLoopbackListener;
  const management = config.runtimeRole === "hub" ? config.hub?.managementIngress : undefined;
  const targets = [
    { listener: "unauthenticatedLoopbackListener", port: loopback?.enabled ? loopback.port : undefined },
    { listener: "hub.managementIngress", port: management?.enabled ? management.port : undefined },
  ] as const;
  for (const { listener, port } of targets) {
    // The port-less companion shares the public bind; it has no independent target.
    if (port === undefined) continue;
    await new Promise<void>((resolve, reject) => {
      const probe = createServer(socket => socket.destroy());
      const fail = (cause: unknown) => reject(new AuxiliaryListenerBindError(listener, port, "127.0.0.1", cause));
      probe.once("error", fail);
      probe.once("listening", () => probe.close(error => error ? fail(error) : resolve()));
      try { probe.listen({ port, host: "127.0.0.1" }); } catch (error) { fail(error); }
    });
  }
}
