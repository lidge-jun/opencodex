/**
 * Cursor's local-agent effort table, read from the installed bundle.
 *
 * Cursor Private Inference decides which model rows get a Reasoning control from a table
 * compiled into extensions/cursor-agent-exec/dist/main.js, not from the gateway's
 * reasoning_effort list (devlog 260902_cursor_bundle_effort_table/000). Reading that table
 * from the install the dashboard already detects lets the prediction follow a Cursor update
 * instead of a hand-copied mirror. Read-only, size-bounded, cached by (path, mtime, size);
 * any parse failure yields null so the caller falls back to the static mirror.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CursorInstall } from "./cursor-detect";

export interface CursorEffortFamily {
  id: string;
  pattern: RegExp;
  /** [] = family matched but Cursor shows no control. */
  ladder: readonly string[];
  param?: "reasoning_effort" | "output_config.effort";
  defaultValue?: string;
  outputCap?: number;
  requiresReasoningCapability: boolean;
}

export interface CursorBareGpt5Rule {
  pattern: RegExp;
  ladder: readonly string[];
  defaultValue: string;
}

export interface CursorEffortTable {
  families: readonly CursorEffortFamily[];
  /** The bare gpt-5 / gpt-5.x rule that runs when no family matched. */
  bareGpt5: CursorBareGpt5Rule | null;
  version: string | null;
  bundlePath: string;
}

const BUNDLE_MAX_BYTES = 32 * 1024 * 1024;

/** Bundle path under the install root cursor-detect reports. */
export function cursorAgentBundlePath(install: Pick<CursorInstall, "path">, platform: string = process.platform): string {
  const tail = ["extensions", "cursor-agent-exec", "dist", "main.js"];
  return platform === "darwin"
    ? join(install.path, "Contents", "Resources", "app", ...tail)
    : join(install.path, "resources", "app", ...tail);
}

/**
 * Parse the family table out of the minified source:
 *   const w={param:"reasoning_effort",values:[...],defaultValue:"medium"};
 *   ...const T={...},k={...},S={...},b=[{id:"...",matches:e=>/.../u.test(e),effort:k,outputCap:128e3},...];
 * Identifier names are minifier-assigned, so binding is by structure: every
 * <ident>={param:"...",values:[...],defaultValue:"..."} is an effort constant, and a family's
 * effort: is either such an identifier or an inline object.
 */
export function parseCursorEffortTable(source: string): Omit<CursorEffortTable, "version" | "bundlePath"> | null {
  const constants = new Map<string, { param: string; values: string[]; defaultValue: string }>();
  const constRe = /(?:const |,)([A-Za-z_$][\w$]*)=\{param:"(reasoning_effort|output_config\.effort)",values:\[([^\]]*)\],defaultValue:"([a-z]+)"\}/gu;
  for (const m of source.matchAll(constRe)) {
    constants.set(m[1]!, { param: m[2]!, values: splitStrings(m[3]!), defaultValue: m[4]! });
  }
  const tableStart = source.indexOf('=[{id:"anthropic-');
  if (tableStart === -1) return null;
  const tableEnd = source.indexOf("];", tableStart);
  if (tableEnd === -1) return null;
  const body = source.slice(tableStart + 2, tableEnd + 1);
  const entryRe = /\{id:"([^"]+)",matches:e=>\/((?:\\\/|[^/])+)\/([a-z]*)\.test\(e\)((?:,(?:effort:(?:[A-Za-z_$][\w$]*|\{[^}]*\})|outputCap:[\de.]+|effortRequiresReasoningCapability:!0))*)\}/gu;
  const families: CursorEffortFamily[] = [];
  // Every "{id:" opener in the window must be consumed by entryRe. A build that adds a
  // property to one family would otherwise drop that family silently and the caller would
  // report a bundle-sourced "no control" for it instead of falling back to the mirror.
  const openers = body.split('{id:"').length - 1;
  for (const m of body.matchAll(entryRe)) {
    let pattern: RegExp;
    try { pattern = new RegExp(m[2]!, m[3]!); } catch { return null; }
    const tail = m[4]!;
    const effortRef = /effort:([A-Za-z_$][\w$]*)(?:,|$)/u.exec(tail)?.[1];
    const inline = /effort:\{param:"([^"]+)",values:\[([^\]]*)\],defaultValue:"([a-z]+)"\}/u.exec(tail);
    const effort = inline
      ? { param: inline[1]!, values: splitStrings(inline[2]!), defaultValue: inline[3]! }
      : effortRef ? constants.get(effortRef) : undefined;
    if (effortRef && !inline && !effort) return null; // unknown constant: structure changed
    const cap = /outputCap:([\de.]+)/u.exec(tail)?.[1];
    families.push({
      id: m[1]!,
      pattern,
      ladder: effort?.values ?? [],
      ...(effort ? { param: effort.param as CursorEffortFamily["param"], defaultValue: effort.defaultValue } : {}),
      ...(cap ? { outputCap: Number(cap) } : {}),
      requiresReasoningCapability: tail.includes("effortRequiresReasoningCapability:!0"),
    });
  }
  if (families.length === 0 || families.length !== openers) return null;
  // The tested variable and the returned constant are minifier-assigned names; bind by shape.
  const bareRe = /if\(\/(\^gpt-5[^/]+)\/([a-z]*)\.test\([A-Za-z_$][\w$]*\)\)return ([A-Za-z_$][\w$]*)\}/u.exec(source);
  const bareConst = bareRe ? constants.get(bareRe[3]!) : undefined;
  let bareGpt5: CursorBareGpt5Rule | null = null;
  if (bareRe && bareConst) {
    let pattern: RegExp;
    try { pattern = new RegExp(bareRe[1]!, bareRe[2]!); } catch { return null; }
    bareGpt5 = { pattern, ladder: bareConst.values, defaultValue: bareConst.defaultValue };
  }
  return { families, bareGpt5 };
}

function splitStrings(list: string): string[] {
  return [...list.matchAll(/"([^"]+)"/gu)].map(m => m[1]!);
}

export interface CursorEffortTableDeps {
  platform: string;
  stat(path: string): { mtimeMs: number; size: number } | null;
  readText(path: string): string | null;
}

export function realCursorEffortTableDeps(): CursorEffortTableDeps {
  return {
    platform: process.platform,
    stat: path => { try { const s = statSync(path); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } },
    readText: path => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  };
}

let cache: { key: string; table: CursorEffortTable | null } | null = null;

/** Table from the Private Inference install, else null (caller falls back to the static mirror). */
export function loadCursorEffortTable(install: CursorInstall | undefined, deps: CursorEffortTableDeps = realCursorEffortTableDeps()): CursorEffortTable | null {
  if (!install) return null;
  const bundlePath = cursorAgentBundlePath(install, deps.platform);
  const st = deps.stat(bundlePath);
  if (!st || st.size > BUNDLE_MAX_BYTES) return null;
  const key = `${bundlePath}|${st.mtimeMs}|${st.size}`;
  if (cache?.key === key) return cache.table;
  const text = deps.readText(bundlePath);
  const parsed = text ? parseCursorEffortTable(text) : null;
  const table = parsed ? { ...parsed, version: install.version, bundlePath } : null;
  cache = { key, table };
  return table;
}

export function resetCursorEffortTableCacheForTests(): void { cache = null; }
