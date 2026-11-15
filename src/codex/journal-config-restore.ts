import { isDeepStrictEqual } from "node:util";
import { chmodSync, closeSync, fsyncSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { isOcxRoutingMarkerLine } from "./injected-marker";
import { transformManagedSubagentDefaults, type WrittenSubagentDefaults } from "./subagent-defaults";
import { rootAssignmentKey, rootSourceLines, sourceAssignment, sourceText } from "./toml-source-lines";

const ROOT_KEYS = new Set(["openai_base_url", "experimental_realtime_ws_base_url", "model_catalog_json", "model_provider", "web_search"]);
type Field = { start: number; end: number; text: string; value: unknown };
export type JournalConfigFields = Record<string, string | null>;

/** Only injection-owned fields are captured; hooks, projects and paths never enter this map. */
function fields(content: string): Map<string, Field> {
  const { lines, rootEnd } = rootSourceLines(content);
  // Inline/dotted tables have no independently replaceable owned block. Detect
  // them before restoring any root key; leaving them behind would lose recovery
  // evidence while the injected provider still exists. Decode key paths as TOML,
  // including quoted keys, without parsing unrelated (possibly wide) integers.
  let header = "";
  const keyToken = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
  const assignment = new RegExp(`^\\s*(${keyToken}(?:\\s*\\.\\s*${keyToken})*)\\s*=`);
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    if (!line.structural) continue;
    if (/^\s*\[/.test(line.text)) { header = line.text; continue; }
    const prefix = assignment.exec(line.text)?.[1];
    if (!prefix) continue;
    const context = Bun.TOML.parse(header) as Record<string, unknown>;
    // Explicit owned blocks are handled losslessly by the block scan below.
    if (["model_providers", "profiles"].some(key => {
      const table = context[key];
      return table && typeof table === "object" && Object.hasOwn(table, "opencodex");
    })) continue;
    const shape = Bun.TOML.parse(`${header}\n${prefix} = {}`) as Record<string, unknown>;
    for (const key of ["model_providers", "profiles"]) {
      const table = shape[key];
      if (!table || typeof table !== "object") continue;
      if (Object.hasOwn(table, "opencodex")) throw new Error("unsupported dotted owned Codex table");
      if (Object.keys(table).length) continue; // an unrelated provider/profile path
      let end = at + 1;
      while (end < lines.length && !lines[end]!.structural) end++;
      const value = Bun.TOML.parse(`${header}\n${sourceText(lines.slice(at, end))}`) as Record<string, unknown>;
      const actual = value[key];
      if (actual && typeof actual === "object" && Object.hasOwn(actual, "opencodex")) {
        throw new Error("unsupported inline or dotted owned Codex table");
      }
    }
  }
  const found = new Map<string, Field>();
  const put = (key: string, value: Field) => {
    if (found.has(key)) throw new Error("duplicate owned Codex field");
    found.set(key, value);
  };
  for (let at = 0; at < rootEnd; at++) {
    if (!lines[at]!.structural) continue;
    const key = rootAssignmentKey(lines[at]!.text);
    if (!key || !ROOT_KEYS.has(key)) continue;
    const span = sourceAssignment(lines, at, rootEnd);
    if (!span) throw new Error("invalid owned Codex field");
    put(key, span);
  }
  for (let at = rootEnd; at < lines.length; at++) {
    const line = lines[at]!;
    if (!line.structural || !/^\s*\[/.test(line.text)) continue;
    const header = Bun.TOML.parse(line.text) as Record<string, unknown>;
    const target = ["model_providers", "profiles"].find(key => {
      const table = header[key];
      return table && typeof table === "object" && Object.hasOwn(table, "opencodex");
    });
    let end = at + 1;
    while (end < lines.length && !(lines[end]!.structural && /^\s*\[/.test(lines[end]!.text))) end++;
    // A marker adjacent to the next header belongs to that next block, never this one.
    if (end < lines.length && lines[end - 1]?.structural && isOcxRoutingMarkerLine(lines[end - 1]!.text)) end--;
    if (target) {
      const table = (header[target] as Record<string, unknown>).opencodex;
      if (!table || typeof table !== "object" || Object.keys(table).length) throw new Error("unsupported owned child table");
      const text = sourceText(lines.slice(at, end));
      // Child tables are refused rather than accidentally treating them as the parent block.
      const value = Bun.TOML.parse(text);
      put(`${target}.opencodex`, { start: at, end, text, value });
    }
    at = end - 1;
  }
  return found;
}

export function captureJournalConfigFields(content: string, ownership: Ownership): JournalConfigFields {
  const captured: JournalConfigFields = {};
  for (const [key, span] of fields(content)) {
    const recorded = recordedValues(ownership).get(key);
    if (isDeepStrictEqual(span.value, recorded) || key === "model_provider" && span.value === "opencodex"
      || key === "model_providers.opencodex" || key === "profiles.opencodex") captured[key] = span.text;
  }
  // Injection removes the root selection and old inline OCX profiles in URL-only mode.
  for (const key of ["model_provider", "model_providers.opencodex", "profiles.opencodex"]) captured[key] ??= null;
  return captured;
}

interface Ownership {
  injectedConfigFields?: JournalConfigFields;
  injectedOpenaiBaseUrl?: string | null;
  injectedRealtimeWsBaseUrl?: string | null;
  injectedCatalogPath?: string | null;
  injectedRootWebSearch?: string | null;
  replacedRootWebSearch?: string | null;
  injectedSubagentDefaults?: WrittenSubagentDefaults | null;
}

function recordedValues(journal: Ownership): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [key, value] of [
    ["openai_base_url", journal.injectedOpenaiBaseUrl],
    ["experimental_realtime_ws_base_url", journal.injectedRealtimeWsBaseUrl],
    ["model_catalog_json", journal.injectedCatalogPath],
    ["web_search", journal.injectedRootWebSearch],
  ] as const) if (typeof value === "string") values.set(key, value);
  return values;
}

/** Three-way restore: an edited preference stays; an edited routing field blocks hand-back. */
export function restoreJournalConfigFields(current: string, original: string, journal: Ownership, recoverOwnedEdits = false): string | null {
  try {
    const defaults = transformManagedSubagentDefaults(current, null, journal.injectedSubagentDefaults);
    if (!defaults.ok) return null;
    current = defaults.content;
    const now = fields(current), before = fields(original);
    if (journal.replacedRootWebSearch) {
      const replaced = fields(journal.replacedRootWebSearch).get("web_search");
      if (!replaced) return null;
      before.set("web_search", replaced);
    }
    const expected = new Map<string, unknown>();
    if (journal.injectedConfigFields) {
      for (const [key, text] of Object.entries(journal.injectedConfigFields)) {
        if (text === null) { expected.set(key, undefined); continue; }
        const parsed = fields(text);
        const field = parsed.get(key);
        if (!field) return null;
        expected.set(key, field.value);
      }
    } else {
      // Version-1 journals predate field snapshots. Only their explicit value evidence
      // authorizes removal; a whole-file hash alone never authorizes a guessed URL.
      for (const [key, value] of recordedValues(journal)) expected.set(key, value);
      if (now.get("model_provider")?.value === "opencodex") expected.set("model_provider", "opencodex");
    }
    const { bom, lines } = rootSourceLines(current);
    if (recoverOwnedEdits) {
      // Legacy journals lack field snapshots. An exact structural marker is evidence
      // only for its adjacent owned span; loopback-looking values alone prove nothing.
      for (const [key, span] of now) {
        const marker = lines[span.start - 1];
        if (key !== "web_search" && !expected.has(key) && marker?.structural && isOcxRoutingMarkerLine(marker.text)) expected.set(key, span.value);
      }
    }
    const replacements = new Map<number, { end: number; text: string }>();
    const prepend: string[] = [];
    const append: string[] = [];
    const eol = lines.find(line => line.eol)?.eol || "\n";
    for (const key of new Set([...now.keys(), ...expected.keys()])) {
      const present = now.get(key), prior = before.get(key);
      if (isDeepStrictEqual(present?.value, prior?.value)) continue;
      if (!expected.has(key)) {
        if (key === "model" || key.startsWith("agents.") || key === "web_search") continue;
        return null;
      }
      const injected = expected.get(key);
      if (isDeepStrictEqual(injected, prior?.value)) continue; // never owned
      if (!isDeepStrictEqual(present?.value, injected)) {
        if (key === "model" || key.startsWith("agents.") || key === "web_search") continue;
        if (!recoverOwnedEdits) return null;
      }
      const replacement = prior ? prior.text.replace(/\r?\n/g, eol).replace(/(?:\r?\n)?$/, eol) : "";
      if (present) {
        let start = present.start;
        if (start > 0 && lines[start - 1]!.structural && isOcxRoutingMarkerLine(lines[start - 1]!.text)) start--;
        replacements.set(start, { end: present.end, text: replacement });
      } else if (replacement) {
        // A removed root value can safely return before the first table. Missing
        // non-root spans require a containing table, so refuse ambiguous placement.
        if (key.startsWith("agents.")) return null;
        if (key.includes(".")) append.push(replacement);
        else prepend.push(replacement);
      }
    }
    let out = bom + prepend.join("");
    for (let at = 0; at < lines.length;) {
      const replace = replacements.get(at);
      if (replace) { out += replace.text; at = replace.end; }
      else { out += sourceText([lines[at]!]); at++; }
    }
    return append.length ? `${out}${out.endsWith("\n") ? "" : eol}${append.join("")}` : out;
  } catch { return null; }
}

/** Private, exclusive, durable preimage. Never registered as an uninstall-owned artifact. */
export function snapshotDisconnectRecovery(home: string, config: string | null, profile: string | null, journal: unknown): string {
  const dir = mkdtempSync(join(home, ".ocx-disconnect-recovery-"));
  chmodSync(dir, 0o700);
  hardenSecretDir(dir, { required: true });
  const path = join(dir, "snapshot.json");
  const fd = openSync(path, "wx", 0o600);
  try {
    // Harden the empty file before placing possibly sensitive profile/config bytes in it.
    hardenSecretPath(path, { required: true });
    writeFileSync(fd, JSON.stringify({ version: 1, config, profile, journal }));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (process.platform !== "win32") {
    for (const entry of [dir, home]) {
      const directory = openSync(entry, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }
  return dir;
}
