import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { OAuthController } from "./types";
import type { M365CopilotWebSession } from "./types";
import { readM365BrowserWebSession } from "./m365-copilot-web-session";

export class M365BrowserUnavailableError extends Error {
  constructor() {
    super("Microsoft 365 Copilot managed sign-in requires a private browser pipe. Install Chrome, Chromium, or Edge on the proxy machine.");
  }
}

export function m365BrowserExecutable(): string {
  let preferred = "";
  try {
    preferred = process.platform === "win32"
      ? execFileSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"], { encoding: "utf8", windowsHide: true, timeout: 2_000 })
      : process.platform === "linux"
        ? execFileSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8", timeout: 2_000 })
        : execFileSync("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"], { encoding: "utf8", timeout: 2_000 });
  } catch { preferred = ""; }
  const candidates = process.platform === "win32" ? [
    join(process.env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    join(process.env.PROGRAMFILES ?? "C:/Program Files", "Microsoft/Edge/Application/msedge.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Microsoft/Edge/Application/msedge.exe"),
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ] : [Bun.which("google-chrome"), Bun.which("chromium"), Bun.which("chromium-browser"), Bun.which("microsoft-edge")];
  const selected = /edge/i.test(preferred) ? "edge" : /chrome|chromium/i.test(preferred) ? "chrome" : "";
  if (selected) candidates.sort((a, b) => Number(!!b?.toLowerCase().includes(selected)) - Number(!!a?.toLowerCase().includes(selected)));
  const executable = candidates.find((path): path is string => !!path && existsSync(path));
  if (!executable) throw new M365BrowserUnavailableError();
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
  // Windows can release the browser profile handles shortly after the browser process exits.
  for (let attempt = 0; attempt < 20; attempt++) {
    try { rmSync(profile, { recursive: true, force: true }); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" && (error as NodeJS.ErrnoException).code !== "EPERM") throw new Error("Microsoft sign-in browser profile cleanup failed");
      await Bun.sleep(100);
    }
  }
  throw new Error("Microsoft sign-in browser profile is still locked; close its window and retry");
}

const MAX_CDP_FRAME_BYTES = 2 * 1024 * 1024;

class BrowserProtocol {
  private sequence = 0;
  private closed = false;
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onClose?: () => void;
  onEvent?: (method: string, params: any, sessionId?: string) => void;

  constructor(private input: Writable, private output: Readable) {
    input.on("error", this.close);
    output.on("error", this.close);
    output.once("close", this.close);
    output.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  private receive(chunk: Buffer) {
    // CDP JSON frames end in a NUL byte. A pipe read or a UTF-8 character may
    // span multiple chunks, and one read can carry several complete frames.
    for (let start = 0; !this.closed && start < chunk.length;) {
      const end = chunk.indexOf(0, start);
      const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
      this.bufferedBytes += piece.length;
      if (this.bufferedBytes > MAX_CDP_FRAME_BYTES) { this.close(); return; }
      if (piece.length) this.chunks.push(piece);
      if (end < 0) return;
      const text = Buffer.concat(this.chunks, this.bufferedBytes).toString("utf8");
      this.chunks = [];
      this.bufferedBytes = 0;
      start = end + 1;
      let message: any;
      try { message = JSON.parse(text); } catch { this.close(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { this.close(); return; }
      const call = this.pending.get(message.id);
      if (call) {
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error("Microsoft 365 Copilot browser command failed: " + call.method));
        else call.resolve(message.result);
      } else if (typeof message.method === "string") this.onEvent?.(message.method, message.params, message.sessionId);
    }
  }

  command(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 10_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Microsoft 365 Copilot browser disconnected"));
    return new Promise((resolveCall, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Microsoft 365 Copilot browser command timed out")); }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveCall, reject, timer });
      try { this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); }
      catch { this.close(); }
    });
  }

  close = () => {
    if (this.closed) return;
    this.closed = true;
    this.input.destroy();
    this.output.destroy();
    this.chunks = [];
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Microsoft 365 Copilot browser disconnected"));
    }
    this.pending.clear();
    this.onClose?.();
  };
}

type BrowserSpawn = (file: string, args: string[], options: {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"];
  windowsHide: boolean;
}) => ChildProcess;

async function captureInBrowser(authUrl: string, expectedState: string, signal: AbortSignal, onReady: (browser: string) => void, executable = m365BrowserExecutable(), spawnBrowser: BrowserSpawn = spawn): Promise<{ code: string; m365: M365CopilotWebSession }> {
  if (executable.toLowerCase().includes("firefox")) throw new M365BrowserUnavailableError();
  const profile = mkdtempSync(join(tmpdir(), "ocx-m365-auth-"));
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let protocol: BrowserProtocol | undefined;
  let cancelCapture: (() => void) | undefined;
  try {
    chmodSync(profile, 0o700);
    child = spawnBrowser(executable, ["--user-data-dir=" + profile, "--remote-debugging-pipe",
      "--no-first-run", "--no-default-browser-check", "about:blank"], {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true,
    });
    const [,,, input, output] = child.stdio;
    if (input && output) protocol = new BrowserProtocol(input as Writable, output as Readable);
    exited = new Promise<void>(resolveExit => {
      const done = () => { protocol?.close(); resolveExit(); };
      child!.once("error", done);
      child!.once("exit", done);
    });
    if (!protocol) throw new Error("Microsoft 365 Copilot could not open its private browser pipe");
    signal.addEventListener("abort", protocol.close, { once: true });
    signal.throwIfAborted();
    const target = await protocol.command("Target.createTarget", { url: "about:blank" });
    const attached = await protocol.command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId as string;
    await protocol.command("Page.enable", {}, sessionId);
    await protocol.command("Fetch.enable", { patterns: [{ urlPattern: "https://login.microsoftonline.com/common/oauth2/nativeclient*", requestStage: "Request" }] }, sessionId);
    const code = new Promise<string>((resolveCode, reject) => {
      const cancel = () => reject(new Error("Microsoft 365 Copilot sign-in cancelled or expired"));
      cancelCapture = cancel;
      protocol!.onClose = cancel;
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
    onReady(executable.toLowerCase().includes("edge") ? "Edge" : "Chromium-based browser");
    const [capturedCode] = await Promise.all([code, protocol.command("Page.navigate", { url: authUrl }, sessionId)]);
    return { code: capturedCode, m365: await readM365BrowserWebSession(protocol, sessionId, signal) };
  } finally {
    if (cancelCapture) signal.removeEventListener("abort", cancelCapture);
    if (protocol) {
      signal.removeEventListener("abort", protocol.close);
      await protocol.command("Browser.close", {}, undefined, 2_000).catch(() => {});
      protocol.close();
    }
    if (child && exited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited, new Promise<void>(resolveWait => { timer = setTimeout(resolveWait, 2_000); })]);
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) { child.kill("SIGKILL"); await exited; }
      } finally { clearTimeout(timer); }
    }
    await removeM365BrowserProfile(profile);
  }
}

/** A managed sign-in window needs no second URL or copy/paste channel. */
export async function captureM365BrowserCode(authUrl: string, expectedState: string, ctrl: OAuthController, deps: { executable?: string; spawn?: BrowserSpawn } = {}): Promise<{ code: string; m365: M365CopilotWebSession }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  const signal = ctrl.signal ? AbortSignal.any([ctrl.signal, controller.signal]) : controller.signal;
  try {
    signal.throwIfAborted();
    ctrl.onProgress?.("Opening the Microsoft sign-in window...");
    return await captureInBrowser(authUrl, expectedState, signal, browser => {
      ctrl.onAuth?.({ url: "", instructions: "Complete Microsoft sign-in in the " + browser + " window OpenCodex opened. Keep it open while Copilot loads its model picker. The callback and web session are captured locally." });
    }, deps.executable, deps.spawn);
  } finally { clearTimeout(timeout); controller.abort(); }
}
