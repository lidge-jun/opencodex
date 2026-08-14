# 020 — Phase 2: remove Lab from the per-request path

Unit: `260814_lab_core_decoupling`. Depends on: [`010`](./010_lifecycle_shutdown_registry.md).

## The defect being fixed

`src/server/responses/core.ts:36` statically imports `resolveProductionRouteSubject`, and
the block at `1997-2009` calls it inside `handleResponsesInner` (line 1476) on **every
request attempt** — streaming and non-streaming alike, once per attempt and once per combo
child. No configuration disables it.

The call is not free even though it creates no Lab state. `resolveProductionRouteSubject`
delegates to `resolveCompatibilitySubjectsForInboundWire`
(`routing/compatibility/subject.ts:175`), which calls Lab protocol-subject construction and
digest functions (`subject.ts:68,76`) *before* it checks for an installation salt at line 89.
A profile-less install therefore runs Lab digest work on every request and discards it.

## What must be preserved

`labRouteSubjectId` is a live product surface, not dead weight. Written to `usage.jsonl`
(`usage/log.ts:297`), read by `lab/query/passive-production.ts:82`, exposed through
`GET /api/lab/production-signals` (`lab-routes.ts:198`), `ocx lab production-signals`
(`cli/lab.ts:241`), and the Compatibility Matrix GUI (`CompatibilityMatrix.tsx:194`).

Installs that use routing profiles keep this. Installs that do not, lose nothing they had.

## Design

A nullable linker slot in core. Core calls it if populated, skips if null, and never
imports Lab. `handleResponsesInner` is already `async` (line 1476), but the slot is
deliberately **synchronous**: the hook must never delay the upstream request, which the
existing CL-09 comment states as a requirement. A synchronous slot keeps that guarantee
structurally instead of by convention.

## NEW: `src/server/passive-route-linker.ts`

```ts
/**
 * Optional per-attempt route-identity linker.
 *
 * Compatibility Lab attaches an opaque route-subject digest to request attempts so its
 * passive-production surface can correlate them later. That is an opt-in subsystem, so
 * the core request path holds only a slot: null on installs that never activate Lab.
 *
 * Contract for any implementation registered here: synchronous, side-effect free with
 * respect to the request, and non-throwing. The request path must never be delayed,
 * retried, or altered by identity linkage.
 */
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { InboundWire } from "../providers/registry";

export type PassiveRouteLinker = (
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  inboundWire: InboundWire,
) => string | null;

let linker: PassiveRouteLinker | null = null;

/** Install the linker. Returns a detach function. */
export function setPassiveRouteLinker(next: PassiveRouteLinker): () => void {
  linker = next;
  return () => {
    if (linker === next) linker = null;
  };
}

/**
 * Resolve the attempt identity, or null when no subsystem is active.
 * Never throws: linkage is best-effort metadata and must not affect the request.
 */
export function resolvePassiveRouteSubjectId(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  inboundWire: InboundWire,
): string | null {
  if (!linker) return null;
  try {
    return linker(config, providerName, modelId, routed, inboundWire);
  } catch {
    return null;
  }
}

/** Test-only reset. */
export function resetPassiveRouteLinkerForTests(): void {
  linker = null;
}
```

## MODIFY: `src/server/responses/core.ts`

Line 36 — swap the Lab import for the core slot:

```diff
-import { resolveProductionRouteSubject } from "../../routing/compatibility/subject";
+import { resolvePassiveRouteSubjectId } from "../passive-route-linker";
```

Lines 1993-2009 — the call block becomes a slot lookup:

```diff
-  // CL-09: attach only the opaque exact route-subject identity to the attempt.
-  // This is best-effort passive metadata: no Lab state is created and failure
-  // must never alter, retry, or delay the upstream request.
-  if (logCtx.activeAttempt && !logCtx.activeAttempt.labRouteSubjectId) {
-    try {
-      const passiveSubject = resolveProductionRouteSubject(
-        config,
-        route.providerName,
-        route.modelId,
-        route.provider,
-        inboundWire,
-      );
-      if (passiveSubject) logCtx.activeAttempt.labRouteSubjectId = passiveSubject.subjectId;
-    } catch {
-      // Omit passive linkage when exact subject construction is unavailable.
-    }
-  }
+  // Optional route-identity linkage for attempt correlation. Resolves to null unless an
+  // opt-in subsystem registered a linker, so an install without routing profiles does no
+  // work here and loads no additional module.
+  if (logCtx.activeAttempt && !logCtx.activeAttempt.labRouteSubjectId) {
+    const passiveSubjectId = resolvePassiveRouteSubjectId(
+      config,
+      route.providerName,
+      route.modelId,
+      route.provider,
+      inboundWire,
+    );
+    if (passiveSubjectId) logCtx.activeAttempt.labRouteSubjectId = passiveSubjectId;
+  }
```

The `try/catch` moves into the slot helper, so the non-throwing guarantee now lives with
the mechanism rather than being restated at each call site.

## NEW: `src/lib/lab-passive-linker-registration.ts`

The Lab-side adapter. Lives outside `src/lab/` for the same reason the other
`src/lib/lab-*.ts` host-integration modules do: it is the seam, not the subsystem.

```ts
/**
 * Registers Compatibility Lab's passive route-subject linker into the core slot.
 * Imported only from the lazy Lab activation path (see 030), never from the request path.
 *
 * @internal host integration only
 */
import { setPassiveRouteLinker } from "../server/passive-route-linker";
import { resolveProductionRouteSubject } from "../routing/compatibility/subject";

export function registerLabPassiveRouteLinker(): () => void {
  return setPassiveRouteLinker((config, providerName, modelId, routed, inboundWire) => {
    const subject = resolveProductionRouteSubject(config, providerName, modelId, routed, inboundWire);
    return subject ? subject.subjectId : null;
  });
}
```

## Unchanged

`src/usage/log.ts` keeps `labRouteSubjectId` (line 50), `isLabRouteSubjectId` (214), and
the normalization at 297. The field is optional and already tolerates absence — legacy
attempts without linkage are explicitly covered at
`tests/lab-passive-production-evidence.test.ts:54-67`. Renaming it would break the on-disk
format for existing installs to no benefit; it stays.

## Tests

NEW `tests/passive-route-linker.test.ts`:

1. With no linker registered, `resolvePassiveRouteSubjectId` returns null and no Lab
   module is loaded.
2. A registered linker is invoked with the exact arguments and its value is returned.
3. A throwing linker yields null instead of propagating.
4. Detach restores the null state.

MODIFY `tests/lab-passive-production-evidence.test.ts:272-279`: the architecture guard
currently asserts `expect(source).toContain("resolveProductionRouteSubject")` against
`responses/core.ts`. Invert it to assert the *boundary* — core must NOT contain
`resolveProductionRouteSubject` and must NOT import from `routing/compatibility/` — and
move the positive assertion onto `src/lib/lab-passive-linker-registration.ts`.

NEW end-to-end assertion: with the Lab linker registered, a request populates
`labRouteSubjectId`; without it, the attempt is written with the field absent and the
usage entry still validates. This closes the gap the phase-1 explorer found — there is
currently no request-level test proving the hook populates the field at all.

## Accept criteria

- `rg -n "routing/compatibility|lab/" src/server/responses/core.ts` returns nothing.
- Profile-less request path executes zero Lab code (proven by test 1).
- With the linker registered, `labRouteSubjectId` is populated exactly as before.
- `bun x tsc --noEmit` exits 0.
