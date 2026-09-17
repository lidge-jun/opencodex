type Frame = Record<string, any>;
export type ProbeScenario = "automatic" | "required-input";
export type ProbeReport = {
  scenario: ProbeScenario; outcome: "passed" | "failed" | "unknown" | "not_exercised";
  accepted: boolean; successorCreated: boolean; markerObserved: boolean; explicitContinuation: boolean;
  sentControls: number; elapsedMs: number; code?: string;
};
const MARKER = "STEERING_PROBE_OK";
const safeCodes = new Set(["steering_not_supported", "response_not_active", "response_already_completed",
  "invalid_input", "steering_settings_changed", "steering_settings_unsupported", "too_many_pending_steers"]);

/** Content-free, single-attempt probe state. It never executes external tools or approval decisions. */
export class SteeringProbe {
  private base?: Frame;
  private root?: string;
  private successor?: string;
  private steerId?: string;
  private callId?: string;
  private rootEnded = false;
  private sentSteer = false;
  private reportValue?: ProbeReport;
  private bytes = 0;
  private frames = 0;
  private markerObserved = false;
  private explicit = false;
  private sentControls = 0;
  private textTail = "";
  private started = performance.now();
  constructor(readonly scenario: ProbeScenario, private readonly send: (frame: Frame) => void) {}

  /** Only fixed synthetic prompts and a non-executing tool are sent by this harness. */
  request(model: string): Frame {
    return this.base = { type: "response.create", model, store: false, reasoning: { effort: "low" },
      input: this.scenario === "automatic"
        ? "Explain five techniques for organizing a fictional book collection. Work through each in detail."
        : "Call steering_probe once, then use its saved result to answer briefly.",
      ...(this.scenario === "required-input" ? {
        tools: [{ type: "function", name: "steering_probe", description: "Returns a fixed synthetic fixture; performs no external action.",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true }],
        tool_choice: "auto",
      } : {}),
    };
  }
  private steer(): void {
    if (!this.root || this.sentSteer || this.rootEnded) return;
    this.sentSteer = true; this.sentControls++;
    this.send({ type: "response.steer", previous_response_id: this.root, input: `Change the answer: respond only with ${MARKER}. Do not run more tools.` });
  }
  /** Stop with sanitized state, never returning IDs, model output, tokens or endpoint paths. */
  finish(outcome: ProbeReport["outcome"], code?: string): ProbeReport {
    return this.reportValue ??= { scenario: this.scenario, outcome, accepted: !!this.steerId,
      successorCreated: !!this.successor, markerObserved: this.markerObserved, explicitContinuation: this.explicit,
      sentControls: this.sentControls, elapsedMs: Math.max(0, Math.round(performance.now() - this.started)), ...(code ? { code } : {}) };
  }
  get report(): ProbeReport | undefined { return this.reportValue; }

  /** Observe a bounded wire stream. Acceptance alone is never a passing probe. */
  receive(raw: string): ProbeReport | undefined {
    if (this.reportValue) return this.reportValue;
    this.bytes += Buffer.byteLength(raw);
    if (++this.frames > 5000 || this.bytes > 2 * 1024 * 1024) return this.finish("unknown", "probe_budget_exceeded");
    let event: Frame;
    try { event = JSON.parse(raw); } catch { return this.finish("failed", "invalid_event"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) return this.finish("failed", "invalid_event");
    const response = event.response;
    if (event.type === "response.created") {
      if (!response || typeof response.id !== "string" || (!response.id.length || response.id.length > 512)) return this.finish("failed", "invalid_identity");
      if (!this.root) { this.root = response.id; if (this.scenario === "automatic") this.steer(); }
      else {
        if (this.successor || response.id === this.root || !this.rootEnded || !this.steerId
          || (response.previous_response_id != null && response.previous_response_id !== this.root)) return this.finish("failed", "unexpected_successor");
        this.successor = response.id;
      }
    } else if (event.type === "response.output_item.done" && !this.successor && this.scenario === "required-input") {
      const item = event.item;
      if (event.response_id != null && event.response_id !== this.root) return this.finish("failed", "output_identity_mismatch");
      if (item?.type === "function_call" && item.name === "steering_probe" && typeof item.call_id === "string") {
        if (this.callId && item.call_id !== this.callId) return this.finish("failed", "unexpected_tool");
        this.callId = item.call_id; this.steer();
      }
    } else if (event.type === "response.steer.accepted") {
      if (!this.sentSteer || this.steerId || event.steer?.previous_response_id !== this.root || typeof event.steer?.id !== "string") {
        return this.finish("failed", "unexpected_acceptance");
      }
      this.steerId = event.steer.id;
    } else if (event.type === "response.steer.pending") {
      if (!this.steerId || event.steer?.id !== this.steerId || event.steer?.previous_response_id !== this.root || !this.rootEnded) {
        return this.finish("failed", "unexpected_pending");
      }
      if (this.explicit) return this.finish("failed", "duplicate_pending");
      const stubs = event.required_input;
      if (event.reason !== "waiting_for_required_input" || !Array.isArray(stubs) || stubs.length !== 1
        || stubs[0]?.type !== "function_call_output" || stubs[0]?.call_id !== this.callId || !this.callId) {
        return this.finish("not_exercised", "unsupported_required_input");
      }
      this.explicit = true; this.sentControls++;
      this.send({ ...this.base, type: "response.create", previous_response_id: this.root,
        ...(event.stream_id !== undefined ? { stream_id: event.stream_id } : {}),
        input: [{ type: "function_call_output", call_id: this.callId, output: "synthetic saved result; no action was executed" }],
        reasoning: { effort: "medium" }, text: { verbosity: "low" } });
    } else if (event.type === "response.steer.failed" || event.type === "error") {
      const code = event.error?.code;
      return this.finish("failed", safeCodes.has(code) ? code : "upstream_rejection");
    } else if (["response.completed", "response.incomplete", "response.failed"].includes(event.type)) {
      if (this.root && response?.id === this.root) {
        this.rootEnded = true;
        if (!this.sentSteer) return this.finish("not_exercised", "no_steering_window");
      } else if (this.successor && response?.id === this.successor) {
        for (const item of Array.isArray(response.output) ? response.output : []) {
          for (const part of Array.isArray(item?.content) ? item.content : []) if (typeof part?.text === "string" && part.text.includes(MARKER)) this.markerObserved = true;
        }
        if (event.type !== "response.completed") return this.finish("failed", "successor_not_completed");
        if (this.scenario === "required-input" && !this.explicit) return this.finish("not_exercised", "required_input_not_observed");
        return this.finish(this.markerObserved ? "passed" : "failed", this.markerObserved ? undefined : "marker_missing");
      } else return this.finish("failed", "terminal_identity_mismatch");
    } else if (event.type === "response.output_text.delta" && this.successor && typeof event.delta === "string") {
      if (event.response_id != null && event.response_id !== this.successor) return this.finish("failed", "output_identity_mismatch");
      const text = this.textTail + event.delta;
      this.markerObserved ||= text.includes(MARKER); this.textTail = text.slice(-MARKER.length);
    }
    return undefined;
  }
}
