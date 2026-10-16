import { createHash } from "node:crypto";
import type { OcxParsedRequest } from "../types";
import { contentText } from "./state";
import { advisorEvidenceTool } from "./evidence-tool";

export interface AdvisorRepairEvidence {
  id: string;
  command: string;
  firstFailure: { message: number; exitCode: number; output: string };
  repair: { message: number; tool: string };
  repeatedFailure: { message: number; exitCode: number; output: string };
}
interface Validation { command: string; fingerprint: string; invokedAt: number }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const excerpt = (text: string) => text.length <= 1600 ? text : `${text.slice(0, 800)}\n[output truncated]\n${text.slice(-800)}`;

/** A deliberately small command grammar. No pipelines, substitutions or arbitrary scripts. */
function validation(args: Record<string, unknown>, invokedAt: number): Validation | undefined {
  const input = args.cmd ?? args.command;
  const raw = Array.isArray(input) && input.every(value => typeof value === "string")
    ? input.map(value => JSON.stringify(value)).join(" ") : input;
  if (typeof raw !== "string" || raw.length > 4096 || /[\n\r;|<>`$]/.test(raw)) return;
  let command = raw.trim();
  let cwd = typeof (args.workdir ?? args.cwd) === "string" ? String(args.workdir ?? args.cwd) : "";
  const cd = /^cd\s+("[^"]+"|'[^']+'|[^\s&]+)\s*&&\s*(.+)$/.exec(command);
  if (cd) { cwd += `/${cd[1]!.replace(/^["']|["']$/g, "")}`; command = cd[2]!; }
  if (command.includes("&")) return;
  // Quoted arguments stay intact; metacharacters above are rejected even inside quotes.
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g);
  if (!tokens || tokens.join(" ").replace(/\s+/g, " ") !== command.replace(/\s+/g, " ")) return;
  const words = tokens.map(token => token.replace(/^["']|["']$/g, ""));
  const executable = words[0]!.split(/[\\/]/).at(-1)!;
  const rest = words.slice(1).join(" ");
  const isValidation = /^(?:pytest|tsc|eslint)$/.test(executable)
    || (/^(?:bun|npm|pnpm|yarn)$/.test(executable) && /^(?:(?:run\s+)?(?:test|typecheck|lint|check|build)(?:[\s:]|$)|(?:x|exec)\s+(?:tsc|eslint)(?:\s|$))/.test(rest))
    || (/^python(?:3)?$/.test(executable) && /^-m pytest(?:\s|$)/.test(rest))
    || (executable === "cargo" && /^(?:test|check|clippy|build)(?:\s|$)/.test(rest))
    || (executable === "go" && /^(?:test|vet)(?:\s|$)/.test(rest));
  if (!isValidation) return;
  return { command: raw, fingerprint: digest(JSON.stringify([cwd, words])), invokedAt };
}

/** Shell envelope status only. Test prose such as "FAIL" is not an exit status. */
function exitCode(text: string): number | undefined {
  try {
    const wrapped = text.indexOf("\nOutput:\n");
    const raw: unknown = JSON.parse(wrapped >= 0 ? text.slice(wrapped + "\nOutput:\n".length) : text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const code = record.exit_code ?? record.exitCode;
      if (typeof code === "number" && Number.isSafeInteger(code)) return code;
    }
  } catch { /* textual shell envelope */ }
  const code = /^(?:Process exited with code|Process exit code:|Exit code:)\s*(-?\d+)\s*$/m.exec(text);
  return code ? Number(code[1]) : undefined;
}

/** Reconstructed from paired tool calls/results after the latest user turn; no LLM or timers. */
export function collectAdvisorRepairEvidence(parsed: OcxParsedRequest): AdvisorRepairEvidence | undefined {
  const calls = new Map<string, { tool: string; args: Record<string, unknown>; invokedAt: number }>();
  const sessions = new Map<string, Validation>();
  const failures = new Map<string, { failure: AdvisorRepairEvidence["firstFailure"]; callId: string; repair?: AdvisorRepairEvidence["repair"] & { callId: string } }>();
  let candidate: AdvisorRepairEvidence | undefined;
  let candidateFingerprint: string | undefined;
  const messages = parsed.context.messages;
  let start = messages.findLastIndex(message => message.role === "user") + 1;
  // Bounded work; a clipped prefix cannot establish a failure/repair sequence.
  start = Math.max(start, messages.length - 512);
  for (let i = start; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") {
        calls.set(part.id, { ...advisorEvidenceTool(part.name, part.arguments ?? {}), invokedAt: i + 1 });
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    calls.delete(message.toolCallId); // A replayed result cannot stand in for another execution.
    const output = contentText(message.content);
    if (["apply_patch", "Write", "Edit", "write_file", "edit_file"].includes(call.tool) && !message.isError
      && output.trim() && !/^(?:error|failed|failure)\b/i.test(output.trim())) {
      for (const failure of failures.values()) if (call.invokedAt > failure.failure.message) failure.repair = { message: i + 1, tool: call.tool, callId: message.toolCallId };
      continue;
    }
    let check: Validation | undefined;
    if (["exec_command", "shell_command", "shell", "Bash", "bash"].includes(call.tool)) check = validation(call.args, call.invokedAt);
    else if (call.tool === "write_stdin") check = sessions.get(String(call.args.session_id));
    if (!check) continue;
    const code = exitCode(output);
    if (code === undefined) {
      const session = /(?:Process running with session ID\s+|"session_id"\s*:\s*)(\d+)/.exec(output);
      if (session) sessions.set(session[1]!, check);
      continue;
    }
    if (call.tool === "write_stdin") sessions.delete(String(call.args.session_id));
    if (code === 0) {
      failures.delete(check.fingerprint);
      if (candidateFingerprint === check.fingerprint) { candidate = undefined; candidateFingerprint = undefined; }
      continue;
    }
    const failure = { message: i + 1, exitCode: code, output: excerpt(output) };
    const earlier = failures.get(check.fingerprint);
    if (earlier?.repair && check.invokedAt > earlier.repair.message) {
      candidate = {
        // Positions are prompt references only: history pruning must not mint a new event.
        id: digest(JSON.stringify([check.fingerprint, earlier.callId, earlier.repair.callId, message.toolCallId])),
        command: check.command,
        firstFailure: earlier.failure, repair: { message: earlier.repair.message, tool: earlier.repair.tool }, repeatedFailure: failure,
      };
      candidateFingerprint = check.fingerprint;
    }
    failures.set(check.fingerprint, { failure, callId: message.toolCallId });
  }
  return candidate;
}
