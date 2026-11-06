import { startLocalCredentialObservation } from "./inventory";

/**
 * The one way a runtime owns the local-credential observer. `ocx status` attests only while the
 * runtime holding the observer's OS lease lives, so each runtime stops it before it stops serving:
 * a replacement process can then claim its own. A failure leaves the attestation omitted.
 */
export function observeLocalCredentials(): { stop(): void } {
  try { return startLocalCredentialObservation(); }
  catch { return { stop() {} }; }
}

/** Starts the observer before a server, and stops it with that server or its failed start. */
export function withLocalCredentialObservation<S extends { stop(closeActiveConnections?: boolean): Promise<void> }>(start: () => S): S {
  const observation = observeLocalCredentials();
  let server: S;
  try { server = start(); }
  catch (error) { observation.stop(); throw error; }
  const stop = server.stop.bind(server);
  Object.defineProperty(server, "stop", {
    configurable: true,
    value: async (closeActiveConnections?: boolean): Promise<void> => {
      observation.stop();
      await stop(closeActiveConnections);
    },
  });
  return server;
}
