# CL-10 Final Review Closure

This addendum records the runtime contracts added after the final deep review of PR #1510. It supplements the earlier CL-10 hardening plan and does not expand scope into CL-10.5 remote publishing.

## Community mutation contention

Public-evidence mutation remains serialized across processes, but a live non-reclaimable owner is now a fail-fast condition. Synchronous callers receive `PublicEvidenceValidationError` with code `community_cache_busy` instead of blocking the JavaScript agent while polling.

The management API maps `community_cache_busy` to HTTP `503` and sets `Retry-After: 1`. Other public-evidence validation failures remain client errors. Stale-owner recovery, inode checks, exclusive reclaim claims, and ownership-safe release semantics are unchanged.

## Sensitive purge semantics

Once durable local provenance classifies a community cache pathname as locally originated, sensitive purge removes that exact pathname even if the cached object has become oversized, hardlinked, symlinked, or otherwise unreadable through normal community-object validation.

Deletion uses pathname unlink semantics only. It does not follow a symlink target and does not remove another hardlink to the same inode. `ENOENT` is treated as already absent; other unlink failures remain errors. Origin markers are cleared only after the community deletion pass and directory durability boundary complete.

## Revocation target errors

A direct same-publisher bundle revocation whose target bundle is absent is normalized to `PublicEvidenceValidationError` code `revocation_target` with message `revocation target bundle not found`. The optimized direct-target path must not leak platform-specific filesystem `ENOENT` errors.

## Regression requirements

The closure is protected by focused tests that require:

- live lock contention to return `community_cache_busy` in under 500 ms;
- the management community endpoint to return `503` plus `Retry-After: 1` for that contention;
- oversized locally-originated community copies to be removed during sensitive purge;
- hardlinked locally-originated cache pathnames to be removed while a peer hardlink survives; and
- missing direct revocation bundle targets to return stable `revocation_target` errors.

Exact-head GitHub Actions success is required before this closure is considered verified. PR #1510 must remain open and unmerged during this review cycle.
