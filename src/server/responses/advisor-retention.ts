import { jsonUtf8Bytes } from "../../lib/json-byte-size";
import {
  TRANSLATOR_MAX_TURN_BYTES,
  TranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../../lib/translator-budget";
import type { AdapterEvent, OcxMessage, OcxUsage } from "../../types";
import { mergeUsage } from "./terminal-guard";

export const MAX_ADVISOR_RETAINED_EVENTS = 4_096;
export const MAX_ADVISOR_RETAINED_CALLS = 1_024;

/** Independent ownership: never borrow the bridge's event or tool-call leases. */
export class AdvisorRetention {
  private legBytes = 0;
  private historyBytes = 0;
  private copyBytes = 0;
  private usageBytes = 0;
  private events = 0;
  private calls = 0;

  constructor(private readonly shared?: TranslatorBudget) {}

  private charge(bytes: number, kind: "retained_collectors" | "request_copies"): void {
    if (bytes > TRANSLATOR_MAX_TURN_BYTES - this.legBytes - this.historyBytes - this.copyBytes - this.usageBytes) {
      throw new TranslatorBudgetExceededError(kind, TRANSLATOR_MAX_TURN_BYTES);
    }
    this.shared?.chargeRetained(bytes, { kind });
  }

  /** Usage can alias a terminal payload. Keep its own owner after the raw leg ends. */
  usage(first: OcxUsage | undefined, second: OcxUsage | undefined): OcxUsage | undefined {
    if (!second) return first;
    // Two-input merge materializes a new object. Reserve before merging, including
    // a conservative bound for concatenation if a provider supplied malformed scalars.
    const bytes = first
      ? (jsonUtf8Bytes(first) + jsonUtf8Bytes(second)) * 2 + 256
      : jsonUtf8Bytes(second) + 1;
    this.charge(bytes, "request_copies");
    this.copyBytes += bytes;
    let retained = 0;
    try {
      const merged = mergeUsage(first, second);
      const measured = jsonUtf8Bytes(merged, bytes) + 1;
      if (measured > bytes) throw new TranslatorBudgetExceededError("request_copies", TRANSLATOR_MAX_TURN_BYTES);
      retained = measured;
      const previous = this.usageBytes;
      this.usageBytes = retained;
      this.shared?.releaseRetained(previous, { kind: "request_copies" });
      return merged;
    } finally {
      this.copyBytes -= bytes;
      this.shared?.releaseRetained(bytes - retained, { kind: "request_copies" });
    }
  }

  /**
   * `counted: false` is only for non-empty text/thinking deltas: the leg's 16 KiB character
   * caps already bound how many of those can be held, and an ordinary long answer streams
   * thousands of them. They still consume bytes.
   */
  retain(event: AdapterEvent, call = false, counted = true): void {
    if ((counted && this.events >= MAX_ADVISOR_RETAINED_EVENTS) || (call && this.calls >= MAX_ADVISOR_RETAINED_CALLS)) {
      throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
    }
    const bytes = jsonUtf8Bytes(event) + 1;
    this.charge(bytes, "retained_collectors");
    this.legBytes += bytes;
    if (counted) this.events++;
    if (call) this.calls++;
  }

  /** Hold a bounded materialization while its raw sources are still retained. */
  copy<T>(bytes: number, build: () => T): T {
    this.charge(bytes, "request_copies");
    this.copyBytes += bytes;
    try { return build(); }
    finally {
      this.copyBytes -= bytes;
      this.shared?.releaseRetained(bytes, { kind: "request_copies" });
    }
  }

  /** Reserve before constructing replay JSON; transfer the reservation to history. */
  history<T extends OcxMessage | undefined>(bytes: number, build: () => T): T {
    this.charge(bytes, "request_copies");
    this.copyBytes += bytes;
    let retained = 0;
    try {
      const message = build();
      const measured = message ? jsonUtf8Bytes(message, bytes) + 1 : 0;
      if (measured > bytes) throw new TranslatorBudgetExceededError("request_copies", TRANSLATOR_MAX_TURN_BYTES);
      retained = measured;
      this.historyBytes += retained;
      return message;
    } finally {
      this.copyBytes -= bytes;
      this.shared?.releaseRetained(bytes - retained, { kind: "request_copies" });
    }
  }

  /** Event envelopes dominate the replay content; allow new message/call framing too. */
  replayReservation(): number { return this.legBytes + (this.calls + 1) * 256; }

  releaseLeg(): void {
    this.shared?.releaseRetained(this.legBytes, { kind: "retained_collectors" });
    this.legBytes = this.events = this.calls = 0;
  }

  release(): void {
    this.releaseLeg();
    this.shared?.releaseRetained(this.historyBytes, { kind: "request_copies" });
    this.historyBytes = 0;
    this.shared?.releaseRetained(this.usageBytes, { kind: "request_copies" });
    this.usageBytes = 0;
  }
}
