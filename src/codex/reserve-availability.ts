import { createHmac, randomBytes } from "node:crypto";
import { readBoundedResponseBody } from "../lib/bounded-body";
import {
  getMainQuotaCredentialGeneration, isMainQuotaWriterLive, matchesMainQuotaCredential, type MainQuotaWriter,
} from "./main-account-cache";
import { NATIVE_RESERVE_MODEL } from "./catalog/native-models";
import { WHAM_REQUEST_TIMEOUT_MS } from "./quota-recovery-timing";
import type { WhamUsageResponse } from "./quota-types";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AUTHORIZATION_TTL_MS = 60_000;
const credentialSalt = randomBytes(32);
type Token = { accessToken: string; chatgptAccountId: string };
export interface MainReserveAuthorization {
  readonly writer: MainQuotaWriter;
  readonly observedAt: number;
  readonly expiresAt: number;
}
type Input = {
  token: Token;
  writer: MainQuotaWriter | undefined;
  signal?: AbortSignal;
  observeOrdinaryQuota: (data: WhamUsageResponse, writer: MainQuotaWriter) => void;
};
type Slot = {
  key: string;
  writer: MainQuotaWriter;
  credentialGeneration: number;
  revision: number;
  authorization?: MainReserveAuthorization;
  flight?: Promise<MainReserveAuthorization | undefined>;
  controller?: AbortController;
};
let current: Slot | undefined;
const authorizationKeys = new WeakMap<MainReserveAuthorization, string>();

function credentialKey(token: Token, writer: MainQuotaWriter): string {
  return createHmac("sha256", credentialSalt).update(writer.identityKey)
    .update(`:${writer.identityGeneration}:${getMainQuotaCredentialGeneration()}:`).update(token.accessToken).digest("hex");
}
function owned(token: Token, writer: MainQuotaWriter): boolean {
  return isMainQuotaWriterLive(writer) && matchesMainQuotaCredential(token.accessToken, token.chatgptAccountId);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function userId(token: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const auth = record(payload) ? payload["https://api.openai.com/auth"] : undefined;
    if (!record(auth)) return;
    const value = auth.chatgpt_user_id ?? auth.user_id;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch { return; }
}
function identityMatches(data: WhamUsageResponse, token: Token): boolean {
  if (data.account_id != null && data.account_id !== token.chatgptAccountId) return false;
  const expectedUser = userId(token.accessToken);
  return expectedUser === undefined || data.user_id == null || data.user_id === expectedUser;
}
function reserveLimits(data: WhamUsageResponse) {
  return Array.isArray(data.additional_rate_limits)
    ? data.additional_rate_limits.filter(entry => record(entry) && entry.limit_name === NATIVE_RESERVE_MODEL)
    : [];
}
function grantsReserve(data: WhamUsageResponse): boolean {
  const limits = reserveLimits(data);
  return data.rate_limit?.allowed === false && data.rate_limit_upsell?.banner_type === "luna_reserve"
    && limits.length === 1 && limits[0]?.rate_limit?.allowed === true;
}

/** An object copied/spread onto a refreshed credential is not an authorization for that credential. */
export function isMainReserveAuthorizationLive(
  value: MainReserveAuthorization | undefined, token: Token, now = Date.now(),
): boolean {
  if (!value || !owned(token, value.writer) || value.expiresAt <= now || value.observedAt > now) return false;
  const key = credentialKey(token, value.writer);
  return current?.authorization === value && authorizationKeys.get(value) === key && current.key === key;
}

/** Passive usage may revoke, but never grant. Missing Reserve on a passive read is not revocation. */
export function observeMainReserveRevocation(data: WhamUsageResponse, writer: MainQuotaWriter | undefined): void {
  const slot = current;
  if (!slot || !writer || !isMainQuotaWriterLive(writer)
    || writer.identityKey !== slot.writer.identityKey || writer.identityGeneration !== slot.writer.identityGeneration) return;
  if (data.rate_limit?.allowed !== true && !reserveLimits(data).some(limit => limit.rate_limit?.allowed === false)) return;
  slot.revision += 1;
  slot.authorization = undefined;
  slot.controller?.abort();
}

async function waitForCaller<T>(flight: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return flight;
  if (signal.aborted) return;
  let abort!: () => void;
  const aborted = new Promise<undefined>(resolve => { abort = () => resolve(undefined); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([flight, aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function readAuthorization(slot: Slot, input: Input & { writer: MainQuotaWriter }): Promise<MainReserveAuthorization | undefined> {
  const controller = new AbortController();
  slot.controller = controller;
  const revision = slot.revision;
  const deadline = Date.now() + WHAM_REQUEST_TIMEOUT_MS;
  const live = () => current === slot && revision === slot.revision && !controller.signal.aborted
    && Date.now() < deadline && slot.credentialGeneration === getMainQuotaCredentialGeneration()
    && owned(input.token, input.writer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  const stopped = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(), WHAM_REQUEST_TIMEOUT_MS);
  });
  const operation = (async () => {
    const response = await fetch(USAGE_URL, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.token.accessToken}`,
        "chatgpt-account-id": input.token.chatgptAccountId,
        "x-openai-codex-luna-reserve": "1", accept: "application/json",
      },
    });
    if (!response.ok || !live()) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    const body = await readBoundedResponseBody(response, {
      signal: controller.signal, fatalUtf8: true,
      totalTimeoutMs: Math.max(1, deadline - Date.now()), inactivityTimeoutMs: WHAM_REQUEST_TIMEOUT_MS,
    });
    if (!body.displaySafe || body.truncated || !live()) return;
    const raw: unknown = JSON.parse(body.text);
    if (!record(raw)) return;
    const data = raw as WhamUsageResponse;
    if (!identityMatches(data, input.token)) return;
    // Keep malformed additional containers away from legacy ordinary parsers.
    if (data.additional_rate_limits != null && !Array.isArray(data.additional_rate_limits)) return;
    input.observeOrdinaryQuota(data, input.writer);
    if (!live() || !grantsReserve(data)) { slot.authorization = undefined; return; }
    const observedAt = Date.now();
    const authorization = Object.freeze({
      writer: Object.freeze({ ...input.writer }), observedAt, expiresAt: observedAt + AUTHORIZATION_TTL_MS,
    });
    authorizationKeys.set(authorization, slot.key);
    slot.authorization = authorization;
    return authorization;
  })().catch(() => undefined);
  try { return await Promise.race([operation, stopped]); }
  finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    if (slot.controller === controller) slot.controller = undefined;
  }
}

/** Capability-aware read with an already-owned token; no auth-file access or inference. */
export async function getMainReserveAuthorization(input: Input): Promise<MainReserveAuthorization | undefined> {
  const writer = input.writer && { ...input.writer };
  const token = { ...input.token };
  if (input.signal?.aborted || !writer || !owned(token, writer)) return;
  const key = credentialKey(token, writer);
  if (!current || current.key !== key) {
    current?.controller?.abort();
    current = { key, writer: { ...writer }, credentialGeneration: getMainQuotaCredentialGeneration(), revision: 0 };
  }
  const slot = current;
  if (isMainReserveAuthorizationLive(slot.authorization, token)) return slot.authorization;
  if (!slot.flight) {
    const flight = readAuthorization(slot, { ...input, token, writer });
    slot.flight = flight;
    void flight.finally(() => { if (slot.flight === flight) slot.flight = undefined; });
  }
  const result = await waitForCaller(slot.flight, input.signal);
  return !input.signal?.aborted && isMainReserveAuthorizationLive(result, token) ? result : undefined;
}
