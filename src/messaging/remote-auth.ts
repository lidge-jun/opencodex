import { MessageBudget } from "./budget";
import type { LocalSocket } from "./socket";
import { capability, exactRecord, matchesProof, peerProof, REMOTE_PROTOCOL, remoteError,
  validCapability, type RemotePeer, type RemoteState } from "./remote-contract";

export interface RemoteEndpoint { port: number; machineId: string; transaction: string; key: string }
/** Select one directional receiver-issued capability, not a provider or Remote Link credential. */
export function peerEndpoint(peer: RemotePeer, port: number): RemoteEndpoint {
  return { port, machineId: peer.machine.id, transaction: peer.transaction, key: peer.outgoing };
}
/** Authenticate the actual socket before sending a bearer-derived client proof or any native/body frame. */
export async function authenticatedRemoteSocket(state: RemoteState, endpoint: RemoteEndpoint,
  budget: MessageBudget): Promise<LocalSocket> {
  budget.throwIfEnded();
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1024 || endpoint.port > 65535) throw remoteError("invalid_port", "Invalid messaging route port.");
  const Constructor = WebSocket as unknown as { new(url: string): LocalSocket };
  const socket = new Constructor(`ws://127.0.0.1:${endpoint.port}/message`);
  const nonce = capability();
  try {
    await new Promise<void>((resolve, reject) => {
      let stage = 0;
      const cleanup = () => {
        clearTimeout(timer); budget.signal.removeEventListener("abort", abort);
        socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null;
      };
      const fail = () => { cleanup(); reject(remoteError("remote_auth_failed", "Messaging connection identity/authentication failed; no message was sent.")); };
      const abort = () => { cleanup(); reject(budget.signal.reason); };
      const timer = setTimeout(fail, budget.remainingMs(5000));
      budget.signal.addEventListener("abort", abort, { once: true });
      socket.onerror = socket.onclose = fail;
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", protocol: REMOTE_PROTOCOL,
        from: state.machine.id, to: endpoint.machineId, transaction: endpoint.transaction, nonce }));
      socket.onmessage = event => {
        try {
          if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 4096) throw new Error();
          const raw: unknown = JSON.parse(event.data);
          if (stage === 0) {
            const proof = exactRecord(raw, ["type", "nonce", "proof"]);
            if (proof.type !== "challenge" || !validCapability(proof.nonce)
              || !matchesProof(proof.proof, peerProof(endpoint.key, "server", state.machine.id, endpoint.machineId,
                endpoint.transaction, nonce, proof.nonce))) throw new Error();
            budget.throwIfEnded(); stage = 1;
            socket.send(JSON.stringify({ type: "authorize", proof: peerProof(endpoint.key, "client", state.machine.id,
              endpoint.machineId, endpoint.transaction, nonce, proof.nonce) }));
          } else {
            const ready = exactRecord(raw, ["type", "protocol"]);
            if (ready.type !== "authorized" || ready.protocol !== REMOTE_PROTOCOL) throw new Error();
            cleanup(); resolve();
          }
        } catch { fail(); }
      };
      if (budget.signal.aborted) abort();
    });
    budget.throwIfEnded(); return socket;
  } catch (error) { socket.terminate(); throw error; }
}
/** Bound a control operation to one authenticated connection; never reconnect/replay on uncertainty. */
export async function remoteControl(state: RemoteState, endpoint: RemoteEndpoint, action: string,
  params: Record<string, unknown>, budget: MessageBudget): Promise<unknown> {
  const socket = await authenticatedRemoteSocket(state, endpoint, budget);
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: unknown) => {
        clearTimeout(timer); budget.signal.removeEventListener("abort", abort);
        socket.onmessage = socket.onerror = socket.onclose = null;
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(remoteError("remote_control_unknown", "Messaging control outcome is unconfirmed; reconcile configuration before retrying."));
      const timer = setTimeout(abort, budget.remainingMs(10000));
      budget.signal.addEventListener("abort", abort, { once: true });
      socket.onclose = socket.onerror = abort;
      socket.onmessage = event => {
        try {
          if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 8192) throw new Error();
          const reply = exactRecord(JSON.parse(event.data), ["id", "result"]);
          if (reply.id !== 1) throw new Error(); finish(undefined, reply.result);
        } catch { abort(); }
      };
      if (budget.signal.aborted) { abort(); return; }
      try { socket.send(JSON.stringify({ id: 1, method: action, params })); } catch { abort(); }
    });
  } finally { socket.terminate(); }
}
