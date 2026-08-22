# WP1 — #1894 direct Gemini wire id (Wave 5A-1) — rev 2 after audit

> Rev 2 folds audit blockers 1-4. The 404-triggered retry proposed in rev 1 is
> **dropped**: AI Studio installs no `fetchResponse` (`src/adapters/google.ts:384`),
> so the adapter can never observe the 404; the only hosts are the core pre-stream
> recovery loop or the mid-stream terminal guard, and the latter would splice two
> upstream turns into one client stream.

## Defect

`GEMINI_DIRECT_WIRE_RENAMES` (src/adapters/google.ts:58-61) unconditionally
rewrites `gemini-3.7-flash` -> `gemini-3.7-flash-tiered` for every direct Google
deployment. Two live captures disagree:

- `a70bb78d4` (2026-08-14): bare 404s, `-tiered` 200s.
- #1894 (2026-08-16): bare 200s, `-tiered` 404s, `models.list` has no `-tiered` row.

Neither reporter is wrong; the spelling differs per account/rollout. A static
default therefore breaks one population whichever value it takes.

## Decision (rev 2)

**Land #1739 only.** It is the whole of WP1's production change. No new
mechanism ships in this work-phase.

#1739 real state: head `e1c7ec85e`, OPEN, `MERGEABLE/BLOCKED`,
`reviewDecision=CHANGES_REQUESTED`. Its diff is larger than rev 1 recorded:

| #1739 change | Note |
|---|---|
| `resolveDirectGeminiWireModelId(modelId, applyRenames)` | the config gate |
| new `googleMode === "vertex" ? parsed.modelId` branch | Vertex keeps requested identity |
| `messagesToGeminiFormat(parsed, identityModelId)` signature change | **the open review finding** |
| `identityModelId` split for CCA vs direct | stops the `-tiered` wire spelling leaking into the model identity line |

The identity split is a real second bug fix — without it the system prompt tells
the model it is `gemini-3.7-flash-tiered`. The open reviewer finding is that the
fix is applied too broadly across Google modes; that must be resolved before
landing, not merged as-is.

## Deferred to its own work-phase: discovery-resolved spelling

The durable fix is to stop guessing and read what the account advertises.
`src/oauth/index.ts:811` already issues `/v1beta/models?pageSize=1000` per
provider. A later work-phase can resolve the wire spelling from that listing,
keyed on destination + credential identity exactly as
`src/responses/reasoning-replay-cache.ts:65` does, with an explicit
`directGeminiWireRenames` value always winning over any inferred spelling.
That is a separate PABCD cycle, not a rider on #1739.

## File change map (WP1 as executed)

| File | Change |
|------|--------|
| `src/types.ts` | `directGeminiWireRenames?: boolean` (from #1739) |
| `src/config.ts` | zod boolean + round-trip incl. explicit `false` (from #1739) |
| `src/adapters/google.ts` | config gate, Vertex identity branch, `identityModelId` split (from #1739, review finding resolved) |
| `tests/config.test.ts` | persisted `false` round-trip; non-boolean rejected (from #1739) |
| `tests/google-adapter.test.ts` | default/true/false wire ids; CCA unaffected; identity line uses the base id (from #1739) |
| `docs-site/.../providers.md` | document the setting (from #1739) |

## Scope boundary

IN: direct AI Studio wire id resolution and the identity string derived from it.
OUT: any new retry/recovery mechanism; `src/server/responses/core.ts`;
Antigravity/CCA resolution; picker/catalog/usage/price keys (all stay on the base id).

## Accept criteria (with activation)

1. Default (setting absent) sends the `-tiered` id.
   *Activation:* `buildRequest` on a default provider; assert the URL path.
2. `directGeminiWireRenames: false` sends the bare id.
   *Activation:* adapter built with the flag false; assert the URL path.
3. The system-instruction identity names the base id, never the `-tiered` spelling.
   *Activation:* parse the built body `systemInstruction.parts[0].text` and assert
   it contains `powered by the gemini-3.7-flash` and NOT `-tiered`.
4. Cloud Code Assist request paths are unchanged by the flag.
   *Activation:* build with `googleMode: cloud-code-assist` and both flag values.
5. Config round-trips an explicit `false`; a non-boolean is rejected to fallback.

Verifier: `bun test tests/google-adapter.test.ts tests/config.test.ts tests/gemini-37-flash-migration.test.ts`
— all three exist and read the change target.

## Closure

#1894 gets the `bug` label (it is a real regression, currently labeled
`provider-compatibility,provider` only). It closes only once #1739 is on
`origin/dev` with 1-5 green. Because the default still favors the `-tiered`
population, the closing comment must tell the #1894 reporter to set
`directGeminiWireRenames: false` — closing silently would leave them broken.
