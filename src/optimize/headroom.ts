import { DEFAULT_HEADROOM_TIMEOUT_MS, DEFAULT_HEADROOM_URL } from "./constants";
import type { OcxParsedRequest } from "../types/request";
import { isLoopbackHostname } from "../server/auth-cors";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";

export interface HeadroomStats {
  tokens_before?: number;
  tokens_after?: number;
  tokens_saved?: number;
}

export async function checkHeadroomStatus(
  url = DEFAULT_HEADROOM_URL,
  timeoutMs = DEFAULT_HEADROOM_TIMEOUT_MS,
): Promise<{ reachable: boolean; url: string; error?: string }> {
  const normalized = url.replace(/\/+$/, "");
  const endpoint = normalized + "/health";
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { reachable: res.ok, url: normalized };
  } catch (err) {
    return { reachable: false, url: normalized, error: (err as any)?.message || String(err) };
  }
}

let activeHeadroomProc: ReturnType<typeof Bun.spawn> | null = null;
let startingPromise: Promise<{ ok: boolean; message?: string }> | null = null;

// ponytail: process-lifetime child cleanup via optional shutdown hook
registerOptionalShutdownHook("headroom-proxy", () => {
  stopHeadroom();
});

export function stopHeadroom(): void {
  if (activeHeadroomProc) {
    try {
      activeHeadroomProc.kill();
    } catch {
      // ignore best-effort kill error
    }
    activeHeadroomProc = null;
  }
}

export async function startHeadroom(
  targetUrl = DEFAULT_HEADROOM_URL,
): Promise<{ ok: boolean; message?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { ok: false, message: "Invalid target URL" };
  }

  if (!isLoopbackHostname(parsed.hostname)) {
    return { ok: false, message: "Headroom can only be started for local/loopback URLs" };
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : 8787;
  if (isNaN(port) || port <= 0 || port > 65535) {
    return { ok: false, message: "Invalid port for Headroom" };
  }

  const status = await checkHeadroomStatus(targetUrl, 1000);
  if (status.reachable) {
    return { ok: true, message: "Headroom is already running and reachable" };
  }

  if (startingPromise) {
    return startingPromise;
  }

  startingPromise = (async () => {
    const binPath = Bun.which("headroom");
    if (!binPath) {
      return { ok: false, message: "Headroom CLI ('headroom') not found in PATH" };
    }

    try {
      const proc = Bun.spawn([binPath, "proxy", "--port", String(port)], {
        stdout: "ignore",
        stderr: "ignore",
      });
      activeHeadroomProc = proc;

      for (let i = 0; i < 20; i++) {
        await Bun.sleep(500);
        const check = await checkHeadroomStatus(targetUrl, 800);
        if (check.reachable) {
          return { ok: true, message: "Headroom started successfully" };
        }
        if (proc.exitCode !== null) {
          activeHeadroomProc = null;
          return { ok: false, message: "Headroom process exited prematurely" };
        }
      }
      return { ok: false, message: "Headroom process started but health check timed out" };
    } catch (err) {
      return { ok: false, message: (err as any)?.message || String(err) };
    } finally {
      startingPromise = null;
    }
  })();

  return startingPromise;
}

function updateRawItem(rawItem: Record<string, unknown> | null | undefined, compressedText: string): void {
  if (!rawItem) return;
  if ("output" in rawItem) {
    if (typeof rawItem.output === "string") {
      rawItem.output = compressedText;
    } else if (Array.isArray(rawItem.output)) {
      for (const p of rawItem.output) {
        if (p && typeof p === "object") {
          const rec = p as Record<string, unknown>;
          if (rec.type === "input_text" || rec.type === "text") {
            rec.text = compressedText;
          }
        }
      }
    }
  }
  if ("content" in rawItem) {
    if (typeof rawItem.content === "string") {
      rawItem.content = compressedText;
    } else if (Array.isArray(rawItem.content)) {
      for (const p of rawItem.content) {
        if (p && typeof p === "object") {
          const rec = p as Record<string, unknown>;
          if (rec.type === "text" && typeof rec.text === "string") {
            rec.text = compressedText;
          } else if (rec.type === "input_text" && typeof rec.text === "string") {
            rec.text = compressedText;
          } else if (rec.type === "tool_result") {
            if (typeof rec.content === "string") {
              rec.content = compressedText;
            } else if (Array.isArray(rec.content)) {
              for (const inner of rec.content) {
                if (inner && typeof inner === "object" && (inner as Record<string, unknown>).type === "text") {
                  (inner as Record<string, unknown>).text = compressedText;
                }
              }
            }
          }
        }
      }
    }
  }
}

export async function compressWithHeadroom(
  parsed: OcxParsedRequest,
  options: { enabled?: boolean; url?: string; timeoutMs?: number; model?: string } = {},
): Promise<HeadroomStats | null> {
  if (!options.enabled) return null;
  const baseUrl = (options.url || DEFAULT_HEADROOM_URL).replace(/\/+$/, "");
  const endpoint = baseUrl + "/v1/compress";
  // The old default was 3000ms which times out on real conversations; protect against it
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0
    ? (options.timeoutMs === 3000 ? DEFAULT_HEADROOM_TIMEOUT_MS : options.timeoutMs)
    : DEFAULT_HEADROOM_TIMEOUT_MS;

  const rawList = parsed._rawBody && typeof parsed._rawBody === "object"
    ? (Array.isArray((parsed._rawBody as Record<string, unknown>).input)
        ? (parsed._rawBody as Record<string, unknown>).input as Record<string, unknown>[]
        : Array.isArray((parsed._rawBody as Record<string, unknown>).messages)
          ? (parsed._rawBody as Record<string, unknown>).messages as Record<string, unknown>[]
          : null)
    : null;

  if ((!parsed.context?.messages || parsed.context.messages.length === 0) && parsed._rawBody) {
    return compressRawBodyWithHeadroom(parsed._rawBody, options);
  }

  const messages: Array<{ role: string; content: string }> = [];
  const targets: Array<{ role: string; update: (text: string) => void }> = [];

  let rawUserIdx = 0;
  let rawAssistantIdx = 0;

  for (const msg of parsed.context?.messages || []) {
    if (msg.role === "user") {
      let nextRawUser: Record<string, unknown> | null = null;
      if (rawList) {
        for (let k = rawUserIdx; k < rawList.length; k++) {
          const it = rawList[k];
          if (it && (it.role === "user" || (it.type === "message" && it.role === "user"))) {
            nextRawUser = it;
            rawUserIdx = k + 1;
            break;
          }
        }
      }
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
        targets.push({
          role: "user",
          update: t => {
            msg.content = t;
            updateRawItem(nextRawUser, t);
          },
        });
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === "text") {
            messages.push({ role: "user", content: p.text });
            targets.push({
              role: "user",
              update: t => {
                p.text = t;
                updateRawItem(nextRawUser, t);
              },
            });
          }
        }
      }
    } else if (msg.role === "assistant") {
      let nextRawAssistant: Record<string, unknown> | null = null;
      if (rawList) {
        for (let k = rawAssistantIdx; k < rawList.length; k++) {
          const it = rawList[k];
          if (it && (it.role === "assistant" || (it.type === "message" && it.role === "assistant"))) {
            nextRawAssistant = it;
            rawAssistantIdx = k + 1;
            break;
          }
        }
      }
      for (const p of msg.content) {
        if (p.type === "text") {
          messages.push({ role: "assistant", content: p.text });
          targets.push({
            role: "assistant",
            update: t => {
              p.text = t;
              updateRawItem(nextRawAssistant, t);
            },
          });
        }
      }
    } else if (msg.role === "toolResult") {
      if (!msg.isError) {
        const rawToolItem = rawList?.find(
          item => item && (item.call_id === msg.toolCallId || item.tool_call_id === msg.toolCallId),
        );
        if (typeof msg.content === "string") {
          messages.push({ role: "tool", content: msg.content });
          targets.push({
            role: "tool",
            update: t => {
              msg.content = t;
              updateRawItem(rawToolItem, t);
            },
          });
        } else if (Array.isArray(msg.content)) {
          for (const p of msg.content) {
            if (p.type === "text") {
              messages.push({ role: "tool", content: p.text });
              targets.push({
                role: "tool",
                update: t => {
                  p.text = t;
                  updateRawItem(rawToolItem, t);
                },
              });
            }
          }
        }
      }
    }
  }

  if (messages.length === 0) return null;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model: options.model || parsed.modelId }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.warn("[Headroom] proxy HTTP " + res.status);
      return null;
    }

    const data = (await res.json()) as {
      messages?: Array<{ role: string; content: string }>;
      tokens_before?: number;
      tokens_after?: number;
      tokens_saved?: number;
    };
    if (!Array.isArray(data?.messages) || data.messages.length !== targets.length) {
      return null;
    }

    for (let i = 0; i < targets.length; i++) {
      const compressed = data.messages[i];
      if (compressed && typeof compressed.content === "string") {
        targets[i]!.update(compressed.content);
      }
    }

    return {
      tokens_before: data.tokens_before,
      tokens_after: data.tokens_after,
      tokens_saved: data.tokens_saved,
    };
  } catch (err) {
    console.warn("[Headroom] compress failed open:", (err as any)?.message || err);
    return null;
  }
}

export async function compressRawBodyWithHeadroom(
  rawBody: unknown,
  options: { enabled?: boolean; url?: string; timeoutMs?: number; model?: string } = {},
): Promise<HeadroomStats | null> {
  if (!options.enabled || !rawBody || typeof rawBody !== "object") return null;
  const baseUrl = (options.url || DEFAULT_HEADROOM_URL).replace(/\/+$/, "");
  const endpoint = baseUrl + "/v1/compress";
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0
    ? (options.timeoutMs === 3000 ? DEFAULT_HEADROOM_TIMEOUT_MS : options.timeoutMs)
    : DEFAULT_HEADROOM_TIMEOUT_MS;

  const raw = rawBody as Record<string, unknown>;
  const list = Array.isArray(raw.messages) ? raw.messages
    : Array.isArray(raw.input) ? raw.input
    : null;

  if (!list || list.length === 0) return null;

  const messages: Array<{ role: string; content: string }> = [];
  const targets: Array<{ role: string; update: (text: string) => void }> = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;

    // Responses format: function_call_output / custom_tool_call_output
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (typeof item.output === "string") {
        messages.push({ role: "tool", content: item.output });
        targets.push({
          role: "tool",
          update: t => { item.output = t; },
        });
      } else if (Array.isArray(item.output)) {
        for (const p of item.output) {
          if (p && typeof p === "object" && (p.type === "input_text" || p.type === "text") && typeof p.text === "string") {
            messages.push({ role: "tool", content: p.text });
            targets.push({
              role: "tool",
              update: t => { (p as Record<string, unknown>).text = t; },
            });
          }
        }
      }
      continue;
    }

    // Role user or message with role user
    const role = (item.role as string) || (item.type === "message" ? (item.role as string) : "");
    if (role === "user") {
      if (typeof item.content === "string") {
        messages.push({ role: "user", content: item.content });
        targets.push({
          role: "user",
          update: t => { item.content = t; },
        });
      } else if (Array.isArray(item.content)) {
        for (const p of item.content) {
          if (p && typeof p === "object") {
            const rec = p as Record<string, unknown>;
            if (rec.type === "text" && typeof rec.text === "string") {
              messages.push({ role: "user", content: rec.text });
              targets.push({
                role: "user",
                update: t => { rec.text = t; },
              });
            } else if (rec.type === "tool_result") {
              if (rec.is_error === true) continue;
              if (typeof rec.content === "string") {
                messages.push({ role: "tool", content: rec.content });
                targets.push({
                  role: "tool",
                  update: t => { rec.content = t; },
                });
              }
            }
          }
        }
      }
      continue;
    }

    // Role assistant
    if (role === "assistant") {
      if (typeof item.content === "string") {
        messages.push({ role: "assistant", content: item.content });
        targets.push({
          role: "assistant",
          update: t => { item.content = t; },
        });
      } else if (Array.isArray(item.content)) {
        for (const p of item.content) {
          if (p && typeof p === "object") {
            const rec = p as Record<string, unknown>;
            if (rec.type === "text" && typeof rec.text === "string") {
              messages.push({ role: "assistant", content: rec.text });
              targets.push({
                role: "assistant",
                update: t => { rec.text = t; },
              });
            }
          }
        }
      }
      continue;
    }

    // Role tool
    if (role === "tool") {
      if (typeof item.content === "string") {
        messages.push({ role: "tool", content: item.content });
        targets.push({
          role: "tool",
          update: t => { item.content = t; },
        });
      } else if (Array.isArray(item.content)) {
        for (const p of item.content) {
          if (p && typeof p === "object" && p.type === "text" && typeof p.text === "string") {
            messages.push({ role: "tool", content: p.text });
            targets.push({
              role: "tool",
              update: t => { (p as Record<string, unknown>).text = t; },
            });
          }
        }
      }
    }
  }

  if (messages.length === 0) return null;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model: options.model || (raw.model as string) || "unknown" }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.warn("[Headroom] proxy HTTP " + res.status);
      return null;
    }

    const data = (await res.json()) as {
      messages?: Array<{ role: string; content: string }>;
      tokens_before?: number;
      tokens_after?: number;
      tokens_saved?: number;
    };
    if (!Array.isArray(data?.messages) || data.messages.length !== targets.length) {
      return null;
    }

    for (let i = 0; i < targets.length; i++) {
      const compressed = data.messages[i];
      if (compressed && typeof compressed.content === "string") {
        targets[i]!.update(compressed.content);
      }
    }

    return {
      tokens_before: data.tokens_before,
      tokens_after: data.tokens_after,
      tokens_saved: data.tokens_saved,
    };
  } catch (err) {
    console.warn("[Headroom] compress failed open:", (err as any)?.message || err);
    return null;
  }
}
