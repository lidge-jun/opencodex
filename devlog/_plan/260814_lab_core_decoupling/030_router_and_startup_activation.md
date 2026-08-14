# 030 — Phase 3: policy-evidence slot and lazy Lab activation

Unit: `260814_lab_core_decoupling`. Depends on: [`010`](./010_lifecycle_shutdown_registry.md),
[`020`](./020_request_path_gate.md).

## The constraint that dictates the design

`routeModelInternal` (`src/router.ts:504`) is synchronous, and so are its public wrappers
`routeModel` (654) and `routeConcreteModel` (684). Making them async to permit
`await import()` would touch ~11 production call expressions and ~272 test call sites, and
would break the synchronous subagent-fallback API — `tryRouteFallbackModel`
(`codex/subagent-model-fallback.ts:63`) feeds `isNativeModelQuotaExhausted:200`,
`isModelHealthBlocked:216`, `isSubagentModelUnavailable:234`,
`selectAvailableSubagentModel:269`, `noteSubagentModelFailure:298`, and
`applySubagentModelFallback:510`, none of which can await.

**Routing stays synchronous.** Rewriting the routing contract to relocate an import would
be a far larger and riskier change than the problem justifies.

## Design

`assemblePolicyCandidateEvidence` already splits cleanly along the needed line
(`assemble.ts:88-129`): compatibility work is fully enclosed in
`if (hasCompatibilityRequirements && compatibilityPolicy)`, while capability, health,
quota, and cost are unconditional. Phase 3 makes that existing split physical.

- **Core keeps** capability, health, quota, cost — the evidence routing always needs.
- **Lab supplies** compatibility evidence through a synchronous slot, populated at
  activation.

The slot is synchronous, so routing never awaits. Activation is asynchronous and happens
once, away from the request path.

## MODIFY: `src/routing/compatibility/assemble.ts`

Remove the two Lab-reaching imports and the subject/catalog/evidence block. Replace with a
slot lookup.

```diff
-import { resolvePolicyCompatibilitySubjects } from "./subject";
-import { loadCompatibilityCatalogSnapshot } from "./catalog";
-import { loadCompatibilityEvidenceSnapshot } from "./reader";
+import { resolveCompatibilityEvidenceProvider } from "./provider-slot";
```

Inside `assemblePolicyCandidateEvidence`:

```diff
   const compatibilityPolicy = profile.compatibility;
   const hasCompatibilityRequirements = Boolean(
     compatibilityPolicy && compatibilityPolicy.requiredSuites.length > 0,
   );
-  const resolvedByCandidate = new Map<string, ResolvedPolicyCompatibilitySubjects>();
-  let catalog: CompatibilityCatalogSnapshot = new Map();
-  let snapshot = { projectionAvailable: true, projectionIncompatible: false, bySubject: new Map() };
-
-  if (hasCompatibilityRequirements && compatibilityPolicy) {
-    // ...subject resolution, catalog snapshot, evidence snapshot...
-  }
+  // Compatibility evidence is supplied by an opt-in subsystem. When no provider is
+  // registered — the case for every install without compatibility-gated profiles — the
+  // evaluator sees no compatibility evidence and scores on capability/health/quota/cost
+  // exactly as it did before compatibility policy existed.
+  const compatibilityProvider = hasCompatibilityRequirements && compatibilityPolicy
+    ? resolveCompatibilityEvidenceProvider()
+    : null;
+  const compatibilityByCandidate = compatibilityProvider
+    ? compatibilityProvider(config, profile, compatibilityPolicy!, options)
+    : null;
```

and in the per-candidate map:

```diff
-    const compatibility = hasCompatibilityRequirements && compatibilityPolicy
-      ? attachCompatibilityEvidence(resolvedByCandidate.get(key), snapshot, catalog, compatibilityPolicy)
-      : undefined;
+    const compatibility = compatibilityByCandidate?.get(key);
```

`attachCompatibilityEvidence`, the subject resolution loop, and the snapshot loading move
wholesale into the provider module below. The logic is relocated, not rewritten.

## NEW: `src/routing/compatibility/provider-slot.ts`

```ts
/**
 * Slot for the optional compatibility-evidence provider.
 *
 * Routing is synchronous and must stay synchronous (see 030 rationale), so this is a
 * plain nullable reference rather than a dynamic import. The Lab implementation is
 * installed during lazy activation; installs without compatibility-gated routing
 * profiles never register one and never load the Lab module graph.
 */
import type { OcxConfig } from "../../types";
import type { NormalizedRoutingProfile, NormalizedProfileCompatibility } from "../profile";
import type { AssemblePolicyEvidenceOptions, CandidateCompatibilityEvidence } from "./types";

export type CompatibilityEvidenceProvider = (
  config: OcxConfig,
  profile: NormalizedRoutingProfile,
  policy: NormalizedProfileCompatibility,
  options: AssemblePolicyEvidenceOptions,
) => Map<string, CandidateCompatibilityEvidence>;

let provider: CompatibilityEvidenceProvider | null = null;

export function setCompatibilityEvidenceProvider(next: CompatibilityEvidenceProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

export function resolveCompatibilityEvidenceProvider(): CompatibilityEvidenceProvider | null {
  return provider;
}

export function resetCompatibilityEvidenceProviderForTests(): void {
  provider = null;
}
```

`src/router.ts:34` keeps importing `assemblePolicyCandidateEvidence`, which is now
Lab-free. **No change to `router.ts` itself** — the file's Lab reachability disappears
because its dependency stopped reaching Lab.

### Verify the quota chain is genuinely severed

`assemble.ts:7` imports `quotaEvidenceForCandidate` from `../quota`, and that is the entry
to the cycle documented in `000_plan.md`. Phase 1 cuts the cycle's closing edge at
`lifecycle.ts`, so this import no longer reaches Lab. Confirm with an actual module-graph
check in phase 4 rather than by reasoning.

## NEW: `src/lib/lab-activation.ts`

One activation entry point, idempotent, owning every Lab registration.

```ts
/**
 * Lazy Compatibility Lab activation.
 *
 * Nothing in the proxy core imports Lab. This module is the single place that does, and
 * it is itself imported dynamically, so a process that never activates Lab never loads
 * the ~69-module Lab graph.
 *
 * @internal host integration only
 */
import type { OcxConfig } from "../types";

let activation: Promise<void> | null = null;

/** True when the install has any routing profile or enabled Lab automation. */
export function labActivationRequired(config: OcxConfig, configDir?: string): boolean {
  if (Object.keys(config.routingProfiles ?? {}).length > 0) return true;
  return labAutomationPolicyEnabledOnDisk(configDir);
}

/** Activate once. Safe to call repeatedly and concurrently. */
export function ensureLabActivated(config: OcxConfig, configDir?: string): Promise<void> {
  activation ??= (async () => {
    const [{ registerLabPassiveRouteLinker }, { registerLabCompatibilityEvidenceProvider },
           { setLabAutomationDispatchDeps, startLabAutomationScheduler },
           { loadLabAutomationPolicy }, { createProductionLabRouteExecutor }] = await Promise.all([
      import("./lab-passive-linker-registration"),
      import("./lab-compatibility-provider-registration"),
      import("../lab/automation/orchestrator"),
      import("../lab/automation/persistence"),
      import("./lab-live-route-production"),
    ]);

    registerLabPassiveRouteLinker();
    registerLabCompatibilityEvidenceProvider();

    const executor = createProductionLabRouteExecutor({ configDir, loadConfig: () => config });
    setLabAutomationDispatchDeps({ configDir, loadConfig: () => config, routeExecutor: executor });
    if (loadLabAutomationPolicy(configDir).enabled) startLabAutomationScheduler(configDir);
  })();
  return activation;
}

export function resetLabActivationForTests(): void {
  activation = null;
}
```

`labAutomationPolicyEnabledOnDisk` reads the policy JSON directly with `node:fs` rather
than importing `lab/automation/persistence` — importing it to decide whether to import Lab
would defeat the purpose. The file is a small JSON document at a known path; a missing or
malformed file means "not enabled".

## MODIFY: `src/server/index.ts`

`startServer` is synchronous (line 492) with ~508 call sites, so it stays synchronous.
Lines 48-53 lose their Lab imports; lines 1738-1750 become a conditional, non-blocking
activation.

```diff
-import {
-  setLabAutomationDispatchDeps,
-  startLabAutomationScheduler,
-} from "../lab/automation/orchestrator";
-import { loadLabAutomationPolicy } from "../lab/automation/persistence";
-import { createProductionLabRouteExecutor } from "../lib/lab-live-route-production";
+import { labActivationRequired, ensureLabActivated } from "../lib/lab-activation";
```

```diff
   const labConfigDir = getConfigDir();
-  const productionLabRouteExecutor = createProductionLabRouteExecutor({ ... });
-  setLabAutomationDispatchDeps({ ... });
-  if (loadLabAutomationPolicy(labConfigDir).enabled) {
-    startLabAutomationScheduler(labConfigDir);
-  }
+  // Compatibility Lab is optional. Activate it only for installs that actually use it,
+  // and never block listen on it: startServer is synchronous and the proxy must serve
+  // traffic whether or not an optional subsystem finished wiring itself up.
+  if (labActivationRequired(config, labConfigDir)) {
+    void ensureLabActivated(config, labConfigDir).catch(err => {
+      console.warn(
+        "[lab] activation failed; Compatibility Lab features are unavailable:",
+        err instanceof Error ? err.message : err,
+      );
+    });
+  }
```

The deferred-activation window is real and accepted: for a few milliseconds after listen,
a policy route may assemble evidence before the provider registers. The evaluator already
treats absent compatibility evidence as unknown and applies the profile's configured
unknown policy, so the failure mode is a known, bounded one rather than a crash.

## MODIFY: management routes

`lab-routes.ts` and `lab-automation-routes.ts` statically import Lab, so mounting them
eagerly would re-defeat the boundary. Both must be reached through a dynamic import at
request time inside the management router, and the automation routes must call
`ensureLabActivated` before enabling a scheduler or dispatching a manual run — otherwise a
user who enables automation through the dashboard on a profile-less install gets a
scheduler with no dispatch dependencies registered.

## Tests

NEW `tests/lab-activation-boundary.test.ts`:

1. `labActivationRequired` is false for empty config, true with a routing profile, true
   with automation enabled on disk.
2. `ensureLabActivated` runs once under concurrent calls.
3. After activation, both the passive linker and the compatibility provider are registered.
4. Without activation, `assemblePolicyCandidateEvidence` returns candidates with
   `compatibility === undefined` and does not throw.

MODIFY existing compatibility-policy tests to activate the provider in `beforeEach`, since
they assert on compatibility evidence that is now provider-supplied.

## Accept criteria

- `rg -n "lab/|routing/compatibility/(subject|catalog|reader)" src/server/index.ts src/router.ts` returns nothing.
- Compatibility-gated profiles behave identically after activation.
- Profile-less startup registers nothing and loads no Lab module.
- `bun x tsc --noEmit` exits 0.
