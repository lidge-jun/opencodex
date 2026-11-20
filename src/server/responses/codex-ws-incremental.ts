// Send only new input on acknowledged, account-bound native Codex WebSocket continuations.
// Only an explicit cache-miss refusal of a proxy delta permits full-create recovery.
import { codexWsIncrementalUploadEnabled, onCodexWsIncrementalUploadDisabled } from "../../config/codex-ws-incremental-setting";
export { codexWsIncrementalUploadEnabled, setCodexWsIncrementalUpload } from "../../config/codex-ws-incremental-setting";
export const CODEX_WS_INCREMENTAL_IDLE_MS = 600_000;
export const CODEX_WS_INCREMENTAL_MAX_AGE_MS = 3_000_000;
const MAX_CONTEXT = 64 * 1024 * 1024;
const MAX_RETAINED = 128 * 1024 * 1024;
type Obj = Record<string, unknown>;
type State = { caller: string; envelope: string; items: string[]; outputStart: number; id: string; bytes: number };
const states = new Map<object, State>();
let retained = 0;
onCodexWsIncrementalUploadDisabled(() => { states.clear(); retained = 0; });
const counters = { fullCreates: 0, deltaCreates: 0, fullFrameBytes: 0, sentFrameBytes: 0,
  cold: 0, prefixMismatch: 0, envelopeChanged: 0, callerChanged: 0, unidentifiedCaller: 0, ineligible: 0, overMemoryLimit: 0 };
const record = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (record(v)) return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v) ?? "null";
}
function outputItemKey(v: unknown): string {
  if (!record(v)) return stable(v);
  const item = { ...v };
  // Compare acknowledged output with its prepared replay form, which may omit server fields.
  // call_id, ciphertext, roles, content, tool arguments and every other field remain exact.
  if (['message', 'reasoning', 'function_call', 'custom_tool_call'].includes(String(item.type)) || typeof item.role === 'string') {
    delete item.id; delete item.status;
    if (record(item.metadata)) {
      const metadata = { ...item.metadata }; delete metadata.turn_id;
      if (Object.keys(metadata).length) item.metadata = metadata; else delete item.metadata;
    }
    if (record(item.internal_chat_message_metadata_passthrough)) {
      const metadata = { ...item.internal_chat_message_metadata_passthrough };
      delete metadata.turn_id; delete metadata.create_time;
      if (Object.keys(metadata).length) item.internal_chat_message_metadata_passthrough = metadata;
      else delete item.internal_chat_message_metadata_passthrough;
    }
  }
  if (item.type === 'reasoning' && Array.isArray(item.content) && item.content.length === 0) delete item.content;
  if (Array.isArray(item.content)) item.content = item.content.map(part => {
    if (!record(part)) return part;
    const p = { ...part };
    if (Array.isArray(p.annotations) && p.annotations.length === 0) delete p.annotations;
    if (Array.isArray(p.logprobs) && p.logprobs.length === 0) delete p.logprobs;
    return p;
  });
  return stable(item);
}
function envelopeKey(body: Obj): string {
  const value = { ...body };
  delete value.input; delete value.type;
  if (record(value.client_metadata)) {
    const metadata = { ...value.client_metadata };
    for (const key of ['turn_id', 'x-codex-turn-state', 'x-codex-turn-metadata', 'x-client-request-id']) delete metadata[key];
    value.client_metadata = metadata;
  }
  return stable(value);
}
/**
 * Namespace of the resolved data-plane principal. Unidentified requests send and seed no delta.
 */
export function codexWsCallerKey(principal: string | undefined): string | undefined {
  return principal ? `principal:${principal}` : undefined;
}
export type IncrementalPlan = { session: object; caller: string; frameText: string; fullFrameText: string; fullBytes: number; sentBytes: number;
  delta: boolean; envelope: string; items: string[]; retainable: boolean };
/** True while any socket holds an acknowledged prefix, so an oversized create could still shrink to a delta. */
export function codexWsIncrementalHasRetainedState(): boolean { return states.size > 0; }
// The planner is an optimization only: a failure (for example a RangeError from deeply nested
// items) must forget that socket's prefix and fall back to a full frame, never escape into the
// caller after the session was reserved, where it would leave the pooled socket busy.
// A retained prefix belongs to the caller that created it: only the same admitted caller may
// continue it, and a request with no admitted caller neither continues nor seeds one.
export function prepareIncrementalFrame(session: object, fullFrame: string, caller: string | undefined): IncrementalPlan | undefined {
  try { return planIncrementalFrame(session, fullFrame, caller); } catch { forgetIncrementalSession(session); return undefined; }
}
function planIncrementalFrame(session: object, fullFrame: string, caller: string | undefined): IncrementalPlan | undefined {
  if (!codexWsIncrementalUploadEnabled()) return undefined;
  if (!caller) { counters.unidentifiedCaller++; forgetIncrementalSession(session); return undefined; }
  let body: unknown;
  try { body = JSON.parse(fullFrame); } catch { return undefined; }
  if (!record(body) || body.type !== 'response.create' || !Array.isArray(body.input)
    || body.previous_response_id != null || body.background === true
    || Object.hasOwn(body, 'stream_id') || Object.hasOwn(body, 'generate')) {
    counters.ineligible++; forgetIncrementalSession(session); return undefined;
  }
  const fullBytes = Buffer.byteLength(fullFrame);
  const envelope = envelopeKey(body);
  const input = body.input;
  const items = input.map(stable);
  const prior = states.get(session);
  let frameText = fullFrame;
  let delta = false;
  if (!prior) counters.cold++;
  else if (prior.caller !== caller) counters.callerChanged++;
  else if (prior.envelope !== envelope) counters.envelopeChanged++;
  else if (items.length <= prior.items.length || !prior.items.every((item, i) =>
    item === (i < prior.outputStart ? items[i] : outputItemKey(input[i])))) counters.prefixMismatch++;
  else {
    const candidate = JSON.stringify({ ...body, previous_response_id: prior.id, input: body.input.slice(prior.items.length) });
    if (Buffer.byteLength(candidate) < fullBytes) { frameText = candidate; delta = true; }
  }
  // An in-flight turn invalidates the previous local prefix. Unknown completion never seeds reuse.
  forgetIncrementalSession(session);
  return { session, caller, frameText, fullFrameText: fullFrame, fullBytes, sentBytes: Buffer.byteLength(frameText), delta,
    envelope, items, retainable: fullBytes <= MAX_CONTEXT };
}
export function recordIncrementalDispatch(plan: IncrementalPlan): void {
  counters[plan.delta ? 'deltaCreates' : 'fullCreates']++;
  counters.fullFrameBytes += plan.fullBytes; counters.sentFrameBytes += plan.sentBytes;
}
export function completeIncrementalFrame(plan: IncrementalPlan, response: unknown): void {
  try { retainCompletedFrame(plan, response); } catch { forgetIncrementalSession(plan.session); }
}
function retainCompletedFrame(plan: IncrementalPlan, response: unknown): void {
  if (!codexWsIncrementalUploadEnabled() || !record(response) || response.status !== 'completed'
    || typeof response.id !== 'string' || !Array.isArray(response.output)) return;
  const items = [...plan.items, ...response.output.map(outputItemKey)];
  const bytes = items.reduce((n, item) => n + Buffer.byteLength(item), Buffer.byteLength(plan.envelope));
  if (!plan.retainable || bytes > MAX_CONTEXT) { counters.overMemoryLimit++; return; }
  forgetIncrementalSession(plan.session);
  while (retained + bytes > MAX_RETAINED && states.size) forgetIncrementalSession(states.keys().next().value!);
  states.set(plan.session, { caller: plan.caller, envelope: plan.envelope, items,
    outputStart: plan.items.length, id: response.id, bytes }); retained += bytes;
}
export function forgetIncrementalSession(session: object): void {
  const state = states.get(session); if (!state) return;
  retained -= state.bytes; states.delete(session);
}
export function codexWsIncrementalStats() {
  return { enabled: codexWsIncrementalUploadEnabled(), ...counters, retainedBytes: retained, retainedSessions: states.size,
    idleRetentionMs: CODEX_WS_INCREMENTAL_IDLE_MS, maxSessionAgeMs: CODEX_WS_INCREMENTAL_MAX_AGE_MS,
    savedFrameBytes: counters.fullFrameBytes - counters.sentFrameBytes };
}
