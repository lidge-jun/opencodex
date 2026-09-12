import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

const MAX_AUTH_BYTES = 256 * 1024;
export const ORCA_ACCOUNT_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sameLocalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Reject links at every component; never follow an external credential reference. */
export function assertPlainLocalPath(path: string): string {
  if (/^(?:\\\\|\/\/)/.test(path)) throw new Error("Network and device credential paths are unsupported.");
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of relative(current, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Unsafe local credential path.");
  }
  if (!sameLocalPath(realpathSync(absolute), absolute)) throw new Error("Unsafe local credential path.");
  return absolute;
}

export function readBoundedLocalFile(path: string, limit = MAX_AUTH_BYTES): string {
  assertPlainLocalPath(path);
  const before = lstatSync(path);
  if (!before.isFile() || before.size > limit) throw new Error("Invalid local credential file.");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > limit || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error("Local credential file changed.");
    }
    // The cap bounds the read, not the allocation: tiny registry files should not
    // allocate 32 MiB on each preview/recheck. One extra byte detects concurrent growth.
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== opened.size) throw new Error("Local credential file changed.");
    assertPlainLocalPath(path);
    const after = lstatSync(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error("Local credential file changed.");
    }
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local OAuth credential.");
  return value as Record<string, unknown>;
}

export function parseOrcaAuth(raw: string, requireFresh = true) {
  const auth = object(JSON.parse(raw));
  if ((auth.auth_mode !== undefined && auth.auth_mode !== "chatgpt")
    || (auth.OPENAI_API_KEY !== undefined && auth.OPENAI_API_KEY !== null && auth.OPENAI_API_KEY !== "")) {
    throw new Error("Expected a ChatGPT OAuth credential.");
  }
  const tokens = object(auth.tokens);
  if (typeof tokens.access_token !== "string" || typeof tokens.account_id !== "string" || !tokens.account_id) {
    throw new Error("Local OAuth credential lacks account identity.");
  }
  const parts = tokens.access_token.split(".");
  if (parts.length !== 3) throw new Error("Invalid local OAuth bearer.");
  const claims = object(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
  const identity = object(claims["https://api.openai.com/auth"]);
  if (identity.chatgpt_account_id !== tokens.account_id || typeof claims.sub !== "string" || !claims.sub
    || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.exp * 1000)
    || (requireFresh && claims.exp * 1000 <= Date.now() + 60_000)) {
    throw new Error("Local OAuth identity or expiry is invalid.");
  }
  return { accessToken: tokens.access_token, refreshToken: "", expiresAt: claims.exp * 1000,
    chatgptAccountId: tokens.account_id, sourceSubject: claims.sub };
}

export function readOrcaAuthSource(path: string) {
  if (!isAbsolute(path) || !ORCA_ACCOUNT_DIRECTORY.test(dirname(dirname(path)).split(/[\\/]/).pop() ?? "")
    || dirname(path).split(/[\\/]/).pop() !== "home"
    || dirname(dirname(dirname(path))).split(/[\\/]/).pop() !== "codex-accounts"
    || path.split(/[\\/]/).pop() !== "auth.json") throw new Error("Invalid Orca credential location.");
  try {
    const accountDirectory = dirname(dirname(path)).split(/[\\/]/).pop()!;
    if (readBoundedLocalFile(join(dirname(path), ".orca-managed-home"), 128).trim() !== accountDirectory) {
      throw new Error("Orca home ownership marker does not match.");
    }
    return { ...parseOrcaAuth(readBoundedLocalFile(path)), sourceAuthPath: path };
  }
  catch { throw new Error("Orca credential unavailable; update the account in Orca and retry."); }
}
