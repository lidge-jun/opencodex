import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { arch } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type {
  RemoteWorkspaceCommandRequest,
  RemoteWorkspaceCommandResult,
  RemoteWorkspaceCommandRunner,
} from "./workspace-executor";

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const NATIVE_HELPER_PROTOCOL_VERSION = 1;
const MAX_NATIVE_HELPER_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_HELPER_ERROR_CHARS = 512;
const MAX_NATIVE_HELPER_STDERR_BYTES = 16 * 1024;
const MAX_WORKSPACE_PREFLIGHT_ENTRIES = 250_000;
const SANDBOX_BUN_PATH = "/ocx-runtime/bin/bun";
const READABLE_SYSTEM_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
] as const;
const READABLE_ETC_PATHS = [
  "/etc/alternatives",
  "/etc/ca-certificates",
  "/etc/ssl",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/resolv.conf",
] as const;

export interface LinuxRemoteWorkspaceCommandRunnerOptions {
  bubblewrapPath?: string;
  networkAccess?: boolean;
  /** Additional read-only toolchain trees explicitly approved by the device owner. */
  toolchainRoots?: readonly string[];
  /** Exact Bun executable used by OCX; mounted as one file rather than exposing its host directory. */
  runtimeExecutablePath?: string;
  /** Writable roots inspected before command capability is advertised. */
  writableRoots?: readonly string[];
  spawn?: typeof Bun.spawn;
  /** Cross-platform test seam for the real namespace capability probe. */
  probe?: (argv: readonly string[]) => boolean;
}

export interface RemoteWorkspaceNativeHelperDescriptor {
  path: string;
  sha256: string;
}

interface NativeHelperRequest {
  version: typeof NATIVE_HELPER_PROTOCOL_VERSION;
  operation: "probe" | "run";
  root?: string;
  cwd?: string;
  command?: string[];
  toolchainRoots?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  networkAccess?: boolean;
}

interface NativeHelperProbeResponse {
  version: typeof NATIVE_HELPER_PROTOCOL_VERSION;
  ok: true;
  probe: true;
}

export interface NativeRemoteWorkspaceCommandRunnerOptions {
  helper: RemoteWorkspaceNativeHelperDescriptor;
  toolchainRoots?: readonly string[];
  /** Writable workspace roots that must never contain the executable enforcing their sandbox. */
  writableRoots: readonly string[];
  networkAccess?: boolean;
  platform?: NodeJS.Platform;
  spawn?: typeof Bun.spawn;
  spawnSync?: typeof Bun.spawnSync;
  /** Pure test seam. Production always executes the digest-pinned helper's real probe. */
  probe?: (request: NativeHelperRequest) => unknown;
}

const availabilityCache = new Map<string, boolean>();

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("remote workspace native helper returned an invalid response");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(record).some(key => !allowed.has(key))) {
    throw new Error("remote workspace native helper returned an invalid response");
  }
  return record;
}

function parseNativeHelperProbeResponse(value: unknown): NativeHelperProbeResponse {
  const raw = exactObject(value, ["version", "ok", "probe"]);
  if (raw.version !== NATIVE_HELPER_PROTOCOL_VERSION || raw.ok !== true || raw.probe !== true) {
    throw new Error("remote workspace native helper failed its confinement probe");
  }
  return { version: NATIVE_HELPER_PROTOCOL_VERSION, ok: true, probe: true };
}

function boundedBase64(value: unknown, label: string, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`remote workspace native helper returned invalid ${label}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maximum || decoded.toString("base64") !== value) {
    throw new Error(`remote workspace native helper returned invalid ${label}`);
  }
  return decoded;
}

function parseNativeHelperCommandResponse(value: unknown, maximum: number): RemoteWorkspaceCommandResult {
  const raw = exactObject(value, ["version", "ok", "exitCode", "stdoutBase64", "stderrBase64"]);
  if (raw.version !== NATIVE_HELPER_PROTOCOL_VERSION || raw.ok !== true
    || typeof raw.exitCode !== "number" || !Number.isSafeInteger(raw.exitCode)
    || raw.exitCode < -2_147_483_648 || raw.exitCode > 4_294_967_295) {
    throw new Error("remote workspace native helper returned an invalid command result");
  }
  const stdout = boundedBase64(raw.stdoutBase64, "stdout", maximum);
  const stderr = boundedBase64(raw.stderrBase64, "stderr", maximum);
  if (stdout.byteLength + stderr.byteLength > maximum) {
    throw new Error("remote workspace native helper exceeded its output contract");
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    exitCode: raw.exitCode,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}

function parseNativeHelperJson(value: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    throw new Error("remote workspace native helper returned malformed JSON");
  }
}

function sha256File(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_NATIVE_HELPER_BYTES) {
      throw new Error("remote workspace native helper has an invalid size");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < metadata.size) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.byteLength, metadata.size - offset), offset);
      if (count === 0) throw new Error("remote workspace native helper changed while hashing");
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs
      || after.dev !== metadata.dev || after.ino !== metadata.ino) {
      throw new Error("remote workspace native helper changed while hashing");
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

export function pinRemoteWorkspaceNativeHelper(path: string): RemoteWorkspaceNativeHelperDescriptor {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("remote workspace native helper must be an absolute path");
  }
  const linked = lstatSync(path);
  if (!linked.isFile() || linked.isSymbolicLink()) {
    throw new Error("remote workspace native helper must remain a real file");
  }
  const canonical = realpathSync(path);
  accessSync(canonical, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  if (process.platform !== "win32" && (statSync(canonical).mode & 0o022) !== 0) {
    throw new Error("remote workspace native helper must not be group or world writable");
  }
  return { path: canonical, sha256: sha256File(canonical) };
}

export function discoverRemoteWorkspaceNativeHelper(options: {
  platform?: NodeJS.Platform;
  architecture?: string;
} = {}): RemoteWorkspaceNativeHelperDescriptor | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return undefined;
  const architecture = options.architecture ?? arch();
  const executable = platform === "win32"
    ? "opencodex-remote-workspace-helper.exe"
    : "opencodex-remote-workspace-helper";
  const candidates = [
    // Signed release bundles place the helper here.
    `${import.meta.dir}/../../native-bin/${platform}-${architecture}/${executable}`,
    // Source/private-dogfood builds produced by `bun run build:remote-workspace-helper`.
    `${import.meta.dir}/../../native/remote-workspace-helper/target/release/${executable}`,
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return pinRemoteWorkspaceNativeHelper(candidate);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseRemoteWorkspaceNativeHelperDescriptor(value: unknown): RemoteWorkspaceNativeHelperDescriptor {
  const raw = exactObject(value, ["path", "sha256"]);
  if (typeof raw.path !== "string" || !isAbsolute(raw.path) || raw.path.includes("\0") || raw.path.length > 4096
    || typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    throw new Error("invalid remote workspace native helper descriptor");
  }
  return { path: raw.path, sha256: raw.sha256 };
}

function assertNativeHelperIntegrity(value: RemoteWorkspaceNativeHelperDescriptor): RemoteWorkspaceNativeHelperDescriptor {
  const helper = parseRemoteWorkspaceNativeHelperDescriptor(value);
  const linked = lstatSync(helper.path);
  if (!linked.isFile() || linked.isSymbolicLink() || realpathSync(helper.path) !== helper.path) {
    throw new Error("remote workspace native helper identity changed; pair it again");
  }
  accessSync(helper.path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  if (process.platform !== "win32" && (linked.mode & 0o022) !== 0) {
    throw new Error("remote workspace native helper permissions are unsafe");
  }
  if (sha256File(helper.path) !== helper.sha256) {
    throw new Error("remote workspace native helper digest changed; pair it again");
  }
  return helper;
}

function assertNativeHelperOutsideWritableRoots(
  helper: RemoteWorkspaceNativeHelperDescriptor,
  roots: readonly string[],
): string[] {
  if (roots.length < 1 || roots.length > 32) {
    throw new Error("remote workspace native runner needs one to 32 writable roots");
  }
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root) || root.includes("\0")) {
      throw new Error("remote workspace writable root must be an absolute path");
    }
    const canonicalRoot = realpathSync(root);
    if (canonicalRoots.includes(canonicalRoot)) {
      throw new Error("remote workspace native runner received a duplicate writable root");
    }
    if (inside(canonicalRoot, helper.path)) {
      // A sandboxed command can write anywhere below its approved root. Executing the sandbox
      // helper from that same tree would turn the hash-then-spawn pathname into a writable trust
      // anchor that a workspace command can replace before a later invocation.
      throw new Error("remote workspace native helper must be outside every writable workspace root");
    }
    canonicalRoots.push(canonicalRoot);
  }
  return canonicalRoots;
}

function nativeHelperEnvironment(platform: NodeJS.Platform): Record<string, string> {
  const result: Record<string, string> = {};
  const names = platform === "win32"
    ? ["SystemRoot", "WINDIR", "TEMP", "TMP"]
    : ["TMPDIR"];
  for (const name of names) {
    const value = process.env[name];
    if (value) result[name] = value;
  }
  return result;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertWorkspaceHasNoExternalHardlinkAliases(root: string): void {
  const canonicalRoot = realpathSync(root);
  const pending = [canonicalRoot];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const directory = opendirSync(current);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        entries += 1;
        if (entries > MAX_WORKSPACE_PREFLIGHT_ENTRIES) {
          throw new Error("remote workspace is too large for safe command preflight");
        }
        const target = join(current, entry.name);
        const metadata = lstatSync(target);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          pending.push(target);
        } else if (!metadata.isDirectory() && metadata.nlink > 1) {
          // A bind mount or Seatbelt path rule cannot distinguish two names for one inode. Reject
          // rather than let a workspace alias read or mutate a file whose other name is outside.
          throw new Error("remote workspace command root contains a hard-linked file");
        }
      }
    } finally {
      directory.closeSync();
    }
  }
}

function assertCommandRootsSafe(roots: readonly string[]): void {
  for (const root of roots) assertWorkspaceHasNoExternalHardlinkAliases(root);
}

function sandboxPath(root: string, cwd: string): string {
  if (!inside(root, cwd)) throw new Error("remote workspace command cwd escaped its root");
  const rel = relative(root, cwd);
  return rel ? `/workspace/${rel.split(sep).join("/")}` : "/workspace";
}

function bindArgs(flag: "--ro-bind" | "--ro-bind-try", paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const path of paths) {
    if (flag === "--ro-bind-try" || existsSync(path)) result.push(flag, path, path);
  }
  return result;
}

function approvedToolchainRoots(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!isAbsolute(value) || !existsSync(value) || value.includes("\0")) {
      throw new Error("remote workspace toolchain root must be an existing absolute path");
    }
    const metadata = lstatSync(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("remote workspace toolchain root must remain a real directory");
    }
    result.push(realpathSync(value));
  }
  return [...new Set(result)];
}

function approvedRuntimeExecutable(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error("remote workspace runtime executable must be an absolute path");
  }
  const canonical = realpathSync(value);
  if (!statSync(canonical).isFile()) throw new Error("remote workspace runtime executable must be a file");
  accessSync(canonical, constants.X_OK);
  return canonical;
}

export function linuxRemoteWorkspaceCommandArgv(
  request: RemoteWorkspaceCommandRequest,
  options: LinuxRemoteWorkspaceCommandRunnerOptions = {},
): string[] {
  const bubblewrap = options.bubblewrapPath ?? "/usr/bin/bwrap";
  if (!isAbsolute(bubblewrap) || !existsSync(bubblewrap)) {
    throw new Error("bubblewrap is required for remote workspace command execution on Linux");
  }
  const toolchains = approvedToolchainRoots(options.toolchainRoots ?? []);
  const runtimeExecutable = approvedRuntimeExecutable(options.runtimeExecutablePath);
  const commandPath = [...(runtimeExecutable ? ["/ocx-runtime/bin"] : []), ...toolchains, DEFAULT_PATH].join(":");
  return [
    bubblewrap,
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(options.networkAccess === true ? [] : ["--unshare-net"]),
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    ...(runtimeExecutable ? [
      "--dir", "/ocx-runtime",
      "--dir", "/ocx-runtime/bin",
      "--ro-bind", runtimeExecutable, SANDBOX_BUN_PATH,
    ] : []),
    ...bindArgs("--ro-bind", READABLE_SYSTEM_PATHS),
    ...bindArgs("--ro-bind-try", READABLE_ETC_PATHS),
    ...toolchains.flatMap(path => ["--ro-bind", path, path]),
    "--bind", request.root, "/workspace",
    "--chdir", sandboxPath(request.root, request.cwd),
    "--clearenv",
    "--setenv", "HOME", "/workspace",
    "--setenv", "PATH", commandPath,
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--",
    ...request.command,
  ];
}

async function collectBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  reserve: (bytes: number) => boolean,
  onOverflow: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!reserve(next.value.byteLength)) {
        onOverflow();
        throw new Error("remote workspace command output limit exceeded");
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

export function createLinuxRemoteWorkspaceCommandRunner(
  options: LinuxRemoteWorkspaceCommandRunnerOptions = {},
): RemoteWorkspaceCommandRunner {
  const spawn = options.spawn ?? Bun.spawn;
  return {
    async run(request): Promise<RemoteWorkspaceCommandResult> {
      assertWorkspaceHasNoExternalHardlinkAliases(request.root);
      const argv = linuxRemoteWorkspaceCommandArgv(request, options);
      const child = spawn(argv, {
        cwd: request.root,
        env: { PATH: DEFAULT_PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let retained = 0;
      let timedOut = false;
      let overflowed = false;
      let cancelled = false;
      const stop = () => {
        try { child.kill(); } catch { /* process already exited */ }
      };
      const cancel = () => {
        cancelled = true;
        stop();
      };
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();
      const reserve = (bytes: number): boolean => {
        if (retained + bytes > request.maxOutputBytes) {
          overflowed = true;
          return false;
        }
        retained += bytes;
        return true;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
      try {
        const [stdoutResult, stderrResult, exitCode] = await Promise.allSettled([
          collectBoundedOutput(child.stdout, reserve, stop),
          collectBoundedOutput(child.stderr, reserve, stop),
          child.exited,
        ]);
        if (cancelled) throw new Error("remote workspace command was cancelled");
        if (timedOut) throw new Error("remote workspace command timed out");
        if (overflowed) throw new Error("remote workspace command output limit exceeded");
        if (stdoutResult.status === "rejected") throw stdoutResult.reason;
        if (stderrResult.status === "rejected") throw stderrResult.reason;
        if (exitCode.status === "rejected") throw exitCode.reason;
        return { exitCode: exitCode.value, stdout: stdoutResult.value, stderr: stderrResult.value };
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
      }
    },
  };
}

function nativeHelperFailure(value: unknown): Error {
  const raw = exactObject(value, ["version", "ok", "error"]);
  if (raw.version !== NATIVE_HELPER_PROTOCOL_VERSION || raw.ok !== false
    || typeof raw.error !== "string" || raw.error.length < 1
    || [...raw.error].length > MAX_NATIVE_HELPER_ERROR_CHARS || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw.error)) {
    return new Error("remote workspace native helper returned an invalid failure");
  }
  return new Error(raw.error);
}

function nativeHelperRequest(options: NativeRemoteWorkspaceCommandRunnerOptions, request: RemoteWorkspaceCommandRequest): NativeHelperRequest {
  return {
    version: NATIVE_HELPER_PROTOCOL_VERSION,
    operation: "run",
    root: request.root,
    cwd: request.cwd,
    command: [...request.command],
    toolchainRoots: approvedToolchainRoots(options.toolchainRoots ?? []),
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
    networkAccess: options.networkAccess === true,
  };
}

export function createNativeRemoteWorkspaceCommandRunner(
  options: NativeRemoteWorkspaceCommandRunnerOptions,
): RemoteWorkspaceCommandRunner {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("remote workspace native command helper is supported only on macOS and Windows");
  }
  if (!nativeRemoteWorkspaceCommandRunnerAvailable(options)) {
    throw new Error("remote workspace native command helper failed its confinement probe");
  }
  const spawn = options.spawn ?? Bun.spawn;
  return {
    async run(request): Promise<RemoteWorkspaceCommandResult> {
      const helper = assertNativeHelperIntegrity(options.helper);
      const writableRoots = assertNativeHelperOutsideWritableRoots(helper, options.writableRoots);
      const requestRoot = realpathSync(request.root);
      if (!writableRoots.includes(requestRoot)) {
        throw new Error("remote workspace command root is outside the native runner grant");
      }
      assertWorkspaceHasNoExternalHardlinkAliases(requestRoot);
      const body = JSON.stringify(nativeHelperRequest(options, request));
      if (Buffer.byteLength(body, "utf8") > 64 * 1024) {
        throw new Error("remote workspace native helper request is too large");
      }
      const child = spawn([helper.path], {
        cwd: request.root,
        env: nativeHelperEnvironment(platform),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      let retained = 0;
      let overflowed = false;
      let cancelled = false;
      let timedOut = false;
      const stop = () => {
        try { child.kill(); } catch { /* helper already exited */ }
      };
      const cancel = () => {
        cancelled = true;
        stop();
      };
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();
      const maximumResponseBytes = Math.ceil(request.maxOutputBytes / 3) * 4 + 4_096;
      const reserve = (bytes: number): boolean => {
        if (retained + bytes > maximumResponseBytes + MAX_NATIVE_HELPER_STDERR_BYTES) {
          overflowed = true;
          return false;
        }
        retained += bytes;
        return true;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs + 2_000);
      try {
        if (!cancelled) {
          child.stdin.write(body);
          child.stdin.end();
        }
        const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
          collectBoundedOutput(child.stdout, reserve, stop),
          collectBoundedOutput(child.stderr, reserve, stop),
          child.exited,
        ]);
        if (cancelled) throw new Error("remote workspace command was cancelled");
        if (timedOut) throw new Error("remote workspace native helper timed out");
        if (overflowed) throw new Error("remote workspace native helper output limit exceeded");
        if (stdoutResult.status === "rejected" || stderrResult.status === "rejected" || exitResult.status === "rejected") {
          throw new Error("remote workspace native helper failed");
        }
        if (Buffer.byteLength(stdoutResult.value, "utf8") > maximumResponseBytes
          || Buffer.byteLength(stderrResult.value, "utf8") > MAX_NATIVE_HELPER_STDERR_BYTES
          || exitResult.value !== 0) {
          throw new Error("remote workspace native helper failed");
        }
        const response = parseNativeHelperJson(Buffer.from(stdoutResult.value, "utf8"));
        if (response && typeof response === "object" && !Array.isArray(response)
          && (response as Record<string, unknown>).ok === false) {
          throw nativeHelperFailure(response);
        }
        return parseNativeHelperCommandResponse(response, request.maxOutputBytes);
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
        try { child.stdin.end(); } catch { /* helper already closed stdin */ }
      }
    },
  };
}

export function nativeRemoteWorkspaceCommandRunnerAvailable(
  options: NativeRemoteWorkspaceCommandRunnerOptions,
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return false;
  try {
    const helper = assertNativeHelperIntegrity(options.helper);
    const writableRoots = assertNativeHelperOutsideWritableRoots(helper, options.writableRoots);
    assertCommandRootsSafe(writableRoots);
    const request: NativeHelperRequest = { version: NATIVE_HELPER_PROTOCOL_VERSION, operation: "probe" };
    const raw = options.probe
      ? options.probe(request)
      : (() => {
        const result = (options.spawnSync ?? Bun.spawnSync)([helper.path], {
          cwd: dirname(helper.path),
          env: nativeHelperEnvironment(platform),
          stdin: Buffer.from(JSON.stringify(request), "utf8"),
          stdout: "pipe",
          stderr: "ignore",
          timeout: 8_000,
          windowsHide: true,
        });
        if (!result.success || result.stdout.byteLength > 4_096) {
          throw new Error("remote workspace native helper probe failed");
        }
        return parseNativeHelperJson(result.stdout);
      })();
    parseNativeHelperProbeResponse(raw);
    return true;
  } catch {
    return false;
  }
}

export function createPlatformRemoteWorkspaceCommandRunner(options: {
  platform?: NodeJS.Platform;
  linux?: LinuxRemoteWorkspaceCommandRunnerOptions;
  native?: Omit<NativeRemoteWorkspaceCommandRunnerOptions, "platform">;
} = {}): RemoteWorkspaceCommandRunner | undefined {
  const platform = options.platform ?? process.platform;
  if (platform === "linux" && linuxRemoteWorkspaceCommandRunnerAvailable(options.linux)) {
    const linux = {
      ...options.linux,
      runtimeExecutablePath: options.linux?.runtimeExecutablePath ?? process.execPath,
    };
    return createLinuxRemoteWorkspaceCommandRunner(linux);
  }
  if ((platform === "darwin" || platform === "win32") && options.native) {
    const native = { ...options.native, platform };
    try {
      return createNativeRemoteWorkspaceCommandRunner(native);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function linuxRemoteWorkspaceCommandRunnerAvailable(
  options: LinuxRemoteWorkspaceCommandRunnerOptions = {},
): boolean {
  const path = options.bubblewrapPath ?? "/usr/bin/bwrap";
  if (!isAbsolute(path) || !existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    if (options.writableRoots) assertCommandRootsSafe(options.writableRoots);
  } catch {
    return false;
  }
  const argv = [
    path,
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(options.networkAccess === true ? [] : ["--unshare-net"]),
    "--proc", "/proc",
    "--dev", "/dev",
    ...bindArgs("--ro-bind", READABLE_SYSTEM_PATHS),
    "--",
    "/bin/true",
  ];
  if (options.probe) return options.probe(argv);
  const cacheKey = `${path}\0${options.networkAccess === true ? "network" : "isolated"}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    available = Bun.spawnSync(argv, {
      env: { PATH: DEFAULT_PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 2_000,
    }).success;
  } catch {
    available = false;
  }
  availabilityCache.set(cacheKey, available);
  return available;
}

/**
 * [Decision Log]
 * - 목적과 의도: An OCX-only executor must run builds inside the selected workspace without
 *   exposing the rest of that computer's home or coding-agent credentials.
 * - 기존 구현 및 제약 조건: Merely setting cwd does not confine an arbitrary command; Windows
 *   and macOS need native helpers before they can make the same guarantee.
 * - 검토한 주요 대안: Direct Bun.spawn, a full read-only host bind, Docker, and bubblewrap with
 *   a minimal system/toolchain view, plus cwd-only Windows/macOS subprocesses.
 * - 선택한 방식: Linux uses bubblewrap. macOS and Windows use a separately built, digest-pinned
 *   Rust helper with Seatbelt or AppContainer plus a kill-on-close Job Object. Every native helper
 *   must pass a real write/read/network escape probe before OCX advertises command capability.
 * - 다른 대안 대신 이 방식을 선택한 이유: It is rootless, starts per command, keeps project
 *   writes local to the executor, and fails closed instead of claiming cwd is a sandbox.
 * - 장점, 단점 및 영향: Builds run on all three desktop OS families without installing the model
 *   CLI on the Executor. A missing, replaced, or policy-blocked helper degrades to file tools only.
 */
