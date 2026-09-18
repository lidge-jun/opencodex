# Roadmap audit locks implementation boundaries

The source audit separates landed work from remaining acceptance. Pool design reflection (Pauli), eligibility/native-main reflection (Singer), and TUN reflection (Faraday) all aligned after concrete amendments. These are inherited-model independent reads; no native architect role or runtime execution is claimed.

Independent A reviewer Leibniz found three blockers: native history identity across offline login replacement, capacity attempt timing and truncated ledger attribution, and a warmup primitive that retries despite a one-attempt promise. Main accepted all three. Native history is not persisted in this slice, stored-pool history binds generation, capacity uses whole contained request intervals and rejects incomplete evidence, and scheduled warmup explicitly disables model fallback. Focused re-audit returned VERDICT: PASS on 2026-09-12, against 69e3dcda755a52feb1327edad6c8ea6cefd6e871.

Reader result: separate PRs deliver callback transport, policy reasons/selection, reset ordering, generic lifecycle, quota history/capacity, diagnostic classification, and native-main reauth. Source-backed findings justify each slice; next step is the independent callback implementation cycle. No implementation or remote verification exists yet. Local tests/build/typecheck/install: NOT RUN by user instruction. Source and doc checks do not establish runtime behavior.

Remaining acceptance constraints: authenticated TUN field evidence; native-main cross-restart history/token capacity intentionally omitted; generic recovery requires positive provider/post-refresh evidence (permanent refresh rejection and sidecar auth without such evidence stay terminal); one-shot warmup supports stored pool only. All remain visible in final issue dispositions and are not silently marked complete.

C correction: first git diff --cached --check rejected spaces in blank lines of the quoted public patch, so the chained commit did not run. Those documentation-only spaces were removed before retry. The B-to-C narrative mentioned a commit prematurely; the actual commit and receipt follow this correction.
