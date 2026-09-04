import { clearCodingAgentBinaryCache, type CodingAgentProviderProfile } from "../coding-agent/profile";

/**
 * Region-isolated profiles for the official CodeBuddy Code CLI.
 *
 * CodeBuddy Global and CodeBuddy CN are SEPARATE credential destinations (§五/§十四/§十六). They
 * share one adapter, one binary name, and the shared coding-agent stream-json parser; the region is
 * fixed by the officially documented `CODEBUDDY_INTERNET_ENVIRONMENT` value (`public` for the
 * overseas/global product, `internal` for the China product) — the vendor states: "使用
 * CODEBUDDY_API_KEY 时，必须根据版本正确配置 CODEBUDDY_INTERNET_ENVIRONMENT". A global key is never
 * sent to the CN environment or vice versa.
 *
 * Evidence (verified 2026-09-03): npm `@tencent-ai/codebuddy-code` v2.143.0 (Tencent Cloud);
 * keys https://www.codebuddy.ai/profile/keys (Global) / https://copilot.tencent.com/profile/keys (CN);
 * headless https://www.codebuddy.ai/docs/cli/headless.
 */
export interface CodeBuddyProfile extends CodingAgentProviderProfile {
  family: "codebuddy";
  /** Official `CODEBUDDY_INTERNET_ENVIRONMENT` value for this region. */
  internetEnvironment: "public" | "internal";
}

export const CODEBUDDY_GLOBAL_PROFILE: CodeBuddyProfile = {
  providerId: "codebuddy",
  family: "codebuddy",
  region: "global",
  label: "CodeBuddy",
  internetEnvironment: "public",
  canonicalBaseUrl: "https://www.codebuddy.ai",
  binaryCandidates: ["codebuddy", "cbc", "codebuddy-code"],
  tokenEnv: "CODEBUDDY_API_KEY",
  installHint: "npm install -g @tencent-ai/codebuddy-code",
  documentationUrl: "https://www.codebuddy.ai/docs/cli/headless",
};

export const CODEBUDDY_CN_PROFILE: CodeBuddyProfile = {
  providerId: "codebuddy-cn",
  family: "codebuddy",
  region: "cn",
  label: "CodeBuddy CN",
  internetEnvironment: "internal",
  canonicalBaseUrl: "https://www.codebuddy.cn",
  binaryCandidates: ["codebuddy", "cbc", "codebuddy-code"],
  tokenEnv: "CODEBUDDY_API_KEY",
  installHint: "npm install -g @tencent-ai/codebuddy-code",
  documentationUrl: "https://www.codebuddy.cn/docs/cli/headless",
};

export const CODEBUDDY_PROFILES: readonly CodeBuddyProfile[] = [CODEBUDDY_GLOBAL_PROFILE, CODEBUDDY_CN_PROFILE];

/** Binary-discovery cache is shared across coding-agent families; re-exported for test isolation. */
export const clearCodeBuddyBinaryCache = clearCodingAgentBinaryCache;
