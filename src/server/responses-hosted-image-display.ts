import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import {
  chargeImageBudget, createImageBudget, decodeValidatedImageBase64,
  artifactHttpUrl, getArtifactsDir, MAX_ENCODED_BYTES_PER_IMAGE, pruneArtifacts, sniffImageExtension,
} from "../images/artifacts";
import { sseDataPayload, replaceSseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

type Row = Record<string, any>;
const object = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const originators = new Set(["codex_cli_rs", "Codex Desktop", "codex_app", "codex_work_desktop"]);
const generatedName = /^img-codex-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp|gif)$/;

/** One spelling per local path: file URL or plain, either separator, dot segments, folded case. */
function comparablePath(value: string, foldCase: boolean): string | undefined {
  let path = value;
  if (/^file:\/\//i.test(path)) {
    try { path = decodeURIComponent(path.replace(/^file:\/\/(?:localhost)?/i, "")); } catch { return undefined; }
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  }
  path = posix.normalize(path.replace(/\\/g, "/"));
  return foldCase ? path.toLowerCase() : path;
}

/**
 * Full client replay can include display-only messages even without their generated ids.
 * Shared by Responses request preparation and the remote compaction handler.
 */
export function redactHostedImageDisplayPaths(body: unknown, platform: NodeJS.Platform = process.platform): void {
  if (!object(body) || !Array.isArray(body.input)) return;
  // macOS and Windows filesystems fold case by default, so either spelling names the artifact.
  const foldCase = platform === "darwin" || platform === "win32";
  const dir = comparablePath(getArtifactsDir(), foldCase);
  const generatedLink = /!\[Generated image\]\(<([^>\r\n]+)>\)/g;
  const redact = (text: string) => text.replace(generatedLink, (link, path: string) => {
    const candidate = comparablePath(path, foldCase);
    const slash = candidate?.lastIndexOf("/") ?? -1;
    if (!candidate || !dir || slash < 0 || candidate.slice(0, slash) !== dir) return link;
    const name = candidate.slice(slash + 1);
    if (!generatedName.test(name)) return link;
    // No file read or existence check: history may outlive artifact retention.
    return "![Generated image](<" + artifactHttpUrl(name) + ">)";
  });
  for (const item of body.input) {
    if (!object(item) || item.role !== "assistant"
      || (item.type !== undefined && item.type !== "message")) continue;
    if (typeof item.content === "string") item.content = redact(item.content);
    else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (object(part) && ["output_text", "input_text", "text"].includes(part.type)
          && typeof part.text === "string") part.text = redact(part.text);
      }
    }
  }
}

/** Local filesystem links are only appropriate for the loopback Codex client. */
export function isLocalCodexImageClient(headers: Headers, admissionKind?: string, inboundWire?: string): boolean {
  return admissionKind === "loopback"
    && (inboundWire === undefined || inboundWire === "responses")
    && (originators.has(headers.get("originator") ?? "")
      || /^codex(?:[_ /-]|$)/i.test(headers.get("user-agent") ?? ""));
}

/** Client branch only: raw hosted items remain intact in the upstream replay cache. */
export function createHostedImageDisplayRewrite(): SseBlockRewrite & { json(text: string): string } {
  const budget = createImageBudget();
  const states = new Map<string, { message: Row; added: boolean; done: boolean }>();
  let extraSequence = 0;
  let wroteArtifact = false;

  function stateFor(item: Row, index: number) {
    const key = typeof item.id === "string" ? item.id : "index:" + index;
    let state = states.get(key);
    if (state) return state;
    // Bound metadata independently of the existing 100 MiB decoded-image budget.
    if (states.size >= 128) throw new RangeError("hosted image result count exceeds local display limit");
    const id = "msg_ocx_img_" + createHash("sha256").update(key).digest("hex").slice(0, 32);
    state = { added: false, done: false, message: {
      // Persist image results outside the client's collapsible progress messages.
      id, type: "message", role: "assistant", phase: "final_answer", status: "in_progress", content: [],
      ...(item.internal_chat_message_metadata_passthrough === undefined ? {} : {
        internal_chat_message_metadata_passthrough: item.internal_chat_message_metadata_passthrough,
      }),
    } };
    states.set(key, state);
    return state;
  }

  function complete(item: Row, index: number) {
    const state = stateFor(item, index);
    if (state.message.status !== "in_progress") return state;
    let text = item.status === "completed"
      ? "The completed image result has no supported image data for local display."
      : "Image generation did not complete; no image is available to display.";
    let status = "incomplete";
    if (item.status === "completed" && typeof item.result === "string") {
      try {
        if (item.result.length > MAX_ENCODED_BYTES_PER_IMAGE) throw new RangeError("image too large");
        const bytes = decodeValidatedImageBase64(item.result);
        chargeImageBudget(budget, bytes.length);
        const dir = getArtifactsDir();
        recordOwnedConfigPath(getConfigDir(), dir);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const candidate = join(dir, "img-codex-" + randomUUID() + "." + sniffImageExtension(bytes));
        // Bounded synchronous write: block rewriters cannot await. Never use upstream ids as paths.
        try {
          writeFileSync(candidate, bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            try { unlinkSync(candidate); } catch { /* best-effort partial-write cleanup */ }
          }
          throw error;
        }
        wroteArtifact = true;
        text = "![Generated image](<" + candidate + ">)";
        status = "completed";
      } catch {
        // Do not expose image data, filesystem errors, or credentials in a generated message.
        text = "The image result could not be saved for local display.";
      }
    }
    state.message = { ...state.message, status, content: [{ type: "output_text", text, annotations: [] }] };
    return state;
  }

  function doneEvents(item: Row, index: number): Row[] {
    const state = complete(item, index);
    if (state.done) return [];
    const { message } = state;
    const common = { item_id: message.id, output_index: index, content_index: 0 };
    const part = message.content[0];
    const events: Row[] = [];
    if (!state.added) events.push({ type: "response.output_item.added", output_index: index,
      item: { ...message, status: "in_progress", content: [] } });
    events.push(
      { type: "response.content_part.added", ...common, part: { ...part, text: "" } },
      { type: "response.output_text.delta", ...common, delta: part.text },
      { type: "response.output_text.done", ...common, text: part.text },
      { type: "response.content_part.done", ...common, part },
      { type: "response.output_item.done", output_index: index, item: message },
    );
    state.added = state.done = true;
    return events;
  }

  function snapshot(response: Row, terminal: boolean, events?: Row[]): Row {
    if (!Array.isArray(response.output)) return response;
    // Reject oversized snapshots before saving artifacts that cannot be delivered.
    const keys = new Set(states.keys());
    for (const [index, item] of response.output.entries()) {
      if (!object(item) || item.type !== "image_generation_call") continue;
      keys.add(typeof item.id === "string" ? item.id : "index:" + index);
      if (keys.size > 128) throw new RangeError("hosted image result count exceeds local display limit");
    }
    let changed = false;
    const output = response.output.map((item: unknown, index: number) => {
      if (!object(item) || item.type !== "image_generation_call") return item;
      changed = true;
      if (terminal) {
        if (events) events.push(...doneEvents(item, index));
        return complete(item, index).message;
      }
      return stateFor(item, index).message;
    });
    return changed ? { ...response, output } : response;
  }

  const rewrite = ((block: string): readonly string[] => {
    const payload = sseDataPayload(block);
    if (!payload || payload === "[DONE]") return [block];
    let event: Row;
    try { event = JSON.parse(payload); } catch { return [block]; }
    if (!object(event)) return [block];
    let result: Row[] = [event];
    const hasIndex = Number.isSafeInteger(event.output_index) && event.output_index >= 0;
    const index = hasIndex ? event.output_index : 0;
    if (object(event.item) && event.item.type === "image_generation_call"
      && (hasIndex || typeof event.item.id === "string")) {
      if (event.type === "response.output_item.added") {
        const state = stateFor(event.item, index);
        result = state.added ? [] : [{ ...event, item: state.message }];
        state.added = true;
      } else if (event.type === "response.output_item.done") {
        result = doneEvents(event.item, index);
      }
    } else if (typeof event.type === "string" && event.type.startsWith("response.image_generation_call.")) {
      // Hosted progress/partial-image frames refer to the replaced item; never expose mismatched ids.
      result = [];
    } else if (object(event.response)) {
      const terminal = ["response.completed", "response.incomplete", "response.failed"].includes(event.type);
      const injected: Row[] = [];
      const response = snapshot(event.response, terminal, injected);
      if (response !== event.response) result = [...injected, { ...event, response }];
    }
    const sequence = Number.isSafeInteger(event.sequence_number) ? event.sequence_number + extraSequence : undefined;
    const shift = extraSequence;
    extraSequence += result.length - 1;
    return result.map((value, offset) => {
      if (value === event && shift === 0 && result.length === 1) return block;
      const next = sequence === undefined ? value : { ...value, sequence_number: sequence + offset };
      const data = JSON.stringify(next);
      return value.type === event.type ? replaceSseDataPayload(block, data) : "event: " + value.type + "\ndata: " + data;
    });
  }) as SseBlockRewrite & { json(text: string): string };

  rewrite.json = (text: string) => {
    let response: unknown;
    try { response = JSON.parse(text); } catch { return text; }
    if (!object(response)) return text;
    const next = snapshot(response, true);
    return next === response ? text : JSON.stringify(next);
  };
  rewrite.dispose = () => {
    states.clear();
    if (wroteArtifact) {
      wroteArtifact = false;
      pruneArtifacts();
    }
  };
  return rewrite;
}
