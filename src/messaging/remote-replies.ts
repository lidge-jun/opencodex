import { exactRecord, remoteError, type RemotePeer } from "./remote-contract";
import type { RemoteMessageStore } from "./remote-store";
import type { messageEnvelope } from "./envelope";
import { isThreadId } from "./types";

interface ReplyGrant {
  peer: string;
  transaction: string;
  thread: string;
  expires: number;
  busy: boolean;
}
export const REPLY_GRANT_LIMIT = 256;
export const REPLY_GRANT_MS = 24 * 60 * 60 * 1000;

/** Owner-lifetime, bounded return routes; enrollment alone never authorizes unrelated return traffic. */
export class RemoteReplyGrants {
  private readonly grants = new Map<string, ReplyGrant>();
  constructor(private readonly store: RemoteMessageStore, private readonly now = () => performance.now()) {}

  private current(peer: RemotePeer) {
    return this.store.requireEnabled().peers.find(item => item.machine.id === peer.machine.id
      && item.transaction === peer.transaction && item.incoming === peer.incoming && item.outgoing === peer.outgoing);
  }
  private prune() {
    const peers = this.store.requireEnabled().peers;
    for (const [id, grant] of this.grants) {
      if (grant.expires <= this.now() || !peers.some(peer =>
        peer.machine.id === grant.peer && peer.transaction === grant.transaction)) {
        this.grants.delete(id);
      }
    }
  }
  /** Local-control only: register before dispatch, forget only on definite request non-submission. */
  control(value: unknown) {
    const raw = exactRecord(value, ["peerId", "transaction", "messageId", "threadId", "action"]);
    if (![raw.peerId, raw.transaction, raw.messageId, raw.threadId].every(isThreadId)
      || !["open", "forget"].includes(String(raw.action))) {
      throw remoteError("invalid_reply_route", "Invalid reply route registration.");
    }
    const peer = this.store.peer(raw.peerId as string);
    if (peer.transaction !== raw.transaction) {
      throw remoteError("peer_revoked", "Reply route enrollment changed.");
    }
    this.prune();
    const id = raw.messageId as string;
    if (raw.action === "forget") {
      const existing = this.grants.get(id);
      if (existing && (existing.peer !== raw.peerId || existing.transaction !== raw.transaction
        || existing.thread !== raw.threadId || existing.busy)) {
        throw remoteError("invalid_reply_route", "Reply route is not removable.");
      }
      this.grants.delete(id);
      return { registered: false };
    }
    if (this.grants.has(id) || this.grants.size >= REPLY_GRANT_LIMIT) {
      throw remoteError("remote_capacity", "The owner's bounded reply-route capacity was reached; no new request was dispatched.");
    }
    this.grants.set(id, { peer: peer.machine.id, transaction: peer.transaction, thread: raw.threadId as string,
      expires: this.now() + REPLY_GRANT_MS, busy: false });
    return { registered: true };
  }
  /** Response-only peers can discover only the original local senders awaiting their response. */
  visible(peer: RemotePeer, thread: string): boolean {
    this.prune();
    const current = this.current(peer);
    return !!current && (current.allowInbound === true || [...this.grants.values()].some(grant =>
      grant.peer === peer.machine.id && grant.transaction === peer.transaction && grant.thread === thread && !grant.busy));
  }
  /** Reserve synchronously before native dispatch; an uncertain response consumes its grant, never replays it. */
  begin(peer: RemotePeer, header: ReturnType<typeof messageEnvelope>["header"], thread: string) {
    this.prune();
    const current = this.current(peer);
    if (!current) {
      throw remoteError("peer_revoked", "Message enrollment changed before dispatch.");
    }
    const grant = header.kind === "response" && header.inReplyTo ? this.grants.get(header.inReplyTo) : undefined;
    if (!grant || grant.peer !== peer.machine.id || grant.transaction !== peer.transaction
      || grant.thread !== thread) {
      if (current.allowInbound === true) {
        return (_submitted: boolean) => {};
      }
      throw remoteError("reply_route_required", "This peer may send only a correlated response to an opened local reply route.");
    }
    if (grant.busy) {
      throw remoteError("reply_route_required", "A correlated response is already in flight on this reply route.");
    }
    // Broad consent may allow unrelated traffic, but a matching response still spends its one-shot grant.
    grant.busy = true;
    return (submitted: boolean) => {
      if (submitted) {
        this.grants.delete(header.inReplyTo!);
      } else {
        grant.busy = false;
      }
    };
  }
}
