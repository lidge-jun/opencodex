import { readRuntimePort, type RuntimePortState } from "../config/process-state";
import { timingSafeEqual } from "node:crypto";
import { createGuiPairIntent, GUI_PAIR_INTENT_HEADER, type GuiPairIntent } from "../lib/gui-pair-intent";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationChallenge,
  verifyLocalAttestationProof,
} from "../lib/local-management-attestation";
import {
  GUI_PAIR_BROWSER_ORIGIN_HEADER,
  GUI_PAIR_CAPABILITY_HEADER,
  GUI_PAIR_CAPABILITY_TTL_MS,
  GUI_PAIR_CAPABILITY_VERSION,
  GUI_PAIR_EXPECTED_PID_HEADER,
  GUI_PAIR_EXPIRES_AT_HEADER,
  GUI_PAIR_METHOD,
  GUI_PAIR_NONCE_HEADER,
  GUI_PAIR_PATH,
  DESKTOP_GUI_PAIR_PATH,
  canonicalGuiBrowserOrigin,
  canonicalHttpOrigin,
  createGuiPairCapability,
} from "../lib/gui-pair-capability";
import { directLocalHttpFetch } from "../server/direct-local-http";
import {
  isOpencodexHealthz,
  probeHostname,
  type HealthzIdentity,
  type LiveProxy,
} from "../server/proxy-liveness";

export type GuiPairRequestResult =
  | { kind: "created"; grant: string; browserOrigin: string; serverOrigin: string; expiresAt: number }
  | { kind: "unavailable"; reason: "unattested-target" | "runtime-mismatch" | "attestation" | "capability" | "transport" | "rejected" | "local-intent" | "origin-refused" | "rate-limited" };

export interface GuiPairClientDeps {
  desktopPurpose?: boolean;
  fetchImpl?: typeof fetch;
  readRuntime?: (pid: number) => RuntimePortState | null;
  createChallenge?: () => string;
  now?: () => number;
  timeoutMs?: number;
  /** Hub invitation policy is unchanged; standalone commands require local write intent. */
  requireLocalIntent?: boolean;
  createIntent?: typeof createGuiPairIntent;
}

const GUI_PAIR_REQUEST_TIMEOUT_MS = 10_000;

function sameRuntime(left: RuntimePortState, right: RuntimePortState | null): boolean {
  const leftSecret = Buffer.from(left.attestationSecret ?? "");
  const rightSecret = Buffer.from(right?.attestationSecret ?? "");
  return !!right?.attestationSecret
    && right.pid === left.pid
    && right.port === left.port
    && right.hostname === left.hostname
    && leftSecret.length === rightSecret.length
    && timingSafeEqual(leftSecret, rightSecret);
}

/**
 * Which refusal the grant route sent, as one fixed word; the body itself never surfaces.
 *
 * Only the route's plain 403 "GUI pairing grant refused" (no `code`) means its loaded config did not
 * admit this origin, the one case an allow-list edit or a restart can cure (#8319). Its 429 is the
 * per-minute grant limit. A coded refusal, a capability refusal and anything else stay `rejected`,
 * so the caller does not send an operator to edit a correct allow-list (#8495 review).
 *
 * This is a heuristic: the route answers the same uncoded 403 for any unexpected failure inside
 * grant creation, not only for a refused origin. Those are rare and the advice (check the two origin
 * settings, restart) is harmless there; an explicit server code would make it exact.
 */
async function refusalReason(response: Response): Promise<"origin-refused" | "rate-limited" | "rejected"> {
  if (response.status === 429) return "rate-limited";
  if (response.status !== 403) return "rejected";
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return "rejected";
  const record = body as Record<string, unknown>;
  return record.error === "GUI pairing grant refused" && record.code === undefined ? "origin-refused" : "rejected";
}

function parseCreatedResult(value: unknown, browserOrigin: string): GuiPairRequestResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.grant !== "string"
    || !/^ocx_pair_[A-Za-z0-9_-]{43}$/.test(record.grant)
    || canonicalGuiBrowserOrigin(record.browserOrigin) !== browserOrigin
    || typeof record.expiresAt !== "number"
    || !Number.isSafeInteger(record.expiresAt)
  ) return null;
  const serverOrigin = canonicalHttpOrigin(record.serverOrigin);
  if (!serverOrigin) return null;
  return {
    kind: "created",
    grant: record.grant,
    browserOrigin,
    serverOrigin,
    expiresAt: record.expiresAt,
  };
}

export async function requestBoundGuiPairingGrant(
  target: LiveProxy,
  browserOrigin: string,
  deps: GuiPairClientDeps = {},
): Promise<GuiPairRequestResult> {
  if (target.source !== "runtime" || target.pid === null || target.pid <= 0) {
    return { kind: "unavailable", reason: "unattested-target" };
  }
  const canonicalOrigin = canonicalGuiBrowserOrigin(browserOrigin);
  if (!canonicalOrigin || canonicalOrigin !== browserOrigin) {
    return { kind: "unavailable", reason: "capability" };
  }
  const readRuntime = deps.readRuntime ?? readRuntimePort;
  const runtime = readRuntime(target.pid);
  if (!runtime?.attestationSecret || runtime.pid !== target.pid || runtime.port !== target.port) {
    return { kind: "unavailable", reason: "runtime-mismatch" };
  }
  const fetchImpl = deps.fetchImpl ?? directLocalHttpFetch;
  const timeoutMs = deps.timeoutMs ?? GUI_PAIR_REQUEST_TIMEOUT_MS;
  const challenge = (deps.createChallenge ?? createLocalAttestationChallenge)();
  const baseUrl = `http://${probeHostname(target.hostname)}:${target.port}`;
  let proofResponse: Response;
  try {
    proofResponse = await fetchImpl(`${baseUrl}/healthz`, {
      headers: { [LOCAL_ATTESTATION_CHALLENGE_HEADER]: challenge },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "unavailable", reason: "transport" };
  }
  const body = await proofResponse.json().catch(() => null) as HealthzIdentity | null;
  if (
    !proofResponse.ok
    || !isOpencodexHealthz(body)
    || body?.pid !== target.pid
    || body?.port !== target.port
    || !verifyLocalAttestationProof(
      runtime.attestationSecret,
      challenge,
      target.pid,
      target.port,
      proofResponse.headers.get(LOCAL_ATTESTATION_PROOF_HEADER),
    )
  ) return { kind: "unavailable", reason: "attestation" };
  if (body.guiPairCapability !== GUI_PAIR_CAPABILITY_VERSION) {
    return { kind: "unavailable", reason: "capability" };
  }
  if (!sameRuntime(runtime, readRuntime(target.pid))) {
    return { kind: "unavailable", reason: "runtime-mismatch" };
  }
  const expiresAt = (deps.now ?? Date.now)() + GUI_PAIR_CAPABILITY_TTL_MS;
  const path = deps.desktopPurpose ? DESKTOP_GUI_PAIR_PATH : GUI_PAIR_PATH;
  const capability = createGuiPairCapability(
    runtime.attestationSecret,
    challenge,
    GUI_PAIR_METHOD,
    path,
    browserOrigin,
    target.pid,
    target.port,
    expiresAt,
  );
  if (!capability) return { kind: "unavailable", reason: "capability" };
  let intent: GuiPairIntent | undefined;
  try {
    if (deps.desktopPurpose || deps.requireLocalIntent !== false) intent = (deps.createIntent ?? createGuiPairIntent)(capability);
  } catch { return { kind: "unavailable", reason: "local-intent" }; }
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: GUI_PAIR_METHOD,
      headers: {
        "Content-Length": "0",
        [GUI_PAIR_EXPECTED_PID_HEADER]: String(target.pid),
        [GUI_PAIR_NONCE_HEADER]: challenge,
        [GUI_PAIR_EXPIRES_AT_HEADER]: String(expiresAt),
        [GUI_PAIR_BROWSER_ORIGIN_HEADER]: browserOrigin,
        [GUI_PAIR_CAPABILITY_HEADER]: capability,
        ...(intent ? { [GUI_PAIR_INTENT_HEADER]: intent.proof } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { kind: "unavailable", reason: await refusalReason(response) };
    const result = parseCreatedResult(await response.json().catch(() => null), browserOrigin);
    return result ?? { kind: "unavailable", reason: "rejected" };
  } catch {
    return { kind: "unavailable", reason: "transport" };
  } finally { intent?.dispose(); }
}
