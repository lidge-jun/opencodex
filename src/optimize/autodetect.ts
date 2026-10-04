import type { FilterFunction } from "./filters";
// Port of auto_detect_filter (rtk/src/cmds/system/pipe_cmd.rs:132-188) + JS extras
// Detection order: git-log → git-diff → git-status → build-output → grep → find → tree → ls → search-list
//                  → read-numbered → dedup-log → smart-truncate → null
import { DETECT_WINDOW, READ_NUMBERED_MIN_HIT_RATIO, SMART_TRUNCATE_MIN_LINES } from "./constants";
import { gitDiff } from "./filters/gitDiff";
import { gitStatus } from "./filters/gitStatus";
import { gitLog } from "./filters/gitLog";
import { buildOutput } from "./filters/buildOutput";
import { grep } from "./filters/grep";
import { find } from "./filters/find";
import { dedupLog } from "./filters/dedupLog";
import { ls } from "./filters/ls";
import { tree } from "./filters/tree";
import { smartTruncate } from "./filters/smartTruncate";
import { readNumbered, READ_NUMBERED_LINE_RE } from "./filters/readNumbered";
import { searchList, SEARCH_LIST_HEADER_RE } from "./filters/searchList";

const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_BUILD_OUTPUT = /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
const RE_TREE_GLYPH = /[├└]──|│  /;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;

export function autoDetectFilter(text: string): FilterFunction | null {
  // Rust: floor_char_boundary to avoid UTF-8 split — JS .slice() by char is safe
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;

  if (RE_GIT_LOG.test(head)) return gitLog;
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) return gitDiff;
  if (RE_GIT_STATUS.test(head)) return gitStatus;

  // Build output BEFORE porcelain check: prevents cargo "Compiling" misdetection as git-status
  if (RE_BUILD_OUTPUT.test(head)) return buildOutput;

  if (isMostlyPorcelain(head)) return gitStatus;

  const lines = head.split("\n");
  const nonEmpty = lines.filter(l => l.trim().length > 0);

  // Rust grep rule: first 5 non-empty lines, ANY matches "file:number:content"
  const first5 = nonEmpty.slice(0, 5);
  if (first5.some(isGrepLine)) return grep;

  // Rust find rule: ALL non-empty lines path-like (no ':'), >=3 lines
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return find;

  // Tree: contains box-drawing glyphs typical of `tree` command
  if (RE_TREE_GLYPH.test(head)) return tree;

  // ls -la: has "total N" header or >=3 rows starting with perms string
  if (RE_LS_TOTAL.test(head) || countMatches(head, RE_LS_ROW) >= 3) return ls;

  // Cursor Glob search list header
  if (SEARCH_LIST_HEADER_RE.test(head)) return searchList;

  // Line-numbered file dump ("  N|content") — fire only if many lines match
  if (lines.length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(lines)) {
    return readNumbered;
  }

  // Large unformatted blob — smart truncate (keep head + tail)
  if (lines.length >= SMART_TRUNCATE_MIN_LINES) return smartTruncate;

  // Fallback: dedupLog for generic multi-line noise with actual duplicates
  if (nonEmpty.length >= 5 && hasConsecutiveDuplicates(lines)) return dedupLog;

  return null;
}

function hasConsecutiveDuplicates(lines: string[]): boolean {
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]?.trim();
    const curr = lines[i]?.trim();
    if (prev && curr && prev.length > 0 && prev === curr) return true;
  }
  return false;
}

function isGrepLine(line: string): boolean {
  // Rust: splitn(3, ':') → parts.len()==3 && parts[1].parse::<usize>().is_ok()
  const first = line.indexOf(":");
  if (first === -1) return false;
  const second = line.indexOf(":", first + 1);
  if (second === -1) return false;
  const lineno = line.slice(first + 1, second);
  return /^\d+$/.test(lineno);
}

function isPathLike(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  // A drive-letter prefix (e.g. "C:\Users\me" or "C:/Users/me") marks a
  // Windows absolute path, so treat the whole line as path-like. Trailing
  // colons (e.g. "C:\path\file.js:10") are tolerated, matching grep-style
  // suffixes on Windows dumps.
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.includes(":")) return false;
  return t.startsWith(".") || t.startsWith("/") || t.includes("/");
}

function isMostlyPorcelain(head: string): boolean {
  const lines = head.split("\n").filter(l => l.trim());
  if (lines.length < 3) return false;
  const hits = lines.filter(l => RE_PORCELAIN.test(l)).length;
  return hits / lines.length >= 0.6;
}

function isLineNumbered(lines: string[]): boolean {
  let hits = 0;
  let nonEmpty = 0;
  const sample = lines.slice(0, 100);
  for (const l of sample) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (READ_NUMBERED_LINE_RE.test(l)) hits++;
  }
  if (nonEmpty < 5) return false;
  return hits / nonEmpty >= READ_NUMBERED_MIN_HIT_RATIO;
}

function countMatches(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (text.match(g) || []).length;
}
