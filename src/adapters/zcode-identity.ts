/**
 * ZCode client identity headers.
 *
 * Z.ai attributes GLM Coding Plan traffic to the client that sent it, and grants the
 * ZCode harness an increased usage allowance (150%) over third-party clients. These
 * builders reproduce the official client's LLM companion headers so plan-metered
 * destinations are attributed correctly:
 *
 *   - Identity: `HTTP-Referer`, `User-Agent: ZCode/<version>` (optionally with the AI SDK
 *     suffix the client appends on Anthropic-wire calls), `X-ZCode-App-Version`, `X-Title`,
 *     `X-Release-Channel`, `X-Client-Language`/`-Timezone` (always sent, "unknown"
 *     fallback), `X-Platform`, `X-Os-Category`, `X-Os-Version`, and `X-ZCode-Agent: glm`
 *     last. No `X-Device-Mid` on LLM calls.
 *   - Attribution: fresh `x-request-id`/`x-zcode-trace-id` per request and
 *     `x-zcode-session-type: main`; the coding-plan routes also carry `x-query-id` and
 *     `x-session-id`, which the plan gateway route omits.
 *
 * Eligibility is endpoint-based: only destinations that meter a plan subscription —
 * the coding paths (`/api/coding/paas/v4`, the BigModel Responses v1 route) and the
 * zcode.z.ai plan gateway — qualify. Pay-as-you-go endpoints (`/api/paas/v4`) have no
 * subscription quota, so identifying there would be pointless noise.
 */
import { randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";

const ZCODE_APP_VERSION = process.env.ZCODE_PLAN_APP_VERSION?.trim() || "3.11.2";
const ANTHROPIC_SDK_UA = "ai-sdk/anthropic/3.0.81";
const ZCODE_PLAN_ORIGIN = "https://zcode.z.ai";

function printable(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && /^[\x20-\x7e]+$/.test(v) ? v : undefined;
}

function osCategory(p: string): string {
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "linux";
}

function clientLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
  } catch {
    return "unknown";
  }
}

function clientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    return "unknown";
  }
}

/** True for plan-metered Z.ai/Zhipu destinations (coding-plan and plan-gateway routes). */
export function isZcodePlanMeteredEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  const url = baseUrl.replace(/\/+$/, "").toLowerCase();
  return url === "https://zcode.z.ai/api/v1/zcode-plan"
    || url === "https://zcode.z.ai/api/v1/zcode-plan/anthropic"
    || url === "https://api.z.ai/api/coding/paas/v4"
    || url === "https://open.bigmodel.cn/api/coding/paas/v4"
    || url === "https://open.bigmodel.cn/api/v1";
}

/** Companion headers the official client sends on every LLM completion. */
export function buildZcodeIdentityHeaders(opts: { userAgentSuffix?: string } = {}): Record<string, string> {
  const version = printable(ZCODE_APP_VERSION);
  const osPlatform = printable(process.env.ZCODE_IDENTITY_PLATFORM ?? platform()) ?? "";
  const osArch = printable(process.env.ZCODE_IDENTITY_ARCH ?? arch()) ?? "";
  const osRelease = printable(process.env.ZCODE_IDENTITY_RELEASE ?? release());
  const releaseChannel = process.env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
  return {
    "HTTP-Referer": ZCODE_PLAN_ORIGIN,
    "User-Agent": `ZCode/${version ?? "unknown"}${opts.userAgentSuffix ? ` ${opts.userAgentSuffix}` : ""}`,
    ...(version ? { "X-ZCode-App-Version": version } : {}),
    "X-Title": "Z Code@cli",
    "X-Release-Channel": releaseChannel,
    "X-Client-Language": clientLanguage(),
    "X-Client-Timezone": clientTimezone(),
    ...(osPlatform && osArch ? { "X-Platform": `${osPlatform}-${osArch}` } : {}),
    ...(osPlatform ? { "X-Os-Category": osCategory(osPlatform) } : {}),
    ...(osRelease ? { "X-Os-Version": osRelease } : {}),
    "X-ZCode-Agent": "glm",
  };
}

/** Fresh per-request attribution headers; scope selects the coding-plan-only pair. */
export function buildZcodeTraceHeaders(scope: "start-plan" | "coding-plan" = "coding-plan"): Record<string, string> {
  return {
    "x-request-id": randomUUID(),
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": randomUUID(),
    ...(scope === "coding-plan" ? { "x-query-id": randomUUID(), "x-session-id": randomUUID() } : {}),
  };
}
