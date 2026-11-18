/**
 * Anthropic's typed Advisor server tool (`advisor_20260301`, beta `advisor-tool-2026-03-01`) on the
 * translated Messages lane (#8448). Claude Code declares it by default; Anthropic runs the advisor
 * model server-side inside the same request and returns `server_tool_use` (name `advisor`, empty
 * input) followed by `advisor_tool_result`. Both blocks are kept verbatim for the next turn.
 *
 * Pure helpers shared by the inbound replay (`src/claude/inbound-content-options.ts`), the
 * adapter (`src/adapters/anthropic.ts`) and the Claude outbound. Nothing here reads, logs or
 * rewrites a result's text or `encrypted_content`; validation only checks field types.
 */
import { credentialDomainFor } from "../../protocols/opaque-state";
import type { OcxProviderConfig } from "../../types";

type Rec = Record<string, unknown>;

export const ADVISOR_TOOL_BETA = "advisor-tool-2026-03-01";
export const ADVISOR_SERVER_TOOL_NAME = "advisor";

function isPlainRecord(value: unknown): value is Rec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A typed Advisor declaration (`advisor_YYYYMMDD`), the same shape the native lane's scope check reads. */
export function isAdvisorServerToolType(type: unknown): boolean {
  return typeof type === "string" && /^advisor_\d{8}$/.test(type);
}

/**
 * Whether a destination receives the declaration: an `anthropic`-adapter provider on first-party
 * Anthropic by default, an Anthropic-compatible gateway only with `forwardAdvisorTool: true`.
 * An explicit `false` keeps it off even `api.anthropic.com` (a relay that borrows the
 * first-party body builder, like Zed's, sets it).
 */
export function advisorServerToolDestination(provider: Pick<OcxProviderConfig, "adapter" | "baseUrl" | "authMode" | "forwardAdvisorTool">): boolean {
  if (provider.adapter !== "anthropic" || provider.forwardAdvisorTool === false) return false;
  return provider.forwardAdvisorTool === true || credentialDomainFor(provider)?.firstPartyAnthropic === true;
}

/** The call input Anthropic documents: always an empty object. */
export function isAdvisorCallInput(input: unknown): input is Rec {
  return isPlainRecord(input) && Object.keys(input).length === 0;
}

/** A streamed call's assembled `input_json_delta` fragments; none at all is the empty input. */
export function advisorCallInputFromJson(json: string): Rec | undefined {
  if (json.trim() === "") return {};
  try {
    const input = JSON.parse(json) as unknown;
    return isAdvisorCallInput(input) ? input : undefined;
  } catch {
    return undefined;
  }
}

const RESULT_FIELDS: Readonly<Record<string, { required: string; optional: readonly string[] }>> = {
  advisor_result: { required: "text", optional: ["stop_reason"] },
  advisor_redacted_result: { required: "encrypted_content", optional: ["stop_reason"] },
  advisor_tool_result_error: { required: "error_code", optional: [] },
};

/**
 * `advisor_tool_result.content`: exactly one documented variant with string fields and no others —
 * `advisor_result` (`text`), `advisor_redacted_result` (`encrypted_content`), each with an
 * optional `stop_reason`, or `advisor_tool_result_error` (`error_code`).
 */
export function isAdvisorResultContent(content: unknown): boolean {
  if (!isPlainRecord(content) || typeof content.type !== "string" || !Object.hasOwn(RESULT_FIELDS, content.type)) return false;
  const fields = RESULT_FIELDS[content.type]!;
  if (typeof content[fields.required] !== "string") return false;
  return Object.keys(content).every(key => key === "type" || key === fields.required
    || (fields.optional.includes(key) && typeof content[key] === "string"));
}

/**
 * A replayed Advisor block rebuilt from the fields Anthropic documents, so nothing a client added to
 * its history rides along; undefined for any other block, which the caller copies as before.
 */
export function advisorReplayBlock(block: Rec): Rec | undefined {
  if (block.type === "server_tool_use" && block.name === ADVISOR_SERVER_TOOL_NAME) {
    return { type: "server_tool_use", id: block.id, name: ADVISOR_SERVER_TOOL_NAME, input: block.input };
  }
  if (block.type === "advisor_tool_result") {
    return { type: "advisor_tool_result", tool_use_id: block.tool_use_id, content: block.content };
  }
  return undefined;
}

/** Whether a declared catalog or replay run names the Advisor. */
export function hasAdvisorDeclaration(tools: readonly Rec[] | undefined): boolean {
  return tools?.some(tool => isAdvisorServerToolType(tool.type)) === true;
}

function runHasAdvisor(run: readonly Rec[]): boolean {
  return run.some(block => block.type === "server_tool_use" && block.name === ADVISOR_SERVER_TOOL_NAME);
}

function runHasOtherServerTool(run: readonly Rec[]): boolean {
  return run.some(block => block.type === "server_tool_use" && block.name !== ADVISOR_SERVER_TOOL_NAME);
}

/**
 * Withhold the caller's Advisor for a turn the proxy Advisor joins: its declaration and every
 * replayed run that contains an Advisor call. The synthetic `advisor` owns the name for the whole
 * turn, so a later leg that drops the synthetic tool (consultations exhausted) must not bring the
 * history or the beta back and change the prompt mid-turn. Returns whether a declaration was withheld.
 */
export function withholdAdvisorServerTools(parsed: {
  _anthropicServerTools?: readonly Rec[];
  _anthropicServerReplay?: ReadonlyMap<string, readonly Rec[]>;
}): boolean {
  const declared = hasAdvisorDeclaration(parsed._anthropicServerTools);
  if (declared) parsed._anthropicServerTools = parsed._anthropicServerTools!.filter(tool => !isAdvisorServerToolType(tool.type));
  const replay = parsed._anthropicServerReplay;
  if (replay && [...replay.values()].some(runHasAdvisor)) {
    const kept = new Map([...replay].filter(([, run]) => !runHasAdvisor(run)));
    if (kept.size > 0) parsed._anthropicServerReplay = kept;
    else delete parsed._anthropicServerReplay;
  }
  return declared;
}

export interface AnthropicServerToolPlan {
  /** Typed declarations this destination receives, in caller order. */
  declared: Rec[];
  /** Replayable runs this destination receives. */
  replay?: ReadonlyMap<string, readonly Rec[]>;
  /** Betas the forwarded Advisor declaration or history needs. */
  betas: string[];
}

/**
 * Split the caller's out-of-body server tools by destination. Web tools keep their own audience
 * (`webDestination`); the Advisor goes to `advisorServerToolDestination` unless a function tool of
 * the same name owns it this turn (the proxy Advisor's synthetic tool, or a client function). A
 * shadowed or ineligible turn drops both the declaration and the Advisor history, as before #8448.
 */
export function planAnthropicServerTools(
  provider: Pick<OcxProviderConfig, "adapter" | "baseUrl" | "authMode" | "forwardAdvisorTool">,
  declared: readonly Rec[] | undefined,
  replay: ReadonlyMap<string, readonly Rec[]> | undefined,
  functionNames: ReadonlySet<string>,
  webDestination: boolean,
): AnthropicServerToolPlan {
  const advisor = advisorServerToolDestination(provider) && !functionNames.has(ADVISOR_SERVER_TOOL_NAME);
  const tools = (declared ?? []).filter(tool => isAdvisorServerToolType(tool.type) ? advisor : webDestination);
  let runs: Map<string, readonly Rec[]> | undefined;
  let replaysAdvisor = false;
  for (const [anchor, run] of replay ?? []) {
    const hasAdvisor = runHasAdvisor(run);
    if ((hasAdvisor && !advisor) || (runHasOtherServerTool(run) && !webDestination)) continue;
    replaysAdvisor ||= hasAdvisor;
    (runs ??= new Map()).set(anchor, run);
  }
  const betas = advisor && (replaysAdvisor || hasAdvisorDeclaration(tools)) ? [ADVISOR_TOOL_BETA] : [];
  return { declared: tools, ...(runs ? { replay: runs } : {}), betas };
}

/**
 * A streamed `advisor_tool_result` paired with the open `server_tool_use` of the same response.
 * Undefined when the call is missing, its id differs, its input is not the documented empty object,
 * or the result content is not a documented variant: the exchange is dropped, never synthesized.
 */
export function advisorServerExchange(
  call: { id: string; name?: string; json: string } | undefined,
  result: Rec,
): { blocks: { use: Rec; result: Rec }; completed: boolean } | undefined {
  if (!call || call.name !== ADVISOR_SERVER_TOOL_NAME || call.id !== result.tool_use_id) return undefined;
  const input = advisorCallInputFromJson(call.json);
  if (!input || !isAdvisorResultContent(result.content)) return undefined;
  return {
    blocks: { use: { type: "server_tool_use", id: call.id, name: ADVISOR_SERVER_TOOL_NAME, input }, result },
    completed: (result.content as Rec).type !== "advisor_tool_result_error",
  };
}
