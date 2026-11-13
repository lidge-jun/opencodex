/**
 * agy CLI: a marked shell function per profile that exports the AGY_LLM_GATEWAY_* variables for agy only.
 * No agy settings file is changed. Idea follows Magpie (MIT, (c) yetone), internal/agent/agy.go.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  adminGatewayOverride, dropStash, envGatewayOverride, mkdirTracked, readBytes, readStash, removeFile, rmdirsIfEmpty,
  sha256, writeBytes, writeStash,
} from "./io";
import type { GatewayClientConnector, GatewayClientContext, GatewayClientResult, GatewayClientStatus, GatewayTarget } from "./types";

const ID = "agy";
const START = "# >>> opencodex agy >>>";
const END = "# <<< opencodex agy <<<";
type Kind = "posix" | "powershell";
interface Entry { path: string; kind: Kind; originalBytes: string | null; createdDirs: string[]; writtenSha256: string }
interface Stash { version: 1; files: Entry[] }

const posixQuote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
const psQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;

export function agyBlock(kind: Kind, target: GatewayTarget): string {
  if (kind === "posix") {
    return [START, `agy() { AGY_LLM_GATEWAY_URL=${posixQuote(target.url)} AGY_LLM_GATEWAY_API_KEY=${posixQuote(target.apiKey)} AGY_LLM_GATEWAY_WIRE_PROTOCOL='genai' command agy "$@"; }`, END].join("\n");
  }
  return [
    START,
    "function agy {",
    "    $real = Get-Command agy -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    "    if (-not $real) { Write-Error 'agy was not found on PATH'; return }",
    "    $names = 'AGY_LLM_GATEWAY_URL', 'AGY_LLM_GATEWAY_API_KEY', 'AGY_LLM_GATEWAY_WIRE_PROTOCOL'",
    "    $saved = @{}",
    "    foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }",
    `    $env:AGY_LLM_GATEWAY_URL = ${psQuote(target.url)}`,
    `    $env:AGY_LLM_GATEWAY_API_KEY = ${psQuote(target.apiKey)}`,
    "    $env:AGY_LLM_GATEWAY_WIRE_PROTOCOL = 'genai'",
    "    try { & $real @args } finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n], 'Process') } }",
    "}",
    END,
  ].join("\n");
}

/** Profile files this connector writes, per platform. Existing files first; one is created when none exists. */
function targets(ctx: GatewayClientContext): { path: string; kind: Kind }[] {
  const win = ctx.platform === "win32";
  const out: { path: string; kind: Kind }[] = [];
  const posix = [join(ctx.home, ".bashrc"), ...(win ? [] : [join(ctx.home, ".zshrc")])];
  for (const path of posix) if (existsSync(path)) out.push({ path, kind: "posix" });
  if (!win && out.length === 0) {
    const zsh = basename(ctx.env.SHELL ?? "") === "zsh";
    out.push({ path: join(ctx.home, zsh ? ".zshrc" : ".bashrc"), kind: "posix" });
  }
  const ps7 = win ? join(ctx.home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1") : join(ctx.home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
  const ps5 = join(ctx.home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
  const psExisting = (win ? [ps7, ps5] : [ps7]).filter(p => existsSync(p));
  for (const path of psExisting) out.push({ path, kind: "powershell" });
  if (win && psExisting.length === 0) out.push({ path: ps7, kind: "powershell" });
  return out;
}

function blockSpan(text: string): { start: number; end: number } | null {
  const start = text.indexOf(START);
  if (start < 0) return null;
  const endMark = text.indexOf(END, start);
  if (endMark < 0) return null;
  let end = endMark + END.length;
  if (text.startsWith("\r\n", end)) end += 2; else if (text[end] === "\n") end += 1;
  return { start, end };
}

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");
const withBlock = (text: string, block: string): string => {
  const eol = eolOf(text);
  const b = block.replace(/\n/g, eol) + eol;
  const span = blockSpan(text);
  if (span) return text.slice(0, span.start) + b + text.slice(span.end);
  if (text === "") return b;
  let head = text;
  if (!/\n$/.test(head)) head += eol;
  if (!/(\r?\n){2}$/.test(head)) head += eol;
  return head + b;
};
const withoutBlock = (text: string): string => { const s = blockSpan(text); return s ? text.slice(0, s.start) + text.slice(s.end) : text; };
const blockIn = (text: string): string | null => { const s = blockSpan(text); return s ? text.slice(s.start, s.end).replace(/\r\n/g, "\n").replace(/\n$/, "") : null; };

function status(ctx: GatewayClientContext, target?: GatewayTarget): GatewayClientStatus {
  const stash = readStash<Stash>(ctx, ID);
  const files = targets(ctx);
  const known = new Map(files.map(f => [f.path, f.kind]));
  for (const e of stash?.files ?? []) if (!known.has(e.path)) known.set(e.path, e.kind);
  let withBlocks = 0;
  let current = 0;
  const rows: GatewayClientStatus["files"] = [];
  for (const [path, kind] of known) {
    const bytes = readBytes(path);
    const block = bytes ? blockIn(bytes.toString("utf8")) : null;
    if (block !== null) { withBlocks++; if (!target || block === agyBlock(kind, target)) current++; }
    rows.push({ path, role: kind === "posix" ? "shell profile" : "PowerShell profile", exists: bytes !== null });
  }
  const state = withBlocks > 0 && current === known.size ? "connected" : withBlocks > 0 || stash ? "drifted" : "disconnected";
  const overrides: GatewayClientStatus["overrides"] = [];
  const admin = adminGatewayOverride(ctx);
  if (admin) overrides.push({ source: "admin_settings", detail: admin });
  const env = envGatewayOverride(ctx, target?.url);
  if (env) overrides.push({ source: "env", detail: env });
  const notes = ["Open a new terminal to pick up the agy function.", "Gateway support needs agy 1.2.15 or newer."];
  if (ctx.platform === "win32") notes.push("Google lists agy for macOS and Linux only; on Windows this works only where an agy build runs, so treat it as untested.");
  if (ctx.env.AGY_LLM_GATEWAY_URL?.trim()) notes.push("AGY_LLM_GATEWAY_URL is exported globally in the environment OpenCodex sees; the agy function overrides it for agy only.");
  return { id: ID, label: "agy CLI", state, files: rows, overrides, notes };
}

function connect(ctx: GatewayClientContext, target: GatewayTarget): GatewayClientResult {
  const old = readStash<Stash>(ctx, ID);
  const entries: Entry[] = [];
  const changedFiles: string[] = [];
  const staged: { entry: Entry; out: Buffer; changed: boolean }[] = [];
  for (const t of targets(ctx)) {
    const bytes = readBytes(t.path);
    const prev = old?.files.find(e => e.path === t.path);
    const hasBlock = bytes !== null && blockIn(bytes.toString("utf8")) !== null;
    const text = bytes ? bytes.toString("utf8") : "";
    const out = Buffer.from(withBlock(text, agyBlock(t.kind, target)));
    const keep = prev !== undefined && hasBlock;
    staged.push({
      entry: { path: t.path, kind: t.kind, originalBytes: keep ? prev.originalBytes : bytes ? bytes.toString("base64") : null, createdDirs: prev?.createdDirs ?? [], writtenSha256: sha256(out) },
      out, changed: bytes === null || sha256(bytes) !== sha256(out),
    });
  }
  try {
    for (const s of staged) {
      if (!existsSync(dirname(s.entry.path))) s.entry.createdDirs = [...s.entry.createdDirs, ...mkdirTracked(dirname(s.entry.path))];
      entries.push(s.entry);
    }
    writeStash(ctx, ID, { version: 1, files: entries } satisfies Stash);
    for (const s of staged) { if (s.changed) { writeBytes(s.entry.path, s.out); changedFiles.push(s.entry.path); } }
  } catch (error) {
    return { ok: false, code: "io-error", message: `Could not update the shell profiles: ${(error as Error).message}`, changed: changedFiles.length > 0, changedFiles, notes: [] };
  }
  return { ok: true, changed: changedFiles.length > 0, changedFiles, message: "The agy command now starts on the OpenCodex gateway. Open a new terminal to use it.", notes: status(ctx, target).notes };
}

function disconnect(ctx: GatewayClientContext): GatewayClientResult {
  const stash = readStash<Stash>(ctx, ID);
  const paths = new Map<string, Entry | undefined>();
  for (const t of targets(ctx)) paths.set(t.path, undefined);
  for (const e of stash?.files ?? []) paths.set(e.path, e);
  const changedFiles: string[] = [];
  let pathWise = false;
  for (const [path, entry] of paths) {
    const bytes = readBytes(path);
    if (bytes && entry && sha256(bytes) === entry.writtenSha256) {
      if (entry.originalBytes === null) { removeFile(path); rmdirsIfEmpty(entry.createdDirs); }
      else writeBytes(path, Buffer.from(entry.originalBytes, "base64"));
      changedFiles.push(path);
      continue;
    }
    if (!bytes) { if (entry) rmdirsIfEmpty(entry.createdDirs); continue; }
    const text = bytes.toString("utf8");
    if (blockIn(text) === null) continue;
    writeBytes(path, Buffer.from(withoutBlock(text)));
    changedFiles.push(path);
    pathWise = true;
  }
  if (!stash && changedFiles.length === 0) return { ok: true, changed: false, changedFiles: [], restore: "none", message: "Not connected by OpenCodex; nothing was changed.", notes: [] };
  dropStash(ctx, ID);
  return {
    ok: true, changed: changedFiles.length > 0, changedFiles, restore: changedFiles.length === 0 ? "none" : pathWise ? "path-wise" : "exact",
    message: pathWise ? "Removed the OpenCodex agy block; the rest of each edited profile was kept as it is." : "Shell profiles restored byte for byte.",
    notes: ["Open a new terminal to apply it."],
  };
}

export const AGY_CONNECTOR: GatewayClientConnector = { id: ID, label: "agy CLI", status, connect, disconnect };
