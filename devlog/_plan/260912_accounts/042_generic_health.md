# Show the existing pool's selection and health state

Cycle generic-health depends on lifecycle. Existing pseudonymous account attribution at `src/providers/label.ts:41`, usage log serialization at `src/usage/log.ts:554`, summaries at `src/usage/summary.ts:1237` are reused, not recreated.

MODIFY existing OAuth health DTO/projector and `src/server/management/oauth-account-routes.ts` to expose bounded selection reason and health/cooldown scope alongside per-account quota. MODIFY `gui/src/hooks/useProviderAccountPools.ts` typed account projection, shared current/all-account card renderer and locale catalogs for reason. CLI account status uses same closed reason. Aggregate pool counts by healthy/cooling/reauth and known/unknown quota; do not sum unlike family/window percentages into fictitious capacity.

```ts
type GenericSelectionReason = "affinity" | "manual" | "quota" | "round-robin" | "fill-first" | "auth-failover" | "quota-failover";
```

Creation: admitted generic selector; serialization: authenticated account DTO and required per-attempt usage history; deserialization: typed optional client fields; consumers: status/account card/aggregate counts. No raw user/account/credential identifiers added to logs. Tests cover missing legacy fields, successful recovery clearing error, removed accounts, family-specific cooldown display and stale response merge. Source/structure/user docs align. Local suites/build NOT RUN; hosted final cumulative tip and rendered account card required.

Reflection REF-02 accepted: request-history reason is REQUIRED. Add optional accountSelectionReason/accountQuotaScope to PersistedUsageAttempt in src/usage/log.ts and normalize/serialize closed unions. Stamp after admission per attempt in src/server/request-log.ts and core, preserving prior attempts. Update request-history API/client detail renderer and all localized labels. Legacy rows omit safely. Regression source covers persistence/reload, multi-account retries, and no overwrite of earlier reason.
