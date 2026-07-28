/**
 * Deterministic ordering of Claude Code's own tool/skills/deferred-tools listings on
 * the native Anthropic passthrough (`anthropicNativePassthrough`, `claude-messages.ts`).
 * Claude Code enumerates MCP tools/skills in whatever order its own reconnect/discovery
 * race resolves them, so byte-identical conversations can arrive with different array
 * order turn to turn — busting Anthropic's prompt-cache prefix for no reason. Sorting is
 * safe: `tool_choice` targets tools by name, not position, and the two system-reminder
 * blocks below are pure listings with no inherent order the model depends on.
 *
 * Ported (algorithm only, re-implemented in TypeScript) from `sort-stabilization.mjs`,
 * MIT licensed, github.com/cnighswonger/claude-code-cache-fix.
 */

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const SKILLS_BLOCK_RE = /^([\s\S]*?\n\n)(- [\s\S]+?)(\n<\/system-reminder>\s*)$/;
const DEFERRED_TOOLS_BLOCK_RE = /^(<system-reminder>\nThe following deferred tools are now available[^\n]*\n)([\s\S]+?)(\n<\/system-reminder>\s*)$/;

export function isSkillsBlockText(text: unknown): text is string {
  return typeof text === "string" && text.includes("User-invocable skills");
}

export function isDeferredToolsBlockText(text: unknown): text is string {
  return typeof text === "string" && text.includes("deferred tools are now available");
}

export function sortSkillsBlockText(text: string): string {
  const match = text.match(SKILLS_BLOCK_RE);
  if (!match) return text;
  const [, header, entriesText, footer] = match;
  const entries = entriesText.split(/\n(?=- )/);
  entries.sort();
  return header + entries.join("\n") + footer;
}

export function sortDeferredToolsBlockText(text: string): string {
  const match = text.match(DEFERRED_TOOLS_BLOCK_RE);
  if (!match) return text;
  const [, header, toolsList, footer] = match;
  const tools = toolsList.split("\n").map(t => t.trim()).filter(Boolean);
  tools.sort();
  return header + tools.join("\n") + footer;
}

/** Normalize known system-reminder listings; leave all other instructions untouched. */
export function normalizeSystemReminderText(text: string): string {
  if (isSkillsBlockText(text)) return sortSkillsBlockText(text);
  if (isDeferredToolsBlockText(text)) return sortDeferredToolsBlockText(text);
  return text;
}

/** Sort tool definitions by name; unnamed server tools sort first. */
export function sortToolsByName(tools: unknown[]): void {
  tools.sort((a, b) => {
    const nameA = isRec(a) && typeof a.name === "string" ? a.name : "";
    const nameB = isRec(b) && typeof b.name === "string" ? b.name : "";
    return nameA.localeCompare(nameB);
  });
}

/** Sort `body.system` skills/deferred-tools listings and `body.tools` by name, in place. */
export function stabilizeSystemAndToolOrder(body: Rec): void {
  if (Array.isArray(body.system)) {
    const system = body.system as unknown[];
    for (let i = 0; i < system.length; i++) {
      const block = system[i];
      if (!isRec(block) || block.type !== "text" || typeof block.text !== "string") continue;
      const normalized = normalizeSystemReminderText(block.text);
      if (normalized !== block.text) system[i] = { ...block, text: normalized };
    }
  }

  if (Array.isArray(body.tools)) sortToolsByName(body.tools as unknown[]);
}
