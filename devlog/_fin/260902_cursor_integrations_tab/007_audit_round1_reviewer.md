# 007 — Reviewer audit (Opus, arrived after the direct round in 005)

VERDICT: GO-WITH-FIXES (blockers=8). Disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 | `/api/integrations/*` would be a third prefix | folded — route is `GET /api/native-integrations/cursor` |
| 2 | capability vs exemption; ratchet only shrinks | folded — route added to the existing `["integration","native"]` capability (mutates stays true), `bun run skill:surface` |
| 3 | 000 said t() has no en fallback | folded — provider.tsx:25 falls back to en; `Record<TKey,string>` + locale-parity force every locale |
| 4 | English-seeded zh-TW prose fails locale-parity:161 | folded — zh-TW gets translated prose; `integrations.tab.cursor` allowlisted |
| 5 | DSH rename pinned at locale-parity:242 | folded — DSH_VISIBLE_COPY[locale][1] becomes "DSH"; `api.clientConfig.clientDsh` stays long |
| 6 | cursor-color.svg is two-ink; keep unmasked; NATIVE_MARKS entry mandatory | folded into 020 |
| 7 | surfaces test mock falls through to a file-client envelope | folded — add a cursor branch honoring failExtraSources; add cursor to the unknown loop and card coverage |
| 8 | TABS + hashes + render guard + mark must land together | folded — one commit |
| G | effort table placement; adapter has CURSOR_MODEL_EFFORT_TIERS | rebutted: the adapter table maps opencodex→Cursor backend tiers for the outbound provider; this table predicts what Cursor's *local runtime* renders, a different contract. Kept in models-capabilities.ts next to the schema it complements, with a comment naming the distinction. |
| D | bound the stored UA | folded — 80 chars, prefix-validated |
| B | apiKeyMode describes the public bind | folded — comment in the route |
