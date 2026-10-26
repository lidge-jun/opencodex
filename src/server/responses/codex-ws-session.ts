import { readCodexWsUpgradeHeaders } from "./codex-ws-metadata";

export const MAX_CODEX_WS_SESSION_EXCHANGES = 32;
export const CODEX_WS_SESSION_CLOSE_GRACE_MS = 1_000;

/** A disposed lease must not leave a private socket waiting on an unresponsive peer. */
function closeSessionSocket(socket: WebSocket & { terminate?: () => void }, immediate: boolean): void {
  if (immediate) {
    // Preserve the retained pool's immediate physical-capacity release.
    try { socket.close(); } catch { /* already closing */ }
    try { socket.terminate?.(); } catch { /* already closed */ }
    return;
  }
  if (socket.readyState === 3) return;
  if (typeof socket.terminate !== "function") {
    // A close observer cannot force teardown without the optional native method.
    try { socket.close(); } catch { /* best-effort graceful teardown */ }
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    socket.removeEventListener("close", cleanup);
  };
  const terminate = (): void => {
    cleanup();
    if (socket.readyState !== 3) {
      try { socket.terminate?.(); } catch { /* best-effort physical teardown */ }
    }
  };
  // Install before close(): older runtimes and test peers may close synchronously.
  // Capture only the socket, not the disposed session or its former exchange owner.
  socket.addEventListener("close", cleanup, { once: true });
  timer = setTimeout(terminate, CODEX_WS_SESSION_CLOSE_GRACE_MS);
  timer.unref?.();
  try { socket.close(); } catch { terminate(); }
  // close() may synchronously change the state narrowed by the earlier guard.
  if ((socket.readyState as number) === 3) cleanup();
}

/** Owns one physical socket; request listeners belong to the exchange, not this object. */
export class CodexWsSession {
  readonly socket: WebSocket;
  opened = false;
  closed = false;
  busy = false;
  private owner?: (reason: Error) => void;
  private readonly completedIds = new Set<string>();
  private pendingUpgradeHeaders?: Headers;
  private connectionHeaders?: Headers;

  constructor(url: string, headers: Record<string, string>, readonly retainable = false,
    private readonly changed: () => void = () => {}, proxy?: string) {
    this.socket = new WebSocket(url, { headers, ...(proxy ? { proxy } : {}) } as unknown as string[]);
    this.socket.addEventListener("handshake", this.onHandshake);
    this.socket.addEventListener("open", this.onOpen);
    this.socket.addEventListener("message", this.onIdleMessage);
    this.socket.addEventListener("close", this.onClose);
    this.socket.addEventListener("error", this.onIdleError);
  }

  get reused(): boolean { return this.completedIds.size > 0; }
  hasCompleted(id: string): boolean { return this.completedIds.has(id); }
  upgradeHeaders(): Headers { return new Headers(this.opened && !this.closed ? this.connectionHeaders : undefined); }

  reserve(): boolean {
    if (this.closed || this.busy || (this.opened && this.socket.readyState !== undefined && this.socket.readyState !== 1)) return false;
    this.busy = true;
    const socket = this.socket as WebSocket & { ref?: () => void };
    try { socket.ref?.(); } catch { /* optional keepalive hint */ }
    return true;
  }

  bindOwner(owner: (reason: Error) => void): () => void {
    if (!this.busy || this.closed || this.owner) throw new Error("codex websocket lease is unavailable");
    this.owner = owner;
    return () => { if (this.owner === owner) this.owner = undefined; };
  }

  release(completedId: string | null): void {
    this.owner = undefined;
    if (this.closed) return;
    if (!this.retainable || !completedId || !this.opened
      || (this.socket.readyState !== undefined && this.socket.readyState !== 1)) {
      this.dispose();
      return;
    }
    this.completedIds.add(completedId);
    if (this.completedIds.size >= MAX_CODEX_WS_SESSION_EXCHANGES) {
      this.dispose();
      return;
    }
    this.busy = false;
    const socket = this.socket as WebSocket & { unref?: () => void };
    try { socket.unref?.(); } catch { /* optional hint; shutdown/expiry still owns cleanup */ }
    this.changed();
  }

  dispose(reason = new Error("codex websocket session disposed")): void {
    if (this.closed) return;
    this.closed = true;
    const owner = this.owner;
    this.owner = undefined;
    this.detach();
    try { owner?.(reason); } finally {
      this.busy = false;
      this.completedIds.clear();
      closeSessionSocket(this.socket, this.retainable);
      this.changed();
    }
  }

  private onHandshake = (event: Event): void => {
    if (this.opened || this.closed) return;
    this.pendingUpgradeHeaders = readCodexWsUpgradeHeaders((event as MessageEvent<unknown>).data);
  };
  private onOpen = (): void => {
    if (this.closed) return;
    // A 101 payload alone is not proof that Bun accepted the handshake.
    this.connectionHeaders = this.pendingUpgradeHeaders;
    this.pendingUpgradeHeaders = undefined;
    this.socket.removeEventListener("handshake", this.onHandshake);
    this.opened = true;
  };
  private onIdleMessage = (): void => {
    if (!this.busy) this.dispose(new Error("codex websocket received unsolicited idle data"));
  };
  private onIdleError = (): void => { if (!this.busy) this.dispose(); };
  private onClose = (): void => {
    this.closed = true;
    this.busy = false;
    this.completedIds.clear();
    this.detach();
    this.changed();
    // The active exchange's close listener retains pre-send fallback semantics.
  };
  private detach(): void {
    this.pendingUpgradeHeaders = undefined;
    this.connectionHeaders = undefined;
    this.socket.removeEventListener("handshake", this.onHandshake);
    this.socket.removeEventListener("open", this.onOpen);
    this.socket.removeEventListener("message", this.onIdleMessage);
    this.socket.removeEventListener("close", this.onClose);
    this.socket.removeEventListener("error", this.onIdleError);
  }
}
