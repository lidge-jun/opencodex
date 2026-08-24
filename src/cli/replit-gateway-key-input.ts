import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import {
  MAX_REPLIT_GATEWAY_KEY_LENGTH,
  REPLIT_GATEWAY_KEY_PATTERN,
} from "../providers/replit/constants";
import { CliUsageError, type CliStdin, type RuntimeApiDeps } from "./runtime-api";

export const REPLIT_GATEWAY_KEY_ENV = "REPLIT_GATEWAY_KEY";
export const INSTALL_REPLIT_USAGE = `Usage: ocx provider install-replit --origin <https-url>
  [--stdin | --gateway-key-file <path>]
  [--allow-custom-domain] [--replace] [--set-default] [--json]

Gateway key sources (choose one):
  ${REPLIT_GATEWAY_KEY_ENV} environment variable
  --stdin                     read one line from stdin
  --gateway-key-file <path>   read one line from a file

Never pass the gateway key on the command line.`;

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
export const GATEWAY_KEY_MAX_READ_BYTES = MAX_REPLIT_GATEWAY_KEY_LENGTH + 64;

function firstLine(raw: string): string {
  return raw.split(/[\r\n]/, 1)[0]?.trim() ?? "";
}

function rejectEmpty(line: string): string {
  if (!line) throw new CliUsageError("gateway key input is empty", INSTALL_REPLIT_USAGE);
  if (line.length > MAX_REPLIT_GATEWAY_KEY_LENGTH) {
    throw new CliUsageError("gateway key input is too large", INSTALL_REPLIT_USAGE);
  }
  if (!REPLIT_GATEWAY_KEY_PATTERN.test(line)) {
    throw new CliUsageError("gateway key contains invalid characters", INSTALL_REPLIT_USAGE);
  }
  return line;
}

export function validateBoundedGatewayKeyValue(raw: string): string {
  return rejectEmpty(raw.trim());
}

function assertPrivateRegularFile(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new CliUsageError("gateway key file is not readable", INSTALL_REPLIT_USAGE);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CliUsageError("gateway key file must be a regular file", INSTALL_REPLIT_USAGE);
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new CliUsageError("gateway key file has insecure permissions", INSTALL_REPLIT_USAGE);
  }
  if (stats.size > GATEWAY_KEY_MAX_READ_BYTES) {
    throw new CliUsageError("gateway key file is too large", INSTALL_REPLIT_USAGE);
  }
}

export function readBoundedGatewayKeyFile(path: string): string {
  assertPrivateRegularFile(path);
  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new CliUsageError("gateway key file must be a regular file", INSTALL_REPLIT_USAGE);
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new CliUsageError("gateway key file has insecure permissions", INSTALL_REPLIT_USAGE);
    }
    const buffer = Buffer.allocUnsafe(GATEWAY_KEY_MAX_READ_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > GATEWAY_KEY_MAX_READ_BYTES) {
      throw new CliUsageError("gateway key file is too large", INSTALL_REPLIT_USAGE);
    }
    return rejectEmpty(firstLine(buffer.subarray(0, offset).toString("utf8")));
  } finally {
    closeSync(fd);
  }
}

export async function readBoundedGatewayKeyStdin(deps: RuntimeApiDeps): Promise<string> {
  const input: CliStdin = deps.stdinImpl ?? process.stdin;
  const timeoutMs = deps.stdinTimeoutMs ?? 120_000;
  if (input.readableEnded === true) {
    throw new CliUsageError("gateway key input is empty", INSTALL_REPLIT_USAGE);
  }
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onData = (chunk: unknown) => {
      const encoded = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += encoded.byteLength;
      if (bytes > GATEWAY_KEY_MAX_READ_BYTES) {
        finish(() => reject(new CliUsageError("gateway key input is too large", INSTALL_REPLIT_USAGE)));
        return;
      }
      buffer += encoded.toString("utf8");
      const newline = buffer.search(/[\r\n]/);
      if (newline >= 0) finish(() => resolve(buffer.slice(0, newline).trim()));
    };
    const onEnd = () => finish(() => resolve(buffer.trim()));
    const onError = () => finish(() => reject(new CliUsageError("gateway key input failed", INSTALL_REPLIT_USAGE)));
    const timer = setTimeout(
      () => finish(() => reject(new CliUsageError("timed out waiting for gateway key on stdin", INSTALL_REPLIT_USAGE))),
      timeoutMs,
    );
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
  return rejectEmpty(line);
}
