// Ask Pao Brain — deterministic intent routing over local metadata. Phase 15
// keeps this local-first: pattern-routed queries answer from the Agent OS store
// with source citations; unmatched questions return a scoped, honest fallback
// instead of a fabricated answer.

import { listMemories } from "./memory";
import { listSkills } from "./skills";
import { listTasks } from "./tasks";
import { listNodes } from "./remote";
import { searchAgentOs } from "./search";

export interface AskAnswer {
  question: string;
  intent: string;
  answer: string;
  sources: string[];
}

export function askPaoBrain(question: string): AskAnswer {
  const q = question.toLowerCase();

  if (/mcp.*(offline|online|health)|offline.*mcp/.test(q)) {
    const nodes = listNodes();
    const offline = nodes.filter((n) => n.status !== "online");
    return {
      question,
      intent: "mcp_health",
      answer: offline.length === 0
        ? "All registered nodes are online (or none are registered yet)."
        : `Not healthy: ${offline.map((n) => `${n.name} (${n.status})`).join(", ")}`,
      sources: offline.map((n) => `remote-node:${n.id}`),
    };
  }

  if (/skill.*(unused|not used|ไม่ได้ใช้)|unused.*skill/.test(q)) {
    const skills = listSkills();
    return {
      question,
      intent: "skill_usage",
      answer: skills.length === 0
        ? "No skills registered."
        : `${skills.length} skills registered: ${skills.map((s) => s.name).join(", ")}. Usage mapping is recorded per skill config.`,
      sources: skills.map((s) => `skill:${s.id}`),
    };
  }

  if (/error|fail|ปัญหา|พัง/.test(q)) {
    const failed = listTasks("failed");
    return {
      question,
      intent: "errors",
      answer: failed.length === 0
        ? "No failed tasks right now."
        : `${failed.length} failed task(s): ${failed.map((t) => `${t.title} (${t.error?.message ?? "unknown"})`).join("; ")}`,
      sources: failed.map((t) => `task:${t.id}`),
    };
  }

  if (/memory|decision|จำ/.test(q)) {
    const memories = listMemories({ limit: 5 });
    return {
      question,
      intent: "memory",
      answer: memories.length === 0 ? "No memories recorded." : memories.map((m) => m.title).join("; "),
      sources: memories.map((m) => `memory:${m.id}`),
    };
  }

  const hits = searchAgentOs(question, 5);
  return {
    question,
    intent: "search_fallback",
    answer: hits.length === 0
      ? "No local match found. (Semantic search needs a local model seam — not configured.)"
      : `Top local matches: ${hits.map((h) => `${h.kind}:${h.title}`).join("; ")}`,
    sources: hits.map((h) => `${h.kind}:${h.id}`),
  };
}
