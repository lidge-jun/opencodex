import { closeSync, openSync, readSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Dispatchers are a few lines; a larger file is not inspected and so not trusted. */
const MAX_DISPATCHER_BYTES = 64 * 1024;
/** Launcher hops followed before the chain is reported as unverifiable. */
const MAX_DISPATCHER_DEPTH = 4;

/** Thrown by the default reader when a dispatcher is larger than the inspection bound. */
export class DispatcherTooLargeError extends Error {}

/** Returns a dispatcher's full text; throws when it cannot be read completely. */
export type ReadDispatcherFn = (path: string) => string;

export type BatchDispatcherVerdict =
  | { preservesEmptyArguments: true }
  | { preservesEmptyArguments: false; reason: "powershell_hop" | "unreadable" | "incomplete" | "indirect_launch" };

/** Read the whole dispatcher, refusing one that does not fit the inspection bound. */
function readWholeDispatcher(path: string): string {
  const fd = openSync(path, "r");
  try {
    // One byte past the bound tells a complete read from a truncated one.
    const buffer = Buffer.alloc(MAX_DISPATCHER_BYTES + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const bytes = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (bytes === 0) break;
      filled += bytes;
    }
    if (filled > MAX_DISPATCHER_BYTES) throw new DispatcherTooLargeError(path);
    return buffer.subarray(0, filled).toString("latin1");
  } finally {
    closeSync(fd);
  }
}

/** `REM ...` and `:: ...` lines are comments; a mention there launches nothing. */
const COMMENT_LINE = /^\s*(?:@?rem(?:\s|$)|::)/i;
/** `%~dp0` expands to the dispatcher's own directory with a trailing separator. */
const POWERSHELL_HOP = /(?:^|[\s"'(&|@\\/]|%~dp0)(?:powershell|pwsh)(?:\.exe)?(?=[\s"')&|]|$)/i;
/** A quoted or bare token naming another batch file. */
const BATCH_REFERENCE = /"([^"]+\.(?:cmd|bat))"|([^\s"'&|<>()]+\.(?:cmd|bat))(?=[\s"'&|<>()]|$)/gi;
/** The target of a CALL statement. */
const CALL_TARGET = /(?:^|[\s&|(@])call\s+("[^"]*"|[^\s&|<>()]+)/gi;

function unquote(token: string): string {
  return token.replace(/^"|"$/g, "");
}

/**
 * Resolve a referenced batch file to a literal path: relative to this dispatcher through `%~dp0`,
 * or already absolute. Anything still carrying a variable cannot be verified.
 */
function resolveReference(reference: string, dispatcher: string): string | undefined {
  const pathApi = dispatcher.includes("\\") ? win32 : posix;
  const expanded = /^%~dp0/i.test(reference)
    ? pathApi.join(pathApi.dirname(dispatcher), reference.replace(/^%~dp0[\\/]?/i, ""))
    : reference;
  if (expanded.includes("%") || expanded.includes("!")) return undefined;
  return win32.isAbsolute(expanded) || posix.isAbsolute(expanded) ? expanded : undefined;
}

type LineVerdict = { kind: "powershell" } | { kind: "unknown" } | { kind: "batches"; paths: string[] };

function inspectLine(line: string, dispatcher: string): LineVerdict {
  if (POWERSHELL_HOP.test(line)) return { kind: "powershell" };
  const paths: string[] = [];
  for (const match of line.matchAll(CALL_TARGET)) {
    const target = unquote(match[1] ?? "");
    // CALL :label stays inside this file; a CALL of a native image keeps argv boundaries.
    if (target.startsWith(":") || /\.(?:exe|com)$/i.test(target)) continue;
    if (!/\.(?:cmd|bat)$/i.test(target)) return { kind: "unknown" };
  }
  for (const match of line.matchAll(BATCH_REFERENCE)) {
    const resolved = resolveReference(match[1] ?? match[2] ?? "", dispatcher);
    if (!resolved) return { kind: "unknown" };
    paths.push(resolved);
  }
  return { kind: "batches", paths };
}

/**
 * Can this .cmd/.bat dispatcher deliver an empty-string argument to the CLI it launches?
 *
 * cmd.exe hands "" to the batch file intact, and a dispatcher that forwards %* straight to a
 * native image or to node (the npm cmd-shim layout) delivers it as an empty argv entry. A
 * dispatcher that forwards through "powershell -File ... %*" does not: the PowerShell hop drops
 * the empty values, so --setting-sources "" --max-turns 1 arrives as
 * --setting-sources --max-turns 1 (#7518).
 *
 * The bytes of the dispatcher about to be run are the evidence; nothing is guessed from install
 * paths. A positive verdict needs the whole chain inspected: every file read completely, and every
 * hop to another batch file resolved to a literal path and inspected in turn, up to
 * `MAX_DISPATCHER_DEPTH` files. An unreadable or oversized file, a hop through a variable, or a chain
 * deeper than the bound proves nothing and is refused.
 */
export function inspectBatchDispatcher(path: string, read: ReadDispatcherFn = readWholeDispatcher): BatchDispatcherVerdict {
  const seen = new Set<string>();
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const key = current.toLowerCase();
    if (seen.has(key)) continue;
    if (seen.size >= MAX_DISPATCHER_DEPTH) return { preservesEmptyArguments: false, reason: "indirect_launch" };
    seen.add(key);
    let body: string;
    try {
      body = read(current);
    } catch (error) {
      return { preservesEmptyArguments: false, reason: error instanceof DispatcherTooLargeError ? "incomplete" : "unreadable" };
    }
    for (const line of body.split(/\r?\n/)) {
      if (COMMENT_LINE.test(line)) continue;
      const verdict = inspectLine(line, current);
      if (verdict.kind === "powershell") return { preservesEmptyArguments: false, reason: "powershell_hop" };
      if (verdict.kind === "unknown") return { preservesEmptyArguments: false, reason: "indirect_launch" };
      pending.push(...verdict.paths);
    }
  }
  return { preservesEmptyArguments: true };
}
