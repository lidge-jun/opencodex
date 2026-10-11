import type { TKey } from "../../i18n/en";

/**
 * Compatibility linter for a custom prompt layer. Pure, no I/O.
 *
 * Every rule traces to devlog 002 section 6. Findings are WARNINGS and never
 * block a save: a user who deliberately wants to override Codex's identity may,
 * they just should not do it by accident.
 */
export type LintLevel = "warn" | "info";

export interface LintFinding {
  level: LintLevel;
  rule: string;
  messageKey: TKey;
  /** [start, end) into the body, for inline highlighting. */
  span?: [number, number];
}

/**
 * The 8 KB advisory is OPENCODEX POLICY, not an upstream limit.
 * `developer_instructions` is a plain config string with no cap, and an earlier
 * draft wrongly cited the 32 KiB AGENTS.md project-doc budget, which governs an
 * unrelated mechanism. The justification is per-request token cost and keeping a
 * hand-editable config file hand-editable - so it is info, never warn.
 */
const SIZE_ADVISORY_BYTES = 8 * 1024;

interface Rule {
  rule: string;
  level: LintLevel;
  messageKey: TKey;
  pattern: RegExp;
  /**
   * Never echo the matched text back: for credential-shaped matches the span
   * IS the sensitive value, and rendering it beside the warning would copy the
   * secret out of the editor and onto screenshots and shoulders.
   */
  redactSpan?: boolean;
}

const RULES: readonly Rule[] = [
  {
    // Contradicts the base identity Codex already establishes.
    rule: "identity",
    level: "warn",
    messageKey: "codexSet.lint.identity",
    pattern: /you\s+are\s+(claude|grok|gemini|gpt-|chatgpt)/gi,
  },
  {
    // The tool registry defines the tools; prose cannot add or rename one.
    rule: "foreign-tool",
    level: "warn",
    messageKey: "codexSet.lint.foreignTool",
    pattern: /\b(Read|Edit|Write|Bash|Glob|Grep)\s+tool\b/g,
  },
  {
    // No template engine runs over instructions, so a placeholder ships literally.
    rule: "placeholder",
    level: "warn",
    messageKey: "codexSet.lint.placeholder",
    pattern: /\$\{\{[\s\S]*?\}\}/g,
  },
  {
    rule: "apply-patch",
    level: "warn",
    messageKey: "codexSet.lint.applyPatch",
    pattern: /apply_patch\s+(?:is|must|should|means|works)/gi,
  },
  {
    // Codex injects its own approval vocabulary; a second one contradicts it.
    rule: "approval-vocab",
    level: "warn",
    messageKey: "codexSet.lint.approvalVocab",
    pattern: /\b(always-approve|ask mode|acceptEdits)\b/gi,
  },
  {
    // Environment facts are generated later and will contradict a stated one.
    rule: "environment",
    level: "warn",
    messageKey: "codexSet.lint.environment",
    pattern: /\b(your (?:cwd|working directory) is|today's date is|you have no network access|you are running on (?:macos|linux|windows))/gi,
  },
  {
    // A credential pasted into a layer lands in config.toml in plain text and
    // ships to the model on every request. The shapes here cover the common
    // token prefixes; false positives are acceptable for a warning that never
    // blocks a save. The match itself is never rendered - see redactSpan.
    rule: "secret",
    level: "warn",
    messageKey: "codexSet.lint.secret",
    redactSpan: true,
    pattern: /(sk-[a-zA-Z0-9_-]{20,}|ghp_[0-9a-zA-Z]{36}|github_pat_[0-9a-zA-Z_]{22,}|glpat-[0-9a-zA-Z_-]{20,}|xox[baprs]-[0-9a-zA-Z-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g,
  },
  {
    // Phrasing that tells the model to drop its own instructions is prompt
    // injection even when the user wrote it about themselves - it strips the
    // guidance Codex builds up around this layer.
    rule: "ignore-instructions",
    level: "warn",
    messageKey: "codexSet.lint.ignoreInstructions",
    pattern: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?)\b/gi,
  },
  {
    // The same identity clash as "identity", in Korean: this fork's users write
    // layers in Korean at least as often as in English, and "당신은 클로드" is
    // the same accident as "you are claude". Reuses the English message.
    rule: "identity-ko",
    level: "warn",
    messageKey: "codexSet.lint.identity",
    // ASCII tokens want \b so "claudette" does not match; Hangul cannot take \b
    // because every syllable is a non-word char, so "클로드입니다" never sees a
    // boundary. The alternation keeps both.
    pattern: /(?:(?:당신은|너는)\s*(?:claude|grok|gemini|chatgpt|gpt)\b)|(?:(?:당신은|너는)\s*(?:클로드|그록|제미나이|챗gpt))/gi,
  },
];

function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function lintPromptLayer(body: string): LintFinding[] {
  const findings: LintFinding[] = [];
  /**
   * Every span a redact rule covered. Withholding only the credential's own
   * match is not enough: a second rule whose span merely OVERLAPS it echoes the
   * same secret back inside a different warning.
   */
  const hidden: [number, number][] = [];
  for (const rule of RULES) {
    // Fresh regex per call: a shared /g literal carries lastIndex between calls,
    // which makes the SECOND lint of the same text miss its first match.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
      const span: [number, number] = [match.index, match.index + match[0].length];
      if (rule.redactSpan) hidden.push(span);
      findings.push({
        level: rule.level,
        rule: rule.rule,
        messageKey: rule.messageKey,
        span: rule.redactSpan ? undefined : span,
      });
      // A zero-length match would spin forever.
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  if (hidden.length > 0) {
    for (const finding of findings) {
      // The rendered slice copies whatever range it is given, so a span that
      // touches a credential loses its highlight entirely rather than a tail.
      if (finding.span && hidden.some(([s, e]) => finding.span![0] < e && s < finding.span![1])) {
        finding.span = undefined;
      }
    }
  }
  if (utf8Length(body) > SIZE_ADVISORY_BYTES) {
    findings.push({ level: "info", rule: "size", messageKey: "codexSet.lint.size" });
  }
  return findings.sort((a, b) => (a.span?.[0] ?? Infinity) - (b.span?.[0] ?? Infinity));
}

