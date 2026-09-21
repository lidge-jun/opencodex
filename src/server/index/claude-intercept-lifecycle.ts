import type { Server } from "bun";
import {
  startClaudeIntercept,
  type ClaudeInterceptHandle,
  type StartClaudeInterceptOptions,
} from "../../claude/intercept/runtime";

/**
 * Owns the Claude intercept pair (CONNECT proxy + TLS listener) on behalf of `startServer`.
 * The pair is an optional integration: a bind failure degrades to a warning, never to a
 * startup failure, because every other client keeps working without it. `startServer` stays
 * synchronous, so the start is fire-and-forget and `stop()` awaits whatever it produced.
 */
export interface ClaudeInterceptLifecycle<T> {
  /** True once the TLS listener has bound and `requestServer` is it. */
  ownsListener(requestServer: Server<T>): boolean;
  start(options: StartClaudeInterceptOptions<T>): void;
  stop(): Promise<void>;
}

export function createClaudeInterceptLifecycle<T>(): ClaudeInterceptLifecycle<T> {
  let listener: Server<T> | null = null;
  let pending: Promise<ClaudeInterceptHandle<T> | null> = Promise.resolve(null);
  return {
    ownsListener: requestServer => listener !== null && requestServer === listener,
    start(options) {
      const dispatch = options.dispatch;
      pending = startClaudeIntercept<T>({
        ...options,
        dispatch: (req, requestServer) => {
          listener ??= requestServer;
          return dispatch(req, requestServer);
        },
      }).then(handle => {
        if (handle) {
          listener = handle.listener;
          console.log(`🔐 Claude intercept proxy active on http://127.0.0.1:${handle.proxyPort} (CONNECT api.anthropic.com → local TLS)`);
        }
        return handle;
      }).catch((error: unknown) => {
        console.warn(`⚠ Claude intercept proxy could not start: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    },
    async stop() {
      await (await pending)?.stop();
    },
  };
}
