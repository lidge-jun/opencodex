/**
 * The sizing rubric for Codex agent roles: which capability tier a role needs and how hard it
 * should reason, on a neutral scale that never names a model.
 *
 * This is the one home of the rubric. The dashboard's auto-assign sends it as the system prompt
 * and parses the answer here; any later surface that sizes a role imports it rather than
 * restating it. Choosing the concrete model and the concrete effort level is not the sizing
 * model's job: that mapping is deterministic code in "role-auto-assign.ts".
 *
 * The tier and effort definitions, the risk factors, and the rules are ported from the
 * modelchk skill by LilMGenius,
 * https://github.com/LilMGenius/paperthin/blob/main/skills/depth/modelchk/SKILL.md,
 * adapted from sizing one task to sizing a standing role and given a strict JSON answer shape.
 * That text is used under the MIT License:
 *
 *   Copyright (c) 2026 LilMGenius
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 *   BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/** Capability tiers, cheapest first. */
export const SIZING_TIERS = ["fast", "standard", "frontier"] as const;
export type SizingTier = typeof SIZING_TIERS[number];

/** Reasoning effort intents, least deliberation first. Positions on a ladder, never level names. */
export const SIZING_EFFORTS = ["glance", "measured", "thorough", "exhaustive"] as const;
export type SizingEffort = typeof SIZING_EFFORTS[number];

export const ROLE_INSTRUCTIONS_EXCERPT_CHARS = 1500;

const MAX_FIELD_CHARS = 400;

export const ROLE_SIZING_SYSTEM_PROMPT = [
  "You size Codex agent roles before anyone spends a run on them. Each role is a standing agent that",
  "a parent hands many tasks of the kind its instructions describe. For each role, size two dials",
  "from one assessment of risk and complexity: capability tier and reasoning effort.",
  "",
  "Capability tier is the cheapest sufficient class:",
  "- fast: local, mechanical, reversible work with cheap, complete verification.",
  "- standard: ordinary repo-grounded reasoning, multi-step drafting, normal coding, and conventional documentation or skill work.",
  "- frontier: architecture, high ambiguity, safety/security/privacy/data-loss risk, release-critical review, cross-domain scope, or work where one wrong assumption wastes a large run.",
  "",
  "Reasoning effort is how hard the model should deliberate. From least to most deliberation:",
  "- glance: minimal deliberation; take the direct path. Resolves to the model's floor.",
  "- measured: ordinary deliberation. Resolves to the model's default, or the middle of its ladder if no default is named.",
  "- thorough: work the alternatives and check assumptions. Resolves above the everyday setting, short of the top.",
  "- exhaustive: maximal deliberation; exhaust the search and re-check the work. Resolves to the model's ceiling.",
  "",
  "The axes are independent. A bounded but fiddly role can be fast + thorough; a quick expert call can",
  "be frontier + glance. In most work they move together, parting when a cheap task needs hard thinking",
  "or a strong model needs only a quick call. Effort buys deliberation, never capability, and more",
  "effort is not more correct.",
  "",
  "Assess risk and complexity once for both dials:",
  "- file, module, or ownership boundary crossing;",
  "- reversibility and blast radius;",
  "- safety, security, privacy, publishing, or data-loss risk;",
  "- novelty, ambiguity, and long-context synthesis load;",
  "- need for external research, adversarial review, or careful release sequencing;",
  "- cost of a wrong answer.",
  "",
  "Choose the cheapest capability tier whose ceiling covers the role's judgment and risk. Default effort",
  "to track tier (fast->glance, standard->measured, frontier->thorough), reserving exhaustive for the",
  "hardest, highest-stakes work. Raise effort when an otherwise cheap role needs ambiguity resolved, long",
  "multi-step reasoning, or adversarial self-check; lower it for bounded work under a strong model.",
  "",
  "Rules:",
  "- Default to the cheapest sufficient tier and the effort the work needs, not the strongest of either.",
  "- Never raise effort to buy capability; raise the tier.",
  "- Risk beats size: a narrow high-risk role can need frontier; a broad mechanical role can stay fast + thorough.",
  "- Use only the neutral words above. Do not name concrete model products, vendors, versions, or vendor effort levels anywhere in the answer.",
  "",
  "Answer with one JSON object and nothing else, no prose and no code fence:",
  '{"roles":{"<role name>":{"tier":"fast|standard|frontier","effort":"glance|measured|thorough|exhaustive","rationale":"<one sentence covering both dials>","move_up_if":"<signals that would justify a stronger tier or higher effort>","move_down_if":"<signals that would justify a cheaper tier or lower effort>"}}}',
  "Include every role you were given, keyed by its exact name, with exactly those five fields.",
].join("\n");

export interface RoleSizing {
  readonly tier: SizingTier;
  readonly effort: SizingEffort;
  readonly rationale: string;
  readonly moveUpIf: string;
  readonly moveDownIf: string;
}

/** A role's sizing, or the reason it could not be sized. No reason is ever turned into a guess. */
export type RoleSizingOutcome =
  | { readonly sizing: RoleSizing }
  | { readonly unsized: string };

export interface RoleSizingInput {
  readonly role: string;
  readonly instructions: string;
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * What the sizing model reads about one role: its description, then its developer instructions,
 * cut to ROLE_INSTRUCTIONS_EXCERPT_CHARS. Null when the file is not TOML or carries neither,
 * because a role sized from its name alone would be a guess.
 */
export function roleInstructionsExcerpt(toml: string): string | null {
  let document: unknown;
  try {
    document = Bun.TOML.parse(toml.replace(/^\ufeff/, ""));
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null) return null;
  const fields = document as Record<string, unknown>;
  const parts = [textField(fields.description), textField(fields.developer_instructions)]
    .filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return parts.join("\n\n").slice(0, ROLE_INSTRUCTIONS_EXCERPT_CHARS);
}

export function buildRoleSizingUserMessage(inputs: readonly RoleSizingInput[]): string {
  return "Size these Codex agent roles.\n\n" + JSON.stringify({
    roles: inputs.map(input => ({ name: input.role, instructions: input.instructions })),
  }, null, 2);
}

const ANSWER_FIELDS = ["tier", "effort", "rationale", "move_up_if", "move_down_if"] as const;

function oneLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed === "" || collapsed.length > MAX_FIELD_CHARS ? null : collapsed;
}

function isMember<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (set as readonly string[]).includes(value);
}

function validateEntry(entry: unknown): RoleSizingOutcome {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { unsized: "the sizing answer for this role is not an object" };
  }
  const fields = entry as Record<string, unknown>;
  const extra = Object.keys(fields).filter(key => !(ANSWER_FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) return { unsized: "the sizing answer has unexpected fields: " + extra.join(", ") };
  if (!isMember(SIZING_TIERS, fields.tier)) return { unsized: "the sizing answer has no valid tier" };
  if (!isMember(SIZING_EFFORTS, fields.effort)) return { unsized: "the sizing answer has no valid effort" };
  const rationale = oneLine(fields.rationale);
  const moveUpIf = oneLine(fields.move_up_if);
  const moveDownIf = oneLine(fields.move_down_if);
  if (rationale === null || moveUpIf === null || moveDownIf === null) {
    return { unsized: "the sizing answer is missing a rationale or a move trigger" };
  }
  return { sizing: { tier: fields.tier, effort: fields.effort, rationale, moveUpIf, moveDownIf } };
}

const CODE_FENCE = /^\x60{3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\x60{3}$/i;

/**
 * Validate the sizing model's answer for each requested role.
 *
 * The answer must be one JSON object of the shape the rubric asks for. The only leniency is a
 * single surrounding code fence, which models add out of habit and which carries no content.
 * Anything else wrong marks the affected role, or every role when the whole answer is unusable,
 * as unsized with the reason.
 */
export function parseRoleSizingResponse(text: string, roles: readonly string[]): Map<string, RoleSizingOutcome> {
  const out = new Map<string, RoleSizingOutcome>();
  const everyRole = (reason: string) => {
    for (const role of roles) out.set(role, { unsized: reason });
    return out;
  };
  const trimmed = text.trim();
  const fenced = CODE_FENCE.exec(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ? fenced[1]! : trimmed);
  } catch {
    return everyRole("the sizing model did not answer with JSON");
  }
  const answered = typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>).roles
    : undefined;
  if (typeof answered !== "object" || answered === null || Array.isArray(answered)) {
    return everyRole("the sizing answer has no roles object");
  }
  for (const role of roles) {
    out.set(role, Object.hasOwn(answered, role)
      ? validateEntry((answered as Record<string, unknown>)[role])
      : { unsized: "the sizing model did not size this role" });
  }
  return out;
}
