/**
 * Request-body shaping required by the zcode.z.ai start-plan gateway.
 *
 * The gateway inspects the POST body: without the official ZCode identity blocks at the
 * head of the `system` field it rejects the request with biz code 3012 ("method not
 * allowed"), regardless of auth. Three transforms mirror the official client:
 *
 *   1. Prepend the static ZCode system blocks (CLI prefix, agent identity, environment)
 *      before any caller system blocks, merging the dynamic
 *      "You are powered by the model named <model>." line into the trailing Environment
 *      block's text (never as a separate block).
 *   2. Two-phase cache_control handling: strip stray `cache_control` from non-system
 *      content blocks, then mark the LAST content block of the LAST non-system message
 *      as ephemeral — the breakpoint the official client keeps for prompt caching.
 *   3. Inject `metadata.user_id` from the plan JWT's `user_id` claim when it can be
 *      decoded, preserving any other metadata fields.
 */
import systemBlocksJson from "./system-blocks.json";

interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

const ZCODE_SYSTEM_BLOCKS = systemBlocksJson as SystemBlock[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Prepend the official gateway blocks to the request's `system` field (pure). */
export function buildStartPlanSystem(existingSystem: unknown, currentModel?: string): SystemBlock[] {
  const official = ZCODE_SYSTEM_BLOCKS.map(b => ({ ...b, cache_control: b.cache_control ? { ...b.cache_control } : undefined }));
  const model = currentModel?.trim();
  if (model) {
    const env = official[official.length - 1];
    if (env) env.text = `${env.text}\n- You are powered by the model named ${model}.`;
  }
  return [...official, ...normalizeUserSystem(existingSystem)];
}

function normalizeUserSystem(system: unknown): SystemBlock[] {
  if (typeof system === "string") {
    const text = system.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(system)) return [];
  const out: SystemBlock[] = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ type: "text", text: item });
    } else if (isPlainObject(item) && item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      out.push({
        type: "text",
        text: item.text,
        ...(isPlainObject(item.cache_control) ? { cache_control: item.cache_control as { type: "ephemeral" } } : {}),
      });
    }
  }
  return out;
}

interface WithMessages {
  system?: unknown;
  messages?: unknown;
}

/** Strip cache_control from non-system blocks, then mark the last message's last block. */
export function applyStartPlanCacheControl(body: WithMessages): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  let modified = false;
  for (const msg of messages) {
    if (!isPlainObject(msg) || msg.role === "system" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isPlainObject(block) && "cache_control" in block) {
        delete block.cache_control;
        modified = true;
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isPlainObject(msg) || msg.role === "system") continue;
    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      return true;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const last = msg.content[msg.content.length - 1];
      if (isPlainObject(last) && !last.cache_control) {
        last.cache_control = { type: "ephemeral" };
        return true;
      }
      return modified;
    }
    return modified;
  }
  return modified;
}

/** Decode the `user_id` claim from a plan JWT without verifying (it is our own token). */
export function userIdFromJwt(jwt: string | undefined): string | undefined {
  if (!jwt) return undefined;
  const part = jwt.split(".")[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { user_id?: unknown };
    return typeof payload.user_id === "string" && payload.user_id.trim() ? payload.user_id : undefined;
  } catch {
    return undefined;
  }
}

/** Apply all gateway body transforms in place; returns the (possibly reserialized) body. */
export function transformStartPlanBody(bodyText: string, model: string | undefined, userId: string | undefined): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!isPlainObject(parsed)) return bodyText;
  const body = parsed as Record<string, unknown> & WithMessages;
  body.system = buildStartPlanSystem(body.system, model);
  applyStartPlanCacheControl(body);
  if (userId) {
    const existing = body.metadata;
    const base = isPlainObject(existing) ? { ...existing } : {};
    if (base.user_id !== userId) {
      base.user_id = userId;
      body.metadata = base;
    }
  }
  return JSON.stringify(body);
}
