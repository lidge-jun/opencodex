import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import type { OAuthController } from "./types";

export function m365BrowserExecutable(): string {
  let preferred = "";
  try {
    preferred = process.platform === "win32"
      ? execFileSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"], { encoding: "utf8", windowsHide: true, timeout: 2_000 })
      : process.platform === "linux"
        ? execFileSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8", timeout: 2_000 })
        : execFileSync("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"], { encoding: "utf8", timeout: 2_000 });
  } catch {}
  const candidates = process.platform === "win32" ? [
    join(process.env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    join(process.env.PROGRAMFILES ?? "C:/Program Files", "Microsoft/Edge/Application/msedge.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Microsoft/Edge/Application/msedge.exe"),
    join(process.env.PROGRAMFILES ?? "C:/Program Files", "Mozilla Firefox/firefox.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Mozilla Firefox/firefox.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Programs/Mozilla Firefox/firefox.exe"),
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
  ] : [Bun.which("google-chrome"), Bun.which("chromium"), Bun.which("chromium-browser"), Bun.which("microsoft-edge"), Bun.which("firefox")];
  const selected = /firefox/i.test(preferred) ? "firefox" : /edge/i.test(preferred) ? "edge" : /chrome|chromium/i.test(preferred) ? "chrome" : "";
  if (selected) candidates.sort((a, b) => Number(!!b?.toLowerCase().includes(selected)) - Number(!!a?.toLowerCase().includes(selected)));
  const executable = candidates.find((path): path is string => !!path && existsSync(path));
  if (!executable) throw new Error("Microsoft 365 Copilot sign-in requires Firefox, Chrome or Edge on the proxy machine");
  return executable;
}

export function m365CallbackCode(candidate: string, expectedState: string): string | undefined {
  const url = new URL(candidate);
  if (url.origin !== "https://login.microsoftonline.com" || url.pathname !== "/common/oauth2/nativeclient") return;
  if (url.searchParams.get("state") !== expectedState) throw new Error("Microsoft 365 Copilot OAuth state mismatch");
  if (url.searchParams.has("error")) throw new Error("Microsoft 365 Copilot authorization was declined");
  const code = url.searchParams.get("code");
  if (!code || code.length > 16_384) throw new Error("Microsoft 365 Copilot returned an invalid authorization code");
  return code;
}

async function removeM365BrowserProfile(profile: string): Promise<void> {
  if (!resolve(profile).startsWith(resolve(tmpdir()) + sep) || !profile.includes("ocx-m365-auth-")) throw new Error("Invalid temporary browser profile path");
  // Windows releases Firefox profile handles shortly after the browser process exits.
  for (let attempt = 0; attempt < 20; attempt++) {
    try { rmSync(profile, { recursive: true, force: true }); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" && (error as NodeJS.ErrnoException).code !== "EPERM") throw new Error("Microsoft sign-in browser profile cleanup failed");
      await Bun.sleep(100);
    }
  }
  throw new Error("Microsoft sign-in browser profile is still locked; close its window and retry");
}

class BrowserProtocol {
  private sequence = 0;
  private pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onEvent?: (method: string, params: any, sessionId?: string) => void;
  constructor(private socket: WebSocket) {
    socket.onmessage = event => {
      if (typeof event.data !== "string" || event.data.length > 2 * 1024 * 1024) { this.close(); return; }
      let message: any;
      try { message = JSON.parse(event.data); } catch { this.close(); return; }
      const call = this.pending.get(message.id);
      if (call) {
        this.pending.delete(message.id); clearTimeout(call.timer);
        if (message.error) call.reject(new Error("Microsoft 365 Copilot browser command failed: " + call.method));
        else call.resolve(message.result);
      } else if (typeof message.method === "string") this.onEvent?.(message.method, message.params, message.sessionId);
    };
    socket.onclose = () => this.rejectPending();
    socket.onerror = () => this.rejectPending();
  }
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    return new Promise((resolveCall, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Microsoft 365 Copilot browser command timed out")); }, 10_000);
      this.pending.set(id, { method, resolve: resolveCall, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("Microsoft 365 Copilot browser disconnected")); }
    });
  }
  private rejectPending() { for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error("Microsoft 365 Copilot browser disconnected")); } this.pending.clear(); }
  close() { this.socket.close(); this.rejectPending(); }
}

async function captureInBrowser(authUrl: string, expectedState: string, signal: AbortSignal, onReady: (browser: string) => void, executable = m365BrowserExecutable()): Promise<string> {
  if (executable.toLowerCase().includes("firefox")) return captureInFirefox(executable, authUrl, expectedState, signal, onReady);
  const profile = mkdtempSync(join(tmpdir(), "ocx-m365-auth-"));
  chmodSync(profile, 0o700);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let protocol: BrowserProtocol | undefined;
  try {
    child = Bun.spawn([executable, "--user-data-dir=" + profile, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore" });
    const activePort = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    while (!existsSync(activePort)) {
      signal.throwIfAborted();
      if (Date.now() > deadline || child.exitCode !== null) throw new Error("Microsoft 365 Copilot could not start its sign-in browser");
      await Bun.sleep(100);
    }
    const [port, path] = readFileSync(activePort, "utf8").trim().split(/\r?\n/);
    if (!/^\d+$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[0-9a-f-]+$/i.test(path ?? "")) {
      throw new Error("Microsoft 365 Copilot browser returned an invalid local endpoint");
    }
    const socket = new WebSocket("ws://127.0.0.1:" + port + path);
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Microsoft 365 Copilot browser connection timed out")); }, 10_000);
      socket.onopen = () => { clearTimeout(timer); resolveOpen(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("Microsoft 365 Copilot browser connection failed")); };
    });
    protocol = new BrowserProtocol(socket);
    const target = await protocol.command("Target.createTarget", { url: "about:blank" });
    const attached = await protocol.command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId as string;
    await protocol.command("Page.enable", {}, sessionId);
    await protocol.command("Fetch.enable", { patterns: [{ urlPattern: "https://login.microsoftonline.com/common/oauth2/nativeclient*", requestStage: "Request" }] }, sessionId);
    const code = new Promise<string>((resolveCode, reject) => {
      const cancel = () => reject(new Error("Microsoft 365 Copilot sign-in cancelled or expired"));
      signal.addEventListener("abort", cancel, { once: true });
      protocol!.onEvent = (method, params, eventSession) => {
        if (method !== "Fetch.requestPaused" || eventSession !== sessionId) return;
        void (async () => {
          try {
            const captured = m365CallbackCode(params.request.url, expectedState);
            if (!captured) { await protocol!.command("Fetch.continueRequest", { requestId: params.requestId }, sessionId); return; }
            // Consume the code locally before Microsoft's browser-only wrongplace warning.
            await protocol!.command("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }, { name: "Content-Security-Policy", value: "default-src 'none'" }],
              body: Buffer.from("<p>Microsoft sign-in captured. Return to OpenCodex.</p>").toString("base64") }, sessionId);
            signal.removeEventListener("abort", cancel); resolveCode(captured);
          } catch { signal.removeEventListener("abort", cancel); reject(new Error("Microsoft 365 Copilot could not validate the sign-in callback")); }
        })();
      };
    });
    onReady(executable.toLowerCase().includes("msedge") ? "Edge" : "Chrome");
    await protocol.command("Page.navigate", { url: authUrl }, sessionId);
    return await code;
  } finally {
    if (protocol) { await protocol.command("Browser.close").catch(() => {}); protocol.close(); }
    if (child && child.exitCode === null) {
      await Promise.race([child.exited, Bun.sleep(2_000)]);
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
    await removeM365BrowserProfile(profile);
  }
}

async function captureInFirefox(executable: string, authUrl: string, expectedState: string, signal: AbortSignal, onReady: (browser: string) => void): Promise<string> {
  const profile = mkdtempSync(join(tmpdir(), "ocx-m365-auth-"));
  chmodSync(profile, 0o700);
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = reservation.port; reservation.stop(true);
  const child = Bun.spawn([executable, "--no-remote", "--new-instance", "--profile", profile, "--remote-debugging-port=" + port, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let protocol: BrowserProtocol | undefined;
  try {
    const deadline = Date.now() + 15_000;
    while (!protocol) {
      signal.throwIfAborted();
      // Firefox's Windows launcher may exit successfully after starting its browser process.
      if (Date.now() > deadline || child.exitCode !== null && child.exitCode !== 0) throw new Error("Microsoft 365 Copilot could not start its Firefox sign-in window");
      const socket = new WebSocket("ws://127.0.0.1:" + port + "/session");
      const connected = await new Promise<boolean>(resolveConnected => {
        const timer = setTimeout(() => { socket.close(); resolveConnected(false); }, 500);
        socket.onopen = () => { clearTimeout(timer); resolveConnected(true); };
        socket.onerror = () => { clearTimeout(timer); resolveConnected(false); };
      });
      if (connected) protocol = new BrowserProtocol(socket);
      else { socket.close(); await Bun.sleep(100); }
    }
    const session = await protocol.command("session.new", { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
    if (session.capabilities?.browserName !== "firefox") throw new Error("Microsoft 365 Copilot browser identity mismatch");
    const target = await protocol.command("browsingContext.create", { type: "tab" });
    await protocol.command("session.subscribe", { events: ["network.beforeRequestSent"], contexts: [target.context] });
    await protocol.command("network.addIntercept", { phases: ["beforeRequestSent"], contexts: [target.context],
      urlPatterns: [{ type: "pattern", protocol: "https", hostname: "login.microsoftonline.com", pathname: "/common/oauth2/nativeclient" }] });
    let callbackCaptured = false;
    let rejectCapture!: (error: Error) => void;
    const code = new Promise<string>((resolveCode, reject) => {
      rejectCapture = reject;
      const cancel = () => reject(new Error("Microsoft 365 Copilot sign-in cancelled or expired"));
      signal.addEventListener("abort", cancel, { once: true });
      protocol!.onEvent = (method, params) => {
        if (method !== "network.beforeRequestSent" || params.context !== target.context || !params.isBlocked) return;
        void (async () => {
          try {
            const captured = m365CallbackCode(params.request.url, expectedState);
            if (!captured) { await protocol!.command("network.continueRequest", { request: params.request.request }); return; }
            callbackCaptured = true;
            void protocol!.command("network.failRequest", { request: params.request.request }).catch(() => {});
            signal.removeEventListener("abort", cancel); resolveCode(captured);
          } catch { signal.removeEventListener("abort", cancel); reject(new Error("Microsoft 365 Copilot could not validate the Firefox callback")); }
        })();
      };
    });
    onReady("Firefox");
    void protocol.command("browsingContext.navigate", { context: target.context, url: authUrl, wait: "none" }).catch(error => { if (!callbackCaptured) rejectCapture(error); });
    return await code;
  } finally {
    if (protocol) { await protocol.command("browser.close").catch(() => {}); protocol.close(); }
    await Promise.race([child.exited, Bun.sleep(2_000)]);
    if (child.exitCode === null) { child.kill(); await child.exited; }
    await removeM365BrowserProfile(profile);
  }
}

/** A managed sign-in window needs no second URL or copy/paste channel. */
export async function captureM365BrowserCode(authUrl: string, expectedState: string, ctrl: OAuthController, deps: { executable?: string } = {}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  const signal = ctrl.signal ? AbortSignal.any([ctrl.signal, controller.signal]) : controller.signal;
  try {
    signal.throwIfAborted();
    ctrl.onProgress?.("Opening the Microsoft sign-in window...");
    return await captureInBrowser(authUrl, expectedState, signal, browser => {
      ctrl.onAuth?.({ url: "", instructions: "Complete Microsoft sign-in in the " + browser + " window OpenCodex opened. The callback is captured locally; no URL copying is needed." });
    }, deps.executable);
  } finally { clearTimeout(timeout); controller.abort(); }
}
