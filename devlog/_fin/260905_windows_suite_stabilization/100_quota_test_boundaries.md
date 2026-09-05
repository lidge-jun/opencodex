# 100 — Portable quota child processes and bounded fixture setup

Class C3 after the quota route-registration finding; spec-satisfaction repair.
Trigger: run 33941712300 jobs 101240599941
and 101240599984. Goal: preserve cold-process/durable-restart and hard-cap
assertions on Windows. Non-goals: production store changes, larger timeouts,
skips, retries, ACL bypasses. Owner: main; agents read-only unless the plan is
amended. Stop on contrary child stderr or changed store semantics and re-plan.

## MODIFY tests/usage/quota-reset-seen-store.test.ts

At the real-second-process test, preserve the full file URL for dynamic import:

```diff
-const storeUrl = new URL("../../src/quota/reset-seen-store.ts", import.meta.url).pathname;
+const storeUrl = new URL("../../src/quota/reset-seen-store.ts", import.meta.url).href;
-const proc = Bun.spawn(["bun", script], {
+const proc = Bun.spawn([process.execPath, script], {
```

The corpus's dynamic-import-needs-file-url case refines the initial proposal:
an import specifier stays a URL; only a spawn argv script becomes fileURLToPath.
Keep JSON.stringify around the generated import URL. Replace stdout-only wait
with Promise.all of proc.exited, stdout.text and stderr.text; assert exitCode=0
with stdout/stderr in the assertion message, then return trimmed stdout. Keep
the sequential true/false assertions and OPENCODEX_HOME unchanged.

Replace the 2000-call hard-ceiling setup with this boundary probe (no mock):

```ts
const now = Date.now();
const future = now + 365 * DAY;
const path = join(getConfigDir(), "quota-reset-state.json");
const seeded = Object.fromEntries(Array.from({ length: 1_023 }, (_, index) => [
  `live-${index}`, { at: now, resetAt: future + index },
]));
writeFileSync(path, JSON.stringify({ version: 1, claims: seeded, events: [] }));
resetQuotaResetStoreForTests();
expect(claimCountForTests()).toBe(1_023);
expect(claimQuotaReset("boundary", now, future + 1_023)).toBe(true);
expect(claimCountForTests()).toBe(1_024);
expect(claimQuotaReset("nearer", now, future - 1)).toBe(true);
expect(claimCountForTests()).toBe(1_024);
expect(hasSeenQuotaReset("boundary")).toBe(false);
const expected = { ...seeded, nearer: { at: now, resetAt: future - 1 } };
expect(JSON.parse(readFileSync(path, "utf8")).claims).toEqual(expected);
expect(claimQuotaReset("furthest", now, future + 2_000)).toBe(false);
expect(hasSeenQuotaReset("furthest")).toBe(false);
expect(claimCountForTests()).toBe(1_024);
expect(JSON.parse(readFileSync(path, "utf8")).claims).toEqual(expected);
resetQuotaResetStoreForTests();
expect(claimCountForTests()).toBe(1_024);
expect(hasSeenQuotaReset("nearer")).toBe(true);
expect(hasSeenQuotaReset("boundary")).toBe(false);
expect(hasSeenQuotaReset("furthest")).toBe(false);
```

Hydration does not prune. Only a real insertion crosses 1024; the future dates
exclude age/settled pruning. Disabling insertion's prune must fail at 1025.
Disk equality and rehydration prove the retained claim is persisted, not merely
left in memory. This replaces 1024 setup writes with two production writes.

## MODIFY tests/usage/quota-reset-observation.test.ts

Add fileURLToPath import, wrap the existing helper URL with it, and spawn with
process.execPath. Collect exit/stdout/stderr concurrently and include stderr in
the zero-exit assertion. Keep the fresh child home and empty-event assertion.
Clean that private temp home only after the child exits, using the existing
test cleanup helper if teardown is added. No helper source change.

## Acceptance and verification

- Focused command: `bun test tests/usage/quota-reset-seen-store.test.ts tests/usage/quota-reset-observation.test.ts`.
- Typecheck: `bun run typecheck`. No local full suite.
- Original Windows red is captured in 009.1. Final integration uses existing
  ci.yml workflow_dispatch lane=all on a fixed task branch, never a moving dev ref.
- Mutant: temporarily omit claimQuotaReset's prune call; run only the hard-cap
  case, require failure at 1025, then restore source exactly. This is a local
  focused test, not a full suite. No mutant is committed or pushed.
- The initial test-only slice leaves store/schema untouched; the amendment below
  also repairs existing route/capability inventories and their generated reference. Existing
  corpus case covers the path issue; add this occurrence only after Windows proof.
- Verifiers name direct files and the production prune owner. CI commands were
  observed in the baseline logs; local focused command is executed during B/C.

## Quota integration inventory amendment (same newly merged feature)

Windows job101240600060 also fails management-route-registry reconciliation:
GET /api/quota-resets is absent; the dispatcher wrapper is unresolved. This is
platform-independent integration debt introduced with quota reset, not an OS
timing defect. The route and CLI implementation already exist. Extend wp8's
scope to the following four metadata/dispatch/derived-reference files; no
store, authentication, authorization or handler behavior changes.

MODIFY `src/server/management/route-registry.ts`: add beside the negated routes:

```ts
{ method: "GET", path: "/api/quota-resets", module: "server/management/quota-reset-routes", mutates: false, mechanism: "negated-guard" },
```

MODIFY `src/server/management-api.ts`: use the existing lazy namespace mount
pattern (routing profiles and Lab use the same helper):

```diff
-if (ctx.url.pathname !== "/api/quota-resets") return null;
+if (!pathInManagementNamespace(ctx.url.pathname, "/api/quota-resets")) return null;
```

The real handler keeps exact path and GET guards. Child paths now import that
handler before falling through; prefix collisions still do not load it. This
small lazy-load scope change is explicit, not disguised as no behavior change.
No route scanner exemption, duplicate owner entry, or assumed method is added.

MODIFY `src/cli/capabilities.ts`: declare the already-implemented command:

```ts
{
  command: ["provider", "resets"],
  summary: "Show recently detected quota resets.",
  routes: [{ method: "GET", path: "/api/quota-resets" }],
  flags: [
    { name: "--limit", value: "number", summary: "Maximum events to return." },
    { name: "--json", value: "boolean", summary: "Emit the API payload as JSON." },
  ],
  mutates: false,
  json: "payload",
},
```

MODIFY `skills/ocx/references/01_management_surface.md` mechanically via
`bun run skill:surface`, which renders the capability registry. No new command
implementation and no CLI-parity exemption: provider-runtime.ts already sends
the request. The value chain is declaration -> capability consumers and surface
renderer -> generated Markdown checked by skill-ocx.test.ts; no new type/enum.

Extra focused verification: management-route-registry.test.ts,
cli-capabilities.test.ts, skill-ocx.test.ts, quota-reset-notify.test.ts,
quota-reset-core-boundary.test.ts. Check exact GET, invalid limit, non-GET,
child path, prefix collision and lazy core boundary. Audit the dispatch diff
explicitly for auth bypass/import exposure; no workflow changes are planned.

## Roadmap audit

Independent gpt-6-astra/high reviewer: VERDICT PASS; no blocking issues. Auth
precedes dispatch; child/prefix fallthrough and the inert registry stay intact.
Main baseline focused registry+capability check: 27 pass / 3 fail (registry
reconciliation only), exit 1, matching Windows. This approves the design, not
implementation. The two superseded scope descriptions were synchronized.

## B-phase evidence amendment: activation fixture (one more quota test)

Final Windows job101240599990 and the local seven-file check both fail
quota-reset-notify.test.ts:515: activation expected true, actual false. The
config warning names webhookUrl. H1 is confirmed by the fixture's http URL
against config.ts's https-only schema. H2 (stale cache) is contradicted by the
explicit cache reset; H3 (network receiver failure) cannot explain failure
before activation/delivery. Do not change the schema or TLS validation.

MODIFY only that test's fixture: configure a reserved HTTPS URL
`https://hooks.example.test/activation`; wrap the existing fetch function in
the test to map exactly that URL to its already-existing loopback HTTP server.
Preserve method, body, headers, redirect and signal; other URLs delegate unchanged.
Record the requested HTTPS URL and assert one call. Restore fetch in finally.
The test still proves config -> activation -> quota writer -> actual HTTP body;
it deliberately does not claim TLS integration. Lower-level policy tests remain.
Replace the 40x25ms body polling with a completion promise resolved by the real
receiver. Implementation review caught that an outer test timeout does not
unwind an indefinitely awaited promise: race the receiver against the existing
INTERNAL_DEADLINE_MS, clear its timer in finally, and use SERVER_BUDGET_MS for
the real-server case. These are nested failure bounds, not polling sleeps.

Verification: rerun the original failing activation case, then the seven focused
files. The schema remains HTTPS-only; no fixture-only exception enters runtime.

## wp8 closeout

Implemented at `0db639aea`. Seven focused files: 110 pass, 0 fail, 476 assertions
(4.20 s). Typecheck exit0; privacy scan passed. Hard-cap prune mutant: expected
1024, actual1025 (exit1); restored source exactly, then 1pass/15assertions.
Missing-webhook fault: a transport stub withheld delivery with a 10ms watchdog;
the test rejected with `quota webhook was not received` and exited1 in126ms,
not an outer-timeout hang. Restored real transport and normal named deadline:
1pass/9assertions. Neither fault mutation was committed.

Independent implementation review: PASS after adding the bounded receiver wait
and moving the fetch override into try/finally. Original route guards and store
implementation remain unchanged. Windows integration remains open under wp9/c-6;
these local focused checks are not claimed as Windows proof.

Receipt-binding correction: the closeout documentation commit changed HEAD after
the privacy receipt, so D correctly refused it. Re-audited the docs-only delta
(PASS, implementation unchanged); recapture a check receipt after this final
documentation commit before closing wp8. No failed gate is recorded as success.
