/**
 * Claude Code appends growing `<total_tokens>…</total_tokens>` footers (and
 * occasional TaskCreate nudges) into system text that becomes Responses
 * `instructions`. That churn breaks Muse/Go prefix cache on the instructions
 * prefix even when tools stay stable. Strip dynamics from instructions;
 * surface the latest notice on `input` instead.
 *
 * Relocation is identified by harness shape: only a trailing, unfenced,
 * canonical notice at the end of instructions is moved. An unmatched fence
 * opener covers through EOF. No match → the original string is returned
 * byte-for-byte. The matcher is content identity only; `translateAnthropicRequest`
 * requires `claudeCode.stabilizePromptCache: true` before this helper runs. Claude Code
 * writes `<total_tokens>N tokens left</total_tokens>`.
 *
 * TaskCreate nudge text has drifted across Claude Code builds; match the
 * known exact paragraphs (legacy + 2.1.263 "tracking progress" form) as
 * trailing alternatives so a mid-session nudge cannot pin older footers
 * above it and flip `instructions` after a previously stable peel.
 */

const TOTAL_NOTICE_RE = /^<total_tokens>[0-9]+ tokens left<\/total_tokens>$/;

/** Legacy Claude Code TaskCreate reminder (pre-"tracking progress"). */
const TASKCREATE_NUDGE_LEGACY =
  "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking, consider using TaskCreate to add them. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.";

/**
 * Claude Code 2.1.263+ TaskCreate reminder observed on hitrate S/T4
 * (FREEZE-DIFF + tip0847 pilots). Mentions TaskUpdate and stale-list cleanup.
 */
const TASKCREATE_NUDGE_CC_2_1_263 =
  "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.";

interface FenceRange {
  start: number;
  end: number;
}

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/;

/**
 * Markdown fence ranges. An unmatched opener covers through EOF: unfinished
 * fenced examples are code content, not a harness suffix. A closer must be a
 * standalone fence line (no info string) of the same character and at least
 * the opener's length.
 */
function fencedRanges(source: string): FenceRange[] {
  const ranges: FenceRange[] = [];
  let offset = 0;
  let openAt: number | null = null;
  let openFence = "";
  while (offset <= source.length) {
    const nl = source.indexOf("\n", offset);
    const lineEnd = nl === -1 ? source.length : nl;
    const line = source.slice(offset, lineEnd).replace(/\r$/, "");
    if (openAt === null) {
      const open = FENCE_OPEN_RE.exec(line);
      if (open) {
        openAt = offset;
        openFence = open[2]!;
      }
    } else {
      const close = FENCE_CLOSE_RE.exec(line);
      if (
        close
        && close[2]![0] === openFence[0]
        && close[2]!.length >= openFence.length
      ) {
        ranges.push({ start: openAt, end: lineEnd });
        openAt = null;
        openFence = "";
      }
    }
    if (nl === -1) break;
    offset = nl + 1;
  }
  if (openAt !== null) ranges.push({ start: openAt, end: source.length });
  return ranges;
}

/** A backwards cursor consumes each line and fence range at most once. */
export function stabilizeClaudeInstructionsForPromptCache(
  instructions: string,
): { instructions: string; dynamicNotice: string | null } {
  const ranges = fencedRanges(instructions);
  let fenceIndex = ranges.length - 1;
  let end = instructions.length;
  let latestTotal: string | null = null;
  let latestNudge: string | null = null;
  let peeled = false;

  for (;;) {
    // This is speculative: a failed candidate must not trim the retained prefix.
    let lineEnd = end;
    while (lineEnd > 0 && instructions[lineEnd - 1] === "\n") {
      lineEnd--;
      if (lineEnd > 0 && instructions[lineEnd - 1] === "\r") lineEnd--;
    }
    if (lineEnd === 0) break;
    const lineStart = instructions.lastIndexOf("\n", lineEnd - 1) + 1;
    let contentStart = lineStart;
    let contentEnd = lineEnd;
    while (contentStart < contentEnd && (instructions[contentStart] === " " || instructions[contentStart] === "\t")) contentStart++;
    while (contentEnd > contentStart && (instructions[contentEnd - 1] === " " || instructions[contentEnd - 1] === "\t")) contentEnd--;
    const notice = instructions.slice(contentStart, contentEnd);
    const total = TOTAL_NOTICE_RE.test(notice);
    const nudge = notice === TASKCREATE_NUDGE_LEGACY || notice === TASKCREATE_NUDGE_CC_2_1_263;
    if (!total && !nudge) break;

    while (fenceIndex >= 0 && ranges[fenceIndex]!.start > contentStart) fenceIndex--;
    if (fenceIndex >= 0 && contentStart < ranges[fenceIndex]!.end) break;
    if (total && latestTotal === null) latestTotal = notice;
    if (nudge && latestNudge === null) latestNudge = notice;
    peeled = true;

    // Commit only the recognized notice and its immediately preceding LF/CRLF separators.
    end = lineStart;
    while (end > 0 && instructions[end - 1] === "\n") {
      end--;
      if (end > 0 && instructions[end - 1] === "\r") end--;
    }
  }

  if (!peeled) return { instructions, dynamicNotice: null };
  const noticeParts: string[] = [];
  if (latestTotal) noticeParts.push(latestTotal);
  if (latestNudge) noticeParts.push(latestNudge);
  return { instructions: instructions.slice(0, end), dynamicNotice: noticeParts.join("\n\n") };
}
