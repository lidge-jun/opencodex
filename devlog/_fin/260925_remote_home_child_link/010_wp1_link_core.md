# 010 — wp1: `src/link/` 순수 모듈 (L1, 브랜치 codex/remote-link-1-core, base dev)

상위 문서: 000_prd.md(r2), 001_stack_plan.md, 002_arch_plan.md(AR-1..AR-4, 감사 처분), 003_decisions.md(K3).

## 범위

IN: 새 파일 `src/link/{paths,ssh-argv,ssh-config,tunnel-state,store}.ts`, 테스트 `tests/clients/link-{ssh-argv,ssh-config,tunnel-state,store,boundary}.test.ts`, 테스트 배치 등록 2곳, `structure/remote-link.md` + manifest + 생성 INDEX, 이 유닛 문서.
OUT: 서버·CLI·GUI 연결, 프로세스 실행, 타이머. 이 레이어의 모듈은 import해도 아무 프로세스나 타이머를 시작하지 않는다.

## 파일 변경 지도

| 경로 | 종류 | 내용 |
|---|---|---|
| src/link/paths.ts | NEW | 링크 디렉터리·저장소·known_hosts 경로 |
| src/link/ssh-argv.ts | NEW | tunnel/exec/probe/resolve argv, 별칭 검증, 원격 인자 인용 |
| src/link/ssh-config.ts | NEW | ssh_config Host 후보 파서와 로더 |
| src/link/tunnel-state.ts | NEW | 터널 상태 리듀서, 백오프, stderr 분류 |
| src/link/store.ts | NEW | links.json 읽기·쓰기·검증, hasLinks 게이트 |
| tests/clients/link-*.test.ts | NEW | 아래 테스트 사례 |
| scripts/test-layout/layout.json | MODIFY | `explicit`에 5개 파일 → "clients" |
| tests/fixtures/test-layout-expected.json | MODIFY | 같은 5개 → "clients" |
| structure/remote-link.md | NEW | 현재형 계약 문서 |
| structure/manifest.json | MODIFY | docs 배열에 remote-link.md(tier 3, documents ["src/link/"]) 추가, remote-workspace.md 다음 |
| structure/INDEX.md | 생성 | `bun run structure:index` |

## 새 파일 전체 내용

아래 코드는 wp0 중 이 워크트리에 임시로 두고 `bun run typecheck` exit 0을 확인한 초안이다(2026-09-25, 이전 증거). 문서 사이클을 위해 작업 트리에서 뺐으므로 wp1 B에서 다시 검증한다.

### src/link/paths.ts

```ts
import { join } from "node:path";
// Definition-site import, not the ../config barrel: the link modules stay small and load nothing
// from the server or the config loader.
import { getConfigDir } from "../config/paths";

/** Directory that holds link state: `<configDir>/link`, created with mode 0700 on first write. */
export function linkDir(configDir: string = getConfigDir()): string {
  return join(configDir, "link");
}

/** Link records. Holds no secrets: data keys stay in the running proxy's `apiKeys`. */
export function linkStorePath(configDir?: string): string {
  return join(linkDir(configDir), "links.json");
}

/** The only known_hosts file link SSH commands trust. Entries are keyed by host alias. */
export function linkKnownHostsPath(configDir?: string): string {
  return join(linkDir(configDir), "known_hosts");
}
```

### src/link/ssh-argv.ts

```ts
/**
 * Argument vectors for the system OpenSSH client used by machine links.
 *
 * Every command is built here so the security-relevant options live in one place:
 * - BatchMode=yes: no password or passphrase prompt, keys and agents only.
 * - HostKeyAlias=<alias> with UserKnownHostsFile=<link known_hosts> and
 *   GlobalKnownHostsFile=none: only a host key the user confirmed for this link is trusted,
 *   and the stored entry has the same form for every port and ProxyJump route.
 * - KnownHostsCommand=none, VerifyHostKeyDNS=no and CheckHostIP=no: no other source of host-key
 *   trust (a helper command, DNS SSHFP records, IP entries) can stand in for the link file.
 *   Command-line options win over ~/.ssh/config, so a user config cannot re-enable them.
 * - Tunnel and exec commands use StrictHostKeyChecking=yes. Only the probe uses accept-new,
 *   against an empty temporary file, so the key it records can be shown to the user first.
 * - Forwards always bind 127.0.0.1 on both ends.
 */

import { isAbsolute } from "node:path";

export type TunnelDirection = "R" | "L";

const ALIAS_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._@%+:\[\]-]{0,252}$/;

export class LinkSshArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkSshArgumentError";
  }
}

/** A host alias as ssh reads it. A leading "-" would be parsed as an option, so it is refused. */
export function isSshAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}

export function assertSshAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) throw new LinkSshArgumentError(`invalid ssh host alias: ${JSON.stringify(alias)}`);
  return alias;
}

function assertPort(port: number, label: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LinkSshArgumentError(`${label} must be an integer port between 1 and 65535`);
  }
  return port;
}

/**
 * ssh splits `-o` values on whitespace, expands `%` tokens, `${ENV}` and a leading `~` in
 * UserKnownHostsFile, treats the value `none` as "no file" and resolves a relative path against
 * its working directory. Any of those could name a different file than the one written, so only
 * an absolute path without expansion syntax is accepted; whitespace is quoted.
 */
function optionPath(path: string): string {
  if (!path || !isAbsolute(path) || /["%$\x00-\x1f]/.test(path) || path.startsWith("~")) {
    throw new LinkSshArgumentError("known_hosts path is not usable in an ssh option");
  }
  return /\s/.test(path) ? `"${path}"` : path;
}

function commonOptions(alias: string, knownHostsFile: string, strict: "yes" | "accept-new"): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", `StrictHostKeyChecking=${strict}`,
    "-o", `HostKeyAlias=${alias}`,
    "-o", `UserKnownHostsFile=${optionPath(knownHostsFile)}`,
    "-o", "GlobalKnownHostsFile=none",
    "-o", "KnownHostsCommand=none",
    "-o", "VerifyHostKeyDNS=no",
    "-o", "CheckHostIP=no",
    "-o", "UpdateHostKeys=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "PermitLocalCommand=no",
    "-o", "LogLevel=ERROR",
  ];
}

export interface TunnelArgvOptions {
  alias: string;
  /** "R": listen on the remote host and reach this host. "L": listen here and reach the remote host. */
  direction: TunnelDirection;
  /** Port the forward listens on (remote for "R", local for "L"). */
  bindPort: number;
  /** Port the forward connects to on the other side's 127.0.0.1. */
  targetPort: number;
  knownHostsFile: string;
}

export function buildTunnelArgv(options: TunnelArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  const bind = assertPort(options.bindPort, "bindPort");
  const target = assertPort(options.targetPort, "targetPort");
  if (options.direction !== "R" && options.direction !== "L") throw new LinkSshArgumentError("direction must be R or L");
  return [
    "ssh", "-N", "-T",
    ...commonOptions(alias, options.knownHostsFile, "yes"),
    "-o", "ExitOnForwardFailure=yes",
    `-${options.direction}`, `127.0.0.1:${bind}:127.0.0.1:${target}`,
    "--", alias,
  ];
}

export interface ExecArgvOptions {
  alias: string;
  /** Remote argv. Each element is quoted for the remote POSIX shell. */
  argv: readonly string[];
  knownHostsFile: string;
}

export function buildExecArgv(options: ExecArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  if (options.argv.length === 0) throw new LinkSshArgumentError("remote argv must not be empty");
  return [
    "ssh", "-T",
    ...commonOptions(alias, options.knownHostsFile, "yes"),
    "-o", "ClearAllForwardings=yes",
    "--", alias,
    quoteRemote(options.argv),
  ];
}

export interface ProbeArgvOptions {
  alias: string;
  /** An empty, private, temporary file. The probe records the offered host key here. */
  tempKnownHostsFile: string;
}

/**
 * First contact with a host that has no confirmed key. accept-new writes the offered key to the
 * temporary file; the caller reads it with `ssh-keygen -lf` and shows the fingerprint before
 * anything is trusted. The remote command is `true` and its result is not trusted either.
 */
export function buildProbeArgv(options: ProbeArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  return [
    "ssh", "-T",
    ...commonOptions(alias, options.tempKnownHostsFile, "accept-new"),
    "-o", "ClearAllForwardings=yes",
    "--", alias,
    "true",
  ];
}

/** `ssh -G <alias>`: resolve an alias the same way ssh itself does, without connecting. */
export function buildResolveArgv(alias: string): string[] {
  return ["ssh", "-G", "--", assertSshAlias(alias)];
}

/** Quote argv for a POSIX remote shell: every element single-quoted, embedded quotes escaped. */
export function quoteRemote(argv: readonly string[]): string {
  return argv.map(arg => {
    if (arg.includes("\0")) throw new LinkSshArgumentError("remote argument contains NUL");
    return `'${arg.replaceAll("'", `'"'"'`)}'`;
  }).join(" ");
}
```

### src/link/ssh-config.ts

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSshAlias } from "./ssh-argv";

/**
 * Host candidates from OpenSSH client configuration.
 *
 * Candidates are offers, not trust: a host is usable only after a probe proves key login and the
 * user confirms its host key. Patterns (`*`, `?`, `!`) and `Match` blocks name no single host,
 * so they are skipped. An `Include` inside a `Host` or `Match` block applies only under that
 * block's condition, so only top-level includes are followed.
 */
export interface HostCandidate {
  alias: string;
  source: "ssh_config";
}

export interface ParseHostCandidatesOptions {
  /** Contents of every file an `Include` pattern names, in order. */
  resolveInclude?: (pattern: string) => string[];
  /** Include nesting limit; OpenSSH uses 16. */
  maxDepth?: number;
}

/**
 * Split arguments exactly the way OpenSSH's argv_split (misc.c) does when readconf calls it with
 * terminate_on_comment set:
 * - blanks and tabs separate arguments; an unquoted `#` at the start of an argument ends the line;
 * - a backslash before `'`, `"` or `\\` — or, outside quotes, before a space — yields that
 *   character; any other backslash (including a trailing one) is kept literally;
 * - single or double quotes group, and the backslash rule above applies inside them too.
 * Returns null for an unterminated quote, which OpenSSH rejects as an invalid line.
 */
export function splitSshArgs(text: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const lead = text[i];
    if (lead === " " || lead === "\t") { i += 1; continue; }
    if (lead === "#") break;
    let arg = "";
    let quote: "'" | '"' | null = null;
    for (; i < text.length; i += 1) {
      const ch = text[i]!;
      const next = text[i + 1];
      if (ch === "\\") {
        if (next === "'" || next === '"' || next === "\\" || (quote === null && next === " ")) {
          i += 1;
          arg += next;
        } else {
          arg += ch;
        }
      } else if (quote === null && (ch === " " || ch === "\t")) {
        break;
      } else if (quote === null && (ch === '"' || ch === "'")) {
        quote = ch;
      } else if (quote !== null && ch === quote) {
        quote = null;
      } else {
        arg += ch;
      }
    }
    if (quote !== null) return null;
    out.push(arg);
  }
  return out;
}

function splitDirective(raw: string): { keyword: string; args: string[] } | null {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  const match = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!match) return null;
  const args = splitSshArgs(match[2]!);
  if (!args) return null;
  return { keyword: match[1]!.toLowerCase(), args };
}

export function parseHostCandidates(text: string, options: ParseHostCandidatesOptions = {}): HostCandidate[] {
  const seen = new Set<string>();
  const out: HostCandidate[] = [];
  const maxDepth = options.maxDepth ?? 16;
  const visit = (body: string, depth: number): void => {
    let block: "top" | "host" | "match" = "top";
    for (const raw of body.split(/\r?\n/)) {
      const directive = splitDirective(raw);
      if (!directive) continue;
      if (directive.keyword === "match") { block = "match"; continue; }
      if (directive.keyword === "include") {
        if (block !== "top" || depth >= maxDepth || !options.resolveInclude) continue;
        for (const pattern of directive.args) {
          for (const included of options.resolveInclude(pattern)) visit(included, depth + 1);
        }
        continue;
      }
      if (directive.keyword !== "host") continue;
      block = "host";
      for (const alias of directive.args) {
        if (/[*?!]/.test(alias) || !isSshAlias(alias)) continue;
        const key = alias.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ alias, source: "ssh_config" });
      }
    }
  };
  visit(text, 0);
  return out;
}

export interface LoadHostCandidatesOptions {
  /** Home directory whose `.ssh/config` is read. Defaults to the user's home. */
  home?: string;
  readFile?: (path: string) => string;
  /** Expand one absolute glob pattern to file paths. */
  glob?: (pattern: string) => string[];
}

function defaultGlob(pattern: string): string[] {
  if (!/[*?[]/.test(pattern)) return [pattern];
  const base = dirname(pattern.slice(0, pattern.search(/[*?[]/) + 1));
  const relative = pattern.slice(base.length + 1);
  return [...new Bun.Glob(relative).scanSync({ cwd: base, absolute: true, onlyFiles: true })].sort();
}

/**
 * Read `~/.ssh/config` and its includes. A missing or unreadable file yields no candidates.
 * Include patterns support a leading `~/`, absolute and `~/.ssh`-relative paths and globs;
 * `~user`, environment variables and `%` tokens are not expanded, so such an include adds no
 * candidates (the host can still be entered by hand).
 */
export function loadHostCandidates(options: LoadHostCandidatesOptions = {}): HostCandidate[] {
  const home = options.home ?? homedir();
  const sshDir = join(home, ".ssh");
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const glob = options.glob ?? defaultGlob;
  const safeRead = (path: string): string | null => {
    try { return read(path); } catch { return null; }
  };
  const root = safeRead(join(sshDir, "config"));
  if (root === null) return [];
  return parseHostCandidates(root, {
    resolveInclude: pattern => {
      const expanded = pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern;
      const absolute = isAbsolute(expanded) ? expanded : resolve(sshDir, expanded);
      let paths: string[];
      try { paths = glob(absolute); } catch { return []; }
      return paths.map(safeRead).filter((body): body is string => body !== null);
    },
  });
}
```

### src/link/tunnel-state.ts

```ts
/**
 * Lifecycle of one link tunnel as a pure reducer. The supervisor that spawns ssh feeds events in
 * and reads decisions out; nothing here touches a process, a timer or the clock.
 *
 * - connected: the forward is up.
 * - reconnecting: a transient failure; requests through the link fail with 503 meanwhile, and a
 *   new attempt is due at `retryAt`.
 * - failed: needs the user. Auth, host key and forward failures are not retried, and neither is a
 *   link that stayed down for FAILED_AFTER_MS.
 */

export type TunnelFailure = "auth" | "hostkey" | "forward" | "timeout";
export type StderrClass = "auth" | "hostkey" | "forward" | "network" | "unknown";

export type TunnelState =
  | { kind: "idle" }
  | { kind: "connecting"; since: number }
  | { kind: "connected"; since: number }
  | { kind: "reconnecting"; since: number; attempt: number; retryAt: number; inFlight: boolean }
  | { kind: "failed"; since: number; reason: TunnelFailure };

export type TunnelEvent =
  | { type: "spawn"; now: number }
  | { type: "ready"; now: number }
  | { type: "exit"; now: number; stderrClass: StderrClass }
  | { type: "tick"; now: number }
  | { type: "stop" };

export const FAILED_AFTER_MS = 5 * 60_000;
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 30_000;

export const IDLE: TunnelState = { kind: "idle" };

/** Capped exponential backoff with ±20% jitter. `random` is injectable for tests. */
export function nextDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(MAX_DELAY_MS, base * jitter));
}

export function reduceTunnel(state: TunnelState, event: TunnelEvent, random?: () => number): TunnelState {
  if (event.type === "stop") return IDLE;
  switch (event.type) {
    case "spawn":
      if (state.kind === "idle" || state.kind === "failed") return { kind: "connecting", since: event.now };
      if (state.kind === "reconnecting") return { ...state, inFlight: true };
      return state;
    case "ready":
      if (state.kind === "connecting" || state.kind === "reconnecting") return { kind: "connected", since: event.now };
      return state;
    case "exit": {
      if (state.kind === "idle" || state.kind === "failed") return state;
      const cls = event.stderrClass;
      if (cls === "auth" || cls === "hostkey" || cls === "forward") return { kind: "failed", since: event.now, reason: cls };
      const since = state.kind === "reconnecting" || state.kind === "connecting" ? state.since : event.now;
      if (event.now - since >= FAILED_AFTER_MS) return { kind: "failed", since: event.now, reason: "timeout" };
      const attempt = state.kind === "reconnecting" ? state.attempt + 1 : 1;
      return { kind: "reconnecting", since, attempt, retryAt: event.now + nextDelayMs(attempt, random), inFlight: false };
    }
    case "tick":
      // An attempt in flight does not pause the clock: a first attempt or a retry that hangs past
      // the limit still fails the link, and the supervisor kills the child on seeing `failed`.
      if ((state.kind === "reconnecting" || state.kind === "connecting") && event.now - state.since >= FAILED_AFTER_MS) {
        return { kind: "failed", since: event.now, reason: "timeout" };
      }
      return state;
  }
}

/** Whether the supervisor should start a new ssh attempt now. */
export function dueForSpawn(state: TunnelState, now: number): boolean {
  return state.kind === "reconnecting" && !state.inFlight && now >= state.retryAt;
}

/** Classify ssh stderr. Anything unrecognised is treated as transient. */
export function classifySshStderr(stderr: string): StderrClass {
  const text = stderr.toLowerCase();
  if (text.includes("host key verification failed") || text.includes("remote host identification has changed")
    || text.includes("no ecdsa host key is known") || text.includes("no ed25519 host key is known")
    || text.includes("no rsa host key is known") || text.includes("host key is known for")) return "hostkey";
  if (text.includes("permission denied") || text.includes("too many authentication failures")) return "auth";
  if (text.includes("remote port forwarding failed") || text.includes("port forwarding failed")
    || text.includes("address already in use") || text.includes("cannot listen to port")
    || text.includes("could not request local forwarding")) return "forward";
  if (text.includes("connection refused") || text.includes("timed out") || text.includes("could not resolve")
    || text.includes("network is unreachable") || text.includes("connection closed") || text.includes("broken pipe")
    || text.includes("connection reset") || text.includes("no route to host")) return "network";
  return "unknown";
}
```

### src/link/store.ts

```ts
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { assertSshAlias } from "./ssh-argv";

/**
 * Persisted machine links. The file names hosts, ports, host-key fingerprints and data-key ids.
 * It never holds a key: keys live in the running proxy's `apiKeys`, and admission reads them there.
 */
export type LinkDirection = "hub-initiated" | "client-initiated";

export interface LinkRecord {
  id: string;
  alias: string;
  direction: LinkDirection;
  /**
   * `ssh-keygen -lf` fingerprint the user confirmed for the client host, e.g. "SHA256:…".
   * Null only for client-initiated links: the hub never opens SSH to that client.
   */
  hostKeyFingerprint: string | null;
  /** Port the tunnel listens on at the client machine's 127.0.0.1. */
  tunnelPort: number;
  /** Id of the data key issued for this link. */
  apiKeyId: string;
  createdAt: string;
}

export interface LinkStore {
  version: 1;
  /** Port of the link listener at this machine's 127.0.0.1, fixed once chosen. */
  listenerPort: number | null;
  links: LinkRecord[];
}

export class LinkStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkStoreError";
  }
}

export function emptyLinkStore(): LinkStore {
  return { version: 1, listenerPort: null, links: [] };
}

export function newLinkId(): string {
  return `lnk_${randomBytes(8).toString("hex")}`;
}

const RECORD_KEYS = new Set(["id", "alias", "direction", "hostKeyFingerprint", "tunnelPort", "apiKeyId", "createdAt"]);
const STORE_KEYS = new Set(["version", "listenerPort", "links"]);
const API_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const FINGERPRINT = /^[A-Z0-9]+:[A-Za-z0-9+/=]{16,128}$/;

/** A trust-boundary file: an unknown field is an error, not something to drop silently. */
function assertOnlyKeys(raw: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new LinkStoreError(`${where} has an unknown field ${JSON.stringify(key)}`);
  }
}

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;

function parseRecord(value: unknown, index: number): LinkRecord {
  const fail = (field: string): never => { throw new LinkStoreError(`links[${index}].${field} is invalid`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LinkStoreError(`links[${index}] is not an object`);
  const raw = value as Record<string, unknown>;
  assertOnlyKeys(raw, RECORD_KEYS, `links[${index}]`);
  if (typeof raw.id !== "string" || !/^lnk_[0-9a-f]{16}$/.test(raw.id)) fail("id");
  if (typeof raw.alias !== "string") fail("alias");
  try { assertSshAlias(raw.alias as string); } catch { fail("alias"); }
  if (raw.direction !== "hub-initiated" && raw.direction !== "client-initiated") fail("direction");
  const fingerprint = raw.hostKeyFingerprint;
  if (fingerprint === null ? raw.direction !== "client-initiated"
    : typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) fail("hostKeyFingerprint");
  if (!isPort(raw.tunnelPort)) fail("tunnelPort");
  if (typeof raw.apiKeyId !== "string" || !API_KEY_ID.test(raw.apiKeyId)) fail("apiKeyId");
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) fail("createdAt");
  return {
    id: raw.id as string,
    alias: raw.alias as string,
    direction: raw.direction as LinkDirection,
    hostKeyFingerprint: fingerprint as string | null,
    tunnelPort: raw.tunnelPort as number,
    apiKeyId: raw.apiKeyId as string,
    createdAt: raw.createdAt as string,
  };
}

export function parseLinkStore(text: string): LinkStore {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new LinkStoreError("links.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LinkStoreError("links.json is not an object");
  const body = raw as Record<string, unknown>;
  assertOnlyKeys(body, STORE_KEYS, "links.json");
  if (body.version !== 1) throw new LinkStoreError("links.json has an unsupported version");
  if (body.listenerPort !== null && !isPort(body.listenerPort)) throw new LinkStoreError("listenerPort is invalid");
  if (!Array.isArray(body.links)) throw new LinkStoreError("links is not an array");
  const links = body.links.map(parseRecord);
  const ids = new Set(links.map(link => link.id));
  if (ids.size !== links.length) throw new LinkStoreError("links.json has duplicate link ids");
  return { version: 1, listenerPort: body.listenerPort as number | null, links };
}

/** A missing file is an empty store. A damaged file is an error, never silently empty. */
export function readLinkStore(path: string): LinkStore {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if (isMissingPathError(error)) return emptyLinkStore();
    throw error;
  }
  return parseLinkStore(text);
}

export function writeLinkStore(path: string, store: LinkStore): void {
  const normalized = parseLinkStore(JSON.stringify(store));
  const dir = dirname(path);
  assertNotRealHomeUnderTest(dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  // atomicWriteFile hardens its private temp on Windows before the rename, so only POSIX needs
  // the explicit mode here.
  atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/**
 * Activation gate for the link listener: true only for a readable store with at least one link.
 * A damaged store keeps the listener closed rather than guessing.
 */
export function hasLinks(path: string): boolean {
  try { return readLinkStore(path).links.length > 0; } catch { return false; }
}
```

## 테스트 사례 (tests/clients/)

모든 테스트는 `mkdtempSync` 임시 디렉터리와 합성 호스트 이름(`alpha.example.test` 등)만 쓴다. 실제 `~/.ssh`를 읽지 않는다. 권한 검사는 `process.platform === "win32"`에서 건너뛴다.

- link-ssh-argv.test.ts
  - tunnel R: argv가 `ssh -N -T`로 시작하고 `StrictHostKeyChecking=yes`, `HostKeyAlias=<alias>`, `UserKnownHostsFile=<abs file>`, `GlobalKnownHostsFile=none`, `KnownHostsCommand=none`, `VerifyHostKeyDNS=no`, `CheckHostIP=no`, `BatchMode=yes`, `ExitOnForwardFailure=yes`, `-R 127.0.0.1:P:127.0.0.1:L`, 마지막 두 원소가 `--`, alias.
  - tunnel L: `-L` 모양 동일.
  - exec: `ClearAllForwardings=yes`, 원격 명령이 인용된 한 문자열, `-N` 없음, `StrictHostKeyChecking=yes`, 위 세 신뢰 차단 옵션 포함.
  - probe: `StrictHostKeyChecking=accept-new`, UserKnownHostsFile이 임시 파일, 원격 명령 `true`, 세 신뢰 차단 옵션 포함.
  - 별칭 거부: `-oProxyCommand=x`, 빈 문자열, 공백 포함, 개행 포함 → LinkSshArgumentError.
  - 포트 거부: 0, 65536, 1.5.
  - known_hosts 경로: 공백 있는 절대 경로는 큰따옴표로 감쌈. 거부: `none`, `relative/known_hosts`, `~/k`, `/tmp/%h/known_hosts`, `/tmp/${HOME}/k`, 큰따옴표 포함, 제어 문자 포함.
  - quoteRemote: `it's` → `'it'"'"'s'`, NUL 거부.
- link-ssh-config.test.ts
  - splitSshArgs(OpenSSH argv_split 규칙): `alpha\\ one` → [`alpha one`]; `"a b" 'c\\'d' e\\` → [`a b`, `c'd`, `e\\`](끝 역슬래시 유지); `x # c` → [`x`]; `"a#b" z` → [`a#b`, `z`]; `'x\\y'` → [`x\\y`](인식 못 한 이스케이프는 유지); `a\\<TAB>b` → [`a\\`, `b`](탭은 이스케이프 대상 아님); 닫히지 않은 따옴표 → null. 이 7개 기대값은 wp0 중 초안으로 실행해 확인했다.
  - Host 여러 개, `*`/`?`/`!` 패턴 제외, isSshAlias를 통과하지 못한 별칭(`"alpha beta"`, `-x`) 제외, 대소문자 무시 중복 제거, `Host=alpha` 형식, 행 끝 주석, 닫히지 않은 따옴표 줄은 무시.
  - Match 블록 뒤의 지시어는 후보를 만들지 않고, 다음 Host는 다시 후보.
  - Include: 임시 디렉터리에 `config`, `conf.d/a.conf`, `conf.d/b.conf`를 쓰고 최상위 `Include conf.d/*.conf`를 `loadHostCandidates({home})`가 glob과 상대 경로로 따라간다. Host 블록 안의 Include와 Match 블록 안의 Include는 따라가지 않는다. 자기 자신을 포함하는 Include는 깊이 16에서 멈춘다.
  - config 파일이 없으면 빈 배열.
- link-tunnel-state.test.ts
  - idle →spawn→ connecting →ready→ connected.
  - connected →exit(network)→ reconnecting{attempt 1, inFlight false}; dueForSpawn은 retryAt 전 false, 후 true; spawn → inFlight true; exit → attempt 2.
  - exit(auth|hostkey|forward) → failed{reason}; failed →spawn→ connecting.
  - 시간 제한: reconnecting since+5분 exit → failed{timeout}; reconnecting →spawn(inFlight)→ since+5분 tick → failed{timeout}; idle →spawn→ connecting → since+5분 tick → failed{timeout}.
  - 오래된 이벤트: failed에서 ready·exit는 상태 불변, idle에서 exit·ready 불변, connected에서 spawn 불변.
  - stop은 어떤 상태에서도 idle.
  - nextDelayMs: random=0.5일 때 1→1000, 2→2000, 6→30000 상한; random 0/1에서 ±20%.
  - classifySshStderr: "Permission denied (publickey)." → auth, "Host key verification failed." → hostkey, "Error: remote port forwarding failed for listen port 20100" → forward, "ssh: connect to host x port 22: Connection refused" → network, 기타 → unknown.
- link-store.test.ts
  - 파일 없음 → emptyLinkStore.
  - 쓰기 후 읽기 왕복, 디렉터리 0700·파일 0600(POSIX).
  - LinkStoreError: 손상 JSON, version 2, 최상위 모르는 필드, 레코드 모르는 필드, 잘못된 id/alias/fingerprint/port, apiKeyId에 제어 문자·공백·빈 문자열, 중복 id. hasLinks는 손상 파일에서 false.
  - hostKeyFingerprint null은 direction client-initiated에서만 허용, hub-initiated에서 null이면 LinkStoreError (003 K3).
  - 파일 내용에 `ocx_data_` 문자열이 없다(레코드는 apiKeyId만 가짐).
- link-boundary.test.ts
  - `src/link/*.ts`에서 시작해 상대 import(`import type` 제외)를 재귀로 따라가, 도달한 모든 파일이 `src/server/`, `src/router`, `src/cli/`, `src/client/`, `gui/` 밖에 있음을 확인한다. 실패하면 경로 사슬을 출력한다.

## structure/remote-link.md (NEW, 현재형)

```md
# Remote Link

`src/link/` owns the building blocks for linking OpenCodex machines over SSH. In this release it contains pure modules only: importing them starts no process, opens no socket and schedules no timer.

`src/link/ssh-argv.ts` builds every OpenSSH argument vector. All commands run with BatchMode, trust only the link known_hosts file keyed by `HostKeyAlias=<alias>` with the global file disabled (`GlobalKnownHostsFile=none`), and bind forwards to 127.0.0.1 on both ends. Tunnel and exec commands use `StrictHostKeyChecking=yes`; only the probe uses `accept-new`, against an empty temporary file, so an offered key can be shown before it is trusted. Aliases that could be parsed as options are refused.

`src/link/ssh-config.ts` lists host candidates from `~/.ssh/config` and its includes. Pattern hosts and `Match` blocks produce no candidates. A candidate is an offer, not trust.

`src/link/tunnel-state.ts` is the tunnel lifecycle reducer: connecting, connected, reconnecting with capped jittered backoff, and failed for auth, host-key, forward and five-minute outages.

`src/link/store.ts` persists link records in `<configDir>/link/links.json` with private permissions. Records hold aliases, ports, confirmed host-key fingerprints and data-key ids, never keys. A damaged file is an error, and `hasLinks` reports false for it.

Regression coverage lives in `tests/clients/link-ssh-argv.test.ts`, `tests/clients/link-ssh-config.test.ts`, `tests/clients/link-tunnel-state.test.ts`, `tests/clients/link-store.test.ts` and `tests/clients/link-boundary.test.ts`.
```

## 검증 명령 (PLAN-VERIFIER-REAL-01)

| 명령 | 읽는 대상 | 기록 |
|---|---|---|
| `bun run typecheck` | tsconfig include에 src/** 포함 | wp0 초안에서 exit 0(이전 증거), wp1 B에서 재실행 |
| `bun test tests/clients/link-*.test.ts` | 새 테스트 직접 인자 | wp1 B에서 실행 |
| `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | 배치 등록 | wp1 B에서 실행 |
| `git add -A && bun run structure:index && bun run structure:check` | 스테이징된 structure 문서와 src/link | wp1 B에서 실행 |
| `bun run privacy:scan` | 저장소 전체 | wp1 C |
| `bun run test:changed` | import 그래프 | wp1 C, 실패는 분류 |

## PR

제목 `feat(link): add pure SSH link building blocks`, base `dev`. 설명에 스택 지도(L1-L6)와 "이 레이어는 서버 경로에 연결되지 않음"을 적는다. GUI 변경 없음.

## wp1 P 재검증 (아키텍트 Sartre, gpt-6-sol high, 2026-09-25)

| ID | 제안 | 처분 |
|---|---|---|
| W1-1 | 참조 API 모두 존재, 서명 호환 | 유지 |
| W1-2 | Bun.Glob.scanSync 옵션 지원 | 유지 |
| W1-3 | layout.json `explicit`에 5개, test-layout-expected.json은 평면 맵 최상위 키 5개 | 수용 |
| W1-4 | manifest `docs` 항목(path, tier, title, scope, documents)을 remote-workspace.md 다음에 삽입, 스테이징 후 structure:index → structure:check | 수용 |
| W1-5 | 새 파일은 2000줄 미만이면 기준선 항목 불필요, 작성 후 ratchet 실행 | 수용 |
| W1-6 | store.ts → atomic-write 경로가 Windows ACL 모듈을 끌어온다. atomicWriteFile이 파일을 이미 강화하므로 명시적 hardenSecretPath는 중복 | 수정 수용: 파일에 대한 명시적 `hardenSecretPath` 호출과 import를 제거하고 디렉터리 `hardenSecretDir`만 남긴다. POSIX chmod 0600은 유지. import 비용은 서버가 이미 atomic-write를 쓰므로 추가 비용 없음 |

- 반영 확인(Sartre): W1-1..W1-5 ALIGNED. W1-6은 부분 일치 → 위험으로 기록: `store.ts`를 단독 import하면 atomic-write 경유로 약 11개 모듈(4,117줄, Windows ACL 포함)이 따라온다(src/config/atomic-write.ts:17-23). 서버·CLI 경로는 이미 이 그래프를 불러오므로 wp1에서 추가 비용은 없고, writer 분리는 후속 과제로 남긴다.

## 감사 반영 (Wegener FAIL r1)

위 코드 절은 아래 수정을 반영해 다시 생성했다. 초안은 임시로 작업 트리에 넣어 `bun run typecheck` exit 0을 확인했다(2026-09-25).

- 차단 1: 공통 옵션에 `KnownHostsCommand=none`, `VerifyHostKeyDNS=no`, `CheckHostIP=no` 추가. `optionPath`는 `%`, `$`, 앞자리 `~`, 큰따옴표, 제어 문자를 거부. 테스트: 세 옵션이 tunnel/exec/probe 모두에 있음, `/tmp/%h/known_hosts`·`/tmp/${HOME}/k`·`~/k` 거부.
- 차단 2: `splitSshArgs`가 OpenSSH argv_split 규칙(작은·큰따옴표, 역슬래시 이스케이프, 인자 시작의 비인용 `#`는 주석)을 따른다. 닫히지 않은 따옴표 줄은 무시. `Include`는 최상위 블록에서만 따라간다(Host/Match 안의 Include는 조건부라서 후보를 만들지 않음). 테스트: Host 블록 안 Include 미추적, Match 블록 안 Include 미추적, `Host "alpha beta"`는 공백 포함 인자로 보고 별칭 검증 단계에서 걸러짐(후보에는 들어가되 assertSshAlias 실패는 wp4에서 처리하므로 여기서는 토큰화만 검사), `Host alpha\ one` 토큰화, `Host alpha # comment`, `Host "a#b"`.
- 차단 3: tick은 inFlight와 상관없이 since 기준 5분이 지나면 failed{timeout}. 테스트: reconnecting → spawn(inFlight) → since+5분 tick → failed{timeout}. 오래된 이벤트: failed 상태에서 ready·exit는 상태 불변, idle에서 exit 불변.
- 차단 4: links.json 최상위와 레코드에 허용 필드 목록 강제(모르는 필드 → LinkStoreError), apiKeyId는 `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$`(실제 키 id는 randomUUID, src/server/management/oauth-account-routes.ts:963). 테스트: 모르는 필드, 제어 문자 apiKeyId.
- 비차단: 명시적 hardenSecretPath 제거 반영(W1-6). 경계 테스트는 `src/link`에서 시작해 상대 import를 재귀로 따라가며 `src/server`, `src/router`, `src/cli`, `src/client`, `gui`에 닿지 않는지 확인하는 전이 검사로 바꾼다. Windows ACL 경로는 이 레이어 테스트에서 검증하지 않으며(POSIX 전용 권한 테스트), CI Windows 샤드는 쓰기·읽기 왕복만 확인한다.

## 감사 반영 (Wegener FAIL r2)

- 차단 1: splitSshArgs를 OpenSSH misc.c argv_split과 같은 규칙으로 다시 썼다(역슬래시 규칙은 따옴표 안에도 적용, 따옴표 밖에서만 공백 이스케이프, 탭은 이스케이프 대상 아님, 인식 못 한 역슬래시와 끝 역슬래시는 유지). 7개 사례의 실행 결과를 테스트 기대값으로 고정.
- 차단 2: optionPath는 절대 경로만 받는다(`none`, 상대 경로 거부).
- 차단 3: connecting도 since 기준 5분 tick에서 failed{timeout}.
- 차단 4: 테스트 사례 절을 다시 써서 새 보안 사례를 모두 명시했다.
- 초안을 임시로 작업 트리에 넣어 `bun run typecheck` exit 0 확인(2026-09-25).

## 감사 반영 (Wegener FAIL r3)

- 차단 1: `GlobalKnownHostsFile=/dev/null` → `GlobalKnownHostsFile=none`(OpenSSH 회귀 테스트와 같은 값, Windows OpenSSH 호환). argv 테스트 기대값도 `none`.
- 비차단: 후보 파서가 `isSshAlias`를 통과한 별칭만 낸다. Include 확장 범위(`~/`, 절대·상대 경로, glob만, `~user`·환경 변수·`%` 토큰은 미확장)를 loadHostCandidates 주석에 명시.
