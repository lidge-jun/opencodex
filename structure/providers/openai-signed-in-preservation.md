# Preserve Signed-In Codex Quota

`codexPreserveSignedInAccount` defaults off. `src/codex/account-preservation.ts` gives native main
and matching ordinary pool entries a lower effective priority band; stored per-ID priorities
remain unchanged inside each band. Eligibility, model evidence, quota headroom, manual pin ceilings
and every strategy still use the shared selection path. Unbound quota preemption compares these
same effective priorities; healthy bindings remain unless existing priority-failback rules apply.
Exact account routes bypass the preference. Fallback may spend reserved quota, never bypassing
pause, reauth, model access, hard lock or paid-credit consent.

`src/codex/signed-in-identity.ts` requires matching selected workspace and normalized member email.
Its process-local observation is published by existing physical-login lifecycle reads and the
owned linked-group read; request routing reads only memory, even during native profile drain.
Unknown/conflicting evidence never links a new ordinary row; transient failures and conflicting claims retain the last verified observation. Startup seeds the observation; later
owned observations follow login changes, and confirmed transitions clear stale observations.
Pool replacements are matched from their current credentials. Existing lifecycle transitions
purge main bindings. No credential or member identity is persisted by the policy.

`src/codex/auth-api/account-preservation.ts` exposes GET/PUT policy status under native-main
ownership and reports affected entry IDs and the actual unbound preview. A validated PUT saves
before releasing runtime state. Explicit application releases affected affinity scopes and manual
preference/pin only for subsequent requests; already-materialized requests retain their account.
The CLI (`src/cli/account-preservation.ts`) drives this API; linked pause remains the absolute
exclusion alternative.
