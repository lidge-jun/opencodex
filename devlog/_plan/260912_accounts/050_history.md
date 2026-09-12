# Retain bounded raw quota observations

Cycle history; C3 persistence. Independent of reset-first strategy. Source: `src/codex/quota.ts:265` commits merged snapshots, `:678` persists latest-only, `:735` clears; `src/codex/quota-types.ts:1` defines quota windows. New history attaches only after writer-generation and native-main identity guards. No new dependency or optional subsystem import on the core path.

MODIFY `src/codex/quota.ts`: extend version-1 quota cache with optional bounded per-account history; store fresh raw observation fields (not carried windows) alongside updatedAt, and preserve explicit window reset identity. Credits-only writes do not append samples. Hydrate only validated bounded numeric rows, ignore malformed input, and deep-copy returned arrays. Bound both per-account samples (200) and retained age (30 days). Clear/reconcile removes matching history; unknown legacy files yield empty history. A stale main writer cannot append; native identity change clears old main observations before accepting new ones.

Before:
```ts
type QuotaDiskFile = { version: 1; quotas: Record<string, StoredAccountQuota>; mainPolicyQuota?: MainPolicyQuota };
```
After:
```ts
type QuotaDiskFile = { version: 1; quotas: Record<string, StoredAccountQuota>; mainPolicyQuota?: MainPolicyQuota; history?: Record<string, StoredAccountQuota[]> };
export function getAccountQuotaHistory(accountId: string): StoredAccountQuota[];
```

MODIFY `src/codex/auth-api.ts` account quota DTO to expose requested bounded history through a protected read route, preserving existing DTO compatibility. MODIFY CLI account quota read path to support history display/JSON with existing management transport. No secret/claim/tag is recorded; account key is the same local cache key, never an upstream bearer. Add tests in the existing quota cache test owner (or register a new domain test in both layout maps), plus protected API/CLI contract cases. Sync all `src/codex/` ownership docs using relevant statement or a cross-link; configuration docs explain retention and that snapshots alone do not establish token capacity.

Field chain: creation is guarded quota commit; serialization is existing atomic quota-cache writer; deserialization is bounded validated hydrate; consumers are copied history getter, authenticated API/CLI, then capacity in the next cycle. Acceptance: old cache compatibility; 201 observations retain 200; credits-only and stale generations append none; different reset windows stay distinguishable; main identity change and removal discard old rows; corrupt/unbounded disk input is ignored/bounded. Local runtime checks NOT RUN; hosted quota/API/CLI regression suite at final history/capacity tip.

Reflection REF-04: fixed aggregate bounds: 64 account identities, 4096 rows, 2 MiB serialized history payload and 4 MiB whole cache read bound. During append/hydrate evict oldest observed rows, tie-break account key; prune accounts absent from authoritative roster. Never include dynamic raw account identities in logs. History retains actual per-window provenance (response-header or WHAM where available), reset boundary and window family; partial inherited values do not count. Overlarge/malformed cache read fails to empty history without blocking newest quota. Tests include many-account overflow, byte overflow, deterministic ties and remove/restart.

A1 accepted: native main history is deliberately NOT hydrated from disk in this slice. It can be sampled in-process only after identity observation and cleared on identity change; persistence omits __main__. Pool history envelopes bind stable configured account identity and stored credential generation, pruning mismatches on hydrate. This avoids attributing offline identity replacements to an old main label. Acceptance explicitly covers main replacement while stopped and account-id reuse. Main cross-restart history remains a documented limitation; bounded durable history is provided for stored pool accounts.
