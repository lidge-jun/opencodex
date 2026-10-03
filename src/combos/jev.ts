import { JEV_ROUTE_DEFAULT_INSTRUCTIONS, JEV_EFFORT_DEFAULT_PROFILES, type JevDecisionPrompt } from "./jev-decision-contract";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import {
  providerOutboundPost,
  providerRedirectError,
} from "../lib/provider-outbound";
import {
  isKeychainReference,
  keychainReferenceBelongsToProvider,
  resolveProviderApiKey,
} from "../providers/api-key-resolve";
import { providerMatchesRegistryTransport } from "../providers/registry";
import type { OcxComboDefaultEffort, OcxConfig, OcxProviderConfig } from "../types";
import {
  isSystemOneEndpoint,
  JEV_DECISION_TIMEOUT_DEFAULT_MS,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
  JEV_MAX_CANDIDATE_FIELD_CHARS,
} from "./types";
import {
  JEV_QUOTA_INSTRUCTION_DESCRIPTIVE,
  JEV_QUOTA_INSTRUCTION_STRUCTURED,
  jevQuotaClause,
  jevQuotaCriterion,
  type JevQuotaSignal,
} from "./jev-quota";

export const JEV_PROVIDER_ID = "jev";
export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export const JEV_MAX_CANDIDATES = 64;
/** Ollama's System One choice questions accept 2..26 options; other services share the floor. */
const SELF_HOSTED_MIN_OPTIONS = 2;
const SELF_HOSTED_MAX_OPTIONS = 26;
/** Environment names that hold TypeSafe credentials; a self-hosted row may never reference them. */
const TYPESAFE_ENV_KEYS = new Set(["TYPESAFE_API_KEY", "JEV_API_KEY"]);
export const JEV_MAX_REQUEST_BYTES = 65_536;
export const JEV_MAX_RESPONSE_BYTES = 65_536;
const JEV_OUTBOUND_DEPENDENCIES = {
  isCanonicalUrl: (name: string, url: string) => name === JEV_PROVIDER_ID && url === JEV_API_URL,
  // Self-hosted decision models (Ollama tev1) listen on plain HTTP loopback. The outbound wrapper
  // still requires the row's own allowPrivateNetwork and a literal local address for that.
  allowLocalCleartextPost: true,
};

const TASK_CHARS = 500;
const TASK_HEAD_CHARS = 320;
const TASK_CLIP_MARK = "\n[...]\n";
const TASK_TAIL_CHARS = TASK_CHARS - TASK_HEAD_CHARS - TASK_CLIP_MARK.length;
const ASSISTANT_TAIL_CHARS = 240;
const TOOL_OUTPUT_TAIL_CHARS = 520;
const TOOL_NAME_CHARS = 160;
const VISIBLE_TEXT_CHUNK_CHARS = 16_384;

const ENVELOPE_TAGS = [
  "codex_internal_context",
  "recommended_plugins",
  "environment_context",
  "skills_instructions",
  "plugins_instructions",
  "apps_instructions",
  "app-context",
  "collaboration_mode",
  "model_switch",
  "multi_agent_mode",
  "permissions instructions",
  "memory_instructions",
].join("|");
const ENVELOPE_TAG_PATTERN = new RegExp(`<(/?)(${ENVELOPE_TAGS})(?:\\s[^<>]*)?>`, "g");

const KNOWN_MODEL_PROFILES: Record<string, string> = {
  "gpt-5.6-luna": "Lower-capacity, cost-optimized member of GPT-5.6.",
  "gpt-5.6-sol": "Higher-capacity GPT-5.6 model for complex professional work.",
  "gpt-6-astra": "Most capable model, intended for the hardest end-to-end reasoning work.",
};


const EFFORTS = new Set<OcxComboDefaultEffort>([
  "low", "medium", "high", "xhigh", "max", "ultra",
]);
const JEV_USAGE_KEYS = new Set(["input_tokens", "output_tokens", "inputTokens", "outputTokens"]);

export interface JevCandidate {
  key: string;
  provider: string;
  model: string;
  reasoningEfforts: readonly OcxComboDefaultEffort[];
  /** Optional operator note sent as decision evidence for this target only. */
  modelProfile?: string;
  /**
   * Remaining-quota evidence; set only when the Combo has `decisionQuotaSignals: true` and the
   * target has a fresh cached quota row. Absent leaves the decision request byte-identical.
   */
  quota?: JevQuotaSignal;
}

/**
 * Which kind of service answered a decision. `typesafe` is the canonical System One endpoint,
 * `systemone` a configured System One-compatible row, `model` an opencodex-routed model.
 */
export type JevDecisionBackend = "typesafe" | "systemone" | "model";

/** The backend a combo's decision settings select. A decision model wins over a provider row. */
export function jevDecisionBackendFor(
  combo: { decisionProvider?: string | null; decisionModel?: string | null },
): JevDecisionBackend {
  if (typeof combo.decisionModel === "string" && combo.decisionModel.trim()) return "model";
  const provider = typeof combo.decisionProvider === "string" ? combo.decisionProvider.trim() : "";
  return provider && provider !== JEV_PROVIDER_ID ? "systemone" : "typesafe";
}

export interface JevDecision {
  backend: JevDecisionBackend;
  targetKey: string;
  effort: OcxComboDefaultEffort | null;
  gate: "apply" | "missing_key" | "no_choices" | "no_state" | "timeout" | "network" | "redirect" | "http" | "malformed" | "invalid";
  latencyMs: number;
  confidence?: number;
  chosenProbability?: number;
  usage?: Record<string, number>;
  /** Set only when the decision request actually carried quota evidence. */
  quotaSent?: true;
}

export interface ResolveJevDecisionOptions {
  body: unknown;
  candidates: readonly JevCandidate[];
  fallback: { targetKey: string; effort: OcxComboDefaultEffort | null };
  config: OcxConfig;
  /**
   * Decision service provider id. Omitted or `"jev"` keeps the canonical TypeSafe destination;
   * any other id names a configured `jev-decision` row (for example a self-hosted Ollama `tev1`).
   */
  decisionProvider?: string;
  /** Operator wording overrides for the route and level questions; absent sends the defaults. */
  decisionPrompt?: JevDecisionPrompt;
  /** Decision deadline; values outside 1000..120000 ms keep the four-second default. */
  timeoutMs?: number;
  signal?: AbortSignal;
  post?: typeof providerOutboundPost;
  now?: () => number;
  onQuotaSent?: (sent: boolean) => void;
}

interface JevRouteOption {
  targetKey: string;
  effort: OcxComboDefaultEffort | null;
  criterion: {
    target: string;
    provider: string;
    model: string;
    reasoning_effort: OcxComboDefaultEffort | null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type !== "input_text" && raw.type !== "output_text" && raw.type !== "text") continue;
    if (typeof raw.text === "string") parts.push(raw.text);
  }
  return parts.join("\n");
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const raw of output) {
      if (typeof raw === "string") {
        parts.push(raw);
        continue;
      }
      if (!isRecord(raw)) continue;
      for (const key of ["text", "output", "content"] as const) {
        if (typeof raw[key] === "string") {
          parts.push(raw[key]);
          break;
        }
      }
    }
    return parts.join("\n");
  }
  if (!isRecord(output)) return "";
  for (const key of ["text", "output", "content"] as const) {
    if (typeof output[key] === "string") return output[key];
  }
  return "";
}

interface BoundedTextSample {
  length: number;
  head: string;
  tail: string;
}

interface TrimmedTextCollector {
  sample: BoundedTextSample;
  pendingWhitespace: BoundedTextSample;
}

function emptyTextSample(): BoundedTextSample {
  return { length: 0, head: "", tail: "" };
}

function appendSampleRange(
  sample: BoundedTextSample,
  source: string,
  start: number,
  end: number,
): void {
  const length = end - start;
  if (length <= 0) return;
  const headRemaining = Math.max(0, TASK_CHARS - sample.head.length);
  if (headRemaining > 0) sample.head += source.slice(start, Math.min(end, start + headRemaining));
  sample.tail = length >= TASK_TAIL_CHARS
    ? source.slice(end - TASK_TAIL_CHARS, end)
    : `${sample.tail}${source.slice(start, end)}`.slice(-TASK_TAIL_CHARS);
  sample.length += length;
}

function appendSample(sample: BoundedTextSample, addition: BoundedTextSample): void {
  if (addition.length === 0) return;
  const headRemaining = Math.max(0, TASK_CHARS - sample.head.length);
  if (headRemaining > 0) sample.head += addition.head.slice(0, headRemaining);
  sample.tail = addition.length >= TASK_TAIL_CHARS
    ? addition.tail
    : `${sample.tail}${addition.head.slice(0, addition.length)}`.slice(-TASK_TAIL_CHARS);
  sample.length += addition.length;
}

function appendTrimmedRange(
  collector: TrimmedTextCollector,
  source: string,
  start: number,
  end: number,
): void {
  for (let chunkStart = start; chunkStart < end; chunkStart += VISIBLE_TEXT_CHUNK_CHARS) {
    const chunkEnd = Math.min(end, chunkStart + VISIBLE_TEXT_CHUNK_CHARS);
    let contentStart = chunkStart;
    if (collector.sample.length === 0) {
      const leadingWhitespace = /^\s*/u.exec(source.slice(chunkStart, chunkEnd))?.[0].length ?? 0;
      contentStart += leadingWhitespace;
      if (contentStart === chunkEnd) continue;
    }
    const trailingWhitespace = /\s*$/u.exec(source.slice(contentStart, chunkEnd))?.[0].length ?? 0;
    const contentEnd = chunkEnd - trailingWhitespace;
    if (contentEnd > contentStart) {
      appendSample(collector.sample, collector.pendingWhitespace);
      collector.pendingWhitespace = emptyTextSample();
      appendSampleRange(collector.sample, source, contentStart, contentEnd);
    }
    if (contentEnd < chunkEnd && collector.sample.length > 0) {
      appendSampleRange(collector.pendingWhitespace, source, contentEnd, chunkEnd);
    }
  }
}

function sampledTask(sample: BoundedTextSample): string {
  if (sample.length <= TASK_CHARS) return sample.head.slice(0, sample.length);
  return `${sample.head.slice(0, TASK_HEAD_CHARS)}${TASK_CLIP_MARK}${sample.tail}`;
}

function clipTask(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TASK_CHARS) return trimmed;
  return `${trimmed.slice(0, TASK_HEAD_CHARS)}${TASK_CLIP_MARK}${trimmed.slice(-TASK_TAIL_CHARS)}`;
}

function taskWithoutProtectedEnvelopes(text: string): string {
  if (!text.includes("<")) return clipTask(text);
  ENVELOPE_TAG_PATTERN.lastIndex = 0;
  let match = ENVELOPE_TAG_PATTERN.exec(text);
  if (!match) return clipTask(text);
  const visible: TrimmedTextCollector = {
    sample: emptyTextSample(),
    pendingWhitespace: emptyTextSample(),
  };
  const stack: string[] = [];
  let cursor = 0;
  let goal: TrimmedTextCollector | undefined;
  let goalDepth: number | undefined;
  let completedGoal: BoundedTextSample | undefined;

  for (; match; match = ENVELOPE_TAG_PATTERN.exec(text)) {
    const tag = match[2]!;
    if (stack.length === 0) appendTrimmedRange(visible, text, cursor, match.index);
    if (goal && goalDepth !== undefined && stack.length === goalDepth + 1) {
      appendTrimmedRange(goal, text, cursor, match.index);
    }

    if (match[1] === "/") {
      const matchingDepth = stack.lastIndexOf(tag);
      if (matchingDepth >= 0) {
        if (goal && goalDepth === matchingDepth && tag === "codex_internal_context") {
          completedGoal = goal.sample;
          goal = undefined;
          goalDepth = undefined;
        }
        stack.length = matchingDepth;
      }
    } else {
      if (stack.length === 0) appendTrimmedRange(visible, "\n", 0, 1);
      if (!completedGoal && !goal && tag === "codex_internal_context") {
        goal = { sample: emptyTextSample(), pendingWhitespace: emptyTextSample() };
        goalDepth = stack.length;
      }
      stack.push(tag);
    }
    cursor = ENVELOPE_TAG_PATTERN.lastIndex;
  }

  if (stack.length === 0) appendTrimmedRange(visible, text, cursor, text.length);
  return sampledTask(visible.sample) || sampledTask(completedGoal ?? emptyTextSample());
}

function appendBoundedTail(tail: string, source: string, start: number, end: number, limit: number): string {
  if (end <= start) return tail;
  const boundedStart = Math.max(start, end - limit);
  return `${tail}${source.slice(boundedStart, end)}`.slice(-limit);
}

function tailWithoutProtectedEnvelopes(text: string, limit: number): string {
  if (!text.includes("<")) return text.trim().slice(-limit);
  ENVELOPE_TAG_PATTERN.lastIndex = 0;
  let match = ENVELOPE_TAG_PATTERN.exec(text);
  if (!match) return text.trim().slice(-limit);

  let tail = "";
  let pendingWhitespace = "";
  let hasContent = false;
  const stack: string[] = [];
  let cursor = 0;
  const appendVisibleRange = (source: string, start: number, end: number): void => {
    for (let chunkStart = start; chunkStart < end; chunkStart += VISIBLE_TEXT_CHUNK_CHARS) {
      const chunkEnd = Math.min(end, chunkStart + VISIBLE_TEXT_CHUNK_CHARS);
      let contentStart = chunkStart;
      if (!hasContent) {
        contentStart += /^\s*/u.exec(source.slice(chunkStart, chunkEnd))?.[0].length ?? 0;
        if (contentStart === chunkEnd) continue;
      }
      const trailingWhitespace = /\s*$/u.exec(source.slice(contentStart, chunkEnd))?.[0].length ?? 0;
      const contentEnd = chunkEnd - trailingWhitespace;
      if (contentEnd > contentStart) {
        tail = appendBoundedTail(tail, pendingWhitespace, 0, pendingWhitespace.length, limit);
        pendingWhitespace = "";
        tail = appendBoundedTail(tail, source, contentStart, contentEnd, limit);
        hasContent = true;
      }
      if (contentEnd < chunkEnd && hasContent) {
        pendingWhitespace = appendBoundedTail(
          pendingWhitespace,
          source,
          contentEnd,
          chunkEnd,
          limit,
        );
      }
    }
  };

  for (; match; match = ENVELOPE_TAG_PATTERN.exec(text)) {
    const tag = match[2]!;
    if (stack.length === 0) appendVisibleRange(text, cursor, match.index);
    if (match[1] === "/") {
      const matchingDepth = stack.lastIndexOf(tag);
      if (matchingDepth >= 0) stack.length = matchingDepth;
    } else {
      if (stack.length === 0) appendVisibleRange("\n", 0, 1);
      stack.push(tag);
    }
    cursor = ENVELOPE_TAG_PATTERN.lastIndex;
  }
  if (stack.length === 0) appendVisibleRange(text, cursor, text.length);
  return tail;
}

function hasImageContent(item: Record<string, unknown>): boolean {
  if (!Array.isArray(item.content)) return false;
  return item.content.some(part => isRecord(part) && (part.type === "input_image" || part.type === "image_url"));
}

export function buildJevState(body: unknown, candidates: readonly JevCandidate[] = []): Record<string, unknown> {
  const input = isRecord(body) ? body.input : undefined;
  let task = "";
  let previousAssistant = "";
  let hasImage = false;
  let toolHistory = false;
  const step: Record<string, unknown> = { type: "other" };

  if (typeof input === "string") {
    task = taskWithoutProtectedEnvelopes(input);
    step.type = "user_turn";
  } else if (Array.isArray(input)) {
    for (const raw of input.slice(-6)) {
      if (!isRecord(raw)) continue;
      if (raw.type === "function_call_output" || raw.type === "custom_tool_call_output") toolHistory = true;
      if (hasImageContent(raw)) hasImage = true;
    }
    for (let index = input.length - 1; index >= 0 && (!task || !previousAssistant); index -= 1) {
      const raw = input[index];
      if (!isRecord(raw)) continue;
      if (!task && raw.role === "user") task = taskWithoutProtectedEnvelopes(contentText(raw.content));
      if (!previousAssistant && raw.role === "assistant") {
        previousAssistant = tailWithoutProtectedEnvelopes(contentText(raw.content), ASSISTANT_TAIL_CHARS);
      }
    }

    const last = input.at(-1);
    if (isRecord(last)
      && (last.type === "function_call_output" || last.type === "custom_tool_call_output")) {
      step.type = "tool_step";
      step.last_tool_output_tail = tailWithoutProtectedEnvelopes(outputText(last.output), TOOL_OUTPUT_TAIL_CHARS);
      const callId = typeof last.call_id === "string" ? last.call_id : "";
      if (callId) {
        for (let index = input.length - 2; index >= 0; index -= 1) {
          const call = input[index];
          if (!isRecord(call) || call.call_id !== callId) continue;
          if (call.type !== "function_call" && call.type !== "custom_tool_call") continue;
          step.tool_call = { name: String(call.name ?? "").slice(0, TOOL_NAME_CHARS) };
          break;
        }
      }
    } else if (isRecord(last) && last.role === "user") {
      step.type = "user_turn";
    }
  }

  const operatorNotes: Record<string, string> = {};
  for (const candidate of candidates) {
    const note = candidate.modelProfile?.trim();
    if (note) operatorNotes[candidate.key] = note;
  }

  return {
    task,
    signals: { has_image: hasImage, tool_history: toolHistory },
    step,
    ...(previousAssistant ? { previous_assistant: previousAssistant.slice(-ASSISTANT_TAIL_CHARS) } : {}),
    ...(Object.keys(operatorNotes).length ? { operator_notes: operatorNotes } : {}),
  };
}

export function hasJevDecisionState(state: Record<string, unknown>): boolean {
  if (typeof state.task === "string" && state.task.trim()) return true;
  if (isRecord(state.signals) && state.signals.has_image === true) return true;
  return isRecord(state.step)
    && typeof state.step.last_tool_output_tail === "string"
    && Boolean(state.step.last_tool_output_tail.trim());
}

function candidateOptions(candidates: readonly JevCandidate[]): Map<string, JevRouteOption> {
  const options = new Map<string, JevRouteOption>();
  for (const candidate of candidates) {
    const efforts = [...new Set(candidate.reasoningEfforts)].filter(effort => EFFORTS.has(effort));
    const choices: Array<OcxComboDefaultEffort | null> = efforts.length > 0 ? efforts : [null];
    for (const effort of choices) {
      const choice = `${candidate.key}:${effort ?? "none"}`;
      if (options.has(choice)) throw new Error("duplicate JEV route choice");
      options.set(choice, {
        targetKey: candidate.key,
        effort,
        criterion: {
          target: candidate.key,
          provider: candidate.provider,
          model: candidate.model,
          reasoning_effort: effort,
        },
      });
    }
  }
  return options;
}

export function candidatesFitRequestBounds(candidates: readonly JevCandidate[]): boolean {
  if (candidates.length > JEV_MAX_CANDIDATES) return false;
  return candidates.every(candidate => [candidate.key, candidate.provider, candidate.model]
    .every(value => value.length > 0 && value.length <= JEV_MAX_CANDIDATE_FIELD_CHARS)
    && (candidate.modelProfile === undefined
      || (typeof candidate.modelProfile === "string" && candidate.modelProfile.length <= JEV_MAX_CANDIDATE_FIELD_CHARS)));
}

function modelProfile(candidate: JevCandidate): string {
  const model = candidate.model.toLowerCase().split("/").at(-1) ?? "";
  return KNOWN_MODEL_PROFILES[model]
    ?? "Configured target with capability unspecified by JEV; judge it only from the supplied request evidence.";
}

function criterionDescription(criterion: JevRouteOption["criterion"], quota: JevQuotaSignal | undefined): string {
  const effort = criterion.reasoning_effort
    ? `${criterion.reasoning_effort} reasoning effort`
    : "no reasoning-effort control";
  const base = `Target ${criterion.target} (provider ${criterion.provider}, model ${criterion.model}) with ${effort}.`;
  return quota ? `${base}${jevQuotaClause(quota)}` : base;
}

function quotaByTarget(candidates: readonly JevCandidate[]): Map<string, JevQuotaSignal> {
  const quota = new Map<string, JevQuotaSignal>();
  for (const candidate of candidates) if (candidate.quota) quota.set(candidate.key, candidate.quota);
  return quota;
}

/** One allowlisted target/effort option, shared by every decision backend. */
export interface JevRouteOptionDescriptor {
  key: string;
  targetKey: string;
  effort: OcxComboDefaultEffort | null;
  description: string;
}

/** Every allowlisted option in question order; throws on a duplicate choice like the builder. */
export function jevRouteOptions(candidates: readonly JevCandidate[]): JevRouteOptionDescriptor[] {
  const quota = quotaByTarget(candidates);
  return [...candidateOptions(candidates)].map(([key, option]) => ({
    key,
    targetKey: option.targetKey,
    effort: option.effort,
    description: criterionDescription(option.criterion, quota.get(option.targetKey)),
  }));
}

/**
 * Build the single `route` choice question.
 *
 * TypeSafe receives each option's structured criterion object. `descriptiveCriteria` renders the
 * same facts as one plain description string per option instead, the portable System One shape
 * that self-hosted services such as Ollama require ("option keys to descriptions or null").
 */
export function buildJevRouteQuestion(
  candidates: readonly JevCandidate[],
  options: { descriptiveCriteria?: boolean; decisionPrompt?: JevDecisionPrompt } = {},
): Record<string, unknown> {
  const routeOptions = candidateOptions(candidates);
  // Quota evidence rides INSIDE each option: measured with tev1, the same facts placed only in
  // model_profiles barely moved a decision, while a per-option tier clause did.
  const quotaByKey = quotaByTarget(candidates);
  const criteria: Record<string, unknown> = {};
  for (const [choice, option] of routeOptions) {
    const quota = quotaByKey.get(option.targetKey);
    criteria[choice] = options.descriptiveCriteria
      ? criterionDescription(option.criterion, quota)
      : quota ? { ...option.criterion, quota: jevQuotaCriterion(quota) } : option.criterion;
  }
  const modelProfiles: Record<string, string> = {};
  for (const candidate of candidates) modelProfiles[candidate.key] = modelProfile(candidate);
  return {
    route: {
      type: "choice",
      instructions: {
        question: options.decisionPrompt?.route?.question ?? JEV_ROUTE_DEFAULT_INSTRUCTIONS.question,
        objective: options.decisionPrompt?.route?.objective ?? JEV_ROUTE_DEFAULT_INSTRUCTIONS.objective,
        evidence: options.decisionPrompt?.route?.evidence ?? JEV_ROUTE_DEFAULT_INSTRUCTIONS.evidence,
        neutrality: options.decisionPrompt?.route?.neutrality ?? JEV_ROUTE_DEFAULT_INSTRUCTIONS.neutrality,
        model_profiles: modelProfiles,
        effort_profiles: { ...JEV_EFFORT_DEFAULT_PROFILES, ...options.decisionPrompt?.route?.effortProfiles },
        speed: options.decisionPrompt?.route?.speed ?? JEV_ROUTE_DEFAULT_INSTRUCTIONS.speed,
        ...(quotaByKey.size > 0
          ? { quota: options.descriptiveCriteria ? JEV_QUOTA_INSTRUCTION_DESCRIPTIVE : JEV_QUOTA_INSTRUCTION_STRUCTURED }
          : {}),
      },
      criteria,
    },
  };
}

export function jevUsage(payload: Record<string, unknown>): Record<string, number> | undefined {
  if (!isRecord(payload.usage)) return undefined;
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(payload.usage)) {
    if (!JEV_USAGE_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function parseJevDecision(
  payload: unknown,
  candidates: readonly JevCandidate[],
): Pick<JevDecision, "targetKey" | "effort" | "confidence" | "chosenProbability" | "usage"> {
  if (!isRecord(payload) || !isRecord(payload.answers) || !isRecord(payload.answers.route)) {
    throw new Error("missing JEV route decision");
  }
  const answer = payload.answers.route;
  const options = candidateOptions(candidates);
  if (typeof answer.choice !== "string" || !options.has(answer.choice)) {
    throw new Error("unknown JEV route choice");
  }

  const chosenProbability = jevChoiceProbability(answer, [...options.keys()], "route");
  const option = options.get(answer.choice)!;
  const confidence = jevConfidence(answer.confidence);
  const usage = jevUsage(payload);
  return {
    targetKey: option.targetKey,
    effort: option.effort,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(chosenProbability !== undefined ? { chosenProbability } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function fallbackDecision(
  fallback: ResolveJevDecisionOptions["fallback"],
  gate: Exclude<JevDecision["gate"], "apply">,
  latencyMs: number,
  backend: JevDecisionBackend,
): JevDecision {
  return { backend, ...fallback, gate, latencyMs };
}

/** The decision deadline: the configured value when in bounds, otherwise the four-second default. */
export function jevDecisionTimeoutMs(value: number | undefined): number {
  return value !== undefined
    && Number.isInteger(value)
    && value >= JEV_DECISION_TIMEOUT_MIN_MS
    && value <= JEV_DECISION_TIMEOUT_MAX_MS
    ? value
    : JEV_DECISION_TIMEOUT_DEFAULT_MS;
}

function canonicalJevProvider(config: OcxConfig): OcxProviderConfig {
  const configured = config.providers[JEV_PROVIDER_ID];
  if (configured && providerMatchesRegistryTransport(JEV_PROVIDER_ID, configured)) return configured;
  return {
    adapter: "jev-decision",
    baseUrl: JEV_API_URL,
    authMode: "key",
    liveModels: false,
  };
}

interface JevDecisionEndpoint {
  name: string;
  provider: OcxProviderConfig;
  url: string;
  model: string;
  apiKey: string | undefined;
  /** Self-hosted System One services accept only string option descriptions. */
  descriptiveCriteria: boolean;
}

function envReferenceName(value: string): string | undefined {
  const braced = /^\$\{(\w+)\}$/.exec(value);
  if (braced) return braced[1];
  return value.startsWith("$") ? value.slice(1) : undefined;
}

/**
 * A self-hosted row may carry only its own secret: never a reference to the TypeSafe environment
 * keys, and never a keychain entry that belongs to another provider. `null` means refused.
 */
function selfHostedApiKey(name: string, apiKey: string | undefined): string | undefined | null {
  if (!apiKey) return undefined;
  const envName = envReferenceName(apiKey);
  if (envName !== undefined && TYPESAFE_ENV_KEYS.has(envName)) return null;
  if (isKeychainReference(apiKey) && !keychainReferenceBelongsToProvider(apiKey, name)) return null;
  return resolveProviderApiKey(apiKey)?.trim() || undefined;
}

/**
 * Resolve where one decision request goes and which credential it may carry.
 *
 * The `jev` id stays pinned to the canonical TypeSafe URL and `jev-latest`: its row key is used
 * only while the row still matches the registry transport, and the environment fallbacks exist
 * only for that URL. A retargeted `jev` row therefore keeps today's behavior instead of becoming a
 * custom destination. Any other id must be an enabled `jev-decision` row whose baseUrl is a
 * `/systemone` endpoint and which names its own model; only its own key may accompany it, so no
 * TypeSafe credential can reach a self-hosted service. `undefined` means no usable decision
 * service (reported through the existing `missing_key` gate).
 */
function jevDecisionEndpoint(config: OcxConfig, decisionProvider: string): JevDecisionEndpoint | undefined {
  const configured = Object.hasOwn(config.providers, decisionProvider)
    ? config.providers[decisionProvider]
    : undefined;
  if (configured?.disabled === true) return undefined;
  if (decisionProvider === JEV_PROVIDER_ID) {
    const configuredOwnsJev = configured
      && providerMatchesRegistryTransport(JEV_PROVIDER_ID, configured);
    const apiKey = (
      configuredOwnsJev ? resolveProviderApiKey(configured.apiKey)?.trim() : undefined
    ) || process.env.TYPESAFE_API_KEY?.trim()
      || process.env.JEV_API_KEY?.trim();
    if (!apiKey) return undefined;
    return {
      name: JEV_PROVIDER_ID,
      provider: canonicalJevProvider(config),
      url: JEV_API_URL,
      model: JEV_MODEL,
      apiKey,
      descriptiveCriteria: false,
    };
  }
  if (configured?.adapter !== "jev-decision" || typeof configured.baseUrl !== "string") return undefined;
  const url = configured.baseUrl.trim().replace(/\/+$/, "");
  if (!url || !isSystemOneEndpoint(url)) return undefined;
  // `jev-latest` is TypeSafe's model name; a self-hosted host must name its own.
  const model = configured.defaultModel?.trim() || configured.models?.[0]?.trim();
  if (!model) return undefined;
  const apiKey = selfHostedApiKey(decisionProvider, configured.apiKey);
  if (apiKey === null) return undefined;
  return {
    name: decisionProvider,
    provider: configured,
    url,
    model,
    apiKey,
    descriptiveCriteria: true,
  };
}

export type JevDecisionFailureGate = Exclude<JevDecision["gate"], "apply">;

/** What a decision exchange needs to know about its endpoint to build the request body. */
export interface JevDecisionEndpointShape {
  model: string;
  /** Self-hosted System One services accept only string option descriptions. */
  descriptiveCriteria: boolean;
}

/** Whether a serialized decision request fits the outbound request cap. */
export function fitsJevRequestBytes(body: string): boolean {
  return new TextEncoder().encode(body).byteLength <= JEV_MAX_REQUEST_BYTES;
}

/**
 * Strictly validate one choice answer's optional `probabilities` against exactly the offered
 * choices and return the chosen probability. `label` names the question in thrown errors.
 */
export function jevChoiceProbability(
  answer: Record<string, unknown>,
  offered: readonly string[],
  label: string,
): number | undefined {
  if (answer.probabilities === undefined) return undefined;
  const probabilities = answer.probabilities;
  if (!isRecord(probabilities)) throw new Error(`invalid JEV ${label} probabilities`);
  const expected = [...offered].sort();
  const actual = Object.keys(probabilities).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`incomplete JEV ${label} distribution`);
  }
  const values = actual.map(key => probabilities[key]);
  if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error(`invalid JEV ${label} probabilities`);
  }
  const numeric = values as number[];
  const selected = probabilities[answer.choice as string] as number;
  if (Math.abs(numeric.reduce((sum, value) => sum + value, 0) - 1) > 0.02
    || selected < Math.max(...numeric) - 1e-6) {
    throw new Error(`inconsistent JEV ${label} distribution`);
  }
  return selected;
}

/** A reported confidence in 0..1, or undefined. */
export function jevConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

/**
 * One decision round-trip shared by every HTTP decision mode: endpoint and credential resolution,
 * the request built by `prepare` for that endpoint, the deadline, the no-redirect policy, and the
 * bounded UTF-8 JSON response. Operational failures come back as a fail-open gate; a caller abort
 * is rethrown by identity. `prepare` may refuse locally by returning a gate, or throw (`invalid`).
 */
export async function exchangeJevDecision(
  options: Pick<ResolveJevDecisionOptions, "config" | "decisionProvider" | "timeoutMs" | "signal" | "post">,
  prepare: (endpoint: JevDecisionEndpointShape) => { body: string } | JevDecisionFailureGate,
): Promise<{ payload: unknown } | { gate: JevDecisionFailureGate }> {
  const endpoint = jevDecisionEndpoint(options.config, options.decisionProvider ?? JEV_PROVIDER_ID);
  if (!endpoint) return { gate: "missing_key" };

  let requestBody: string;
  try {
    // `prepare` sees only the request shape, never the credential or the destination.
    const prepared = prepare({ model: endpoint.model, descriptiveCriteria: endpoint.descriptiveCriteria });
    if (typeof prepared === "string") return { gate: prepared };
    requestBody = prepared.body;
  } catch {
    return { gate: "invalid" };
  }

  const timeoutSignal = AbortSignal.timeout(jevDecisionTimeoutMs(options.timeoutMs));
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const post = options.post ?? providerOutboundPost;

  try {
    const response = await post(
      endpoint.name,
      endpoint.provider,
      endpoint.url,
      {
        headers: {
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: requestBody,
        signal,
      },
      JEV_OUTBOUND_DEPENDENCIES,
    );
    if (options.signal?.aborted) throw options.signal.reason;

    const redirectError = await providerRedirectError(response, endpoint.url);
    if (redirectError) return { gate: "redirect" };
    if (!response.ok) {
      try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
      return { gate: "http" };
    }

    const bounded = await readBoundedResponseBytes(response, {
      maxBytes: JEV_MAX_RESPONSE_BYTES,
      signal,
    });
    if (options.signal?.aborted) throw options.signal.reason;
    if (bounded.oversized) return { gate: "malformed" };

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
      return { payload: JSON.parse(text) };
    } catch {
      return { gate: "malformed" };
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (timeoutSignal.aborted
      || (error instanceof DOMException && error.name === "TimeoutError")) {
      return { gate: "timeout" };
    }
    return { gate: "network" };
  }
}

/**
 * Ask the configured JEV decision service for one allowlisted target/effort decision.
 *
 * Every operational or response failure returns the supplied first-eligible fallback. A caller
 * abort is the exception: request cancellation remains cancellation and is rethrown by identity.
 */
export async function resolveJevDecision(options: ResolveJevDecisionOptions): Promise<JevDecision> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const backend = jevDecisionBackendFor({ decisionProvider: options.decisionProvider });
  let quotaSent = false;
  const failed = (gate: JevDecisionFailureGate): JevDecision => ({
    ...fallbackDecision(options.fallback, gate, Math.max(0, now() - startedAt), backend),
    ...(quotaSent ? { quotaSent: true as const } : {}),
  });

  if (options.signal?.aborted) throw options.signal.reason;
  if (options.candidates.length === 0) return failed("no_choices");
  if (!candidatesFitRequestBounds(options.candidates)) return failed("invalid");

  const exchanged = await exchangeJevDecision(options, (endpoint) => {
    if (endpoint.descriptiveCriteria) {
      // Self-hosted choice questions accept 2..26 options; decide locally instead of spending a
      // round-trip on a request the service will refuse.
      const optionCount = candidateOptions(options.candidates).size;
      if (optionCount < SELF_HOSTED_MIN_OPTIONS) return "no_choices";
      if (optionCount > SELF_HOSTED_MAX_OPTIONS) return "invalid";
    }
    const state = buildJevState(options.body, options.candidates);
    if (!hasJevDecisionState(state)) return "no_state";
    const serialize = (candidates: readonly JevCandidate[]) => JSON.stringify({
      model: endpoint.model,
      state,
      questions: buildJevRouteQuestion(candidates, { descriptiveCriteria: endpoint.descriptiveCriteria, decisionPrompt: options.decisionPrompt }),
    });
    const withQuota = options.candidates.some(candidate => candidate.quota !== undefined);
    const full = serialize(options.candidates);
    if (fitsJevRequestBytes(full)) {
      quotaSent = withQuota;
      options.onQuotaSent?.(withQuota);
      return { body: full };
    }
    if (!withQuota) return "invalid";
    // Quota evidence is optional: a large Combo that only overflows because of it still gets a
    // decision, just without the quota clauses.
    const withoutQuota = serialize(options.candidates.map(({ quota: _quota, ...candidate }) => candidate));
    return fitsJevRequestBytes(withoutQuota) ? { body: withoutQuota } : "invalid";
  });
  if ("gate" in exchanged) return failed(exchanged.gate);

  let parsed: ReturnType<typeof parseJevDecision>;
  try {
    parsed = parseJevDecision(exchanged.payload, options.candidates);
  } catch {
    return failed("invalid");
  }
  if (options.signal?.aborted) throw options.signal.reason;
  return {
    backend,
    ...parsed,
    gate: "apply",
    latencyMs: Math.max(0, now() - startedAt),
    ...(quotaSent ? { quotaSent: true as const } : {}),
  };
}

export type JevDecisionProbeResult =
  | { ok: true; latencyMs: number; message: string }
  | { ok: false; latencyMs: number; error: string };

/**
 * Management connection test for one `jev-decision` provider row. It sends a fixed probe task and
 * no user prompt, and reports only a sanitized gate. Canonical TypeSafe wording is kept for `jev`.
 */
export async function probeJevDecisionProvider(
  config: OcxConfig,
  name: string,
  options: Pick<ResolveJevDecisionOptions, "signal" | "post"> = {},
): Promise<JevDecisionProbeResult> {
  const canonical = name === JEV_PROVIDER_ID;
  const label = canonical ? "TypeSafe JEV" : "JEV decision service";
  const probe = { targetKey: "jev/probe", effort: null } as const;
  const decision = await resolveJevDecision({
    body: {
      input: canonical
        ? "Verify the configured TypeSafe JEV decision service."
        : "Verify the configured JEV decision service.",
    },
    candidates: [{
      key: probe.targetKey,
      provider: "jev",
      model: "jev-latest",
      // Self-hosted System One choice questions need at least two options.
      reasoningEfforts: canonical ? [] : ["low", "high"],
    }],
    fallback: probe,
    config,
    decisionProvider: name,
    ...options,
  });
  if (decision.gate === "apply") {
    return { ok: true, latencyMs: decision.latencyMs, message: `Connected. ${label} answered a decision probe.` };
  }
  return {
    ok: false,
    latencyMs: decision.latencyMs,
    error: decision.gate === "missing_key"
      ? (canonical ? "TypeSafe JEV API key is not configured" : "JEV decision service is disabled or not configured")
      : `${canonical ? "TypeSafe JEV decision probe" : "JEV decision service probe"} failed (${decision.gate})`,
  };
}
