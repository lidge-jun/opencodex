/**
 * Claude Code inbound: Anthropic Messages API request -> internal /v1/responses body.
 *
 * Design (devlog/260711_claude_inbound/010, 003_evidence.md):
 *  - translate-and-replay: the produced body MUST pass the real responsesRequestSchema
 *    parse so routing/OAuth/pool/failover are inherited unchanged.
 *  - thinking/redacted_thinking blocks on replay are DROPPED (v1 policy) — routed
 *    providers carry reasoning in Responses items/ocxr1 envelopes instead.
 *  - thinking.budget_tokens is NEVER forwarded raw; it maps to an effort tier.
 *  - top_k is accepted and silently dropped (no Responses equivalent, CCR parity).
 */
import type { OcxClaudeCodeConfig } from "../types";
import { resolveAlias } from "./alias";
import { stripOneMillionMarker } from "./context-windows";
import { resolveDesktop3pAlias } from "./desktop-3p";
import { createHash } from "node:crypto";

export class AnthropicRequestError extends Error {}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Alias first, then modelMap: exact id, then date-suffix-stripped (`-\d{8}$`), else passthrough. */
export function resolveInboundModel(model: string, cc?: OcxClaudeCodeConfig): string {
  // Defensive: Desktop/CLI strip the [1m] context-variant marker client-side, but a
  // leaking build must not break alias decode (devlog 138 — the 1M signal is the
  // anthropic-beta header, never the id). Case-insensitive: the CLI matches /\[1m\]/i.
  model = stripOneMillionMarker(model);
  const aliased = resolveAlias(model);
  if (aliased) return aliased;
  // Desktop 3P aliases: claude-opus-4-{code} → provider/model route key
  const desktop3p = resolveDesktop3pAlias(model);
  if (desktop3p) {
    // Native pseudo-provider returns bare slug; routed returns provider/model
    const sep = desktop3p.indexOf("/");
    if (sep > 0 && desktop3p.slice(0, sep) === "native") return desktop3p.slice(sep + 1);
    return desktop3p;
  }
  const map = cc?.modelMap ?? {};
  const exact = map[model];
  if (typeof exact === "string" && exact.length > 0) return exact;
  const stripped = model.replace(/-\d{8}$/, "");
  const dateless = map[stripped];
  if (typeof dateless === "string" && dateless.length > 0) return dateless;
  return model;
}

/** budget_tokens ladder -> Responses reasoning effort (003: real API min is 1024; never forward raw). */
export function effortForThinkingBudget(budget: number): string {
  if (budget <= 4096) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

/**
 * Adaptive-thinking wire (devlog 080): Claude Code /effort sends
 * `thinking:{type:"adaptive"}` + `output_config:{effort:"..."}` (verified by local
 * capture of claude 2.1.207 and CLIProxyAPI#1540). Forward the level verbatim when it
 * is a known Responses effort; unknown strings are dropped so downstream defaults win.
 */
const OUTPUT_CONFIG_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export function effortFromOutputConfig(outputConfig: unknown): string | undefined {
  if (!isRec(outputConfig)) return undefined;
  const effort = outputConfig.effort;
  return typeof effort === "string" && OUTPUT_CONFIG_EFFORTS.has(effort) ? effort : undefined;
}

function systemToInstructions(system: unknown): string | undefined {
  if (typeof system === "string") return system.length > 0 ? system : undefined;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      if (isRec(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

function imageBlockToInputImage(block: Rec): Rec | null {
  const source = block.source;
  if (!isRec(source)) return null;
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "input_image", image_url: `data:${media};base64,${source.data}` };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "input_image", image_url: source.url };
  }
  return null;
}

function toolResultOutput(block: Rec): string | Rec[] {
  const isError = block.is_error === true;
  const content = block.content;
  if (typeof content === "string") return isError ? `[tool error] ${content}` : content;
  if (Array.isArray(content)) {
    const out: Rec[] = [];
    for (const item of content) {
      if (!isRec(item)) continue;
      if (item.type === "text" && typeof item.text === "string") {
        out.push({ type: "input_text", text: item.text });
      } else if (item.type === "image") {
        const img = imageBlockToInputImage(item);
        if (img) out.push(img);
      }
    }
    if (isError) out.unshift({ type: "input_text", text: "[tool error]" });
    if (out.length === 0) return isError ? "[tool error]" : "";
    return out;
  }
  return isError ? "[tool error]" : "";
}

function pushUserMessage(input: Rec[], blocks: Rec[]): void {
  if (blocks.length === 0) return;
  input.push({ type: "message", role: "user", content: blocks });
}

/**
 * Bundled-skill elision for routed models (devlog 060). Claude Code loads a skill
 * by calling the `Skill` tool; the ~136k-token document bundle then rides the
 * paired tool_result on EVERY subsequent turn. Third-party models are not trained
 * on these Anthropic bundles, so for blocked skills we substitute the result body
 * with a short stub — the function_call_output item itself stays (pairing intact).
 * Native Anthropic passthrough never reaches this translation.
 */
export const DEFAULT_BLOCKED_SKILLS = ["claude-api"];

/** Shared effective policy for proxy elision and generated routed-agent guards. */
export function effectiveBlockedSkillNames(cc?: Pick<OcxClaudeCodeConfig, "blockedSkills">): string[] {
  const names = cc?.blockedSkills ?? DEFAULT_BLOCKED_SKILLS;
  const normalized: string[] = [];
  for (const name of names) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim().toLowerCase();
    if (trimmed.length > 0) normalized.push(trimmed);
  }
  return [...new Set(normalized)];
}

/**
 * ocx-route directive (devlog 072): injected agent-definition bodies carry
 * `<!-- ocx-route: <model> -->` because Claude Code 2.1.207 ignores custom
 * gateway ids in agent frontmatter (live-proven fallback to sonnet). The body
 * rides the subagent's system prompt, so the proxy re-routes here. Only the
 * FIRST directive wins; the scan is bounded to the system field.
 */
const OCX_ROUTE_RE = /<!--\s*ocx-route:\s*([^\s]+)\s*-->/;

export function extractOcxRouteDirective(body: unknown): string | null {
  if (!isRec(body)) return null;
  const system = body.system;
  let text: string | undefined;
  if (typeof system === "string") text = system;
  else if (Array.isArray(system)) {
    text = system
      .flatMap(b => isRec(b) && b.type === "text" && typeof b.text === "string" ? [b.text as string] : [])
      .join("\n");
  }
  if (!text) return null;
  const match = OCX_ROUTE_RE.exec(text);
  return match ? match[1]! : null;
}

/** Injected-skill payloads below this size are never stubbed (not worth it). */
const SKILL_ELISION_MIN_CHARS = 10_000;
const SKILL_TEXT_MARKER = "Base directory for this skill: ";

interface SkillElisionContext {
  /** Skill-tool call ids whose input names a blocked skill (result-body carrier). */
  callIds: ReadonlySet<string>;
  /** Lowercased blocked skill names (text-block carrier). */
  names: readonly string[];
}

const NO_ELISION: SkillElisionContext = { callIds: new Set(), names: [] };

/**
 * Claude Code 2.1.207 (live capture, devlog 060 follow-up): the Skill tool_result is
 * a tiny "Launching skill: <name>" note; the actual ~570k-char document bundle rides
 * as a SEPARATE text block in the same user message, whose first line is
 * `Base directory for this skill: <dir>/<skill-name>`. Stub that block when the
 * directory basename matches a blocked skill.
 */
function maybeElideSkillText(text: string, names: readonly string[]): string {
  if (names.length === 0 || text.length < SKILL_ELISION_MIN_CHARS) return text;
  if (!text.startsWith(SKILL_TEXT_MARKER)) return text;
  const firstLineEnd = text.indexOf("\n");
  const dir = text.slice(SKILL_TEXT_MARKER.length, firstLineEnd === -1 ? text.length : firstLineEnd).trim();
  // Windows clients send `C:\Users\...\claude-api`; normalize separators before
  // basenaming (repo precedent: src/codex/inject.ts isOpencodexCatalogPath).
  const base = dir.replace(/\\/g, "/").split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
  if (!names.includes(base)) return text;
  return `[opencodex] '${base}' skill document bundle (${text.length} chars) elided for routed models `
    + "(claudeCode.blockedSkills). The skill is loaded; answer from general knowledge instead of citing the bundle.";
}

function skillElisionStub(callId: string): string {
  return "[opencodex] Skill document bundle elided for routed models (claudeCode.blockedSkills). "
    + `The skill loaded, but its reference documents were removed to save context (call ${callId}). `
    + "Answer from general knowledge instead of citing the bundle.";
}

/** Collect Skill-tool call ids whose input names a blocked skill. */
function blockedSkillCallIds(messages: readonly unknown[], blocked: readonly string[]): Set<string> {
  const ids = new Set<string>();
  if (blocked.length === 0) return ids;
  const needles = blocked.flatMap(name => {
    const lower = name.toLowerCase();
    return lower.length > 0 ? [lower] : [];
  });
  if (needles.length === 0) return ids;
  for (const msg of messages) {
    if (!isRec(msg) || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isRec(block) || block.type !== "tool_use" || block.name !== "Skill") continue;
      if (typeof block.id !== "string" || block.id.length === 0) continue;
      const inputJson = JSON.stringify(block.input ?? {}).toLowerCase();
      if (needles.some(name => inputJson.includes(name))) ids.add(block.id);
    }
  }
  return ids;
}

/**
 * Claude Code (observed 2026-07-11, real CLI smoke) sends `role:"system"` entries in
 * `messages` despite the published API having no system role. Map them to Responses
 * instructions text: the native ChatGPT backend rejects system message items in
 * `input` ("System messages are not allowed", verified live), so folding into
 * `instructions` is the only shape that works on every route.
 */
function systemMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (isRec(raw) && raw.type === "text" && typeof raw.text === "string") parts.push(raw.text);
  }
  return parts.join("\n\n");
}

function userMessageToItems(content: unknown, input: Rec[], elide: SkillElisionContext = NO_ELISION): void {
  if (typeof content === "string") {
    if (content.length > 0) pushUserMessage(input, [{ type: "input_text", text: content }]);
    return;
  }
  if (!Array.isArray(content)) return;
  // Preserve block order: tool_result blocks become standalone function_call_output
  // items; contiguous text/image runs become one user message.
  let pending: Rec[] = [];
  for (const raw of content) {
    if (!isRec(raw)) continue;
    switch (raw.type) {
      case "text":
        if (typeof raw.text === "string") pending.push({ type: "input_text", text: maybeElideSkillText(raw.text, elide.names) });
        break;
      case "image": {
        const img = imageBlockToInputImage(raw);
        if (img) pending.push(img);
        break;
      }
      case "tool_result": {
        pushUserMessage(input, pending);
        pending = [];
        if (typeof raw.tool_use_id !== "string" || raw.tool_use_id.length === 0) {
          throw new AnthropicRequestError("tool_result requires tool_use_id");
        }
        input.push({
          type: "function_call_output",
          call_id: raw.tool_use_id,
          // Blocked-skill bundles are stubbed out for routed models (devlog 060).
          output: elide.callIds.has(raw.tool_use_id) ? skillElisionStub(raw.tool_use_id) : toolResultOutput(raw),
        });
        break;
      }
      case "document":
        // No Responses equivalent for raw document blocks; surface the title so the
        // model at least sees the attachment happened.
        pending.push({ type: "input_text", text: `[document${typeof raw.title === "string" ? `: ${raw.title}` : ""}]` });
        break;
      default:
        break; // thinking/redacted_thinking never appear in user messages; ignore unknowns
    }
  }
  pushUserMessage(input, pending);
}

function assistantMessageToItems(content: unknown, input: Rec[]): void {
  if (typeof content === "string") {
    if (content.length > 0) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] });
    return;
  }
  if (!Array.isArray(content)) return;
  let pendingText: Rec[] = [];
  const flush = () => {
    if (pendingText.length > 0) input.push({ type: "message", role: "assistant", content: pendingText });
    pendingText = [];
  };
  for (const raw of content) {
    if (!isRec(raw)) continue;
    switch (raw.type) {
      case "text":
        if (typeof raw.text === "string") pendingText.push({ type: "output_text", text: raw.text });
        break;
      case "tool_use": {
        flush();
        if (typeof raw.id !== "string" || raw.id.length === 0 || typeof raw.name !== "string" || raw.name.length === 0) {
          throw new AnthropicRequestError("tool_use requires id and name");
        }
        input.push({ type: "function_call", call_id: raw.id, name: raw.name, arguments: JSON.stringify(raw.input ?? {}) });
        break;
      }
      case "thinking":
      case "redacted_thinking":
        break; // v1 policy: dropped on replay (003 evidence — safe for routed providers)
      default:
        break;
    }
  }
  flush();
}

function toolsToResponses(tools: unknown): Rec[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Rec[] = [];
  for (const raw of tools) {
    if (!isRec(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type.startsWith("web_search")) {
      out.push({ type: "web_search" }); // hosted sidecar path
      continue;
    }
    if (typeof raw.name === "string" && raw.name.length > 0 && isRec(raw.input_schema)) {
      out.push({
        type: "function",
        name: raw.name,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        parameters: raw.input_schema as Record<string, unknown>,
      });
      continue;
    }
    // Other server tools (bash_*, text_editor_*, ...) have no routed equivalent: drop.
  }
  return out.length > 0 ? out : undefined;
}

function toolChoiceToResponses(choice: unknown, body: Rec): void {
  if (!isRec(choice)) return;
  if (choice.disable_parallel_tool_use === true) body.parallel_tool_calls = false;
  switch (choice.type) {
    case "auto": body.tool_choice = "auto"; break;
    case "none": body.tool_choice = "none"; break;
    case "any": body.tool_choice = "required"; break;
    case "tool":
      if (typeof choice.name !== "string" || choice.name.length === 0) {
        throw new AnthropicRequestError("tool_choice.tool requires a name");
      }
      body.tool_choice = { type: "function", name: choice.name };
      break;
    default: break;
  }
}

/** Recursive canonical JSON (keys sorted at every depth) — stable cache-cohort input. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Rec).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Provenance of the generated prompt_cache_key (never serialized into the wire body). */
export type ClaudeCacheKeySource = "metadata" | "system" | null;

export interface ClaudeInboundTranslation {
  body: Rec;
  cacheKeySource: ClaudeCacheKeySource;
}

/**
 * Translate an Anthropic Messages request body into a /v1/responses request body.
 * Throws AnthropicRequestError (-> 400 invalid_request_error) on malformed input.
 */
export function anthropicToResponsesBody(raw: unknown, cc?: OcxClaudeCodeConfig): Rec {
  return anthropicToResponsesTranslation(raw, cc).body;
}

/**
 * Full translation result: the wire body plus the prompt-cache-key provenance as an
 * OUT-OF-BODY tuple (audit 133 R3#1 — an in-body marker would leak upstream through
 * the native Responses forward and 400).
 */
export function anthropicToResponsesTranslation(raw: unknown, cc?: OcxClaudeCodeConfig): ClaudeInboundTranslation {
  if (!isRec(raw)) throw new AnthropicRequestError("request body must be a JSON object");
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    throw new AnthropicRequestError("model is required");
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new AnthropicRequestError("messages must be a non-empty array");
  }

  const input: Rec[] = [];
  const systemParts: string[] = [];
  const topLevelSystem = systemToInstructions(raw.system);
  if (topLevelSystem !== undefined) systemParts.push(topLevelSystem);
  const blockedNames = effectiveBlockedSkillNames(cc);
  const elide: SkillElisionContext = {
    callIds: blockedSkillCallIds(raw.messages, blockedNames),
    names: blockedNames,
  };
  for (const msg of raw.messages) {
    if (!isRec(msg)) throw new AnthropicRequestError("each message must be an object");
    if (msg.role === "user") userMessageToItems(msg.content, input, elide);
    else if (msg.role === "assistant") assistantMessageToItems(msg.content, input);
    else if (msg.role === "system") {
      const text = systemMessageText(msg.content);
      if (text.length > 0) systemParts.push(text);
    }
    else throw new AnthropicRequestError(`unsupported message role: ${String(msg.role)}`);
  }

  const body: Rec = {
    model: resolveInboundModel(raw.model, cc),
    input,
    store: false,
    stream: raw.stream === true,
  };

  if (systemParts.length > 0) body.instructions = systemParts.join("\n\n");

  const tools = toolsToResponses(raw.tools);
  if (tools) body.tools = tools;
  toolChoiceToResponses(raw.tool_choice, body);

  if (typeof raw.max_tokens === "number") body.max_output_tokens = raw.max_tokens;
  if (typeof raw.temperature === "number") body.temperature = raw.temperature;
  if (typeof raw.top_p === "number") body.top_p = raw.top_p;
  // top_k: accepted and dropped (no Responses equivalent).
  if (Array.isArray(raw.stop_sequences) && raw.stop_sequences.length > 0) {
    body.stop = raw.stop_sequences.filter((s): s is string => typeof s === "string");
  }
  let cacheKeySource: ClaudeCacheKeySource = null;
  if (isRec(raw.metadata) && typeof raw.metadata.user_id === "string") {
    body.user = raw.metadata.user_id;
    // OpenAI-side prompt caching is routed by prompt_cache_key (Codex clients send
    // their session id; without it consecutive /v1/messages turns reported
    // cached_tokens: 0 on the ChatGPT backend — devlog 090). Claude Code's
    // metadata.user_id embeds the session uuid, so hashing it yields a stable
    // per-session key with a bounded length/charset.
    body.prompt_cache_key = createHash("sha256").update(raw.metadata.user_id).digest("hex").slice(0, 32);
    cacheKeySource = "metadata";
  } else if (systemParts.length > 0) {
    // Claude Desktop sends no metadata.user_id (H1, devlog 130): without any key the
    // ChatGPT/OpenAI backends reported cached_tokens:0 on every turn. Fall back to a
    // cache-cohort hash (devlog 260712 B4 + Pro review 012): fingerprint what the
    // upstream actually receives — resolved model, post-translation system, and the
    // FULL translated tool definitions in WIRE ORDER (sorting the hash while sending
    // a different order would break the key↔prefix correspondence). canonical JSON
    // (recursive key sort) + a version field so future normalization changes never
    // mix cohorts. system-only keys herded different models/toolsets into one key
    // and burned OpenAI's ~15 RPM per-key routing budget (audit R1#4/R2#5/R1#10).
    // Exact-prefix matching still isolates content; the key only steers routing
    // affinity. Callers must NOT synthesize a session_id header from this fallback
    // (audit 133 R2#3).
    body.prompt_cache_key = createHash("sha256")
      .update(canonicalJson({
        version: 2,
        model: body.model,
        system: systemParts,
        tools: Array.isArray(body.tools) ? body.tools : [],
      }))
      .digest("hex").slice(0, 32);
    cacheKeySource = "system";
  }

  const thinking = raw.thinking;
  const outputConfigEffort = effortFromOutputConfig(raw.output_config);
  const thinkingDisabled = isRec(thinking) && thinking.type === "disabled";
  if (!thinkingDisabled && (isRec(thinking) || outputConfigEffort !== undefined)) {
    const reasoning: Rec = { summary: "auto" };
    if (outputConfigEffort !== undefined) {
      // Adaptive wire: /effort arrives as output_config.effort (devlog 080).
      reasoning.effort = outputConfigEffort;
    } else if (isRec(thinking) && thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
      reasoning.effort = effortForThinkingBudget(thinking.budget_tokens);
    }
    body.reasoning = reasoning;
  }

  return { body, cacheKeySource };
}
