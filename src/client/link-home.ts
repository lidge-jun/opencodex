/**
 * A Remote Link Child's view of its Home (#6957): the Home's name for refusal and status text,
 * the Home's OpenCodex-owned Codex settings, and authenticated read-only management reads.
 *
 * Every read goes through the connection-bound link relay (`fetchBoundLinkRelay`): the link key
 * is sent only after the listener on the tunnel port proves it holds the same link identity, so a
 * process that took the tunnel port never sees the key.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import {
  codexSettingsDigest,
  parseHomeCodexSettingsDocument,
  type HomeCodexSettingsDocument,
} from "../link/codex-settings";
import { LINK_CHILD_PARITY_PATH, type LinkChildParityReport } from "../link/child-parity";
import {
  LINK_CODEX_SETTINGS_PATH,
  LINK_MANAGEMENT_PREFIX,
  linkManagementReadAllowed,
} from "../link/management-routes";
import { linkDir } from "../link/paths";
import type { OcxClientConnectionConfig } from "../types";
import { withClientLifecycle } from "./lifecycle-lock";
import { fetchBoundLinkRelay } from "./link-relay-transport";
import { readClientLinkState, type ClientLinkState } from "./link-state";

const RECORD_MAX_BYTES = 64 * 1024;

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
const SETTINGS_MAX_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 10_000;

export interface LinkHomeDeps {
  /** Trusted complete-send test seam; production uses the connection-bound transport. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The connection fields a Home read needs; connect calls these before its state is committed. */
export type LinkHomeConnection = Pick<OcxClientConnectionConfig, "transport" | "link" | "apiKeyId">;

export interface HomeCodexSettingsRecord {
  linkId: string;
  fetchedAt: string;
  /**
   * When this Child first applied these settings (OCX-6, P5). A re-apply of the same digest for
   * the same link keeps it, so an idempotent `ocx sync` never makes a fresh runtime look stale.
   */
  appliedAt: string;
  document: HomeCodexSettingsDocument;
}

export function homeCodexSettingsPath(): string {
  return join(linkDir(), "home-codex-settings.json");
}

function linkTarget(connection: LinkHomeConnection, admissionKey: string) {
  if (connection.transport !== "link" || !connection.link) throw new Error("not a Remote Link Child");
  return {
    tunnelPort: connection.link.tunnelPort,
    linkId: connection.link.linkId,
    apiKeyId: connection.apiKeyId,
    admissionKey,
  };
}

/** The last applied Home settings for this link, or null when absent, malformed or another link's. */
export function readHomeCodexSettingsRecord(linkId: string, path = homeCodexSettingsPath()): HomeCodexSettingsRecord | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.linkId !== linkId || typeof record.fetchedAt !== "string" || Number.isNaN(Date.parse(record.fetchedAt))) return null;
    const document = parseHomeCodexSettingsDocument(record.document);
    // Records written before OCX-6 carry no apply time; their read time is the closest one.
    const appliedAt = isIsoTimestamp(record.appliedAt) ? record.appliedAt : record.fetchedAt;
    return document ? { linkId, fetchedAt: record.fetchedAt, appliedAt, document } : null;
  } catch {
    return null;
  }
}

export function writeHomeCodexSettingsRecord(record: HomeCodexSettingsRecord, path = homeCodexSettingsPath()): void {
  const dir = linkDir();
  assertNotRealHomeUnderTest(join(dir, ".."));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function clearHomeCodexSettingsRecord(path = homeCodexSettingsPath()): void {
  try { unlinkSync(path); } catch (error) { if (!isMissingPathError(error)) throw error; }
}

/**
 * The record an apply of `document` produces: the apply time is `appliedAt` unless the previous
 * record is for the same link and the same settings digest, in which case it is kept.
 */
export function homeCodexSettingsReceipt(
  linkId: string,
  document: HomeCodexSettingsDocument,
  fetchedAt: string,
  appliedAt: string,
  previous: HomeCodexSettingsRecord | null = readHomeCodexSettingsRecord(linkId),
): HomeCodexSettingsRecord {
  const unchanged = previous !== null && previous.linkId === linkId
    && codexSettingsDigest(previous.document.settings) === codexSettingsDigest(document.settings);
  return { linkId, fetchedAt, appliedAt: unchanged ? previous.appliedAt : appliedAt, document };
}

export function linkApplyLockPath(): string {
  return join(linkDir(), "apply-lock.sqlite");
}

/**
 * Before an apply writes settings that differ from the recorded ones, withdraw the record, so a
 * failed injection or record write reads as "no recorded apply" instead of the previous digest
 * (OCX-6). Re-applying the same settings keeps it. Returns whether the record was withdrawn.
 */
export function withdrawChangingHomeCodexSettingsRecord(linkId: string, document: HomeCodexSettingsDocument): boolean {
  const previous = readHomeCodexSettingsRecord(linkId);
  if (!previous || codexSettingsDigest(previous.document.settings) === codexSettingsDigest(document.settings)) return false;
  clearHomeCodexSettingsRecord();
  return true;
}

/** The apply lock is held by another apply or a link connect in flight; nothing ran. */
export class LinkApplyBusyError extends Error {
  readonly code = "link_apply_busy";
  constructor() {
    super("another Home settings apply is in progress on this machine; retry when it finishes");
    this.name = "LinkApplyBusyError";
  }
}

/**
 * Serialize applies of the Home's settings on this Child, from the Home read through the Codex
 * injection to the record write, so a receipt always names the settings the injection wrote.
 * Outermost in the client lock order (before N, L and C); a second apply fails fast.
 */
export async function withLinkApply<T>(work: () => Promise<T>, lockPath: string = linkApplyLockPath()): Promise<T> {
  const dir = linkDir();
  assertNotRealHomeUnderTest(join(dir, ".."));
  // Only a refusal of the apply lock itself means "another apply"; an error from inside `work`
  // (including a busy ordinary lifecycle lock) passes through as itself.
  let entered = false;
  try {
    return await withClientLifecycle(() => { entered = true; return work(); }, { lockPath });
  } catch (error) {
    if (!entered && error instanceof Error && error.message === "client_lifecycle_busy") {
      throw new LinkApplyBusyError();
    }
    throw error;
  }
}

/**
 * The Home's name as this Child knows it: the SSH alias of a Child-initiated link, else the
 * host name the Home published with its Codex settings, else null ("its Home").
 */
export function linkHomeName(
  connection: OcxClientConnectionConfig,
  readSidecar: () => ClientLinkState | null = readClientLinkState,
): string | null {
  const linkId = connection.link?.linkId;
  if (!linkId) return null;
  try {
    const sidecar = readSidecar();
    if (sidecar && sidecar.linkId === linkId) return sidecar.alias;
  } catch { /* an unreadable sidecar names nothing */ }
  return readHomeCodexSettingsRecord(linkId)?.document.home.name ?? null;
}

/** "Home home-box" or "its Home": the phrase every link Child message uses. */
export function linkHomePhrase(
  connection: OcxClientConnectionConfig,
  readSidecar?: () => ClientLinkState | null,
): string {
  const name = linkHomeName(connection, readSidecar);
  return name ? `Home ${name}` : "its Home";
}

/**
 * A `fetch` for the existing data-plane reads (`/v1/hub-state`, `/v1/usage`) that sends each
 * request through the connection-bound link relay, so the link key reaches only the Home.
 */
export function linkBoundFetch(connection: LinkHomeConnection, admissionKey: string): typeof fetch {
  const target = linkTarget(connection, admissionKey);
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    // A Request keeps its method, headers and signal unless init overrides them.
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    return fetchBoundLinkRelay(target, url, {
      ...(request ? { method: request.method, headers: request.headers, signal: request.signal } : {}),
      ...(init ?? {}),
      redirect: "manual",
    });
  }) as typeof fetch;
}

/**
 * One authenticated, read-only management read on the Home. `path` is a Home management path
 * with an optional query (`/api/providers`); anything outside the shared allowlist throws before
 * a request is built.
 */
export async function fetchLinkHomeManagement(
  connection: LinkHomeConnection,
  admissionKey: string,
  path: string,
  init: { method?: "GET" | "HEAD"; signal?: AbortSignal } = {},
  deps: LinkHomeDeps = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const local = new URL(path, "http://link.invalid");
  if (local.origin !== "http://link.invalid" || !linkManagementReadAllowed(method, local.pathname, local.searchParams)) {
    throw new Error("path is not readable over the Remote Link");
  }
  const target = linkTarget(connection, admissionKey);
  const destination = `http://127.0.0.1:${target.tunnelPort}${LINK_MANAGEMENT_PREFIX}${local.pathname}${local.search}`;
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(deps.timeoutMs ?? READ_TIMEOUT_MS)])
    : AbortSignal.timeout(deps.timeoutMs ?? READ_TIMEOUT_MS);
  const request: RequestInit = {
    method,
    headers: { accept: "application/json", authorization: `Bearer ${admissionKey}` },
    redirect: "manual",
    signal,
  };
  return deps.fetchImpl ? deps.fetchImpl(destination, request) : fetchBoundLinkRelay(target, destination, request);
}

export type HomeCodexSettingsFetch =
  | { kind: "fresh"; document: HomeCodexSettingsDocument }
  | { kind: "unsupported" }
  | { kind: "failed"; reason: string };

export async function fetchHomeCodexSettings(
  connection: LinkHomeConnection,
  admissionKey: string,
  deps: LinkHomeDeps = {},
): Promise<HomeCodexSettingsFetch> {
  let response: Response;
  try {
    const target = linkTarget(connection, admissionKey);
    const destination = `http://127.0.0.1:${target.tunnelPort}${LINK_CODEX_SETTINGS_PATH}`;
    const request: RequestInit = {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${admissionKey}` },
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? READ_TIMEOUT_MS),
    };
    response = deps.fetchImpl ? await deps.fetchImpl(destination, request) : await fetchBoundLinkRelay(target, destination, request);
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error && error.name === "LinkRelayAuthenticationError" ? error.message : "the Home is unreachable" };
  }
  if (response.status === 404) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return { kind: "unsupported" };
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return { kind: "failed", reason: `the Home answered HTTP ${response.status}` };
  }
  try {
    const result = await readBoundedResponseBytes(response, { maxBytes: SETTINGS_MAX_BYTES, signal: AbortSignal.timeout(deps.timeoutMs ?? READ_TIMEOUT_MS) });
    if (result.oversized) return { kind: "failed", reason: "the Home's settings exceeded the allowed size" };
    const document = parseHomeCodexSettingsDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)));
    return document ? { kind: "fresh", document } : { kind: "failed", reason: "the Home returned an unreadable settings document" };
  } catch {
    return { kind: "failed", reason: "the Home returned an unreadable settings document" };
  }
}

export type HomeCodexSettingsSource =
  | { source: "home"; document: HomeCodexSettingsDocument; fetchedAt: string }
  | { source: "cached"; document: HomeCodexSettingsDocument; fetchedAt: string; reason: string }
  | { source: "local"; reason: string };

/**
 * The settings a sync applies. A failed read reuses the last record for this link so a brief
 * outage never flips the Child back to its local values; a Home that predates the route leaves
 * the Child's local values in place and says so. A fresh read is NOT recorded here: the caller
 * records it with `recordHomeCodexSettings` only after the injection that applies it succeeds,
 * because `ocx status` reads the record as "applied".
 */
export async function resolveHomeCodexSettings(
  connection: LinkHomeConnection,
  admissionKey: string,
  deps: LinkHomeDeps & { now?: () => Date } = {},
): Promise<HomeCodexSettingsSource> {
  const linkId = connection.link?.linkId;
  if (!linkId) return { source: "local", reason: "not a Remote Link Child" };
  const fetched = await fetchHomeCodexSettings(connection, admissionKey, deps);
  if (fetched.kind === "fresh") {
    return { source: "home", document: fetched.document, fetchedAt: (deps.now ?? (() => new Date()))().toISOString() };
  }
  if (fetched.kind === "unsupported") {
    clearHomeCodexSettingsRecord();
    return { source: "local", reason: "the Home does not publish Codex settings; upgrade the Home" };
  }
  const cached = readHomeCodexSettingsRecord(linkId);
  return cached
    ? { source: "cached", document: cached.document, fetchedAt: cached.fetchedAt, reason: fetched.reason }
    : { source: "local", reason: fetched.reason };
}

/**
 * Record settings a successful injection applied and return the committed record; null when the
 * source was not a fresh Home read. A write failure throws: the caller reports it, because
 * `ocx status` and the Home read this record as the proof of what was applied.
 */
export function recordHomeCodexSettings(
  linkId: string,
  settings: HomeCodexSettingsSource,
  now: () => Date = () => new Date(),
): HomeCodexSettingsRecord | null {
  if (settings.source !== "home") return null;
  const record = homeCodexSettingsReceipt(linkId, settings.document, settings.fetchedAt, now().toISOString());
  writeHomeCodexSettingsRecord(record);
  return record;
}

/**
 * Tell the Home what this Child last applied and when its runtime started (OCX-6). Resolves to
 * `"accepted"`, `"unsupported"` for a Home that predates the route, or `"failed"`.
 */
export async function sendLinkChildParityReport(
  connection: LinkHomeConnection,
  admissionKey: string,
  report: LinkChildParityReport,
  deps: LinkHomeDeps = {},
): Promise<"accepted" | "unsupported" | "failed"> {
  let response: Response;
  try {
    const target = linkTarget(connection, admissionKey);
    const destination = `http://127.0.0.1:${target.tunnelPort}${LINK_CHILD_PARITY_PATH}`;
    const body = JSON.stringify(report);
    const request: RequestInit = {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${admissionKey}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? READ_TIMEOUT_MS),
    };
    response = deps.fetchImpl ? await deps.fetchImpl(destination, request) : await fetchBoundLinkRelay(target, destination, request);
  } catch {
    return "failed";
  }
  try { await response.body?.cancel(); } catch { /* best effort */ }
  if (response.status === 404) return "unsupported";
  return response.status === 204 ? "accepted" : "failed";
}
