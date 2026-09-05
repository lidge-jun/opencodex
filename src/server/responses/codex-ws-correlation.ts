export const CODEX_WS_ID_MAX_BYTES = 4096;
export const CODEX_WS_MAX_TRACKED_ITEMS = 10_000;
const MAX_TRACKED_ID_BYTES = 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
    && Buffer.byteLength(value) <= CODEX_WS_ID_MAX_BYTES;
}

/** A cold incompatible response may finish one-shot; a reused socket cannot mix owners. */
export class CodexWsCorrelation {
  private responseId: string | null = null;
  private reusable = true;
  private readonly items = new Set<string>();
  private itemBytes = 0;

  constructor(private readonly strict: boolean, private readonly previouslyCompleted: (id: string) => boolean) {}

  private mismatch(): void {
    this.reusable = false;
    if (this.strict) throw new Error("codex websocket response identity mismatch");
  }

  accept(event: Record<string, unknown>): void {
    if (event.stream_id !== undefined) { this.mismatch(); return; }
    if (event.type === "error") return;
    const response = record(event.response) ? event.response : undefined;
    if (event.type === "response.created") {
      const next = response?.id;
      if (!id(next) || this.responseId !== null || this.previouslyCompleted(next)) {
        this.mismatch();
        return;
      }
      this.responseId = next;
      return;
    }
    if (!this.responseId) { this.mismatch(); return; }
    if ((response && response.id !== this.responseId)
      || (event.response_id !== undefined && event.response_id !== this.responseId)) this.mismatch();
    const item = record(event.item) ? event.item : undefined;
    if (event.type === "response.output_item.added") {
      if (!id(item?.id) || this.items.has(item.id)) { this.mismatch(); return; }
      this.itemBytes += Buffer.byteLength(item.id);
      if (this.items.size >= CODEX_WS_MAX_TRACKED_ITEMS || this.itemBytes > MAX_TRACKED_ID_BYTES) {
        throw new Error("codex websocket correlation exceeds its bounded item budget");
      }
      this.items.add(item.id);
      return;
    }
    const itemId = event.item_id ?? item?.id;
    if (itemId !== undefined && (!id(itemId) || !this.items.has(itemId))) this.mismatch();
    if (typeof event.type === "string" && event.type.endsWith(".delta") && itemId === undefined) this.mismatch();
  }

  completed(event: Record<string, unknown>): string | null {
    const response = record(event.response) ? event.response : undefined;
    return this.reusable && event.type === "response.completed" && response?.status === "completed"
      && response.id === this.responseId ? this.responseId : null;
  }

  finish(): void { this.items.clear(); this.itemBytes = 0; }
}
