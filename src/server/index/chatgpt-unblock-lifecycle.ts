import type { ChatgptUnblockHandle, StartChatgptUnblockOptions } from "../../chatgpt/desktop-unblock/runtime";
import { chatgptPacFallbackEnabled, startChatgptUnblock } from "../../chatgpt/desktop-unblock/runtime";
import { chatgptAppCommandLine, chatgptCommandLineHasPac, chatgptCommandLineHasRule } from "../../chatgpt/desktop-unblock/launch-watcher";
import { getConfigDir } from "../../config/paths";

/**
 * Owns the ChatGPT desktop send-unblock listener on behalf of `startServer`. The listener is
 * an optional integration: a bind failure degrades to a warning, never to a startup failure,
 * because every other duty keeps working without it. `startServer` stays synchronous, so the
 * start is fire-and-forget and `stop()` awaits whatever it produced.
 *
 * Stopping cannot take the resolver switch back out of a running ChatGPT app, so a stop that
 * leaves the app routed at the now-closed port says so and names the way back to native
 * networking.
 */
export interface ChatgptUnblockLifecycle {
  start(options: StartChatgptUnblockOptions): void;
  stop(): Promise<void>;
}

export function createChatgptUnblockLifecycle<T>(): ChatgptUnblockLifecycle {
  let pending: Promise<ChatgptUnblockHandle<T> | null> = Promise.resolve(null);
  let pacMode = false;
  return {
    start(options) {
      pacMode = chatgptPacFallbackEnabled(options.config);
      pending = startChatgptUnblock<T>(options).then(handle => {
        if (handle) {
          console.log(`🔓 ChatGPT send-unblock active on https://127.0.0.1:${handle.port} (CA: ${handle.caCertPath})`);
          if (handle.entryProxy) {
            const route = handle.pacRoute === "system-pac" ? "the system PAC" : "the system proxy chain";
            console.log(`   PAC fallback on http://127.0.0.1:${handle.entryProxy.port} (other hosts, and chatgpt.com while opencodex is down, follow ${route})`);
            if (handle.pacRoute === "system-pac-unreadable") {
              console.warn("⚠ A system PAC is configured but could not be read; the generated PAC routes other hosts DIRECT until opencodex restarts with it readable.");
            }
          }
          console.log("   Launch the ChatGPT app with: ocx chatgpt launch   (or `ocx chatgpt install-watcher` for Dock launches)");
        }
        return handle;
      }).catch((error: unknown) => {
        console.warn(`⚠ ChatGPT send-unblock could not start: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    },
    async stop() {
      const handle = await pending;
      if (!handle) return;
      await handle.stop();
      warnIfAppStillRouted(handle.port, pacMode);
    },
  };
}

function warnIfAppStillRouted(port: number, pacMode: boolean): void {
  if (process.platform !== "darwin") return;
  try {
    const app = chatgptAppCommandLine();
    if (app === null) return;
    if (pacMode) {
      if (!chatgptCommandLineHasPac(app, getConfigDir())) return;
      console.warn(`⚠ The ChatGPT app is still launched with opencodex's PAC; its chatgpt.com traffic now falls through to the captured system chain.`);
      console.warn("   To return it to native networking: ocx chatgpt restore");
      return;
    }
    if (!chatgptCommandLineHasRule(app, port)) return;
    console.warn(`⚠ The ChatGPT app is still routed to port ${port}; its chatgpt.com requests fail until opencodex listens again.`);
    console.warn("   To return it to native networking: ocx chatgpt restore");
  } catch { // no-excuse-ok: catch -- a diagnostic at shutdown must never fail the stop itself.
  }
}
