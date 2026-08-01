# 090 — WP9: Desktop 3P label normalization + output schema guard (D2)

Root cause in `030a_defect_investigation.md` §D2. This doc is the implementation
contract. Distinct from the request-path image guard (`anthropic-image-guard.ts`),
which already exists — this guards what we WRITE into the Desktop config.

## Scope

IN: normalize `labelOverride` so bracket markers like `[1m]` never reach a Desktop
label; validate the emitted `Desktop3pModelEntry[]` against the schema invariants
before it is written.
OUT: any change to alias generation (names are already hashed safely), any change to
the request/image path.

## D2a — label normalization

`displayModelId` (`src/claude/desktop-3p.ts:100-110`) splits on `-`/`_` and title-cases
parts, so `k3[1m]` renders as `K3[1m]`. Bracket segments are capability markers, not
name text. Normalize them:

```diff
 function displayModelId(modelId: string): string {
   return modelId
+    // Capability markers like [1m] are not name text: strip the brackets so the label
+    // reads "K3 1M", never "K3[1m]".
+    .replace(/\[([^\]]+)\]/g, "-$1")
     .split(/[-_]+/)
     .filter(Boolean)
     .map(part => {
       const lower = part.toLowerCase();
-      if (lower === "gpt" || lower === "glm" || lower === "ai") return lower.toUpperCase();
+      if (lower === "gpt" || lower === "glm" || lower === "ai" || lower === "1m") return lower.toUpperCase();
       return part.charAt(0).toUpperCase() + part.slice(1);
     })
     .join(" ");
 }
```

`k3[1m]` → `k3-1m` → parts `k3`, `1m` → `K3 1M`. Verified against the live alias:
the model NAME is still the hashed `claude-opus-4-8-kj2` (names were never the leak).

## D2b — the output schema guard

NEW `src/claude/desktop-3p-guard.ts`, mirroring the image-guard precedent (pure
validator, throws on violation, called at the write boundary):

```ts
/**
 * Write-path validation for the Desktop 3P model list. The request path has its own
 * guards (anthropic-image-guard.ts); this is the config-output counterpart. A bad
 * entry here ships inside a user-visible config file, so it fails LOUD at the write
 * boundary rather than silently producing a config Desktop rejects or mislabels.
 */
import type { Desktop3pModelEntry } from "./desktop-3p";

const NAME_PATTERN = /^claude-[a-z0-9-]+$/;
const MAX_LABEL_CHARS = 80;
/** Bracket capability markers must have been normalized away by displayModelId. */
const FORBIDDEN_LABEL_CHARS = /[[\]]/;

export function assertDesktop3pModelsValid(models: Desktop3pModelEntry[]): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (!NAME_PATTERN.test(model.name)) {
      throw new Error(`Desktop 3P model name is not a valid Claude-shaped id: ${model.name}`);
    }
    if (seen.has(model.name)) {
      throw new Error(`Desktop 3P model name duplicated: ${model.name}`);
    }
    seen.add(model.name);
    if (FORBIDDEN_LABEL_CHARS.test(model.labelOverride)) {
      throw new Error(`Desktop 3P label carries a raw capability marker: ${model.labelOverride}`);
    }
    if (model.labelOverride.length > MAX_LABEL_CHARS) {
      throw new Error(`Desktop 3P label exceeds ${MAX_LABEL_CHARS} chars: ${model.labelOverride}`);
    }
    if (model.supports1m === true && model.anthropicFamilyTier === undefined) {
      throw new Error(`supports1m set without a family tier: ${model.name}`);
    }
  }
}
```

Wait — the duplicate check: alias collisions are currently handled by SKIPPING
(`desktop-3p.ts:180-186` warns and skips). Throwing on duplicates would change that
behaviour. The guard instead validates what collision handling already guarantees:
duplicates must never REACH the write, so assert uniqueness of the final list — if the
skip logic ever regresses, the guard catches it at the boundary. That is the guard's
job.

Call site: inside `generateDesktop3pConfig` / `writeDesktop3pConfig` immediately before
serialization, so every write path (apply route, auto-apply, CLI) is covered:

```diff
   const inferenceModels = generateDesktop3pModels(nativeSlugs, routedModels, profile);
+  assertDesktop3pModelsValid(inferenceModels);
```

And `generateDesktop3pConfig` returns the config object, so guard there once.

## TESTS

`tests/desktop-3p-guard.test.ts` (NEW):

- `kimi/k3[1m]` produces `labelOverride` `K3 1M (kimi)` — no brackets
  (activation evidence for the normalization);
- the guard passes the output of the REAL generator for a representative catalog
  (natives + routed incl. `k3[1m]`, `gemini-3.1-pro`);
- the guard throws on: a name with uppercase/invalid chars, a duplicated name, a label
  containing `[`, an over-long label;
- the full `writeDesktop3pConfig` output for a real catalog passes the guard
  (integration, temp `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR`).

Existing suites must stay green: `tests/desktop-3p.test.ts`,
`tests/desktop-profile.test.ts`, `tests/claude-desktop-native-context.test.ts`.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/desktop-3p-guard.test.ts tests/desktop-3p.test.ts` | pass |
| `bun run typecheck` / full `bun run test` | green |
