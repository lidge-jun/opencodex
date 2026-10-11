import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config/atomic-write";
import { assertNotRealClaudeConfigUnderTest } from "../../lib/test-home-guard";

/**
 * The loopback bypass opencodex keeps in Claude Code's settings env (#6936), and the receipt
 * that proves which part of `NO_PROXY` opencodex wrote.
 *
 * `NO_PROXY` is shared with the user, so a value alone cannot say which entries are ours. Apply
 * records `{ hadKey, previous, written }` in `<claudeConfigDir>/opencodex-no-proxy.json` and
 * removal restores `previous` only while `NO_PROXY` still equals `written`; anything else is
 * preserved. The receipt lives exactly as long as the ownership episode that wrote it: an apply
 * that starts a new episode, and every removal, invalidates it first and fails closed when it
 * cannot. It holds only `NO_PROXY` values, never the proxy token.
 */

/**
 * Local hosts Claude Code must reach directly, in the order opencodex appends them. The proxy
 * refuses every loopback and unspecified target (connect-proxy.ts isLoopbackTarget); these are the
 * forms a NO_PROXY entry can name. `localhost` also covers `*.localhost` because Claude Code's
 * client suffix-matches entries. Other 127/8 addresses cannot be listed (NO_PROXY has no CIDR) and
 * need their own entry; the proxy's 405 body says so.
 */
export const CLAUDE_INTERCEPT_LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1", "0.0.0.0"] as const;

export const NO_PROXY_RECEIPT_FILE = "opencodex-no-proxy.json";

export interface NoProxyReceipt {
  version: 1;
  /** Whether settings env held a NO_PROXY key before the apply. */
  hadKey: boolean;
  /** The value before the apply (null when the key was absent or held null). */
  previous: string | null;
  /** The value the apply wrote. */
  written: string;
}

/** Canonical index of a loopback bypass entry, or -1. `[::1]` is the bracketed form of `::1`. */
function loopbackEntryIndex(entry: string): number {
  const normalized = entry.trim().toLowerCase();
  return CLAUDE_INTERCEPT_LOOPBACK_NO_PROXY.indexOf(
    (normalized === "[::1]" ? "::1" : normalized) as typeof CLAUDE_INTERCEPT_LOOPBACK_NO_PROXY[number],
  );
}

function noProxyEntries(value: string): string[] {
  return value.split(/[,\s]+/).filter(entry => entry.length > 0);
}

/** True when the value already sends every loopback host around the proxy. */
export function noProxyCoversLoopback(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const entries = noProxyEntries(value);
  if (entries.includes("*")) return true;
  const present = new Set(entries.map(loopbackEntryIndex));
  return CLAUDE_INTERCEPT_LOOPBACK_NO_PROXY.every((_, index) => present.has(index));
}

/** A NO_PROXY value opencodex can extend: absent, null, or a string. */
export function noProxyMergeable(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/**
 * The NO_PROXY value apply writes, or null when nothing needs writing: the value already covers
 * loopback, or it is not one opencodex can extend.
 */
export function mergeClaudeInterceptNoProxy(current: unknown): string | null {
  if (!noProxyMergeable(current) || noProxyCoversLoopback(current)) return null;
  const base = typeof current === "string" ? current : "";
  const present = new Set(noProxyEntries(base).map(loopbackEntryIndex));
  const missing = CLAUDE_INTERCEPT_LOOPBACK_NO_PROXY.filter((_, index) => !present.has(index));
  const trimmed = base.replace(/[,\s]+$/, "");
  return trimmed.length === 0 ? missing.join(",") : `${trimmed},${missing.join(",")}`;
}

export function noProxyReceiptPath(configDir: string): string {
  return join(configDir, NO_PROXY_RECEIPT_FILE);
}

interface ReceiptIo {
  write(path: string, content: string): void;
  unlink(path: string): void;
}

const defaultReceiptIo: ReceiptIo = {
  write: (path, content) => atomicWriteFile(path, content),
  unlink: path => unlinkSync(path),
};
let receiptIo: ReceiptIo = defaultReceiptIo;

/** Replace receipt write/unlink in tests; the real-home guard still runs. Returns a restore. */
export function setNoProxyReceiptIoForTests(io: Partial<ReceiptIo>): () => void {
  const before = receiptIo;
  receiptIo = { ...defaultReceiptIo, ...io };
  return () => { receiptIo = before; };
}

/** The receipt, or null when it is missing or malformed (both mean: no provenance). */
export function readNoProxyReceipt(configDir: string): NoProxyReceipt | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(noProxyReceiptPath(configDir), "utf8"));
  } catch { // no-excuse-ok: catch -- a missing or corrupt receipt is the no-provenance state.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const receipt = parsed as Record<string, unknown>;
  if (receipt.version !== 1 || typeof receipt.hadKey !== "boolean" || typeof receipt.written !== "string") return null;
  if (receipt.previous !== null && typeof receipt.previous !== "string") return null;
  return { version: 1, hadKey: receipt.hadKey, previous: receipt.previous, written: receipt.written };
}

/** Raw receipt bytes for rollback capture, or null when there is no readable file. */
export function readNoProxyReceiptBytes(configDir: string): string | null {
  try {
    return readFileSync(noProxyReceiptPath(configDir), "utf8");
  } catch { // no-excuse-ok: catch -- an unreadable receipt is captured as absent.
    return null;
  }
}

/** Delete the receipt. Returns false when it exists but could not be removed. */
export function invalidateNoProxyReceipt(configDir: string): boolean {
  const path = noProxyReceiptPath(configDir);
  // Guard first and outside the catch, so a refusal is visible and nothing is touched.
  assertNotRealClaudeConfigUnderTest(configDir, path);
  try {
    receiptIo.unlink(path);
    return true;
  } catch (error) { // no-excuse-ok: catch -- ENOENT is success; anything else is reported to the caller.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Write raw receipt bytes. Throws on failure; callers decide whether that is fatal. */
export function writeNoProxyReceiptBytes(configDir: string, content: string): void {
  const path = noProxyReceiptPath(configDir);
  assertNotRealClaudeConfigUnderTest(configDir, path);
  receiptIo.write(path, content);
}

export function serializeNoProxyReceipt(receipt: NoProxyReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}
