# 240 — P-4 client version probe

## Evidence

GetUsableModels accepted all three version strings with byte-identical
catalogs (204 entries): cli-2026.07.08-0c04a8a (ours), cli-2026.07.23-e383d2b
(senpi), cli-2026.02.13-41ac335 (our discovery pin). Live Run on the 07.08
pin works (P-5 turns completed).

## Verdict: NOOP (no forced bump)

No behavioral delta proven. Optional freshness bump to 07.23 is safe by this
probe but buys nothing measurable; keep the pin, keep the drift watch from
190 (api2direct reports).
