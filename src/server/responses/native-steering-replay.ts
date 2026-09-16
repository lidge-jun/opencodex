/**
 * Connection-local replay journal. Only input committed by response.created enters
 * a successor's prefix. Uncommitted/rejected steering never enters the shared
 * continuation cache. Bodies are bounded and discarded at connection teardown.
 */
export const MAX_NATIVE_STEERING_REPLAY_BYTES = 32 * 1024 * 1024;
type Frame = Record<string, unknown>;
function record(value: unknown): value is Frame {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function inputItems(input: unknown): unknown[] {
  if (typeof input === "string") return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  return Array.isArray(input) ? input : [];
}
export interface NativeSteeringReplayObserver {
  submitted(frame: Frame): () => void;
  observe(frame: Frame): void;
  dispose(): void;
}

export class NativeSteeringReplay implements NativeSteeringReplayObserver {
  private prefix: unknown[];
  private bytes: number;
  private current?: string;
  private previousOutput: unknown[] = [];
  private outputItems = new Map<number, unknown>();
  private submissions: Array<{ parent: string; input: unknown[]; id?: string; bytes: number }> = [];
  private explicitInput: unknown[] = [];
  private explicitBytes = 0;

  constructor(input: unknown, private readonly remember: (input: unknown[], response: Frame) => void) {
    this.prefix = [...inputItems(input)];
    this.bytes = Buffer.byteLength(JSON.stringify(this.prefix));
    this.check();
  }
  private check(): void {
    if (this.bytes > MAX_NATIVE_STEERING_REPLAY_BYTES) throw new Error("Native steering replay exceeded its bounded history budget; input was not silently truncated.");
  }
  submitted(frame: Frame): () => void {
    const input = inputItems(frame.input);
    const bytes = Buffer.byteLength(JSON.stringify(input));
    this.bytes += bytes;
    try { this.check(); } catch (error) { this.bytes -= bytes; throw error; }
    if (frame.type === "response.steer") {
      const submission = { parent: String(frame.previous_response_id), input, bytes };
      this.submissions.push(submission);
      return () => {
        const index = this.submissions.indexOf(submission);
        if (index >= 0) { this.submissions.splice(index, 1); this.bytes -= bytes; }
      };
    }
    this.explicitInput = input;
    this.explicitBytes = bytes;
    return () => { this.explicitInput = []; this.bytes -= this.explicitBytes; this.explicitBytes = 0; };
  }
  observe(frame: Frame): void {
    const response = record(frame.response) ? frame.response : undefined;
    const steer = record(frame.steer) ? frame.steer : undefined;
    if (frame.type === "response.steer.accepted") {
      const first = this.submissions.find(item => item.parent === steer?.previous_response_id && item.id === undefined);
      if (!first || typeof steer?.id !== "string") throw new Error("Native steering replay acceptance does not match submitted input");
      first.id = steer.id;
    } else if (frame.type === "response.steer.failed") {
      const index = this.submissions.findIndex(item => steer?.id !== undefined
        ? item.id === steer.id
        : item.parent === steer?.previous_response_id && item.id === undefined);
      if (index >= 0) {
        const [failed] = this.submissions.splice(index, 1);
        this.bytes -= failed.bytes;
      }
    } else if (frame.type === "response.created") {
      if (this.current) {
        const committed = this.submissions.filter(item => item.parent === this.current && item.id !== undefined);
        this.prefix.push(...this.previousOutput, ...committed.flatMap(item => item.input), ...this.explicitInput);
        this.submissions = this.submissions.filter(item => !committed.includes(item));
      }
      this.explicitInput = [];
      this.explicitBytes = 0;
      this.previousOutput = [];
      this.outputItems.clear();
      this.current = String(response?.id);
    } else if (frame.type === "response.output_item.done" && Number.isSafeInteger(frame.output_index)) {
      const index = frame.output_index as number;
      if (index < 0 || index > 10_000 || !record(frame.item)) throw new Error("Native steering replay output identity is invalid");
      const previous = this.outputItems.get(index);
      if (previous !== undefined) this.bytes -= Buffer.byteLength(JSON.stringify(previous));
      this.bytes += Buffer.byteLength(JSON.stringify(frame.item));
      this.check();
      this.outputItems.set(index, frame.item);
    } else if (response && ["response.completed", "response.incomplete", "response.failed"].includes(String(frame.type))) {
      const doneItems = [...this.outputItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
      const output = Array.isArray(response.output) && response.output.length ? response.output : doneItems;
      for (const item of doneItems) this.bytes -= Buffer.byteLength(JSON.stringify(item));
      this.bytes += Buffer.byteLength(JSON.stringify(output));
      this.check();
      this.outputItems.clear();
      this.previousOutput = output;
      // Failed and steered parents are never presented to shared state as completed.
      // Their output is used only when a validated successor commits that prefix.
      if (frame.type === "response.completed") this.remember(this.prefix, { ...response, output });
    }
  }
  dispose(): void {
    this.prefix = [];
    this.previousOutput = [];
    this.submissions = [];
    this.explicitInput = [];
    this.outputItems.clear();
    this.bytes = 0;
  }
}
