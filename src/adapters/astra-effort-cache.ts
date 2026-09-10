import { createHash } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { withAstraEffortState } from "./astra-effort-state";

// Explicit protocol gate; keep aligned with PROVIDER_REGISTRY openai-apikey.models/modelReasoningEfforts["gpt-6-astra"].
const ASTRA_MODEL = "gpt-6-astra";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MAX_SNAPSHOTS = 256;
const MAX_ITEMS = 20_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;

type RecordValue = Record<string, unknown>;
type Update = { position: number; effort: string };
type Snapshot = { prefix: string; length: number; envelope: string; baseline: string; effective: string; updates: Update[] };
type State = { version: 1; snapshots: Snapshot[] };

export interface AstraEffortResult {
  body: unknown;
  status: string;
  baseline?: string;
  effective?: string;
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function effort(value: unknown): value is string {
  return typeof value === "string" && EFFORTS.has(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validState(value: unknown): value is State {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.snapshots) || value.snapshots.length > MAX_SNAPSHOTS) return false;
  return value.snapshots.every(s => record(s) && typeof s.prefix === "string" && /^[a-f0-9]{64}$/.test(s.prefix)
    && typeof s.envelope === "string" && /^[a-f0-9]{64}$/.test(s.envelope)
    && Number.isSafeInteger(s.length) && Number(s.length) > 0 && Number(s.length) <= MAX_ITEMS
    && effort(s.baseline) && effort(s.effective) && Array.isArray(s.updates) && s.updates.length <= Number(s.length)
    && s.updates.every((u, i, all) => record(u) && Number.isSafeInteger(u.position) && Number(u.position) >= 0
      && Number(u.position) < Number(s.length) && effort(u.effort)
      && (i === 0 || Number(u.position) > Number(all[i - 1].position)))
    && (s.updates.at(-1)?.effort ?? s.baseline) === s.effective);
}

function unsupported(body: RecordValue, original: unknown, headers: Headers): string | undefined {
  if (body.model !== ASTRA_MODEL) return "unsupported_model";
  if (!record(body.reasoning) || !effort(body.reasoning.effort)) return "unsupported_effort";
  if (body.reasoning.mode !== undefined && body.reasoning.mode !== "standard") return "unsupported_mode";
  if (headers.has("x-openai-subagent") || body.multi_agent !== undefined || body.agents !== undefined) return "multi_agent";
  if (record(original) && (original.truncation === "auto" || original.context_management !== undefined)) return "automatic_context_management";
  if (!Array.isArray(body.input) || body.input.length === 0 || body.input.length > MAX_ITEMS) return "unsupported_input";
  if (body.input.some(i => !record(i))) return "unsupported_input";
  if (body.input.some(i => ["compaction", "context_compaction", "compaction_trigger"].includes(i.type))) return "compaction";
  if (body.input.some(i => ["agent_message", "multi_agent_call", "multi_agent_call_output"].includes(i.type))) return "multi_agent";
  if (Array.isArray(body.tools) && body.tools.some(t => record(t) && t.type === "multi_agent")) return "multi_agent";
  return undefined;
}

function transform(body: RecordValue, state: State): AstraEffortResult & { snapshot?: Snapshot } {
  const input = body.input as RecordValue[];
  const requested = (body.reasoning as RecordValue).effort as string;
  const { input: _input, reasoning, stream: _stream, client_metadata: _client, metadata: _metadata, ...envelope } = body;
  const { effort: _effort, ...reasoningRest } = reasoning as RecordValue;
  const envelopeHash = digest(JSON.stringify({ ...envelope, reasoning: reasoningRest }));
  const prefixes = [digest("")];
  for (const item of input) prefixes.push(digest(prefixes.at(-1)! + JSON.stringify(item)));
  const prefix = prefixes.at(-1)!;
  const candidates = state.snapshots.filter(s => s.envelope === envelopeHash && s.length <= input.length && prefixes[s.length] === s.prefix);
  const longest = Math.max(0, ...candidates.map(s => s.length));
  const matches = candidates.filter(s => s.length === longest);
  const histories = new Set(matches.map(s => JSON.stringify([s.baseline, s.effective, s.updates])));
  if (histories.size > 1) return { body, status: "ambiguous_history", effective: requested, baseline: requested };
  const prior = matches[0];
  if (prior?.length === input.length && prior.effective !== requested) {
    return { body, status: "conflicting_retry", effective: requested, baseline: requested };
  }
  if (prior?.updates.some(u => input[u.position]?.role !== "user"
    || (input[u.position]?.type !== undefined && input[u.position]?.type !== "message"))) {
    return { body, status: "invalid_state", effective: requested, baseline: requested };
  }
  const baseline = prior?.baseline ?? requested;
  const updates = prior ? prior.updates.map(u => ({ ...u })) : [];
  let status = prior ? "replay" : "baseline_reset";
  if (prior && prior.effective !== requested) {
    const nextUser = input.findLastIndex((item, i) => i >= prior.length && item.role === "user" && (item.type === undefined || item.type === "message"));
    if (nextUser < 0 || input.slice(nextUser + 1).some(item =>
      !["user", "developer", "system"].includes(String(item.role)) || (item.type !== undefined && item.type !== "message"))) {
      return { body, status: "missing_user_boundary", effective: requested, baseline: requested };
    }
    updates.push({ position: nextUser, effort: requested });
    status = "updated";
  }
  const output: unknown[] = [];
  let updateIndex = 0;
  for (let i = 0; i < input.length; i++) {
    const update = updates[updateIndex];
    if (update?.position === i) {
      output.push({ type: "configuration_update", reasoning: { effort: update.effort } });
      updateIndex++;
    }
    output.push(input[i]);
  }
  const snapshot: Snapshot = { prefix, length: input.length, envelope: envelopeHash, baseline, effective: requested, updates };
  return { body: updates.length ? { ...body, reasoning: { ...(reasoning as RecordValue), effort: baseline }, input: output } : body,
    status, baseline, effective: requested, snapshot };
}

export function applyAstraEffortCache(
  body: unknown,
  original: unknown,
  headers: Headers,
  servingHeaders: Headers,
  directory = join(getConfigDir(), "astra-effort-cache"),
): AstraEffortResult {
  if (!record(body)) return { body, status: "unsupported_input" };
  const requested = record(body.reasoning) && effort(body.reasoning.effort) ? body.reasoning.effort : undefined;
  const fallback = (status: string): AstraEffortResult => ({ body, status, baseline: requested, effective: requested });
  if (Array.isArray(body.input) && body.input.some(i => record(i) && i.type === "configuration_update")) {
    const last = body.input.findLast(i => record(i) && i.type === "configuration_update");
    return { ...fallback("client_managed"), effective: record(last?.reasoning) && effort(last.reasoning.effort) ? last.reasoning.effort : undefined };
  }
  const reason = unsupported(body, original, headers);
  if (reason) return fallback(reason);
  const metadata = record(body.client_metadata) ? body.client_metadata : {};
  const thread = headers.get("thread-id")?.trim() || (typeof metadata.thread_id === "string" ? metadata.thread_id.trim() : "");
  if (!thread || thread.length > 256) return fallback("missing_thread_identity");
  const account = servingHeaders.get("chatgpt-account-id");
  if (!account) return fallback("missing_serving_identity");
  const scope = digest(JSON.stringify([thread, account]));
  try {
    return withAstraEffortState(directory, scope, serialized => {
      let state: State = { version: 1, snapshots: [] };
      if (serialized !== undefined) {
        if (serialized.length > MAX_STATE_BYTES) return { value: fallback("state_limit") };
        const loaded: unknown = JSON.parse(serialized);
        if (!validState(loaded)) return { value: fallback("invalid_state") };
        state = loaded;
      }
      const result = transform(body, state);
      if (!result.snapshot) return { value: result, state: null };
      const snapshot = result.snapshot;
      if (!state.snapshots.some(s => JSON.stringify(s) === JSON.stringify(snapshot))) {
        if (state.snapshots.length >= MAX_SNAPSHOTS) return { value: fallback("state_limit") };
        state.snapshots.push(snapshot);
      }
      const next = JSON.stringify(state);
      if (next.length > MAX_STATE_BYTES) return { value: fallback("state_limit") };
      return { value: { body: result.body, status: result.status, baseline: result.baseline, effective: result.effective }, state: next };
    });
  } catch {
    return fallback("unavailable_state");
  }
}
