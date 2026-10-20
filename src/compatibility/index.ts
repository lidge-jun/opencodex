import { OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST } from "./openai-responses";
import { OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST } from "./opengateway-responses";
import type { CompatibilityManifestV1 } from "./manifest";

export {
  COMPATIBILITY_DISPOSITIONS,
  COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
  compatibilityManifestIssues,
  defineCompatibilityManifest,
} from "./manifest";
export type {
  CompatibilityClaimV1,
  CompatibilityDisposition,
  CompatibilityEvidenceKind,
  CompatibilityEvidenceRefV1,
  CompatibilityManifestV1,
  CompatibilitySubjectV1,
} from "./manifest";
export { OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST } from "./openai-responses";
export { OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST } from "./opengateway-responses";

export const COMPATIBILITY_MANIFESTS: readonly CompatibilityManifestV1[] = Object.freeze([
  OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST,
  OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST,
]);

export function getCompatibilityManifest(id: string): CompatibilityManifestV1 | undefined {
  return COMPATIBILITY_MANIFESTS.find(manifest => manifest.id === id);
}
