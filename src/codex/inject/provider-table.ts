import { isDeepStrictEqual } from "node:util";
import { OCX_SECTION_MARKER } from "../injected-marker";
import { splitSourceLines, type SourceLine } from "../toml-source-lines";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function providerValue(text: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = Bun.TOML.parse(text); }
  catch { throw new Error("Codex provider table could not be read safely."); }
  const root = record(parsed);
  const providers = record(root?.model_providers);
  const provider = record(providers?.opencodex);
  if (!provider || Object.keys(root!).length !== 1 || Object.keys(providers!).length !== 1) {
    throw new Error("Codex provider table could not be read safely.");
  }
  return provider;
}

const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const ASSIGNMENT = new RegExp(`^\\s*(${KEY}(?:\\s*\\.\\s*${KEY})*)\\s*=`);

function unsupportedProviderAssignment(text: string, section: string): boolean {
  if (section !== "root" && section !== "providers") return false;
  const match = ASSIGNMENT.exec(text);
  if (!match) return false;
  // Parsing only the key path handles quoted/escaped components without reading
  // unrelated large integer values or allowing strings to impersonate a header.
  const parsed = record(Bun.TOML.parse(`${match[1]} = {}\n`))!;
  if (section === "providers") return Object.hasOwn(parsed, "opencodex");
  const providers = record(parsed.model_providers);
  return providers !== null && (Object.keys(providers).length === 0 || Object.hasOwn(providers, "opencodex"));
}

/** Recognize real table headers, including quoted keys, without parsing unrelated values. */
function headerKind(text: string): "provider" | "providers" | "foreign" {
  let parsed: Record<string, unknown> | null;
  try { parsed = record(Bun.TOML.parse(text + "\n")); }
  catch { throw new Error("Codex table header could not be read safely."); }
  const providers = record(parsed?.model_providers);
  if (providers && Object.hasOwn(providers, "opencodex")) {
    if (!record(providers.opencodex)) throw new Error("Codex provider array tables cannot be retained safely.");
    return "provider";
  }
  return providers && Object.keys(providers).length === 0 ? "providers" : "foreign";
}

/** Physical spans are shared by capture and removal so neither sees headers inside values. */
function providerLines(content: string): { bom: string; lines: SourceLine[]; owned: Set<number> } {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const lines = splitSourceLines(content.slice(bom.length));
  const owned = new Set<number>();
  let section: "root" | "provider" | "providers" | "foreign" = "root";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const text = line.text;
    if (line.structural && /^\s*\[/.test(text)) {
      section = headerKind(text);
      if (section === "provider") {
        const previous = lines[index - 1];
        if (previous?.structural && previous.text.trim() === OCX_SECTION_MARKER) owned.add(index - 1);
      }
    } else if (line.structural && unsupportedProviderAssignment(text, section)) {
      // These forms have no independently removable table span. Do not append a
      // competing definition or silently treat a user-owned inline value as absent.
      throw new Error("Codex provider retention requires an explicit provider table.");
    }
    if (section === "provider") owned.add(index);
  }
  return { bom, lines, owned };
}

export function hasOcxProviderTable(content: string): boolean {
  return providerLines(content).owned.size > 0;
}

/** Preserve value bytes, including multiline newlines and separated child tables. */
export function extractOcxProviderTableBlock(content: string): string | null {
  const { lines, owned } = providerLines(content);
  if (owned.size === 0) return null;
  const captured = lines.filter((_, index) => owned.has(index));
  while (captured.length && captured.at(-1)!.structural && !captured.at(-1)!.text.trim()) captured.pop();
  const text = captured.map(line => line.text + line.eol).join("");
  providerValue(text); // Ambiguous or incomplete owned spans never become a retained block.
  return text.endsWith("\n") ? text : text + "\n";
}

export function removeOcxSection(content: string): string {
  const { bom, lines, owned } = providerLines(content);
  if (owned.size) providerValue(lines.filter((_, index) => owned.has(index)).map(line => line.text + line.eol).join(""));
  return bom + lines.filter((_, index) => !owned.has(index)).map(line => line.text + line.eol).join("");
}

/** Compare decoded values; cosmetic layout never rewrites the existing file. */
export function appendOcxProviderTableBlock(content: string, block: string): string {
  const captured = providerValue(block);
  const existing = extractOcxProviderTableBlock(content);
  if (existing !== null) {
    if (!isDeepStrictEqual(providerValue(existing), captured)) {
      throw new Error("Codex restore refused: the native config already defines a different [model_providers.opencodex] table.");
    }
    return content;
  }
  return `${content}${content.endsWith("\n") ? "\n" : "\n\n"}${block}${block.endsWith("\n") ? "" : "\n"}`;
}
