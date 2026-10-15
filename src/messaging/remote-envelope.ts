import { messageEnvelope } from "./envelope";
import { isRecord } from "./types";
import { remoteError, type RemotePeer } from "./remote-contract";

/** Accept only the canonical wrapper bound to this authenticated enrollment and queue UUID. */
export function receiveRemoteEnvelope(text: string, messageId: string, peer: RemotePeer) {
  const prefix = "[opencodex-message ";
  const end = text.indexOf("]\n\n");
  const marker = "\n\nPeer-provided message body follows:\n\n";
  const bodyStart = text.indexOf(marker, end);
  try {
    if (!text.startsWith(prefix) || end < prefix.length || bodyStart < end) {
      throw new Error("Invalid message envelope framing.");
    }
    const header: unknown = JSON.parse(text.slice(prefix.length, end));
    if (!isRecord(header) || header.messageId !== messageId) {
      throw new Error("Message envelope header does not match the queue UUID.");
    }
    if (header.threadId !== null && typeof header.threadId !== "string") {
      throw new Error("Invalid message envelope sender thread.");
    }
    if (header.name !== null && (typeof header.name !== "string" || header.name.length > 4096)) {
      throw new Error("Invalid message envelope sender name.");
    }
    const sender = header.threadId === null ? null : {
      id: header.threadId as string, name: header.name as string | null, status: "idle" as const,
    };
    const envelope = messageEnvelope(messageId, {
      kind: header.kind as "request" | "response" | "notification",
      ...(header.inReplyTo === null ? {} : { inReplyTo: header.inReplyTo as string }),
    }, text.slice(bodyStart + marker.length), sender, peer.machine);
    // This also rejects forged reply commands/hosts, missing guidance, duplicate JSON keys and extra fields.
    if (envelope.text !== text) {
      throw new Error("Message envelope is not canonical for the authenticated peer.");
    }
    return envelope;
  } catch {
    throw remoteError("invalid_remote_envelope", "Remote message attribution or guidance does not match the authenticated peer.");
  }
}
