import type { OcxConfig } from "../../types";
import type { ChatgptUnblockHandle, StartChatgptUnblockOptions } from "../../chatgpt/desktop-unblock/runtime";

/**
 * Owns the ChatGPT desktop send-unblock listener on behalf of `startServer`. The listener is
 * an optional integration: a bind failure degrades to a warning, never to a startup failure,
 * because every other duty keeps working without it. `startServer` stays synchronous, so the
 * start is fire-and-forget and `stop()` awaits whatever it produced.
 *
 * The intercept modules (TLS listener, local CA, WebSocket relay, launch watcher) load only when
 * the feature is enabled. A default install starts the server without evaluating any of them,
 * the same way the other optional subsystems stay off the core startup path.
 *
 * Stopping cannot take the resolver switch back out of a running ChatGPT app, so a stop that
 * leaves the app routed at the now-closed port says so and names the way back to native
 * networking.
 */
export interface ChatgptUnblockLifecycle {
  start(options: StartChatgptUnblockOptions): void;
  stop(): Promise<void>;
}

/** Mirrors `chatgptUnblockEnabled` without loading the runtime module to ask. */
function unblockRequested(config: Pick<OcxConfig, "chatgptDesktop" | "runtimeRole">): boolean {
  return process.platform === "darwin" && config.runtimeRole !== "client" && config.chatgptDesktop?.unblockSend === true;
}

export function createChatgptUnblockLifecycle<T>(): ChatgptUnblockLifecycle {
  let pending: Promise<ChatgptUnblockHandle<T> | null> = Promise.resolve(null);
  return {
    start(options) {
      if (!unblockRequested(options.config)) {
        pending = Promise.resolve(null);
        return;
      }
      pending = import("../../chatgpt/desktop-unblock/runtime")
        .then(runtime => runtime.startChatgptUnblock<T>(options))
        .then(handle => {
          if (handle) {
            console.log(`🔓 ChatGPT send-unblock active on https://127.0.0.1:${handle.port} (CA: ${handle.caCertPath})`);
            console.log("   Launch the ChatGPT app with: ocx chatgpt launch   (or `ocx chatgpt install-watcher` for Dock launches)");
          }
          return handle;
        })
        .catch((error: unknown) => {
          console.warn(`⚠ ChatGPT send-unblock could not start: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
    },
    async stop() {
      const handle = await pending;
      if (!handle) return;
      await handle.stop();
      await warnIfAppStillRouted(handle.port);
    },
  };
}

async function warnIfAppStillRouted(port: number): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const { chatgptAppCommandLine, chatgptCommandLineHasRule } = await import("../../chatgpt/desktop-unblock/launch-watcher");
    const app = chatgptAppCommandLine();
    if (app === null) return;
    if (!chatgptCommandLineHasRule(app, port)) return;
    console.warn(`⚠ The ChatGPT app is still routed to port ${port}; its chatgpt.com requests fail until opencodex listens again.`);
    console.warn("   To return it to native networking: ocx chatgpt restore");
  } catch { // no-excuse-ok: catch -- a diagnostic at shutdown must never fail the stop itself.
  }
}
