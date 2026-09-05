import type { OcxClaudeCodeConfig } from "../types";
import { isAnthropicOutputSchema } from "../adapters/anthropic-output-schema";
import { resolveAlias } from "./alias";
import { stripOneMillionMarker } from "./context-windows";
import { resolveDesktop3pAlias } from "./desktop-3p";
import { isRec, type Rec } from "./inbound-records";

function isClaudeClassifierModel(model: string): boolean {
  const stripped = model.replace(/-\d{8}$/, "");
  return /^claude-opus-[45]/.test(stripped);
}

/**
 * Explicitly configured classifier route for Claude Code Auto Mode safety checks (#1697).
 *
 * Only OPERATOR-DECLARED targets are used: `classifierModel`, then the ordered
 * `classifierFallbacks`. Both are qualified `provider/model` strings the operator chose, so
 * routing them crosses no boundary the operator did not ask for.
 *
 * Deliberately NOT here: inferring a provider from `claudeCode.model`. That value is the
 * injected/default config slot, not the provider the live session actually selected, so it goes
 * stale the moment the user changes the model picker -- and acting on it would silently move a
 * classifier turn onto a provider with its own privacy and billing consequences. Live session
 * affinity needs the request/session state this function does not have; it is tracked as
 * follow-up work rather than approximated from static config.
 */
function configuredClassifierRoute(cc?: OcxClaudeCodeConfig): string | undefined {
  const explicit = typeof cc?.classifierModel === "string" ? cc.classifierModel.trim() : "";
  if (explicit.length > 0) return explicit;
  if (Array.isArray(cc?.classifierFallbacks)) {
    for (const candidate of cc.classifierFallbacks) {
      if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
    }
  }
  return undefined;
}

/** Alias first, then modelMap: exact id, then date-suffix-stripped (`-\d{8}$`), then classifier affinity/config, else passthrough. */
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

  // Claude Code Auto Mode classifier routing (#1697). Bare classifier checks such as
  // `claude-opus-5` carry no provider, so without this they fall through to defaultProvider --
  // which may not speak Anthropic at all. Only an operator-declared target is used.
  if (isClaudeClassifierModel(model)) {
    const configured = configuredClassifierRoute(cc);
    if (configured) return configured;
  }
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

export function formatFromOutputConfig(outputConfig: unknown): Rec | undefined {
  if (!isRec(outputConfig) || !isRec(outputConfig.format)) return undefined;
  const format = outputConfig.format;
  if (
    format.type !== "json_schema"
    || !isRec(format.schema)
    || !isAnthropicOutputSchema(format.schema)
  ) return undefined;
  return { type: "json_schema", name: "response", schema: format.schema };
}

/**
 * ocx-route directive (devlog 072): injected agent-definition bodies carry
 * `<!-- ocx-route: <model> -->` because Claude Code 2.1.207 ignores custom
 * gateway ids in agent frontmatter (live-proven fallback to sonnet). The body
 * rides the subagent's system prompt, so the proxy re-routes here. Only the
 * FIRST directive wins; the scan is bounded to the system field.
 */
const OCX_ROUTE_RE = /<!--\s*ocx-route:\s*([^\s]+)\s*-->/;
const OCX_EFFORT_RE = /<!--\s*ocx-effort:\s*(low|medium|high|xhigh|max)\s*-->/;

function systemText(body: unknown): string | null {
  if (!isRec(body)) return null;
  const system = body.system;
  if (typeof system === "string") return system || null;
  if (!Array.isArray(system)) return null;
  const text = system
    .filter((b): b is Rec => isRec(b) && b.type === "text" && typeof b.text === "string")
    .map(b => b.text as string)
    .join("\n");
  return text || null;
}

export function extractOcxRouteDirective(body: unknown): string | null {
  const text = systemText(body);
  if (!text) return null;
  const match = OCX_ROUTE_RE.exec(text);
  return match ? match[1]! : null;
}

/**
 * Claude Code 2.1.220 collapses custom-agent frontmatter `effort: max` and
 * `effort: xhigh` into the legacy `thinking.budget_tokens` shape. Preserve the
 * exact generated-agent setting through the same trusted system-body channel as
 * ocx-route so the inbound translator can restore `output_config.effort`.
 */
export function extractOcxEffortDirective(body: unknown): NonNullable<OcxClaudeCodeConfig["subagentEffort"]> | null {
  const text = systemText(body);
  if (!text) return null;
  const match = OCX_EFFORT_RE.exec(text);
  return match ? match[1] as NonNullable<OcxClaudeCodeConfig["subagentEffort"]> : null;
}
