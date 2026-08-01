# 010 — WP1: adopt opencodex-owned orphans (diff-level)

One work-phase, one cycle. All edits land in `src/grok/inject.ts` plus one new test
file. No other production file changes.

## Ownership predicate

The whole design hangs on one question: is this table ours? Answer conjunctively, and
bias every uncertain case toward "not ours" (F1).

A table qualifies as an opencodex orphan when ALL of:

1. its header is a PLAIN `[model.<alias>]` — never `[[model.x]]`, never
   `[model.x.sub]` (F3: those spellings mark human authorship and stay reserved);
2. it sits OUTSIDE the managed region;
3. it carries `api_key = "opencodex-loopback"` — the strong signal, a literal string we
   own and no human has cause to type;
4. its `base_url` is a loopback URL (`127.0.0.1` / `localhost`) — corroborating, and it
   keeps us from adopting an entry someone copied our api_key into while pointing at a
   real remote host.

`extra_headers = { "x-opencodex-grok" = "1" }` is deliberately NOT required: the oldest
orphans predate it, and requiring it would leave exactly the entries causing #511
unadopted. It is accepted as an additional positive signal but never as the sole one.

The `ocx-` alias prefix and the `OCX ` name prefix are NOT part of the predicate (weak;
a human could write either).

## New code

```ts
/** A plain [model.<alias>] table outside the fence that opencodex itself wrote. */
interface OrphanTable {
  alias: string;
  /** Offsets into the NORMALIZED (\n) content: header start .. next header or EOF. */
  start: number;
  end: number;
}

const OPENCODEX_API_KEY = "opencodex-loopback";

function isLoopbackBaseUrl(value: string): boolean
function tableBodyKeys(body: string): Map<string, string>   // bare `k = "v"` scan, quoted values unwrapped
function findOpencodexOrphans(content: string, region: ManagedRegion | null): OrphanTable[]
function removeOrphanTables(content: string, orphans: OrphanTable[]): string  // splice back-to-front
function rewriteAliasReferences(content: string, renames: Map<string, string>): string
```

`findOpencodexOrphans` reuses `MODEL_TABLE_HEADER` and `canonicalKeySegment` so the scan
that ADOPTS and the scan that RESERVES can never disagree about what an alias is. It
records each match's span as header-start to next-header-start (or EOF), which is the
F4 defence — the whole table moves, never a line range.

## Wiring into `injectGrokConfig`

Current sequence (`src/grok/inject.ts:227-245`):

```
read -> normalize EOL -> findManagedRegion -> orphaned-marker refusal
     -> buildGrokManagedBlock(..., userModelAliases(content, region), ...)
     -> splice -> restore EOL -> write
```

New sequence, with the sweep placed AFTER the orphaned-marker refusal (F8) and INSIDE
the normalized window (F6):

```
read -> normalize EOL -> findManagedRegion -> orphaned-marker refusal
     -> orphans = findOpencodexOrphans(content, region)
     -> content = removeOrphanTables(content, orphans)          // aliases now free
     -> recompute region against the SHORTENED content           // offsets moved!
     -> buildGrokManagedBlock(..., userModelAliases(content, region), ...)
     -> splice -> rewriteAliasReferences(...) -> restore EOL -> write
```

**The offset recomputation is load-bearing.** `region.start/end` were measured against
the original string; removing bytes above the fence shifts both. Splicing with stale
offsets would cut the file in the wrong place. `findManagedRegion` is re-run rather than
arithmetic-adjusted, because it is the same function that defines the boundary
everywhere else.

## Reference rewriting (F2)

After the block is built we know the surviving alias for each model. For every removed
orphan alias we compute its replacement by matching on the `model = "<id>"` value — the
field that identifies the actual model, not the alias. Then `[models] default` and
`[ui] fork_secondary_model` are rewritten:

```
default = "ocx-gpt-5-6-sol"   ->   default = "ocx-gpt-5-6-sol-2"
```

Only bare `key = "value"` assignments at the top level of `[models]` / `[ui]` are
rewritten, and only when the current value exactly equals a removed alias. If a removed
model has no surviving entry (F5), the reference is LEFT ALONE and that orphan is NOT
removed — a working config with a stale duplicate beats a broken `default`.

Note the suffix does not disappear on the first run: `-2` remains the live alias because
the un-suffixed name is only freed during this same write. A second sync then allocates
the clean name. Both states are correct; the test asserts the reference tracks whichever
alias survives, not a specific string.

## Tests (`tests/grok-orphan-adoption.test.ts`, NEW)

Fixture built from the real shape in `000`: an orphan `[model.ocx-gpt-5-6-sol]` with no
`context_window` above the fence, the correct `-2` entry inside it, `default` pointing at
the orphan, plus a hand-written `[model.my-own]` and a `[[model.arr]]`.

- adoption removes the orphan and leaves exactly ONE table per model;
- the surviving table carries the authoritative `context_window`;
- `[models] default` is rewritten to the surviving alias (F2);
- the hand-written `[model.my-own]` survives byte-identically (F1) — including when it
  points at a loopback `base_url` but carries no opencodex api_key;
- `[[model.arr]]` is never adopted and stays reserved (F3);
- a table whose api_key is ours but whose base_url is REMOTE is not adopted (F1);
- keys of the table FOLLOWING a removed orphan are intact (F4);
- running the sync twice is idempotent and reports `changed: false` the second time (F7);
- CRLF input comes back CRLF (F6);
- an orphan with no surviving catalog entry is left in place and `default` untouched (F5);
- an orphaned begin-marker still refuses to modify anything (F8).

## Out of scope

`stripGrokConfig` is untouched: `ocx stop` removing the fence should not also delete
adopted-but-not-yet-swept entries. Reformatting user content. Changing the alias
allocator.
