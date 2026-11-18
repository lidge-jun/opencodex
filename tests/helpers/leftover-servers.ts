import { startServer as startServerUntracked } from "../../src/server";

type StartedServer = ReturnType<typeof startServerUntracked>;

/**
 * `startServer` for a file whose cases stop their own server in `finally`. Bun abandons a case
 * that times out without running that `finally`, so its listener and spend-ledger owner stay live
 * and every later `startServer` in the file fails with SPEND_LEDGER_OWNER_HOME_CONFLICT. Await
 * `stopLeftoverServers()` from `afterEach` to stop whatever a case left running; a case's own
 * later `stop()` shares the same settlement instead of tearing the server down twice.
 */
export function createServerTracker() {
  const live = new Set<StartedServer>();
  const startServer: typeof startServerUntracked = (...args) => {
    const server = startServerUntracked(...args);
    const stop = server.stop.bind(server);
    let stopping: Promise<void> | undefined;
    live.add(server);
    Object.defineProperty(server, "stop", {
      configurable: true,
      value: (closeActiveConnections?: boolean): Promise<void> => {
        live.delete(server);
        return stopping ??= Promise.resolve(stop(closeActiveConnections));
      },
    });
    return server;
  };
  const stopLeftoverServers = async (): Promise<void> => {
    for (const server of [...live]) await server.stop(true);
  };
  return { startServer, stopLeftoverServers };
}
