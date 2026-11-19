/**
 * agy CLI: a marked shell function per profile that exports the AGY_LLM_GATEWAY_* variables for agy only.
 * No agy settings file is changed. Idea follows Magpie (MIT, (c) yetone), internal/agent/agy.go.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  adminGatewayOverride, assertClientSize, checkedClientDestination, clientRefusal, dropStash, envGatewayOverride,
  inspectClientFile, inspectStashPresence, isRestoreFile, mkdirTracked, mutateClient, readClientFile, readStash,
  removeCreatedClientFile, rmdirsIfEmpty, sha256, writeClientFile, writeStash, type ClientFile,
} from "./io";
import { gatewayNote, type GatewayClientConnector, type GatewayClientContext, type GatewayClientResult, type GatewayClientStatus, type GatewayTarget } from "./types";

const ID = "agy";
const START = "# >>> opencodex agy >>>";
const END = "# <<< opencodex agy <<<";
type Kind = "posix" | "powershell";
/** `pathWiseOnly`: the user edited the profile while connected, so disconnect removes only the block. */
interface Entry {
  path: string;
  kind: Kind;
  resolvedPath?: string;
  originalBytes: string | null;
  createdDirs: string[];
  writtenSha256: string;
  pendingSha256?: string;
  pathWiseOnly?: true;
}
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

type Profile = Pick<Entry, "path" | "kind">;

function candidates(ctx: GatewayClientContext): Profile[] {
  const win = ctx.platform === "win32";
  const bash: Profile = { path: join(ctx.home, ".bashrc"), kind: "posix" };
  const posix: Profile[] = win ? [bash] : [bash, { path: join(ctx.home, ".zshrc"), kind: "posix" }];
  const powershell = "Microsoft.PowerShell_profile.ps1";
  const ps7 = win ? join(ctx.home, "Documents", "PowerShell", powershell) : join(ctx.home, ".config", "powershell", powershell);
  const ps: Profile[] = [{ path: ps7, kind: "powershell" }];
  if (win) ps.push({ path: join(ctx.home, "Documents", "WindowsPowerShell", powershell), kind: "powershell" });
  return [...posix, ...ps];
}

/** Existing profiles, plus the active shell's profile when it needs to be created. */
function targets(ctx: GatewayClientContext, available: Profile[]): Profile[] {
  const posix = available.filter(({ kind, path }) => kind === "posix" && existsSync(path));
  const ps = available.filter(({ kind, path }) => kind === "powershell" && existsSync(path));
  if (ctx.platform === "win32") {
    if (ps.length === 0) ps.push(available[1]!);
  } else {
    const shell = basename(ctx.env.SHELL ?? "");
    const selected = available[shell === "zsh" ? 1 : 0]!;
    if ((posix.length === 0 || shell === "zsh" || shell === "bash") && !posix.includes(selected)) posix.push(selected);
  }
  return [...posix, ...ps];
}

function allowedProfilePaths(available: Profile[], kind: Kind): string[] {
  return available.filter(profile => profile.kind === kind).map(profile => profile.path);
}

function checkedStash(ctx: GatewayClientContext): Stash | null {
  const stash = readStash<Stash>(ctx, ID);
  if (!stash) return null;
  const allowed = new Map(candidates(ctx).map(({ path, kind }) => [path, kind]));
  if (!Array.isArray(stash.files) || stash.files.some(entry =>
    !entry || allowed.get(entry.path) !== entry.kind || !allowed.delete(entry.path)
    || !isRestoreFile(ctx.home, entry.path, entry))) {
    throw new Error("agy restore record names an invalid shell profile");
  }
  return stash;
}

function assertSameTarget(entry: Entry | undefined, target: string | undefined): void {
  if (target && entry?.resolvedPath && entry.resolvedPath !== target) {
    throw new Error(`agy profile now resolves to a different file: ${entry.path}`);
  }
}

const recordedHash = (entry: Entry, current: string): boolean =>
  entry.writtenSha256 === current || entry.pendingSha256 === current;

const MARKER_LINE = new RegExp(`(?:^\uFEFF?|\n)(${START}|${END})(?=\r?\n|$)`, "g");

function blockSpan(text: string): { start: number; end: number } | "malformed" | null {
  const markers = text.matchAll(MARKER_LINE);
  const first = markers.next().value;
  if (!first) return null;
  const last = markers.next().value;
  if (first[1] !== START || last?.[1] !== END || !markers.next().done) return "malformed";
  const start = first.index + first[0].length - START.length;
  let end = last.index + last[0].length;
  if (text.startsWith("\r\n", end)) end += 2; else if (text[end] === "\n") end += 1;
  return { start, end };
}

type Encoding = "utf8" | "utf16le";
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Profile text and how to write it back; null for an encoding we cannot round-trip (UTF-16BE, UTF-32, ANSI). */
function decode(bytes: Buffer): { text: string; encoding: Encoding } | null {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return null;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    // Windows PowerShell 5.1 redirection writes UTF-16LE with a BOM; FF FE 00 00 is UTF-32LE.
    if (bytes.length >= 4 && bytes[2] === 0 && bytes[3] === 0) return null;
    return bytes.length % 2 === 0 ? { text: bytes.subarray(2).toString("utf16le"), encoding: "utf16le" } : null;
  }
  if (bytes.includes(0)) return null;
  try { return { text: strictUtf8.decode(bytes), encoding: "utf8" }; } catch { return null; }
}
const encode = (text: string, encoding: Encoding): Buffer =>
  encoding === "utf16le" ? Buffer.concat([UTF16LE_BOM, Buffer.from(text, "utf16le")]) : Buffer.from(text);

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");
const withBlock = (text: string, block: string): string => {
  const eol = eolOf(text);
  const b = block.replace(/\n/g, eol) + eol;
  const span = blockSpan(text);
  if (span && span !== "malformed") return text.slice(0, span.start) + b + text.slice(span.end);
  if (text === "") return b;
  let head = text;
  if (!/\n$/.test(head)) head += eol;
  if (!/(\r?\n){2}$/.test(head)) head += eol;
  return head + b;
};
function blockIn(text: string): string | null {
  const span = blockSpan(text);
  return span && span !== "malformed" ? text.slice(span.start, span.end).replace(/\r\n/g, "\n").replace(/\n$/, "") : null;
}

function status(ctx: GatewayClientContext, target?: GatewayTarget): GatewayClientStatus {
  const hasRecord = inspectStashPresence(ctx, ID);
  const available = candidates(ctx);
  const files = targets(ctx, available);
  let withBlocks = 0;
  let current = 0;
  let unreadable = false;
  const rows: GatewayClientStatus["files"] = [];
  for (const { path, kind } of files) {
    const file = inspectClientFile(ctx, path, allowedProfilePaths(available, kind));
    const decoded = file ? decode(file.bytes) : null;
    unreadable ||= file === undefined || (file !== null && decoded === null);
    const block = decoded ? blockIn(decoded.text) : null;
    if (block !== null) { withBlocks++; if (!target || block === agyBlock(kind, target)) current++; }
    rows.push({ path, role: kind === "posix" ? "shell profile" : "PowerShell profile", exists: file !== null });
  }
  const state = withBlocks > 0 && current === files.length ? "connected" : withBlocks > 0 || hasRecord || unreadable ? "drifted" : "disconnected";
  const overrides: GatewayClientStatus["overrides"] = [];
  const admin = adminGatewayOverride(ctx);
  if (admin) overrides.push(admin);
  const env = envGatewayOverride(ctx, target?.url);
  if (env) overrides.push(env);
  const notes = [gatewayNote("new-terminal"), gatewayNote("agy-version")];
  if (ctx.platform === "win32") notes.push(gatewayNote("windows-unverified"));
  if (ctx.env.AGY_LLM_GATEWAY_URL?.trim()) notes.push(gatewayNote("agy-env-exported"));
  return { id: ID, label: "agy CLI", state, files: rows, overrides, notes };
}

function connect(ctx: GatewayClientContext, target: GatewayTarget): GatewayClientResult {
  const old = checkedStash(ctx);
  const entries = new Map(old?.files.map(entry => [entry.path, entry]));
  const available = candidates(ctx);
  const profiles = targets(ctx, available).sort((a, b) => Number(entries.has(b.path)) - Number(entries.has(a.path)));
  const seen = new Set<string>();
  const changedFiles: string[] = [];
  const staged: { entry: Entry; file: ClientFile | null; out: Buffer; allowedPaths: string[] }[] = [];
  for (const profile of profiles) {
    const { path, kind } = profile;
    const allowedPaths = allowedProfilePaths(available, kind);
    const file = readClientFile(ctx, path, allowedPaths);
    const prev = entries.get(path);
    assertSameTarget(prev, file?.target);
    if (file && seen.has(file.target)) continue;
    if (file) seen.add(file.target);
    const decoded = file ? decode(file.bytes) : { text: "", encoding: "utf8" as const };
    if (!decoded) return clientRefusal(`${path} is not UTF-8 or BOM-prefixed UTF-16LE text.`, "unsupported-file");
    const out = encode(withBlock(decoded.text, agyBlock(kind, target)), decoded.encoding);
    assertClientSize(out);
    const keep = prev !== undefined && file !== null && blockIn(decoded.text) !== null;
    const drifted = keep && (prev.pathWiseOnly === true || !recordedHash(prev, file.hash));
    staged.push({
      entry: {
        path, kind, originalBytes: keep ? prev.originalBytes : file?.bytes.toString("base64") ?? null,
        createdDirs: prev?.createdDirs ?? [], writtenSha256: file?.hash ?? "",
        pendingSha256: sha256(out),
        ...(drifted ? { pathWiseOnly: true } : {}),
      },
      file, out, allowedPaths,
    });
  }
  try {
    for (const { entry, file, allowedPaths } of staged) {
      entry.resolvedPath = checkedClientDestination(ctx, entry.path, file, allowedPaths);
      assertSameTarget(entries.get(entry.path), entry.resolvedPath);
      entry.createdDirs = [...entry.createdDirs, ...mkdirTracked(dirname(entry.path))];
      entries.set(entry.path, entry);
    }
    writeStash(ctx, ID, { version: 1, files: [...entries.values()] } satisfies Stash);
    for (const { entry, file, out, allowedPaths } of staged) {
      if (file?.hash === entry.pendingSha256) continue;
      writeClientFile(ctx, entry.path, file, out, allowedPaths);
      changedFiles.push(entry.path);
    }
  } catch (error) {
    return clientRefusal(`Could not update the shell profiles: ${(error as Error).message}`, "io-error", changedFiles);
  }
  // The journal already recognises both the previous and written bytes. Promotion is optional.
  for (const { entry } of staged) {
    entry.writtenSha256 = entry.pendingSha256!;
    delete entry.pendingSha256;
  }
  try { writeStash(ctx, ID, { version: 1, files: [...entries.values()] } satisfies Stash); }
  catch { /* pending stays recognisable */ }
  return { ok: true, changed: changedFiles.length > 0, changedFiles, message: "The agy command now starts on the OpenCodex gateway. Open a new terminal to use it.", notes: status(ctx, target).notes };
}

function disconnect(ctx: GatewayClientContext): GatewayClientResult {
  const stash = checkedStash(ctx);
  const available = candidates(ctx);
  const entries = new Map(stash?.files.map(entry => [entry.path, entry]));
  // Prefer journaled entries so an untracked alias cannot turn an exact restore into a block removal.
  const profiles = [...entries.values(), ...targets(ctx, available).filter(({ path }) => !entries.has(path))];
  const seen = new Set<string>();
  const changes: { path: string; apply: () => void }[] = [];
  const createdDirs: string[] = [];
  let pathWise = false;
  for (const { path, kind } of profiles) {
    const entry = entries.get(path);
    const allowedPaths = allowedProfilePaths(available, kind);
    const file = entry ? readClientFile(ctx, path, allowedPaths) : inspectClientFile(ctx, path, allowedPaths);
    assertSameTarget(entry, file?.target);
    if (!file) {
      if (entry) createdDirs.push(...entry.createdDirs);
      continue;
    }
    if (seen.has(file.target)) continue;
    seen.add(file.target);
    if (entry && !entry.pathWiseOnly && recordedHash(entry, file.hash)) {
      if (entry.originalBytes === null) {
        changes.push({ path, apply: () => removeCreatedClientFile(ctx, path, file, allowedPaths) });
        createdDirs.push(...entry.createdDirs);
      } else {
        const bytes = Buffer.from(entry.originalBytes, "base64");
        assertClientSize(bytes);
        if (!bytes.equals(file.bytes)) changes.push({ path, apply: () => writeClientFile(ctx, path, file, bytes, allowedPaths) });
      }
      continue;
    }
    const decoded = decode(file.bytes);
    if (!decoded && entry) return clientRefusal(`${path} uses an unsupported encoding. The restore record was kept.`, "unsupported-file");
    if (!decoded) continue;
    const { text, encoding } = decoded;
    const span = blockSpan(text);
    if (!span || span === "malformed") {
      // With both markers gone, a remaining gateway wrapper still requires repair.
      const hasWrapper = ["URL", "API_KEY", "WIRE_PROTOCOL"].every(key => text.includes(`AGY_LLM_GATEWAY_${key}`));
      if (entry && (span === "malformed" || hasWrapper)) {
        return clientRefusal("An agy profile has incomplete or ambiguous block markers. The restore record was kept.", "unsupported-file");
      }
      continue;
    }
    const bytes = encode(text.slice(0, span.start) + text.slice(span.end), encoding);
    changes.push({ path, apply: () => writeClientFile(ctx, path, file, bytes, allowedPaths) });
    pathWise = true;
  }

  const changedFiles: string[] = [];
  try {
    for (const { path, apply } of changes) {
      apply();
      changedFiles.push(path);
    }
    rmdirsIfEmpty(ctx, createdDirs);
    if (stash) dropStash(ctx, ID);
  } catch (error) {
    return clientRefusal(`Could not restore the shell profiles: ${(error as Error).message}`, "io-error", changedFiles);
  }
  if (!changedFiles.length) return { ok: true, changed: false, changedFiles, restore: "none", message: "No shell profile changes were needed.", notes: [] };
  return {
    ok: true, changed: true, changedFiles, restore: pathWise ? "path-wise" : "exact",
    message: pathWise ? "Removed the OpenCodex agy block; the rest of each edited profile was kept as it is." : "Shell profiles restored byte for byte.",
    notes: [gatewayNote("new-terminal")],
  };
}

export const AGY_CONNECTOR: GatewayClientConnector = {
  id: ID, label: "agy CLI", status,
  connect: (ctx, target) => mutateClient(ctx, () => connect(ctx, target)),
  disconnect: ctx => mutateClient(ctx, () => disconnect(ctx)),
};
