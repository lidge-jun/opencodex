import type { PonytailLevel } from "./types";
import type { OcxParsedRequest } from "../types/request";

// Ponytail intensity-level prompts injected into system message to bias toward minimal code.
// Adapted from ponytail skill (https://github.com/DietrichGebert/ponytail).

export const PONYTAIL_LEVELS: Record<string, PonytailLevel> = {
  LITE: "lite",
  FULL: "full",
  ULTRA: "ultra",
};

const SHARED_PERSONA = "You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.";

const SHARED_LADDER = "Before writing code, stop at the first rung that holds: 1) Does this need to exist at all? (YAGNI) 2) Stdlib does it? Use it. 3) Native platform feature covers it? Use it (CSS over JS, DB constraint over app code). 4) Already-installed dependency solves it? Use it; never add a new one for what a few lines can do. 5) Can it be one line? One line. 6) Only then: the minimum code that works.";

const SHARED_RULES = "No unrequested abstractions (no interface with one implementation, no factory for one product, no config for a value that never changes). No boilerplate or scaffolding \"for later\". Deletion over addition. Boring over clever. Fewest files possible; shortest working diff wins. Two stdlib options the same size: take the edge-case-correct one. Mark deliberate simplifications with a `ponytail:` comment naming the ceiling and upgrade path.";

const SHARED_OUTPUT = "Code first. Then at most three short lines: what was skipped, when to add it. No essays or design notes. Pattern: `[code] → skipped: [X], add when [Y].`";

const SHARED_NOT_LAZY = "Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested. Non-trivial logic leaves ONE runnable check behind (an assert-based self-check or one small test file; no frameworks). Trivial one-liners need no test.";

const SHARED_PERSISTENCE = "ACTIVE EVERY RESPONSE. No drift back to over-building. Still active if unsure.";

export const PONYTAIL_PROMPTS: Record<PonytailLevel, string> = {
  lite: [
    SHARED_PERSONA,
    "Lite: build what's asked, but name the lazier alternative in one line. User picks.",
    SHARED_LADDER,
    SHARED_RULES,
    SHARED_OUTPUT,
    SHARED_NOT_LAZY,
    SHARED_PERSISTENCE,
  ].join(" "),

  full: [
    SHARED_PERSONA,
    "Full: the ladder enforced. Stdlib and native first. Shortest diff, shortest explanation.",
    SHARED_LADDER,
    SHARED_RULES,
    SHARED_OUTPUT,
    SHARED_NOT_LAZY,
    SHARED_PERSISTENCE,
  ].join(" "),

  ultra: [
    SHARED_PERSONA,
    "Ultra: YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same response.",
    SHARED_LADDER,
    SHARED_RULES,
    SHARED_OUTPUT,
    SHARED_NOT_LAZY,
    SHARED_PERSISTENCE,
  ].join(" "),
};


export function injectPonytail(parsed: OcxParsedRequest, level: PonytailLevel = "full"): void {
  const prompt = PONYTAIL_PROMPTS[level] || PONYTAIL_PROMPTS.full;
  if (!parsed.context) {
    parsed.context = { messages: [] };
  }
  if (!Array.isArray(parsed.context.systemPrompt)) {
    parsed.context.systemPrompt = [];
  }
  if (!parsed.context.systemPrompt.some(p => p.includes("lazy senior developer"))) {
    parsed.context.systemPrompt.push(prompt);
  }

  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    injectPonytailToRawBody(parsed._rawBody, level);
  }
}

export function injectPonytailToRawBody(rawBody: unknown, level: PonytailLevel = "full"): void {
  if (!rawBody || typeof rawBody !== "object") return;
  const prompt = PONYTAIL_PROMPTS[level] || PONYTAIL_PROMPTS.full;
  const body = rawBody as Record<string, unknown>;

  if (typeof body.instructions === "string") {
    if (!body.instructions.includes("lazy senior developer")) {
      const sep = String.fromCharCode(10) + String.fromCharCode(10);
      body.instructions = body.instructions.trim() ? body.instructions + sep + prompt : prompt;
    }
    return;
  }

  if (Array.isArray(body.messages)) {
    const sysMsg = body.messages.find(m => m && typeof m === "object" && (m as Record<string, unknown>).role === "system") as Record<string, unknown> | undefined;
    if (sysMsg && typeof sysMsg.content === "string") {
      if (!sysMsg.content.includes("lazy senior developer")) {
        const sep = String.fromCharCode(10) + String.fromCharCode(10);
        sysMsg.content = sysMsg.content.trim() ? sysMsg.content + sep + prompt : prompt;
      }
    } else {
      body.messages.unshift({ role: "system", content: prompt });
    }
    return;
  }
}
