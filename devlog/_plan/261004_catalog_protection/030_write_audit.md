# A3 — Bounded catalog write audit

Depends on A2 intent metadata and owner refusal. Carry #6537 audit behavior with bounded private records.

## File changes

- NEW src/codex/catalog/write-audit.ts: fixed event fields target/outcome/reason/intent/writer/configSource, timestamp/pid/ppid, bounded safe command category and home-redacted identity; append best-effort to opencodex-catalog-audit.jsonl. Owner may create private file; foreign refusal may append only to existing regular file. Tail retention is bounded to 256 KiB and newest 400 records; no whole unbounded file read. Counts only, never model/provider IDs or raw command arguments.
- MODIFY src/codex/catalog-write-serialization.ts: append foreign refusal without creating audit file, preserve unavailable result even on audit error.
- MODIFY src/codex/internal/catalog-writer.ts: successful changed catalog/cache writes and actual refusals emit exactly one event; identical bytes emit none. Register created audit path in existing uninstall manifest only with real file config; audit failure never masks core outcome.
- MODIFY src/codex/catalog/retained-sync.ts and src/codex/convergence.ts: emit refusals that occur before low-level funnel, avoid double records.
- NEW tests/codex-integration/codex-catalog-write-audit.test.ts: source audit tests plus hard byte/record limits, privacy-safe metadata and IO-error behavior.
- MODIFY both test registries, owner test audit expectations where appropriate, structure/codex-home.md.

Field chain: fixed event producers at K/writer/retained/convergence → JSON line encoder → optional human diagnostics; runtime has no audit replay. Unknown existing JSON lines are retained only within bounded tail, never executed. Event inputs are trusted internal typed values; external bytes use regular-file and size checks.

## Acceptance

Run write-audit, owner, intent and source removal/convergence regressions plus common gates. Trigger changed write/refusal/no-op: one/one/zero records. Foreign with absent file: no creation. Foreign with owned existing file: append only within capacity; otherwise skip without mutation. Oversized audit: bounded retained bytes/records. Metadata excludes supplied token-like argv/model/provider strings. Existing symlink/nonregular file: skip. IO errors: core write result unchanged. File mode private on POSIX; Windows native ACL behavior remains a stated evidence gap.

Layer: best-effort diagnostic only; same-user direct file mutation can bypass it. Audit is not an authorization source. No security certification claim.

A3 coordination decision: use existing canonical K to serialize all append/rotation. Move foreign-refusal audit emission into a K-held refusal path without minting a write permit; K authorizes coordination, not publication. For early failures that cannot acquire K, skip best-effort audit. Append/trim use one descriptor and a bounded tail read, cap serialized event length, and truncate/write while K is held; audit damage from process death remains diagnostic-only. Tests simulate concurrent K writers and validate every final line parses and both byte/record ceilings hold. Do not introduce a second global lock or unlocked foreign append.

A3 concrete refinement: NEW catalog/write-audit-contract.ts owns intent/event metadata below serializer and adapter; serializer re-exports existing intent type. Serializer exposes permit-checked audit wrapper and calls the adapter under K for refusal without granting a permit. Adapter takes explicit safe metadata, never argv or arbitrary property spreading. Fixed writer category, at/pid/ppid, redacted bounded home, target/intent/outcome/reason/config source/counts; 2 KiB event ceiling. Tail read at most 256 KiB plus boundary byte; retain only complete records, enforce both 256 KiB and 400 records including new event. Owner may compact the same verified descriptor; foreign access is strictly append-only, skipping malformed/oversized/full files without truncation, creation or chmod. Existing registration rejects external CODEX_HOME paths; attempt registration only on owner creation with file config and document rejected external artifacts as uninstall residuals. Do not widen uninstall ownership policy. Acceptance includes registration rejection, partial lines, foreign-at-cap skip and concurrent complete records. Decisions A3-C1 through C5 accepted from architect.

Final A3 proposal/reflection ALIGNED and independent audit PASS, zero blockers; the last concrete refinement is authoritative where earlier source-carry wording is broader.
