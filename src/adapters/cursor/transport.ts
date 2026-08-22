import type { OcxProviderConfig } from "../../types";
import type { CursorClientMessage, CursorRunRequest, CursorServerMessage } from "./types";
import type { TranslatorBudget } from "../../lib/translator-budget";

export interface CursorTransport {
  run(request: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorServerMessage>;
  writeClient(message: CursorClientMessage): void | Promise<void>;
  close?(): void | Promise<void>;
  /**
   * Whether the run request has been committed to the wire. The retry orchestrator only re-dials
   * failures that happened BEFORE this becomes true, so a turn the Cursor server may already have
   * accepted is never replayed. Absent (undefined) is treated as "committed" — safe by default.
   */
  requestCommitted?(): boolean;
  /**
   * Last ConversationStateStructure captured from conversationCheckpointUpdate on this transport.
   * Test and adapter seams use this instead of reaching into LiveCursorTransport.
   */
  capturedConversationCheckpoint?(): Uint8Array | undefined;
}

export interface CursorTransportFactoryInput {
  provider: OcxProviderConfig;
  translatorBudget: TranslatorBudget;
  headers?: Headers;
  /** Router-prepared fetch that preserves provider overrides and per-request pacing. */
  fetch?: typeof globalThis.fetch;
  /** Pre-first-frame deadline (dial + first server frame). Defaults to 30s when omitted. */
  firstFrameTimeoutMs?: number;
  /** Grace (ms) between close() and the force-destroy fallback after a first-frame timeout. Defaults to 1s. */
  timeoutDestroyGraceMs?: number;
  /**
   * T04 watchdog: maximum inbound decoded-frame silence (ms) after the first frame before the
   * turn is failed. Defaults to 30s.
   */
  streamSilenceFailMs?: number;
  /**
   * T04 watchdog: maximum heartbeat/checkpoint-only traffic (ms) without turn progress before
   * the turn is failed. Defaults to 90s.
   */
  streamHeartbeatOnlyFailMs?: number;
  /**
   * Grace window (ms) before a drained client-tool turn is finalized, so a sibling tool call
   * announced in a later receive chunk can revoke a premature finalize. Defaults to 50ms.
   */
  clientToolFinalizeGraceMs?: number;
  /**
   * True when inbound request text carries the legacy Codex full-access sandbox marker.
   * This is retained as diagnostic/context only; exec-policy.ts does not trust it as
   * native local exec authorization because the text is caller-controlled.
   */
  requestDeclaresFullAccess?: boolean;
  /**
   * Stable Cursor Connect `x-session-id` across transport rebuilds for the same
   * client thread. Distinct from the per-transport native-exec/shell owner.
   */
  sessionId?: string;
}

export type CursorTransportFactory = (input: CursorTransportFactoryInput) => CursorTransport;

export class CursorTransportDisabledError extends Error {
  readonly code = "cursor_transport_disabled";

  constructor(message = "live Cursor transport is disabled") {
    super(message);
    this.name = "CursorTransportDisabledError";
  }
}

export function createDisabledCursorTransport(): CursorTransport {
  return {
    async *run() {
      throw new CursorTransportDisabledError();
    },
    writeClient() {},
    close() {},
  };
}
