/**
 * omo (Codex / LazyCodex)'s per-role model setting, `codex.agents.<role>.model` in `~/.omo/omo.jsonc`.
 *
 * LazyCodex 5.1.1 and later reads it, and callers reach this only after `detectLazyCodex`
 * says LazyCodex is installed. The file is omo's, so this writes only on an explicit
 * dashboard or CLI pick, never creates the file, and refuses a file with comments: the write
 * re-serializes JSON, and a comment the user wrote would be lost without a word.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileNoFollowUnclaimed } from "../config/atomic-write";
import { assertIntegrationWriteOwnership } from "../integrations/config-io";
import { hasJsoncComments, parseJsonc } from "../lib/jsonc";

export type OmoRoleModelsState =
  | { readonly state: "absent" }
  | { readonly state: "comments" }
  | { readonly state: "invalid" }
  | { readonly state: "unreadable" }
  | { readonly state: "present"; readonly models: Readonly<Record<string, string>> };

export type OmoRoleModelWriteStatus = "written" | "unchanged" | "absent" | "skipped_comments" | "invalid";

/** omo resolves its home from HOME, then USERPROFILE, then the OS home; this follows it. */
export function omoJsoncPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const base = env.HOME?.trim() || env.USERPROFILE?.trim() || home;
  return join(base, ".omo", "omo.jsonc");
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Loaded =
  | { kind: "absent" | "comments" | "invalid" }
  | { kind: "document"; text: string; doc: JsonObject };

function load(path: string): Loaded {
  let text: string;
  let fd: number | undefined;
  try {
    // POSIX FIFOs must not block before fstat can reject them. Windows omits
    // these flags and retains the descriptor/path identity checks below.
    const flags = process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    fd = openSync(path, flags);
    const opened = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      return { kind: "invalid" };
    }
    text = readFileSync(fd, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return { kind: "invalid" };
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (hasJsoncComments(text)) return { kind: "comments" };
  try {
    const doc = parseJsonc(text.replace(/^\ufeff/, ""));
    return isObject(doc) ? { kind: "document", text, doc } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function agentsOf(doc: JsonObject): JsonObject | null | undefined {
  const codex = doc.codex;
  if (codex === undefined) return undefined;
  if (!isObject(codex)) return null;
  const agents = codex.agents;
  if (agents === undefined) return undefined;
  return isObject(agents) ? agents : null;
}

export function readOmoRoleModels(path: string = omoJsoncPath()): OmoRoleModelsState {
  let loaded: Loaded;
  try {
    loaded = load(path);
  } catch {
    return { state: "unreadable" };
  }
  if (loaded.kind !== "document") return { state: loaded.kind };
  const agents = agentsOf(loaded.doc);
  if (agents === null) return { state: "invalid" };
  const models: Record<string, string> = {};
  for (const [role, entry] of Object.entries(agents ?? {})) {
    if (isObject(entry) && typeof entry.model === "string") models[role] = entry.model;
  }
  return { state: "present", models };
}

function serialize(text: string, doc: JsonObject): string {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  let out = JSON.stringify(doc, null, indent);
  if (/\r?\n$/.test(text)) out += "\n";
  if (text.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
  return text.startsWith("\ufeff") ? `\ufeff${out}` : out;
}

export function writeOmoRoleModel(role: string, model: string, path: string = omoJsoncPath()): OmoRoleModelWriteStatus {
  const loaded = load(path);
  if (loaded.kind !== "document") return loaded.kind === "comments" ? "skipped_comments" : loaded.kind;
  const { doc, text } = loaded;
  // Only an absent key is created; an explicit null is a value the reader calls invalid.
  const codex = doc.codex === undefined ? {} : doc.codex;
  if (!isObject(codex)) return "invalid";
  const agents = codex.agents === undefined ? {} : codex.agents;
  if (!isObject(agents)) return "invalid";
  const entry = agents[role] === undefined ? {} : agents[role];
  if (!isObject(entry)) return "invalid";
  if (entry.model === model) return "unchanged";
  agents[role] = { ...entry, model };
  codex.agents = agents;
  doc.codex = codex;
  assertIntegrationWriteOwnership(path);
  atomicWriteFileNoFollowUnclaimed(path, serialize(text, doc));
  return "written";
}
