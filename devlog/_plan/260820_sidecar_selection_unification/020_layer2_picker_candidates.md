# 020 — Layer 2: unified picker candidate function + vision set (wp3)

Branch: codex/sidecar-picker-candidates (base: codex/sidecar-auth-slots).

## New file: src/sidecar/candidates.ts
```ts
export interface SidecarCandidate { provider: string; id: string; native?: boolean; inputModalities?: string[]; authSlot?: boolean }
export async function pickerVisibleSidecarCandidates(config: OcxConfig, auth: SidecarAuthState): Promise<SidecarCandidate[]>
// = listManagementModelRows(config).filter(disabled !== true)  (catalog outage → [])
//   ∪ sidecarAuthSlots(auth) marked authSlot: true (added even when hidden/disabled/absent)
// de-dup by provider+id; auth-slot flag wins.
export function visionSidecarCandidates(config, all: SidecarCandidate[]): SidecarCandidate[]
// = all − provably text-only (modelAcceptsImageInput(config, c) === false)
// auth slots carry inputModalities ["text","image"] like baselineCandidate today.
```

## Changes
- src/server/management/vision-sidecar-options.ts: visionCandidateRows → wrapper over pickerVisibleSidecarCandidates (keeps export shape); visionModelOptionsFrom feeds visionEligibleModelOptions ONLY picker-visible+auth-slot candidates. Baseline injection in visionEligibleModelOptions stays but baselines == auth slots when auth present; without auth, current baseline fallback preserved (no regression for fresh installs).
- Keep visionDescriberIsProvablyBlind gate semantics unchanged (write gate ≠ suggestion list).

## Tests: tests/sidecar-candidates.test.ts (+ update sidecar-settings-vision-filter.test.ts)
- Hidden native slug (disabledModels) disappears from options; Luna survives via auth slot.
- Routed provider's catalog row visible in rows appears; text-only proven row excluded.
- Catalog outage → auth slots + baselines only.

## Verify: bun x tsc --noEmit && bun test tests/sidecar-candidates.test.ts tests/sidecar-settings-vision-filter.test.ts tests/vision-eligibility.test.ts tests/catalog-vision-sidecar-modalities.test.ts

