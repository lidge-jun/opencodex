import type { MessageKind } from "../messaging/envelope";
import { isThreadId } from "../messaging/types";

export type MessageArgs = { action: "sessions"; json: boolean }
  | { action: "send"; json: boolean; kind: MessageKind; thread?: string; name?: string; inReplyTo?: string };

/** Pure pre-parse: unknown/duplicate options and unsupported remote surfaces fail closed. */
export function parseMessageArgs(argv: readonly string[]): MessageArgs | null {
  const action = argv[0];
  if (action !== "sessions" && action !== "send") return null;
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]!;
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--json" || (action === "send" && flag === "--stdin")) continue;
    if (action !== "send" || !["--thread", "--name", "--kind", "--in-reply-to"].includes(flag)) return null;
    const value = argv[++index];
    if (!value || value.startsWith("--")) return null;
    values[flag] = value;
  }
  const json = seen.has("--json");
  if (action === "sessions") return { action, json };
  const thread = values["--thread"], name = values["--name"], inReplyTo = values["--in-reply-to"];
  const kind = values["--kind"] ?? "request";
  if (!seen.has("--stdin") || (thread !== undefined) === (name !== undefined)
    || (thread !== undefined && !isThreadId(thread))
    || (name !== undefined && (!name.trim() || name.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(name)))
    || !["request", "response", "notification"].includes(kind)
    || (kind === "response" ? !isThreadId(inReplyTo) : inReplyTo !== undefined)) return null;
  return { action, json, kind: kind as MessageKind, ...(thread ? { thread } : {}),
    ...(name ? { name } : {}), ...(inReplyTo ? { inReplyTo } : {}) };
}
