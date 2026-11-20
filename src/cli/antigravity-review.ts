import { stripVTControlCharacters } from "node:util";

export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

interface PermissionOption { kind: string; optionId: string }
export interface ToolUpdate {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  locations?: unknown;
  content?: unknown;
}

export interface PermissionRequest {
  toolCall?: ToolUpdate;
  options?: PermissionOption[];
}

function oneTimeOption(options: PermissionOption[], kind: string): string | undefined {
  const matching = options.filter(option => option?.kind === kind);
  const id = matching[0]?.optionId;
  if (matching.length === 1 && typeof id === "string" && id && options.filter(option => option?.optionId === id).length === 1) return id;
}

export function permissionOutcome(optionId?: string) {
  return { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } };
}

export function rejectOnce(request?: PermissionRequest): string | undefined {
  return Array.isArray(request?.options) ? oneTimeOption(request.options, "reject_once") : undefined;
}

/** The official agent executes the tool. The terminal returns only the human's per-call choice. */
export async function reviewPermission(
  request: PermissionRequest, question: (text: string, signal: AbortSignal) => Promise<string>, signal: AbortSignal,
  write: (text: string) => void,
): Promise<string | undefined> {
  const deny = rejectOnce(request);
  const allow = Array.isArray(request.options) && oneTimeOption(request.options, "allow_once");
  const call = request.toolCall;
  if (signal.aborted) return deny;
  if (!allow || typeof call?.toolCallId !== "string" || !call.toolCallId ||
      typeof call.title !== "string" || !call.title.trim()) {
    write("\n[permission declined: missing action details or one-time option]\n");
    return deny;
  }

  // Quote control characters in the details, so tool text cannot draw over the local decision prompt.
  const details = JSON.stringify({ title: call.title, kind: call.kind, input: call.rawInput, locations: call.locations, content: call.content }, null, 2)
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u007f-\u009f]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  if (details.length > 64 * 1024) {
    // A partial command or diff would make this an uninformed approval.
    write("\n[permission declined: action exceeds the terminal review limit]\n");
    return deny;
  }
  const answer = await question("\nTool permission\n" + details + "\nAllow this action once? [y/N] ", signal);
  return !signal.aborted && /^y(?:es)?$/i.test(answer.trim()) ? allow : deny;
}

export function toolProgress(call: ToolUpdate): string {
  const label = typeof call.title === "string" && call.title || call.toolCallId;
  if (typeof label !== "string" || !label) return "";
  const status = ["pending", "in_progress", "completed", "failed"].find(value => value === call.status);
  return "\n[tool" + (status ? " " + status : "") + "] " + terminalText(JSON.stringify(label)) + "\n";
}
