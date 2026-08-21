# 110 — Global cross-train triage matrix and merge order

One global order (audit R1-B5): the sidecar stack lands FIRST (9 stacked branches;
cascading a rebase through them is the expensive direction), then the lighter triage
PRs rebase onto the post-stack dev head one at a time. Every individual merge requires
maintainer approval + required CI green (MAINTAINERS.md) — the user's 'CI as lagging
indicator' applies only to repair iterations between pushes, never to the merge click
itself (audit R1-B4).

## Global order

1. Sidecar stack bottom-up: #2203 -> #2204 -> #2206 -> #2209 -> #2211 -> #2238 ->
   #2242 -> #2243 -> #2245 (details + blocker inventory: doc 120).
2. #2227 integration unit (Chat default + unconditional OAuth tier policy, doc 100).
3. #2217 RESHAPED (not raw): rebase onto post-#2227 dev, reframe tests/docs as opt-in
   hardening, gate the compat rewrite to the opt-in Responses route.
4. Doc-130 atomic opt-in switch (wp11).
5. Remaining Responses fixes: #2237, #2229, #2228 (do not depend on the Responses
   default; still valuable for the opt-in lane and other Responses routes).
6. luvs01 / Ingwannu / docs PRs (matrix below).
7. Release prep (doc 140) -> lidge final gate (doc 150).

## Triage matrix (dispositions)

| PR | author | disposition | rationale |
|---|---|---|---|
| #2227 | olddonkey | MERGE (as doc-100 atomic unit) | owns the chat default |
| #2217 | olddonkey | RESHAPE then merge | opt-in-lane hardening; raw form encodes Responses-as-default |
| #2237 | olddonkey | MERGE after #2227 | null reasoning channel drop; wire-agnostic |
| #2229 | olddonkey | MERGE after #2227 | encrypted_content reshape guard; opt-in lane |
| #2228 | olddonkey | MERGE after #2227 | compaction blob provenance; wire-agnostic |
| #2214 | luvs01 | MERGE (address CHANGES_REQUESTED) | continuation binding bug |
| #2236 | luvs01 | MERGE (address CHANGES_REQUESTED) | catalog comment preservation |
| #2226 | luvs01 | MERGE after hygiene unblocked | secret redaction in events |
| #2196 | Ingwannu | MERGE | maintainer chore, privacy-bounded diagnostics |
| #2207 | Ingwannu | MERGE | google tool-result adjacency bug |
| #2202 | Ingwannu | MERGE | claude roster sync bug |
| #2181 | lidge-jun | MERGE (address CHANGES_REQUESTED) | devlog docs |
| #2168 | lidge-jun | MERGE (address CHANGES_REQUESTED) | devlog docs |
| #2235 | umyunsang | REVIEW-ONLY this train | contributor draft gate owns it |
| #2220 | Hylouis233 | REVIEW-ONLY this train | draft, capability sync |
| #2230 | ppvia | OUT (hygiene-blocked draft) | own cycle |
| #2222 | MarcTCruz | OUT (hygiene-blocked draft) | own cycle |
| #2216 | leon80900 | CLOSE-DIRECT (wrong branch, targets main) | ask re-file onto dev |
| #2215 | parkjs101 | OUT (docs draft, changes requested) | own cycle |
| #2213 | louis-tepe | OUT (draft, overlaps doc-130 design) | revisit post-switch |
| #2072 | olddonkey | DEFERRED (audit R2-B2) | Fast policy composes later; must re-verify against both wires |

Rebase anchors are named at execution time in each phase's B (exact dev head SHA),
with cascade verification (typecheck + focused suites) after every land.
