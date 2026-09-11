# 000_plan — unit map

- 000_research.md — claim ledger + gap analysis
- 010_memory_diagnostics.md — extraMemorySize observability (PR parent, base dev)
- 020_watchdog_gc_relief.md — measurement-FIRST GC evaluation (Phase A harness),
  conditional idle-gated production hook (Phase B) per the 260731 gate
- 030_smol_workers.md — smol:true gated on per-worker large-fixture A/B
- 040_macmini_measurement.md — live measurement protocol (feeds 020 Phase A)

Stack shape: PR-A(010, base dev) → PR-B(020 Phase A harness + evaluation,
base PR-A head) → conditional PR for Phase B only on gate PASS;
PR-C(030, base dev, lands per-call-site with A/B evidence).
One decade doc = one work-phase = one PABCD cycle (LOOP-UNIT-CHAIN-01).
Audit round 1: FAIL (4 findings) → docs revised: 020 restructured
measurement-first honoring 260731_macos_rss_retention/040_allocator_residual
gate; 010 static-import sync seam; 030 pre-landing A/B gate; separate
lastReliefAt. See ledger.
