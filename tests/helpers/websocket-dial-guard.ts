/**
 * Refuses and records every `WebSocket` a case constructs. Fetch mocks cannot intercept
 * `new WebSocket(...)`: a streamed turn to the canonical ChatGPT URL otherwise dials the live
 * wss://chatgpt.com and waits on the network for up to the 10 s upgrade deadline before falling back
 * to the mocked HTTP lane. Such providers set `upstreamWebsocket: false`; `restore()` returns the
 * refused dials so the case that made one fails instead of depending on the network.
 */
export function guardWebSocketDials(): { restore(): string[] } {
  const Real = globalThis.WebSocket;
  const dials: string[] = [];
  function RefusedWebSocket(url: string | URL): never {
    dials.push(String(url));
    throw new Error(`unexpected WebSocket dial to ${String(url)}`);
  }
  // Static readyState constants (WebSocket.OPEN, ...) stay readable through the prototype chain.
  Object.setPrototypeOf(RefusedWebSocket, Real);
  globalThis.WebSocket = RefusedWebSocket as unknown as typeof WebSocket;
  return { restore() { globalThis.WebSocket = Real; return dials.splice(0); } };
}
