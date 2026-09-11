# 003 — Live drift at the A gate, and the disposition of competitor PR #2360

Round-2 audit returned **VERDICT: PASS** on the amended documents, with one non-blocking
observation: the backlog moved while work-phase 0 was running. This document records the
drift and disposes it, so the roadmap locks against reality rather than against a
snapshot.

## Drift measured at the A gate

Open PRs: **45 at unit open → 50 now**. Zero PRs left the open set, so the `000`
inventory is still valid as far as it goes; five arrived, all from one contributor
(`chilung-cgu`) within a twelve-minute window.

| PR | Base | Head | Size | Created | Title |
|----|------|------|------|---------|-------|
| #2360 | `dev` | `c4e38608` | 137+/12- (4f) | 08-22 08:27 | fix(tools): repair integral float arguments for native integer fields |
| #2361 | `dev` | `b4c0b949` | 70+/2- (2f) | 08-22 08:32 | fix(reasoning): support per-effort field omission sentinel (`__omit__`) |
| #2362 | `dev` | `64e7e62c` | 141+/3- (3f) | 08-22 08:34 | feat(providers): Responses terminal repair escape hatch for custom providers |
| #2363 | `dev` | `299d87f9` | 61+/0- (3f) | 08-22 08:36 | feat(catalog): apply configured auto_review_model override during sync |
| #2364 | `dev` | `33322b41` | 292+/1- (7f) | 08-22 08:39 | feat(providers): model-specific routing for Vercel AI Gateway (draft) |

Head drift on four already-inventoried PRs: #2351 `916fc9f2→829997d3`,
#2339 `e646ad6e→4fb942d4`, #2311 `9fbfa19b→b7b5c5f1`, #2310 `1acf7343→93b977d3`.
Every phase re-reads its PR's head at its own P; the `000` table is explicitly
"captured at unit open" and is not treated as current at merge time.

## #2360 competes directly with WP3

#2360 fixes issue #2316 — the same issue WP3 exists to fix — and its commit carries
`closes #2316`. It cannot be ignored: two fixes for one issue would either conflict or
double-land.

**Where it agrees with WP3.** Its core is the same shape the amended `030` specifies:
thread the property key into `coerceValue`, and treat a known Codex-native integer field
as integer-declared even when the schema says `number`. That part is correct, and it is
the whole of Defect A.

**Where it carries the defects this unit already identified.**

1. **It re-introduces the `collaboration.ts` alias that `002`/B2 rejected**, and does so
   *without* the uniqueness guard:

   ```ts
   for (const alias of toolChoiceAliases(t)) {
     toolParameterSchemas.set(alias, t.parameters);
   }
   if (!toolParameterSchemas.has(t.name)) toolParameterSchemas.set(t.name, t.parameters);
   ```

   The existing bare-alias path at `src/server/responses/collaboration.ts:154` deliberately
   refuses when `bareNameCounts.get(t.name) !== 1`. This loop bypasses that policy, so with
   two namespaced tools sharing a logical name, one tool's schema can be used to repair the
   other's arguments.

2. **`lookupToolParameterSchema` resolves ambiguity by iteration order.** Its fallback

   ```ts
   for (const [key, schema] of toolParameterSchemas.entries()) {
     if (key.endsWith(`__${toolName}`)) return schema;
   }
   ```

   returns the **first** map entry whose key ends with the bare name. With
   `a__wait_agent` and `b__wait_agent` both present, which schema wins depends on
   insertion order, not on a rule.

3. **A much broader allowlist:** `timeout_ms`, `yield_time_ms`, `max_tokens`,
   `max_output_tokens`, `session_id`, `line`, `start`, `end`, `priority`, `port`.
   `030` deliberately scoped WP3 to `timeout_ms` because that is the field the issue
   reports and the only one proven against a Rust `u64`. Names like `start`, `end`,
   `line`, and `priority` are generic enough to collide with a third-party tool that
   legitimately takes a fractional value, and the PR carries no evidence for them.

4. **It repairs with no schema at all** (`coerceIntegerToolArguments` now proceeds when
   `parameters === undefined`). Combined with the broad allowlist, an unknown provider's
   `priority: 1.0` would be silently rewritten. The existing guard test survives only
   because `undeclared` is not an allowlisted name.

## Disposition

**#2360 → REBUILD (absorb core, remove the rest).** Not closed: the contributor found the
same root cause and their key-threading core is right. Not merged as-is: it re-introduces
a collision policy bypass this unit already analysed and rejected, plus an order-dependent
resolver and an unevidenced allowlist.

WP3's terminal action becomes: land the minimal, evidence-backed fix, credit #2360, and
close it as superseded with these specific reasons recorded — or, if the contributor
prefers, leave it open with the three defects restated. The `closes #2316` keyword on
#2360 stops being a hazard the moment WP3 closes #2316 on its own merits.

## New work-phase (LOOP-UNIT-CHAIN-01)

The four remaining new PRs (#2361, #2362, #2363, #2364) are independent of every existing
lane, so they become a new appended work-phase **wp9**, not an excuse to close the goal.
Note #2361 supersedes the wrong-base #2357 (both address #2356), and #2363 addresses
#1225, which is still OPEN — so #2041 (the conflicting `auto_review_model` PR in wp8)
now has a mergeable competitor and must be disposed against it.

## Reconciliation, restated

```
50 open  =  45 at unit open  +  5 arrived during wp0
         =  wp1(5) + wp2(18) + wp3-disposes(#2360) + wp7(4) + wp8(15) + wp9(4)
            ... reconciled mechanically at wp8/wp9 C against a LIVE gh pr list
```

The final reconciliation runs against a live query, never against this table.

