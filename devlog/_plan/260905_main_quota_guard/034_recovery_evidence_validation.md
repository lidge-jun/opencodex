# Recovery evidence validation and UI focus follow-up

Pauli identified a producer boundary missed by033: legacy normalizeUsagePercent clamps a negative reading to0. Such malformed input must not release retained policy99.

Keep legacy parsing/clamping unchanged. Add `parseMainPolicyUsageQuota(data)` beside parseUsageQuota: reject the message as policy evidence when any normal primary/secondary/tertiary percentage is negative (including numeric header/string forms), otherwise use the canonical parser. Unknown/non-numeric/missing percentages retain existing parser behavior and short-window shape; genuine0 remains valid. Reserve/Spark additional buckets do not become ordinary policy evidence.

Extend setAccountQuotaFromParsed with optional fifth `policyQuota` argument, defaulting to the typed quota input. For a live main writer, explicit null means retain matching existing trusted policy evidence, not replace it with normalized legacy0. A new/mismatched owner cannot inherit it. Untagged main writes continue invalidating policy provenance. Legacy accountQuota writes and their normalization are unchanged.

The owned WHAM producer passes independently validated policy evidence with its existing raw data and plan. The header applicator checks the three canonical percent headers before losing their sign and passes null on negative input. The future Reserve observer callback does the same through parseMainPolicyUsageQuota. This is a conservative invalid-message rule for policy only, not a global legacy parser change.

Add real-WHAM and header sequences: retained99 -> negative -1 (legacy may clamp0; policy remains blocked) -> genuine0 (policy ready, flag still on). Keep missing-short-window metadata cases and expiry-retained-block assertions intact.

UI PR3560 received a valid focus finding: disabling an enabled switch must arm focus restoration too. Set the restoration intent before either enable or disable. If failed save requires an authoritative reload, keep focus on the setting while disabled and restore the toggle after a successful reload. Add success/failure focus assertions without changing acknowledgment semantics. Main applies this on the UI parent during the same stack cascade, before Reserve implementation.
