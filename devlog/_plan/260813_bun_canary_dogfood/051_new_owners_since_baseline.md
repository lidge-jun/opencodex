# New memory owners since `dd6c60b3`

Date: 2026-08-13  
Current checkout: `preview-dev@9973559e78a6319c1051b51bace9ce7c17ce8aff`

## Scan boundary

The requested changed-file command was run against
`dd6c60b3..9973559e78a6319c1051b51bace9ce7c17ce8aff`. Because the range contains
482 changed TypeScript files, the audit also scanned every added source file and
all current module-scope Maps/Sets/caches. Immutable vocabulary Sets, request-local
collections, and WeakMap/WeakSet owners were excluded because they cannot grow by
runtime key retention (`src/adapters/anthropic-output-schema.ts:3-12`;
`src/codex/catalog/filesystem-evidence.ts:58-60`).

The already-fixed workspace metadata cache is not an open finding: it now has a
128-entry cap, 30-second freshness and insertion-time expiry/oldest pruning
(`src/adapters/command-code.ts:211-249`).

## Confirmed new long-lived owners

| Owner | Growth driver | Current cleanup/bound | Classification | Action |
|---|---|---|---|---|
| Native-main hardened identities (`src/codex/native-main-claim.ts:25,74-90`) | Distinct `CODEX_HOME` claim paths/inodes | No cap or reconciliation | **Unbounded, MEDIUM** | Patch with 32-entry insertion-order LRU; eviction safely re-runs hardening. Exact diff: `050_memory_patch_roadmap.md:78-103`. |
| Lab installation salts (`src/lab/subject/installation-salt.ts:6-21,25-34`) | Distinct config roots | Fixed 32-byte values but uncapped path count | **Unbounded, MEDIUM** | Patch with 16-entry LRU. Exact diff: `050_memory_patch_roadmap.md:105-129`. |
| Codex mode-hint capability (`src/codex/features.ts:1039-1082`) | Binary path/version/stat fingerprint churn | No cap or TTL | **Unbounded, MEDIUM** | Patch with 8-entry LRU; a miss repeats inspection. Exact diff: `050_memory_patch_roadmap.md:131-161`. |
| Lab event-id index (`src/lab/ledger/store.ts:28,160-216`) | Every event id in every append-only ledger | No path, count, byte or age bound | **Unbounded, HIGH** | Remove the process index; duplicate-safe append already rebuilds the authoritative set under lock. Exact diff: `050_memory_patch_roadmap.md:163-187`. |
| Model-cache generation tombstones (`src/codex/model-cache.ts:48-50,163-171,225-248`) | Historical provider names | Reconciliation deletes data rows but increments/retains generation keys | **Conditionally unbounded, MEDIUM** | Further investigation; replace with explicit in-flight authority/epoch design before deleting keys. |

## New owners that are bounded or lifecycle-owned

| Owner | Why it is not an unbounded retained store |
|---|---|
| Workspace metadata (`src/adapters/command-code.ts:211-249`) | 128-entry insertion-time expiry/oldest pruning; already patched before this audit. |
| Upstream host health (`src/codex/upstream-host-health.ts:10-13,50-133`) | Hard 128 entries with prune paths and active-lease preservation. |
| Routing health history (`src/routing/health.ts:51-68,351-369`) | 64-entry cache with 1.5-second TTL and oldest eviction. |
| Reasoning replay (`src/responses/reasoning-replay-cache.ts:48-65,126-179`) | 64 entries, 256 KiB and one-hour TTL; local bounded exclusion. |
| Integration mutation flights (`src/server/management/integration-routes.ts:95,146-182`) | Finite client-id enum cardinality, same-key join/busy behavior, identity-safe `finally` deletion. |
| Native-main owner/startup maps (`src/codex/native-main-owner.ts:216-292`; `src/codex/native-profile-startup.ts:243-304`) | One row/live retained server home, deleted only after operations and ownership close. Eviction would detach a live SQLite/OS lock. |
| Stable lock entries (`src/codex/native-main-lock-file.ts:39-52,75-105`) | Ref-counted stable file descriptors; final release deletes the path row. |
| Lab automation scheduler/controllers (`src/lab/automation/orchestrator.ts:54-59,76-106,356-390,421-440`) | Config-root scheduler owners release on server cleanup; per-run controllers and cancellation ids delete in `finally`; process stop clears all. |
| User-cost overlay owners (`src/usage/user-cost-overlay-reconciler.ts:36-39,243-302`; `src/usage/user-cost-overlays.ts:51-111`) | Owner leases and intervals delete on stop; preservation state releases with its owner. |
| Catalog gather flights (`src/codex/catalog/provider-fetch.ts:212-227,1526-1552`) | Eight-flight admission gate and identity-safe `finally` deletion. |
| App-owned registration maps (`src/lib/app-owned-memory.ts:70-71`; `src/lib/app-owned-memory-stores.ts:76-166`) | Fixed startup registrations; these are ownership metadata for 12 retained and four observed stores, not traffic keys. |
| Translator live budgets (`src/lib/translator-budget.ts:101-128,158-165`) | One row/live request budget; disposal is required and aggregate bytes are observed. Per-turn finite byte limits reject coherent overflow. |

## Exclusions and false positives

- The Command Code refreshed-effort map cannot grow beyond the three compiled profile
  ids because unknown ids return before insertion (`src/providers/command-code-efforts.ts:3-16,58-80`).
- CLI dispatch aliases and supported-value Sets are immutable after module initialization
  (`src/cli/dispatch.ts:503-508`; `src/clients/config-export.ts:674-674`).
- Weak-key permit/session maps do not retain their object keys
  (`src/codex/catalog-write-serialization.ts:80-80`;
  `src/codex/catalog/filesystem-evidence.ts:58-58`).
- Lab MCP stub tools/invocations are test-only and are cleared after every owning test
  (`src/lab/live/mcp-loopback.ts:17-31`; `tests/lab-live-probe.test.ts:14-23`). If
  this stub becomes reachable from the live management server, add an invocation ring
  cap before enabling it.

## Result

Post-baseline source contains **four immediately patchable unbounded owners**, **one
conditionally-unbounded owner requiring authority-design work**, and **one test-only
uncapped owner excluded from production accounting**. All other reviewed additions are
immutable, weak-keyed, finitely capped, or owned by an explicit live lifecycle.
