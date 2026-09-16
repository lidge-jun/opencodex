import { readRuntimePort, type RuntimePortState } from "../config/process-state";
import { timingSafeEqual } from "node:crypto";
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
  | { kind: "unavailable"; reason: "unattested-target" | "runtime-mismatch" | "attestation" | "capability" | "transport" | "rejected" };

export interface GuiPairClientDeps {
  fetchImpl?: typeof fetch;
  readRuntime?: (pid: number) => RuntimePortState | null;
  createChallenge?: () => string;
  now?: () => number;
  timeoutMs?: number;
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
  const capability = createGuiPairCapability(
    runtime.attestationSecret,
    challenge,
    GUI_PAIR_METHOD,
    GUI_PAIR_PATH,
    browserOrigin,
    target.pid,
    target.port,
    expiresAt,
  );
  if (!capability) return { kind: "unavailable", reason: "capability" };
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${GUI_PAIR_PATH}`, {
      method: GUI_PAIR_METHOD,
      headers: {
        "Content-Length": "0",
        [GUI_PAIR_EXPECTED_PID_HEADER]: String(target.pid),
        [GUI_PAIR_NONCE_HEADER]: challenge,
        [GUI_PAIR_EXPIRES_AT_HEADER]: String(expiresAt),
        [GUI_PAIR_BROWSER_ORIGIN_HEADER]: browserOrigin,
        [GUI_PAIR_CAPABILITY_HEADER]: capability,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "unavailable", reason: "transport" };
  }
  if (!response.ok) return { kind: "unavailable", reason: "rejected" };
  const result = parseCreatedResult(await response.json().catch(() => null), browserOrigin);
  return result ?? { kind: "unavailable", reason: "rejected" };
}
