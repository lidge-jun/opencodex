/**
 * ZCode plan OAuth login (CLI flow).
 *
 * Mirrors the ZCode desktop client's `oauth/cli` device-style flow:
 *
 *   1. POST /api/v1/oauth/cli/init            -> { flow_id, authorize_url, poll_interval_sec }
 *   2. the user authorizes `authorize_url` in a browser
 *   3. GET  /api/v1/oauth/cli/poll/{flow_id}  -> pending | ready { token, user, zai }
 *
 * `token` is the zcode-plan JWT (no `exp` claim — the gateway does not reject by age), and
 * `zai.access_token` is stored as the refresh slot for diagnosability. Neither is refreshable
 * without a browser round-trip, so a gateway rejection surfaces as re-login.
 */
import { randomBytes } from "node:crypto";
import type { OAuthController, OAuthCredentials } from "./types";

const ZCODE_ORIGIN = "https://zcode.z.ai";
const SDK_UA = "ZCode/3.11.2";
const DEFAULT_POLL_INTERVAL_MS = 3000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

interface CliInitResponse {
  code?: number;
  msg?: string;
  data?: {
    flow_id?: string;
    authorize_url?: string;
    expires_at?: number;
    poll_interval_sec?: number;
  };
}

interface CliPollResponse {
  code?: number;
  msg?: string;
  data?: {
    status?: string;
    token?: string;
    user?: { user_id?: string; email?: string };
    zai?: { access_token?: string };
  };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    }, { once: true });
  });

/** Run one full browser login and return the stored credential. */
export async function loginZcodeStartPlan(ctrl: OAuthController): Promise<OAuthCredentials> {
  const pollToken = randomBytes(32).toString("hex");
  const initRes = await fetch(`${ZCODE_ORIGIN}/api/v1/oauth/cli/init`, {
    method: "POST",
    headers: { authorization: `Bearer ${pollToken}`, "content-type": "application/json", "user-agent": SDK_UA },
    body: JSON.stringify({ provider: "zai" }),
  });
  const init = (await initRes.json().catch(() => undefined)) as CliInitResponse | undefined;
  const flowId = nonEmpty(init?.data?.flow_id);
  const authorizeUrl = nonEmpty(init?.data?.authorize_url);
  if (!initRes.ok || !flowId || !authorizeUrl) {
    throw new Error(`ZCode plan login init failed: ${init?.msg ?? `status ${initRes.status}`}`);
  }

  ctrl.onAuth?.({
    url: authorizeUrl,
    instructions: "Approve the Z.ai authorization in your browser to connect the ZCode plan.",
  });

  const intervalMs = Math.max(1000, (init?.data?.poll_interval_sec ?? 0) * 1000) || DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(intervalMs, ctrl.signal);
    let poll: CliPollResponse | undefined;
    try {
      const res = await fetch(`${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
        headers: { authorization: `Bearer ${pollToken}`, "user-agent": SDK_UA },
      });
      poll = (await res.json().catch(() => undefined)) as CliPollResponse | undefined;
    } catch {
      continue; // transient poll errors retry until the flow deadline
    }
    const data = poll?.data;
    if (data?.status === "ready") {
      const jwt = nonEmpty(data.token);
      if (!jwt) throw new Error("ZCode plan login completed without a JWT");
      return {
        refresh: nonEmpty(data.zai?.access_token) ?? "",
        access: jwt,
        // The plan JWT carries no `exp`; the gateway rejects stale tokens with 401/3012 and the
        // adapter surfaces re-login from there. Max expires keeps the shared refresh gate idle.
        expires: Number.MAX_SAFE_INTEGER,
        email: nonEmpty(data.user?.email),
        accountId: nonEmpty(data.user?.user_id),
        source: "oauth",
      };
    }
    if (data?.status === "failed") throw new Error(`ZCode plan login failed: ${poll?.msg ?? "authorization denied"}`);
  }
  throw new Error("ZCode plan login timed out");
}

/**
 * No silent refresh exists: the JWT is long-lived but unrefreshable without a browser round.
 * Terminal by contract — the shared path marks the account needsReauth and the user re-runs
 * `ocx login zcode-start-plan`.
 */
export async function refreshZcodeStartPlanToken(): Promise<never> {
  throw new Error("invalid_grant: the ZCode plan JWT cannot be refreshed; reconnect with ocx login zcode-start-plan");
}
