import { clearCodingAgentBinaryCache, resolveProfileByBaseUrl, type CodingAgentProviderProfile } from "../coding-agent/profile";

/** Official Qoder CLI profile. Region variants are separate profiles and credentials. */
export interface QoderProfile extends CodingAgentProviderProfile {
  family: "qoder";
}

export const QODER_GLOBAL_PROFILE: QoderProfile = {
  providerId: "qoder",
  family: "qoder",
  region: "global",
  label: "Qoder",
  canonicalBaseUrl: "https://qoder.com",
  binaryCandidates: ["qoder", "qodercli"],
  tokenEnv: "QODER_PERSONAL_ACCESS_TOKEN",
  installHint: "npm install -g @qoder-ai/qodercli",
  documentationUrl: "https://docs.qoder.com/cli/authentication",
};

export const QODER_CN_PROFILE: QoderProfile = {
  providerId: "qoder-cn",
  family: "qoder",
  region: "cn",
  label: "Qoder CN",
  canonicalBaseUrl: "https://qoder.cn",
  binaryCandidates: ["qodercn", "qoderclicn"],
  tokenEnv: "QODERCN_PERSONAL_ACCESS_TOKEN",
  installHint: "npm install -g @qodercn-ai/qoderclicn",
  documentationUrl: "https://docs.qoder.cn/en/cli/authentication",
};

export const QODER_PROFILES: readonly QoderProfile[] = [QODER_GLOBAL_PROFILE, QODER_CN_PROFILE];
export function resolveQoderProfile(baseUrl: string | undefined): QoderProfile | undefined {
  return resolveProfileByBaseUrl(QODER_PROFILES, baseUrl) as QoderProfile | undefined;
}
export const clearQoderBinaryCache = clearCodingAgentBinaryCache;
