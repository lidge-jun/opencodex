# 020 — WP2: config-surface parity for the three missing keys

One full PABCD cycle. Depends on WP1 (`010`) because it extends the same TOML edit
helpers and must not conflict with the translation change.

## Scope

Three upstream keys have no OpenCodex reader or writer:

| Key | Upstream shape | Upstream semantics |
|---|---|---|
| `[agents].enabled` | `boolean`, defaults true | Off switch for multi-agent tools; an enabled `features.multi_agent_v2` overrides it |
| `[agents].max_depth` | `integer` | V1 nesting depth only; **ignored by V2** |
| `features.multi_agent_v2.subagent_developer_instructions` | `string` | Replaces inherited parent developer instructions for V2 children without role-specific instructions |

This phase adds readers, writers, and types. Exposure through the management API and
CLI is WP3 (`030`), deliberately separated so this phase closes on pure config-layer
tests.

## Change map

| Path | Action |
|---|---|
| `src/codex/features.ts` | MODIFY — readers/writers for all three keys |
| `src/types.ts` | MODIFY — `OcxConfig` fields where a persisted OpenCodex mirror is needed |
| features test file | MODIFY — parity tests per key |

## Diff 1 — `agents.enabled` reader

MODIFY `src/codex/features.ts`. Insert after `getAgentsMaxThreads` (ends line 141).

NEW:

```ts
/**
 * Current `[agents] enabled`. Upstream defaults this to true and lets an enabled
 * `features.multi_agent_v2` override a false value entirely
 * (codex-rs multi_agent_version_override), so `null` here means "unset, upstream
 * default applies" and is NOT the same as `true`.
 */
export function getAgentsEnabled(configPath?: string): boolean | null {
  const content = readConfigText(configPath);
  if (content === null) return null;
  const agents = tomlTableBody(content, "agents");
  if (agents === null) return null;
  const m = agents.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/m);
  return m ? m[1] === "true" : null;
}
```

The tri-state return is load-bearing. Collapsing unset into `true` would make it
impossible for the GUI to distinguish "user has not chosen" from "user chose on", and
would make a later write unconditionally materialize a key the user never set.

## Diff 2 — `agents.enabled` writer

MODIFY `src/codex/features.ts`. Model it on the existing `editAgentsMaxThreads` helper
(read it at P; it lives near line 237 and already handles creating the `[agents]` table
and removing a key when passed `null`).

NEW, mirroring that helper's signature and rollback contract:

```ts
/**
 * Persist `[agents] enabled = value`, or remove the key when `value` is null.
 * Reuses the same scoped-edit contract as `editAgentsMaxThreads`: create the table
 * when absent, never touch unrelated keys, and leave the file byte-identical when
 * the value already matches.
 */
export function setAgentsEnabled(
  value: boolean | null,
  configPath?: string,
): { ok: true; changed: boolean } | { ok: false; error: string }
```

Implementation note for B: factor the shared "edit one scalar key inside `[agents]`"
logic out of `editAgentsMaxThreads` rather than copying its regex handling. WP1 already
touches that region, so the refactor lands on top of a known-good state.

## Diff 3 — `agents.max_depth`

Same pattern as Diff 1 and Diff 2, with one behavioral caveat that must appear in the
code comment, not only here: upstream **ignores** `max_depth` under V2. Any surface
that shows this value must not imply it constrains V2 nesting.

```ts
/**
 * Current `[agents] max_depth`. Upstream applies this to V1 agent threads only and
 * ignores it under V2 (config.schema.json: "Maximum nesting depth for V1 agent
 * threads. Ignored by V2."). Do not present it as an effective V2 limit.
 */
export function getAgentsMaxDepth(configPath?: string): number | null
export function setAgentsMaxDepth(
  value: number | null,
  configPath?: string,
): { ok: true; changed: boolean } | { ok: false; error: string }
```

Note the constraint change: upstream dropped the `minimum: 1` bound on `max_depth` in
this range, so the writer must not reintroduce a `>= 1` validation that upstream no
longer enforces.

## Diff 4 — `subagent_developer_instructions`

MODIFY `src/codex/features.ts`. This key lives under `features.multi_agent_v2`, so it
must handle the same three encodings `getMaxConcurrentThreads` already handles: the
dedicated `[features.multi_agent_v2]` table, the inline
`multi_agent_v2 = { ... }` form, and the bare boolean form which has no room for a
value.

```ts
/**
 * Current `features.multi_agent_v2.subagent_developer_instructions`.
 *
 * Upstream tri-state (codex-rs agent/role.rs + control/spawn.rs):
 *   unset        -> the child inherits the parent's developer instructions
 *   non-empty    -> replaces the inherited parent fragment
 *   empty string -> clears the inherited fragment
 *
 * So `null` and `""` are DIFFERENT values and both must round-trip.
 */
export function getSubagentDeveloperInstructions(configPath?: string): string | null
export function setSubagentDeveloperInstructions(
  value: string | null,
  configPath?: string,
): { ok: true; changed: boolean } | { ok: false; error: string }
```

Two implementation constraints for B:

1. The value is free-form text and will contain quotes and newlines. Use a TOML
   multi-line basic string (`"""..."""`) when the value contains a newline or a double
   quote, and escape per TOML rules otherwise. A naive `"${value}"` will corrupt the
   config for realistic instruction text.
2. Upstream's `MultiAgentV2ConfigToml` carries `#[serde(deny_unknown_fields)]`. A
   misspelled key here is not ignored by upstream, it is a hard config-parse failure
   that breaks the user's Codex entirely. Spell it exactly, and add a test asserting
   the emitted key name character-for-character.

## Diff 5 — types

MODIFY `src/types.ts`. Add fields to `OcxConfig` (declared line 514) only for values
OpenCodex needs to persist on its own side. `agents.enabled` and
`subagent_developer_instructions` are user-facing settings the GUI will own, so they
need mirrors; `max_depth` is read-only reporting and does not.

```ts
/**
 * Mirror of native `[agents] enabled`. Undefined means "not managed by opencodex";
 * upstream then applies its own default of true.
 */
agentsEnabled?: boolean;

/**
 * Mirror of native `features.multi_agent_v2.subagent_developer_instructions`.
 * An empty string is meaningful (clears inherited instructions) and is not the
 * same as undefined.
 */
subagentDeveloperInstructions?: string;
```

## Accept criteria

1. Each of the three keys round-trips through its reader and writer without disturbing
   neighboring keys in the same table.
2. `getAgentsEnabled` returns `null` for an absent key, `true`/`false` when present.
3. `getSubagentDeveloperInstructions` distinguishes absent (`null`) from empty (`""`).
4. A multi-line instruction value containing `"` and `\n` round-trips byte-exactly.
5. The emitted key names match upstream character-for-character, asserted directly.
6. `max_depth` accepts values upstream accepts, including values below 1.
7. Writing a value that already matches leaves the file byte-identical.

### Activation scenarios

| Path | Trigger | Observable |
|---|---|---|
| `[agents]` table absent | config with no `[agents]` | writer creates the table, existing content unchanged |
| inline `multi_agent_v2 = { ... }` form | config using the inline form | instructions key lands inside the inline table |
| bare boolean `multi_agent_v2 = true` | that form + a write | form upgraded to inline, mirroring the existing `setMaxConcurrentThreads` behavior |
| multi-line quoting branch | value containing `"` and newline | emitted TOML re-parses to the identical string |
| removal branch | writer called with `null` | key gone, table and siblings intact |

The bare-boolean upgrade and the multi-line quoting branch are the two most likely to
ship dead. Drive both with real fixture content.

## Verification gate

`bun run typecheck` plus the features test file green, with all seven criteria as
explicit assertions and each activation scenario driven by its own case.

---

# Audit fold-back (A-phase, blocker 4, High)

An independent review found this doc not diff-level executable: all three writers were
signatures plus "model it on / read it at P", and the string writer left TOML
serialization unspecified while proposing `"""..."""`, which is unsafe when the value
itself contains `"""`. Accepted. This section supersedes Diff 4's serialization guidance.

## The concrete string encoder

Do not use multi-line basic strings. A single-line basic string with full escaping
handles every case including embedded `"""`, and avoids the whole class of
delimiter-collision bugs. Character-by-character rather than chained `replace` calls,
because chained replacement re-processes its own output:

```ts
/**
 * Encode a string as a TOML single-line basic string.
 *
 * Character-by-character on purpose. A chained-replace implementation
 * (`.replace(/\\/g, "\\\\").replace(/\t/g, "\\t")`) corrupts input: the backslash pass
 * runs first, then later passes insert NEW backslashes that the first pass can no
 * longer protect. Verified failing during planning; see the appendix.
 */
function encodeTomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case '"': out += '\\"'; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      default: {
        const code = ch.codePointAt(0)!;
        out += code < 0x20 || code === 0x7f
          ? `\\u${code.toString(16).padStart(4, "0")}`
          : ch;
      }
    }
  }
  return out + '"';
}
```

## A real Bun trap the tests must route around

While validating the encoder under Bun 1.3.14, `Bun.TOML.parse` was found to decode a
`\t` escape incorrectly:

```
input TOML bytes : k = "tab\there"
parsed value     : "tab\fhere"
expected         : "tab\there"
verdict          : Bun.TOML MISHANDLES \t
```

The same value round-trips correctly through a multi-line form with a raw tab. The
encoder above is correct per the TOML spec; the *reader* in this Bun version is not.

Consequences for WP2, all mandatory:

1. **Do not assert round-trips through `Bun.TOML.parse` for control characters.** A test
   written that way will fail against a correct encoder and push the implementer toward
   "fixing" working code.
2. Assert the emitted bytes directly for control-character cases: given input
   `"tab\there"`, assert the written line is exactly `key = "tab\there"` as bytes.
3. `Bun.TOML.parse` is fine for the ordinary cases — plain text, embedded quotes,
   newlines, backslashes, and embedded `"""` all round-trip correctly — so keep using it
   there.
4. Re-check this on any Bun bump. If a later Bun fixes the decode, the byte-level
   assertions still hold, so nothing breaks.

Verified-passing cases through parse: plain text, `has "quotes" inside`,
`line one\nline two`, `back\slash`, `triple """ quotes`, empty string, and `crlf\r\nend`.

## Writer bodies, concretely

The three writers share one primitive. Extract it from the existing
`editAgentsMaxThreads` rather than duplicating its regex handling, and note that WP1
already touches that region, so this refactor lands on a known-good state.

```ts
/**
 * Set or remove one scalar key inside a top-level TOML table, preserving every other
 * line byte-for-byte. `encoded` is the already-serialized RHS (use
 * `encodeTomlBasicString` for strings, `String(n)` for numbers, `"true"`/`"false"` for
 * booleans). Passing `null` removes the key. Creates the table when absent.
 */
function editScalarInTable(
  content: string,
  table: string,
  key: string,
  encoded: string | null,
): string
```

Each public writer is then a thin wrapper that validates its own type and delegates.
`setSubagentDeveloperInstructions` additionally needs the inline-table upgrade path
already implemented by `setMaxConcurrentThreads`; reuse that mechanism rather than
writing a second one.

## Added accept criteria

8. `encodeTomlBasicString` output re-parses to the identical string for plain text,
   embedded quotes, newlines, backslashes, and embedded `"""`.
9. Control-character values are asserted at the byte level, not through
   `Bun.TOML.parse`, with a comment naming the Bun decode bug.
10. A chained-replace implementation is explicitly not used; a test with input
    containing both a backslash and a tab proves the character-wise path.

### Added activation scenario

| Path | Trigger | Observable |
|---|---|---|
| `\u` fallback branch | value containing `\u0001` | emitted bytes contain `\u0001`, asserted directly |
| embedded triple-quote | value containing `"""` | emitted single-line form re-parses identically |
| backslash-plus-tab | value `mixed \\" and \ttab` | emitted bytes correct; proves no re-processing |

The `\u` fallback is the branch most likely to ship dead: no realistic instruction text
contains a control character, so only a deliberate fixture will drive it.

---

# P-phase re-verification (2026-07-31, execution cycle)

Stale check against `dev` HEAD after WP1 landed (`d751aed51`). The translation helpers
WP1 added shifted line numbers but did not move any anchor this doc names:
`getAgentsMaxThreads` is still the right insertion neighbor (now lines 132-142),
`editAgentsMaxThreads` is at ~272, and the three upstream keys were re-verified in the
staleness audit (`005`) — `agents.enabled` (`config_toml.rs:686`, `Option<bool>`,
default true), `agents.max_depth` (`config_toml.rs:693`, `Option<i32>`, V1-only per
upstream's own comment), `subagent_developer_instructions`
(`feature_configs.rs:100`, `Option<String>`, under `#[serde(deny_unknown_fields)]`).

Three amendments, all from the execution-cycle staleness audit (`005`), each accepted.

## Amendment A — Diff 5 (types.ts mirrors) is REMOVED

`005` finding 1: these keys live in the native `config.toml`, and the management route
already reads native state directly (`agent-settings-routes.ts:107`). Adding
`agentsEnabled` / `subagentDeveloperInstructions` to `OcxConfig` would create a second
source of truth for one value, with sync bugs as the only possible outcome. WP3 reads
native state through this phase's readers; nothing mirrors into OpenCodex's own config.
`src/types.ts` is OUT of this phase's change map.

## Amendment B — the inline form needs a string-aware editor, not regex

`005` finding 2: the existing inline handling (`features.ts` `/^\s*multi_agent_v2\s*=\s*\{([^}]*)\}/m`)
terminates at the first `}` inside the body, so an instruction value containing `}` —
or any TOML escape worth having — corrupts the parse. The plan's "reuse the
`setMaxConcurrentThreads` inline mechanism" does not survive contact with free-form
text.

Final shape for B:

1. **Reader** `getSubagentDeveloperInstructions` scans the inline line with string
   awareness: locate `multi_agent_v2 = {`, walk to the matching `}` while skipping
   TOML basic strings (a `"` toggles in-string, `\` skips the next character), then
   extract the `subagent_developer_instructions` assignment from the body the same way
   and DECODE the escapes (`\\`, `\"`, `\n`, `\r`, `\t`, `\b`, `\f`, `\uXXXX`).
   The dedicated-table form is read with the existing `tomlTableBody` plus the same
   string-aware extraction, since the value may itself contain `#`.
2. **Writer** `setSubagentDeveloperInstructions`:
   - dedicated-table form: `editScalarInTable` with `encodeTomlBasicString`.
   - inline form: string-aware scan to the matching `}` (as above), then replace or
     insert the single-line assignment inside the braces, leaving every other byte
     untouched. Single-line basic strings are always legal inline, so no promotion to
     a dedicated table is ever required.
   - bare boolean form: upgrade in place to an inline table, mirroring
     `setMaxConcurrentThreads`'s existing boolean upgrade, carrying the new key.
3. A small shared private scanner (find matching `}` skipping strings; find key span
   within a body skipping strings) backs both reader and writer — one implementation,
   not two divergent ones.

## Amendment C — the helper refactor is bounded

The doc says to extract `editScalarInTable` "from the existing `editAgentsMaxThreads`".
That is scoped: write `editScalarInTable` as a NEW general helper shaped by that
function's logic, and leave `editAgentsMaxThreads` itself untouched — WP1 just landed
behavior pinned by 51 tests, and re-deriving it through the new helper is unscoped
risk for zero user-visible gain. All new helpers stay module-private (`005` finding 3:
only `setMaxConcurrentThreads` is exported today); only the six public readers/writers
are exported.

## Added accept criteria

11. No field is added to `OcxConfig`; `rg agentsEnabled|subagentDeveloperInstructions
    src/types.ts` stays empty.
12. An instruction value containing both `}` and `,` round-trips through the INLINE
    form without disturbing sibling keys — the case the regex approach provably
    corrupts.
13. An instruction value containing `#` round-trips without becoming a comment.

### Added activation scenarios

| Path | Trigger | Observable |
|---|---|---|
| string-aware `}` scan | inline form + value containing `}` | sibling keys after the value intact |
| escape decoder | stored `\\n` / `\\u0001` | reader returns the real characters |
| `#` inside value | value `keep # not comment` | written line intact on re-read |

---

# A-phase fold-back, execution cycle (verdict GO-WITH-FIXES, 2 High blockers)

Independent terra review. Both blockers accepted and folded; verdict qualifies as
near-pass under AUDIT-LOOP-01 because both are concrete amendments below, leaving no
residual.

## Blocker 1 (accepted) — the scanner must handle TOML literal strings

Amendment B's scanner skipped only basic strings (`"..."`). A hand-written valid value
like `subagent_developer_instructions = 'keep } literal'` would make the scan treat the
`}` inside the literal as the table close, corrupting a subsequent write. Our writer
always EMITS basic strings, but the reader/editor must survive user-authored TOML.

Final scanner contract for B:

- State machine over the inline body recognizes BOTH string kinds: basic `"..."` (an
  unescaped `"` closes; `\` skips the next character) and literal `'...'` (the next `'`
  closes; backslash is NOT special).
- Everything else (numbers, booleans, dates) contains no structural characters, so
  `}`, `,`, and `#` are only meaningful outside any string.
- The decoder mirrors this: basic strings unescape; literal strings are verbatim.
- Tests: inline literal-string values containing `}`, `,`, `#`, and `"` round-trip.

## Blocker 2 (accepted) — `max_depth` parity is the signed-i32 contract

Upstream type is `Option<i32>` (`config_toml.rs:693`) with no minimum; resolution only
defaults it (`mod.rs:3734-3738`) and runtime compares `depth > max_depth` directly
(`agent/registry.rs:76-77`) with no clamp. So:

- Writer validation is exactly `Number.isInteger(value) && value >= -2_147_483_648 &&
  value <= 2_147_483_647`. Writing `2147483648` would produce a config upstream cannot
  deserialize — a hard parse failure for the user's Codex, the worst failure class in
  this file.
- Reader grammar accepts signed decimals (`-?\d+`), not the `\d+` copied from
  `max_threads` — a copied reader would wrongly reject valid negatives.
- Tests: `-1`, `0`, both bounds accepted and round-tripped; `2147483648`,
  `-2147483649`, and non-integers rejected by the writer without touching bytes.

A negative `max_depth` effectively disables V1 child spawning upstream (any positive
next depth exceeds it) while V2 ignores the key entirely — the writer comment must say
this is a valid, meaningful configuration, not an error.

## Verified during this round (no code change needed)

- Upstream precedence confirmed exactly: V2 enabled wins first (`mod.rs:1521-1523`);
  `agents.enabled = false` only matters with V2 off (`:1524-1527`), where it disables
  V1/default. The Diff-1 doc comment's phrasing stands.
- Anchor drift recorded: `editAgentsMaxThreads` is at `src/codex/features.ts:268`,
  `applyConfigEditsAtomically` at `:417`, `setMaxConcurrentThreads` at `:207` (post-WP1).
- No `agentsEnabled`/`subagentDeveloperInstructions` references exist anywhere in
  `src/` or `gui/src/` — Amendment A's removal has no downstream collision.
- Bun 1.3.14 `\t` decode bug re-confirmed; byte-level assertions stand.
