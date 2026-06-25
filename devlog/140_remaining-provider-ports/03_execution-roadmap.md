# 140.03 — Phased execution roadmap (1 phase = 1 PABCD pass)

> Status: **PLAN ONLY** — no source modified. Turns the `02` survey into a phased, jawcode-grounded
> execution plan. Each provider = one decade phase = **one PABCD implementation pass** (gated by user
> approval before code lands, same contract as `02:3-4`). Follows the dev skill (modular, verify-first,
> decade numbering). Grounded in jawcode's actual port source (researched per-provider; cites in each phase doc).

---

## The five phases

| Phase | Provider | Strategy | Difficulty | jawcode core | opencodex doc |
|:-----:|----------|----------|:----------:|--------------|---------------|
| **10** | `google-vertex` | **extend `google`** + ADC | MEDIUM | `google-vertex.ts`, `google-auth.ts` | `10_phase1_google-vertex.md` |
| **20** | `google-antigravity` | **extend `google`** + OAuth | MEDIUM | `google-antigravity.ts`, `oauth/google-antigravity.ts` | `20_phase2_google-antigravity.md` |
| **30** | `amazon-bedrock` | **new adapter** + SigV4 + eventstream | HARD | `amazon-bedrock.ts`, `aws-sigv4.ts`, `aws-eventstream.ts` | `30_phase3_amazon-bedrock.md` |
| **40** | `kiro` | **new adapter** (import auth, reuses eventstream) | HARD | `kiro.ts`, `oauth/kiro.ts` | `40_phase4_kiro.md` |
| **50** | `cursor` | **new adapter** (HTTP/2+protobuf+exec) | HARD+ | `providers/cursor.ts` (2705L) | `50_phase5_cursor.md` → **`devlog/350`** |

## Sequencing + why (build order matters because of shared infra)

```
10 google-vertex     ─┐ establishes the google "mode" hook (config-branch in createGoogleAdapter)
20 google-antigravity ─┘ REUSES the 10 google-mode hook + adds OAuth
30 amazon-bedrock    ─┐ establishes the shared eventstream decoder + AWS SigV4 (src/lib/)
40 kiro              ─┘ REUSES the 30 eventstream decoder; adds import-auth + fingerprint headers
50 cursor            ── isolated (no shared code); largest unknown → last (detailed in 350)
```

- **10 before 20:** both are Gemini-SSE over the `google` adapter; vertex's mode-hook + ADC land first so antigravity only adds the OAuth + CCA-envelope branch.
- **30 before 40:** bedrock ports the AWS **eventstream binary decoder** into `src/lib/`; kiro reuses it verbatim (`kiro.ts:31` imports the same decoder).
- **50 last:** cursor shares nothing with the others and needs a transport escape hatch — see `350` for the full design.
- **Parallelizable after approval:** 10 (google branch) and 30 (eventstream/sigv4) touch disjoint files → can run concurrently; 20 waits on 10, 40 waits on 30.

## Shared infrastructure (build once, reuse)

| Module (NEW in opencodex) | Built in | Reused by | jawcode source |
|---------------------------|:--------:|-----------|----------------|
| `google` adapter mode-hook (`googleMode` config branch) | 10 | 20 | `google.ts` extension |
| GCP ADC resolver (`src/lib/gcp-adc.ts`) | 10 | — | `google-auth.ts` |
| OAuth registry pattern (`OAUTH_PROVIDERS` entry) | 20 | 50 | `oauth/index.ts:36-61` |
| AWS SigV4 signer (`src/lib/aws-auth.ts`, zero `@aws-sdk`) | 30 | — | `aws-sigv4.ts`, `aws-credentials.ts` |
| **AWS eventstream decoder** (`src/lib/eventstream-decoder.ts`) | 30 | **40** | `aws-eventstream.ts` |
| Transport escape hatch (`runTurn` hook) | 50 | — | (opencodex `350` §2) |

## The "1 phase = 1 PABCD pass" contract

Each phase doc (`10`–`50`) is scoped to a single PABCD implementation cycle: **P** plan + approval gate →
**A** port shared/auth modules → **B** build the adapter + wire `resolveAdapter` → **C** verify
(`bun test` + `bun x tsc --noEmit` + the per-phase minimal proof from `02:212-222`) → **D** record + ship.
No phase bundles a second provider; a phase may *internally* have sub-steps but stays one approval unit.

## Global gates (per phase, from dev skill + `02`)

1. `bun x tsc --noEmit` clean + `bun test` green (baseline per `110/00_overview.md:85-86`).
2. The phase's minimal proof (live or mocked stream, `02:212-222`).
3. No regression in existing adapters (anthropic/google/openai/azure/openai-responses).
4. Approval checklist items for that provider (`02:237-244`) signed off **before** coding.
5. Devlog record of the pass (this folder).

## Effort rollup (rough, from `02` grades + per-phase briefs)

| Phase | MVP effort | Risk |
|:-----:|:----------:|:----:|
| 10 vertex | 5–7d | Low–Med |
| 20 antigravity | 5d | Med |
| 30 bedrock | 7–10d | High |
| 40 kiro | 4–6d (after 30) | High |
| 50 cursor | 7–11d (MVP text) | Very High |

> Order of value/risk: ship 10→20 first (Gemini reach, low risk), then 30→40 (AWS-family), then 50 (cursor)
> as an isolated, separately-approved effort.

## Audit record (PABCD-A, jaw Backend employee)

A backend specialist independently audited `10`–`50` against jawcode + opencodex source. **Verdict:
PASS-with-fixes.** Confirmed sound: the extend-`google` vs new-adapter split, the sequencing
(10→20 google-mode hook; 30→40 shared `decodeEventStream`, verified `kiro.ts:31` + `amazon-bedrock.ts:37`
both import it; 50 isolated), the 1-phase-1-PABCD framing, and the auth approaches. **Fixed findings**
(all in Phase 20 + cites): (1) antigravity `parseStream` is **not** unchanged — it nests under
`response.candidates` vs opencodex's top-level `chunk.candidates`, so Phase 20 adds a mode-aware parser;
(2) `projectId` must be read from the stored credential (server injects only the bare token);
(3) added the `cloudcode-pa.googleapis.com` prod-fallback endpoint; (4) corrected jawcode cite prefixes
to `utils/oauth/…`.

→ Per-phase plans: `10`–`50`. Cursor detail: `devlog/350_cursor-provider-add/`.
