import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { renameAtomicFile } from "../lib/windows-atomic-replace";
import {
  REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES,
  type RemoteWorkspaceToolName,
  type RemoteWorkspaceToolResult,
} from "./workspace-tools";

export interface RemoteWorkspaceRoot {
  id: string;
  path: string;
}

export interface RemoteWorkspaceExecutionRequest {
  requestId: string;
  sessionId: string;
  executorDeviceId: string;
  rootId: string;
  tool: RemoteWorkspaceToolName;
  arguments: unknown;
}

export interface RemoteWorkspaceExecutorOptions {
  deviceId: string;
  roots: readonly RemoteWorkspaceRoot[];
  maxOutputBytes?: number;
  platform?: NodeJS.Platform;
  /** Production must provide an OS-sandboxed runner. Omission disables command execution. */
  commandRunner?: RemoteWorkspaceCommandRunner;
}

export interface RemoteWorkspaceCommandRequest {
  command: string[];
  root: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface RemoteWorkspaceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RemoteWorkspaceCommandRunner {
  run(request: RemoteWorkspaceCommandRequest): Promise<RemoteWorkspaceCommandResult>;
}

interface ApprovedRoot {
  id: string;
  path: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("remote workspace arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function noExtraKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some(key => !set.has(key))) throw new Error("unknown remote workspace argument");
}

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

export function validateRemoteWorkspaceRelativePath(
  value: unknown,
  fallback?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = value === undefined ? fallback : value;
  if (typeof path !== "string" || path.length < 1 || path.length > 4096 || path.includes("\0")) {
    throw new Error("invalid remote workspace path");
  }
  const paths = platform === "win32" ? win32 : posix;
  if (paths.isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    throw new Error("remote workspace path must be relative");
  }
  if (platform === "win32") {
    for (const segment of path.split(/[\\/]/)) {
      if (!segment || segment === "." || segment === "..") continue;
      if (/[\x01-\x1f<>:"|?*]/.test(segment) || /[ .]$/.test(segment) || WINDOWS_RESERVED_BASENAME.test(segment)) {
        throw new Error("remote workspace path is not a safe Windows file path");
      }
    }
  }
  return path;
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function assertNoSymlinkComponents(root: string, candidate: string, includeLeaf: boolean): void {
  const rel = relative(root, candidate);
  const parts = rel === "" ? [] : rel.split(sep);
  const limit = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  let current = root;
  for (let index = 0; index < limit; index += 1) {
    current = resolve(current, parts[index]!);
    if (lstatSync(current).isSymbolicLink()) throw new Error("remote workspace symlink traversal is not allowed");
  }
}

function resolveExisting(root: string, value: unknown, platform = process.platform): string {
  const candidate = resolve(root, validateRemoteWorkspaceRelativePath(value, ".", platform));
  if (!inside(root, candidate)) throw new Error("remote workspace path escapes the approved root");
  assertNoSymlinkComponents(root, candidate, true);
  const canonical = realpathSync(candidate);
  if (!inside(root, canonical)) throw new Error("remote workspace path escapes the approved root");
  return canonical;
}

function resolveWritable(root: string, value: unknown, platform = process.platform): string {
  const candidate = resolve(root, validateRemoteWorkspaceRelativePath(value, undefined, platform));
  if (!inside(root, candidate) || candidate === root) throw new Error("remote workspace path escapes the approved root");
  const parent = dirname(candidate);
  assertNoSymlinkComponents(root, parent, true);
  const canonicalParent = realpathSync(parent);
  if (!inside(root, canonicalParent)) throw new Error("remote workspace parent escapes the approved root");
  try {
    assertNoSymlinkComponents(root, candidate, true);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return resolve(canonicalParent, basename(candidate));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error("invalid remote workspace numeric argument");
  }
  return selected;
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(value);
}

function assertOpenedRegularFile(root: string, target: string, descriptor: number, maximum: number) {
  const opened = fstatSync(descriptor);
  const linked = lstatSync(target);
  if (opened.isFile() && linked.isFile() && (opened.nlink !== 1 || linked.nlink !== 1)) {
    throw new Error("remote workspace hard-linked files are not allowed");
  }
  if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink()
    || opened.dev !== linked.dev || opened.ino !== linked.ino
    || opened.birthtimeMs !== linked.birthtimeMs) {
    throw new Error("remote workspace file identity changed during access");
  }
  const canonical = realpathSync(target);
  if (!inside(root, canonical)) throw new Error("remote workspace path escapes the approved root");
  if (opened.size > maximum) throw new Error("remote workspace file exceeds the read limit");
  return opened;
}

function readBoundedRegularFile(root: string, target: string, maximum: number): { body: Buffer; mode: number } {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(target, constants.O_RDONLY | noFollow);
  try {
    const metadata = assertOpenedRegularFile(root, target, descriptor, maximum);
    const body = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < body.byteLength) {
      const read = readSync(descriptor, body, offset, body.byteLength - offset, null);
      if (read === 0) break;
      offset += read;
    }
    assertOpenedRegularFile(root, target, descriptor, maximum);
    return { body: offset === body.byteLength ? body : body.subarray(0, offset), mode: metadata.mode & 0o777 };
  } finally {
    closeSync(descriptor);
  }
}

function assertStableWritableParent(root: string, target: string): void {
  const parent = dirname(target);
  assertNoSymlinkComponents(root, parent, true);
  const canonical = realpathSync(parent);
  if (!inside(root, canonical) || relative(parent, canonical) !== "") {
    throw new Error("remote workspace write parent changed during access");
  }
}

function assertApprovedRootIdentity(root: ApprovedRoot): void {
  const linked = lstatSync(root.path);
  const canonical = realpathSync(root.path);
  if (!linked.isDirectory() || linked.isSymbolicLink()
    || linked.dev !== root.dev || linked.ino !== root.ino
    || linked.birthtimeMs !== root.birthtimeMs
    || relative(root.path, canonical) !== "") {
    throw new Error("remote workspace approved root identity changed; pair the folder again");
  }
}

function assertWritePrecondition(root: string, target: string, expectedSha256: string | null): number {
  try {
    const current = readBoundedRegularFile(root, target, REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES);
    if (expectedSha256 === null || sha256(current.body) !== expectedSha256) {
      throw new Error("remote workspace file changed before write");
    }
    return current.mode;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    if (expectedSha256 !== null) throw new Error("remote workspace file is missing");
    return 0o600;
  }
}

export class RemoteWorkspaceExecutor {
  private readonly roots = new Map<string, ApprovedRoot>();
  private readonly maxOutputBytes: number;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RemoteWorkspaceExecutorOptions) {
    if (!options.deviceId || options.deviceId.length > 256) throw new Error("invalid remote workspace executor device ID");
    this.maxOutputBytes = options.maxOutputBytes ?? REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1024) {
      throw new Error("invalid remote workspace output limit");
    }
    for (const root of options.roots) {
      if (!root.id || root.id.length > 128 || this.roots.has(root.id)) throw new Error("invalid remote workspace root ID");
      const metadata = lstatSync(root.path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("remote workspace root must be a real directory");
      const canonical = realpathSync(root.path);
      const identity = lstatSync(canonical);
      this.roots.set(root.id, {
        id: root.id,
        path: canonical,
        dev: identity.dev,
        ino: identity.ino,
        birthtimeMs: identity.birthtimeMs,
      });
    }
    if (this.roots.size === 0) throw new Error("remote workspace executor needs one approved root");
  }

  async invoke(request: RemoteWorkspaceExecutionRequest, signal?: AbortSignal): Promise<RemoteWorkspaceToolResult> {
    if (request.executorDeviceId !== this.options.deviceId) {
      return { ok: false, error: "remote workspace executor identity mismatch" };
    }
    const root = this.roots.get(request.rootId);
    if (!root) return { ok: false, error: "remote workspace root is not approved" };
    if (!request.requestId || !request.sessionId) return { ok: false, error: "invalid remote workspace request identity" };
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>(resolvePromise => { release = resolvePromise; });
    await previous;
    try {
      if (signal?.aborted) throw new Error("remote workspace operation was cancelled");
      assertApprovedRootIdentity(root);
      switch (request.tool) {
        case "list_directory": return { ok: true, value: this.listDirectory(root, request.arguments) };
        case "read_file": return { ok: true, value: this.readFile(root, request.arguments) };
        case "write_file": return { ok: true, value: this.writeFile(root, request.arguments) };
        case "exec": return { ok: true, value: await this.exec(root, request.arguments, signal) };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "remote workspace operation failed" };
    } finally {
      release();
    }
  }

  private listDirectory(root: ApprovedRoot, input: unknown): unknown {
    const args = objectArguments(input);
    noExtraKeys(args, ["path"]);
    const target = resolveExisting(root.path, args.path ?? ".", this.options.platform);
    if (!statSync(target).isDirectory()) throw new Error("remote workspace list target is not a directory");
    const directory = opendirSync(target);
    const entries: Array<{ name: string; type: "directory" | "file" | "symlink" | "other" }> = [];
    try {
      while (true) {
        const entry = directory.readSync();
        if (!entry) break;
        if (entries.length >= 4096) throw new Error("remote workspace directory has too many entries");
        entries.push({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        });
      }
    } finally {
      directory.closeSync();
    }
    return {
      path: relative(root.path, target) || ".",
      entries,
    };
  }

  private readFile(root: ApprovedRoot, input: unknown): unknown {
    const args = objectArguments(input);
    noExtraKeys(args, ["path", "maxBytes"]);
    const target = resolveExisting(root.path, args.path, this.options.platform);
    const maxBytes = boundedInteger(args.maxBytes, REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES, 1, this.maxOutputBytes);
    const { body } = readBoundedRegularFile(root.path, target, maxBytes);
    return { path: relative(root.path, target), content: decodeUtf8(body), sha256: sha256(body), bytes: body.byteLength };
  }

  private writeFile(root: ApprovedRoot, input: unknown): unknown {
    const args = objectArguments(input);
    noExtraKeys(args, ["path", "content", "expectedSha256"]);
    if (typeof args.content !== "string") throw new Error("remote workspace file content must be text");
    const body = Buffer.from(args.content, "utf8");
    if (body.byteLength > REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES) throw new Error("remote workspace file exceeds the write limit");
    const expectedSha256 = args.expectedSha256;
    if (expectedSha256 !== null && (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256))) {
      throw new Error("invalid remote workspace expected file hash");
    }
    const target = resolveWritable(root.path, args.path, this.options.platform);
    const mode = assertWritePrecondition(root.path, target, expectedSha256);
    const temporary = resolve(dirname(target), `.${randomUUID()}.ocx-remote-write`);
    try {
      writeFileSync(temporary, body, { flag: "wx", mode });
      assertStableWritableParent(root.path, target);
      assertWritePrecondition(root.path, target, expectedSha256);
      renameAtomicFile(temporary, target, undefined, "remote-workspace");
    } finally {
      try { unlinkSync(temporary); } catch { /* committed or already absent */ }
    }
    return { path: relative(root.path, target), sha256: sha256(body), bytes: body.byteLength };
  }

  private async exec(root: ApprovedRoot, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.options.commandRunner) {
      throw new Error("remote workspace command runner is disabled until an OS sandbox is configured");
    }
    const args = objectArguments(input);
    noExtraKeys(args, ["command", "cwd", "timeoutMs"]);
    if (!Array.isArray(args.command) || args.command.length < 1 || args.command.length > 64) {
      throw new Error("invalid remote workspace command vector");
    }
    const command: string[] = [];
    for (const value of args.command) {
      if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value.includes("\0")) {
        throw new Error("invalid remote workspace command vector");
      }
      command.push(value);
    }
    if (command.reduce((total, value) => total + value.length, 0) > 16 * 1024) {
      throw new Error("remote workspace command vector is too large");
    }
    const cwd = resolveExisting(root.path, args.cwd ?? ".", this.options.platform);
    if (!statSync(cwd).isDirectory()) throw new Error("remote workspace command cwd is not a directory");
    const timeoutMs = boundedInteger(args.timeoutMs, 30_000, 1, 60_000);
    const result = await this.options.commandRunner.run({
      command,
      root: root.path,
      cwd,
      timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      signal,
    });
    const outputBytes = Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8");
    if (outputBytes > this.maxOutputBytes) {
      throw new Error("remote workspace command runner exceeded its output contract");
    }
    return { cwd: relative(root.path, cwd) || ".", ...result };
  }
}
