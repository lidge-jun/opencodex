/**
 * Local, deterministic prompt-complexity classifier for routing profiles.
 *
 * This module never calls a model and never returns the prompt itself. Stable
 * signal ids make the decision testable without persisting request content.
 */

import type { OcxRoutingTaskTier } from "../types";

export interface PromptClassification {
  tier: OcxRoutingTaskTier;
  score: number;
  signals: string[];
}

const SIMPLE_PROMPT = [
  /^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening))[!. ]*$/i,
  /^(?:你好|您好|嗨|在吗|谢谢|早上好|下午好|晚上好)[！!。.\s]*$/,
  /\b(?:translate|summari[sz]e|rephrase|rename|fix (?:a )?typo|one[- ]line|briefly)\b/i,
  /(?:翻译|简要总结|简单总结|改写这句话|换个说法|重命名|修正错别字|一句话回答)/,
];

const COMPLEX_PROMPT = [
  /\b(?:architect(?:ure)?|refactor|debug|investigate|root cause|security|performance|benchmark|migration|repository|codebase|pull request|implement|integration test|test suite|deployment)\b/i,
  /(?:架构|重构|调试|排查|根因|安全审计|性能优化|基准测试|迁移|代码库|仓库|完整项目|实现功能|集成测试|测试套件|部署|打包|准备\s*PR|创建\s*PR)/i,
];

const MULTI_STEP_LINE = /^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+/gm;

function requestedReasoningEffort(body: Record<string, unknown>): string | undefined {
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort === "string") return effort.toLowerCase();
  }
  const effort = body.reasoning_effort;
  return typeof effort === "string" ? effort.toLowerCase() : undefined;
}

export function reasoningEffortFromBody(body: Record<string, unknown>): string | undefined {
  return requestedReasoningEffort(body);
}

export function classifyPromptComplexity(
  prompt: string,
  reasoningEffort?: string,
): PromptClassification {
  const text = prompt.trim();
  let score = 2;
  const signals: string[] = [];

  if (text.length <= 80) {
    score -= 1;
    signals.push("short-prompt");
  } else if (text.length >= 4_000) {
    score += 2;
    signals.push("very-long-prompt");
  } else if (text.length >= 1_200) {
    score += 1;
    signals.push("long-prompt");
  }

  if (SIMPLE_PROMPT.some(pattern => pattern.test(text))) {
    score -= 2;
    signals.push("simple-intent");
  }
  if (COMPLEX_PROMPT.some(pattern => pattern.test(text))) {
    score += 2;
    signals.push("complex-intent");
  }
  if (/```[\s\S]*```/.test(text)) {
    score += 1;
    signals.push("code-block");
  }
  if ((text.match(MULTI_STEP_LINE) ?? []).length >= 3) {
    score += 1;
    signals.push("multi-step");
  }

  const effort = reasoningEffort?.toLowerCase();
  if (effort === "minimal" || effort === "low") {
    score -= 1;
    signals.push("low-reasoning");
  } else if (effort === "high") {
    score += 1;
    signals.push("high-reasoning");
  } else if (effort === "xhigh" || effort === "max" || effort === "ultra") {
    score = Math.max(score + 2, 4);
    signals.push("intensive-reasoning");
  }

  return {
    tier: score <= 1 ? "fast" : score >= 4 ? "powerful" : "balanced",
    score,
    signals,
  };
}
