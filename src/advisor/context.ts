/**
 * Advisor consultation payload construction.
 *
 * The advisor must understand "what has this worker actually done so far". Everything here comes
 * from the ALREADY-parsed conversation context (the protocol state the model is allowed to see):
 * no chain-of-thought, no encrypted provider content, no credentials, no environment. Thinking
 * parts are deliberately skipped — hidden reasoning never leaves the worker conversation.
 */
import type { OcxParsedRequest } from "../types";

/** Per-message text cap. Tool outputs (shell/test logs) are the usual oversize offenders. */
const MAX_MESSAGE_CHARS = 4_000;
/** Hard cap for the whole transcript block. */
const MAX_TRANSCRIPT_CHARS = 48_000;
/** Cap per tool description in the catalog block. */
const MAX_TOOL_DESC_CHARS = 200;
/** Cap for the worker's focus question. */
const MAX_QUESTION_CHARS = 2_000;

export interface AdvisorContextInput {
  parsed: OcxParsedRequest;
  /** Routed worker identity, e.g. "deepseek-chat via provider deepseek". */
  workerIdentity: string;
  /** Advisor model string as configured (verbatim; identity shown to both sides). */
  advisorModel: string;
  /** Why this consultation is happening. */
  reason: "manual" | "preflight";
  /** Optional worker-supplied focus question (synthetic tool argument). */
  question?: string;
}

function clip(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

function textFromContent(content: string | readonly { type: string; text?: string }[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter(part => part.type === "text" && typeof part.text === "string")
    .map(part => part.text as string)
    .join("");
}

export function advisorTranscript(parsed: OcxParsedRequest): string {
  const lines: string[] = [];
  for (const message of parsed.context.messages) {
    if (message.role === "assistant") {
      // Text only: tool calls are rendered from their own parts below; thinking is NEVER included.
      const text = clip(message.content
        .filter(part => part.type === "text")
        .map(part => part.text)
        .join(""), MAX_MESSAGE_CHARS);
      if (text) lines.push(`[assistant] ${text}`);
      for (const part of message.content) {
        if (part.type === "toolCall") {
          const args = clip(JSON.stringify(part.arguments ?? {}), MAX_MESSAGE_CHARS);
          lines.push(`[assistant tool call] ${part.name}(${args})`);
        }
      }
    } else if (message.role === "user") {
      const text = clip(textFromContent(message.content), MAX_MESSAGE_CHARS);
      if (text) lines.push(`[user] ${text}`);
    } else if (message.role === "developer") {
      const text = clip(textFromContent(message.content), MAX_MESSAGE_CHARS);
      if (text) lines.push(`[developer note] ${text}`);
    } else if (message.role === "toolResult") {
      const text = clip(textFromContent(message.content), MAX_MESSAGE_CHARS);
      const prefix = message.isError ? "[tool error" : "[tool result";
      lines.push(`${prefix}: ${message.toolName}] ${text}`);
    }
  }
  let transcript = lines.join("\n\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    // Keep the head (task) and the tail (most recent activity); drop the middle.
    const head = transcript.slice(0, MAX_TRANSCRIPT_CHARS / 2);
    const tail = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS / 2);
    transcript = `${head}\n\n[… middle of the conversation omitted …]\n\n${tail}`;
  }
  return transcript;
}

function toolCatalog(parsed: OcxParsedRequest): string {
  const tools = parsed.context.tools ?? [];
  if (tools.length === 0) return "(no tools declared)";
  return tools
    .map(tool => `- ${tool.name}: ${clip(tool.description ?? "", MAX_TOOL_DESC_CHARS) || "(no description)"}`)
    .join("\n");
}

function latestUserTask(parsed: OcxParsedRequest): string {
  for (let i = parsed.context.messages.length - 1; i >= 0; i -= 1) {
    const message = parsed.context.messages[i];
    if (message.role === "user") {
      const text = clip(textFromContent(message.content), MAX_MESSAGE_CHARS);
      if (text) return text;
    }
  }
  return "(no explicit user message found)";
}

export const ADVISOR_SYSTEM_INSTRUCTION =
  "You are an independent expert advisor consulted by a coding agent (the worker) in the middle of "
  + "a task. You receive the task, the worker's conversation so far (including tool calls and their "
  + "results), and the tools the worker has available. Your job is to help the worker succeed: "
  + "architecture and strategy review, root-cause analysis, hypothesis criticism, alternative "
  + "explanations, discriminating experiments, and risk review. You CANNOT execute anything — no "
  + "tools, no file edits, no shell. Give concrete, actionable, prioritized advice. Be specific "
  + "about what the worker should do next and why. Be concise: lead with the single most important "
  + "recommendation, then supporting detail. If the worker is on track, say so plainly instead of "
  + "inventing objections.";

export function buildAdvisorUserPrompt(input: AdvisorContextInput): string {
  const focus = input.question ? clip(input.question, MAX_QUESTION_CHARS) : "";
  return [
    `# Worker identity\n${input.workerIdentity}`,
    `# Advisor identity\n${input.advisorModel} (independent expert advisor, consulted ${input.reason === "manual" ? "at the worker's explicit request" : "automatically before the worker's first substantive turn"})`,
    `# Current task (latest user request)\n${latestUserTask(input.parsed)}`,
    ...(focus ? [`# Worker's focus question\n${focus}`] : []),
    `# Tools available to the worker\n${toolCatalog(input.parsed)}`,
    `# Conversation so far\n${advisorTranscript(input.parsed)}`,
    "Provide your advice for the worker now.",
  ].join("\n\n");
}

/** Visible wrapper identifying advice inside the worker conversation (see reinjection). */
export function formatAdvisorAdvice(input: { advisorModel: string; reason: string; advice: string }): string {
  return [
    "<opencodex_advisor>",
    `advisor model: ${input.advisorModel}`,
    `consultation reason: ${input.reason}`,
    "",
    input.advice,
    "</opencodex_advisor>",
  ].join("\n");
}

/** Non-misleading, bounded context handed to the worker when the advisor itself failed. */
export function formatAdvisorUnavailable(reason: string, error: string): string {
  return [
    "<opencodex_advisor>",
    "The advisor was consulted but is currently unavailable, so this consultation produced no advice.",
    `consultation reason: ${reason}`,
    `failure: ${error}`,
    "",
    "Continue the task with your own judgment. This is not advice.",
    "</opencodex_advisor>",
  ].join("\n");
}
