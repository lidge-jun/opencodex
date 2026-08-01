# 010 — Phase 1: key identity, rename, honest delete, schema

Foundation phase. Every later phase writes to the key entry or its routes, so the
entry gets a validated shape and a truthful CRUD surface first. Nothing here is
visible in the GUI except one compatibility fix (below); phase 4 renders what this
phase makes possible.

Dependency position: first. Phase 2 reads `config.apiKeys` through a new
resolver, phase 3 records the `id` this phase guarantees is stable, phase 4
renders the rename this phase implements.

## Scope

IN

- MODIFY `src/types.ts` — declare the key entry as a named exported interface.
- MODIFY `src/config.ts` — explicit Zod schema for `apiKeys`.
- MODIFY `src/server/management/oauth-account-routes.ts` — random key generation,
  a longer displayed prefix, `PATCH` rename, DELETE that reports what it did,
  name validation.
- MODIFY `gui/src/pages/api-keys-utils.ts` — **B-phase addition.** The salvaging
  schema can now hand the GUI an empty `createdAt` (a working key whose date was
  hand-edited to a non-string is kept rather than revoked), and
  `formatCreatedDate` rendered that as `Invalid Date`. It returns an em dash
  instead. Added here rather than deferred to phase 4 because this phase is what
  makes the empty value reachable.
- NEW `tests/api-keys-routes.test.ts` — the first direct test of these routes.
- NEW `gui/tests/apikeys-created-date.test.ts` — the formatter's three cases.

OUT

- No admission change (phase 2), no telemetry (phase 3), no GUI (phase 4).
- No `expiresAt`, `revokedAt`, `scopes` (`002` §3 — out of unit).
- No change to `saveConfigPreservingClaudeCode` itself.
- Existing stored keys are not rewritten. Their bytes stay valid.

## Design

### The prefix has to discriminate

`ocx_data_` is nine characters and the mask keeps eight
(`oauth-account-routes.ts:444`), so every row reads `ocx_data...` (`001` W6). Two
ways out: mask more characters, or make the tail distinguishable. Both, actually
— the tail must be random for phase 4's rail to be readable, and the mask must
reach past the literal prefix to show it.

Generation moves to `randomBytes`, matching what management secrets already do
(`src/server/management-auth.ts:79-82`). Provider keys leave the hash input
entirely: they were never needed for uniqueness and their presence made the
secret's safety argument depend on concatenation rather than a direct random draw
(`002` §4).

The displayed prefix becomes `key.slice(0, 17)` — `ocx_data_` plus eight hex — so
two keys are distinguishable at a glance while the remaining 32 hex characters
stay unrevealed. 32 hex of a 40-hex random tail is 128 bits unrevealed, which is
not a meaningful weakening.

### Rename is PATCH, not a second POST

`name` already exists on the entry, so rename needs no schema growth
(`002` §3). It gets `PATCH /api/keys` with `{ id, name }` rather than overloading
POST, because POST returns key material and a rename must never be able to.

### DELETE must be able to fail

The handler filters and returns `{success:true}` unconditionally
(`oauth-account-routes.ts:464-469`), so deleting a stale id reads as a successful
revocation (`001` W5). Comparing length before and after is the whole fix.

### Validation belongs at the write boundary, not at config load

`configSchema` never declares `apiKeys`; it survives only via `.passthrough()`
(`src/config.ts:669-704`). The obvious move — add a strict array to the schema —
is a data-loss trap, and this document originally fell into it.

`loadConfig` parses, and on failure merges defaults and re-parses; if the retry
also fails it **backs up the file and returns `getDefaultConfig()`**
(`src/config.ts:1153-1159`). The merge repairs missing top-level fields; it does
nothing to a malformed element inside a user's `apiKeys` array. So a single bad
entry — or an entry with a name longer than whatever limit we pick, which
today's server happily accepts — would take out that user's providers, pool
accounts and every other key at once. The existing tests at
`tests/config.test.ts:165-220` do not cover this: they exercise `.catch()`-guarded
Claude and hostname fields, which repair to a default rather than failing the
parse.

A stricter `z.object({...})` would also **strip unknown per-key properties**,
contradicting `001` §6, which records that passthrough may be carrying fields we
do not read.

So the split is:

- **Read salvages per entry.** No length ceiling, `.passthrough()` on the entry
  so unknown properties survive a load → mutate → save round trip, and — the part
  that matters — a *bad element drops itself, not the array*.
- **Write is strict.** Length and character rules live in the POST and PATCH
  handlers, where rejecting is a 400 to the caller rather than a silent config
  reset for a user who did nothing.

"Tolerant" has to mean per-entry, and it is worth being precise about why,
because the obvious tolerant spelling is also wrong. `.catch(undefined)` on the
array — the pattern used for scalars at `src/config.ts:677` — discards the
**whole array** when any single element fails. Measured on the pinned zod 4.4.3:

```
input:  [ {id:"a", name:"ok", key:"k", createdAt:"t", extra:1}, {id:"", name:2} ]
z.array(entry).optional().catch(undefined)   =>  undefined      // both keys gone
per-entry salvage                            =>  [ {id:"a", …, extra:1} ]
```

So one hand-edited entry would still cost the user every working key — better
than losing providers too, but not acceptable when the good entries are right
there. On a remote bind it is worse than cosmetic: `assertServerAuthConfig`
refuses to start without a data credential (`src/server/auth-cors.ts:194-202`),
so dropping the array can turn a typo into a server that will not boot.

That also answers "why now": phases 2–4 read this entry, so it should have a
declared shape — but the shape's job is to be honest about what is already on
disk, not to retroactively outlaw it.

## File change map

| Path | Action |
|------|--------|
| `src/types.ts` | MODIFY — extract `OcxApiKeyEntry` |
| `src/config.ts` | MODIFY — `apiKeySchema`, wired into `configSchema` |
| `src/server/management/oauth-account-routes.ts` | MODIFY — generation, prefix, PATCH, DELETE, validation |
| `gui/src/pages/api-keys-utils.ts` | MODIFY — unknown-date fallback (B-phase addition) |
| `tests/api-keys-routes.test.ts` | NEW |
| `gui/tests/apikeys-created-date.test.ts` | NEW |

## Diffs

### `src/types.ts:678`

Before:

```ts
  apiKeys?: Array<{ id: string; name: string; key: string; createdAt: string }>;
```

After:

```ts
  apiKeys?: OcxApiKeyEntry[];
```

with the interface declared above `OcxConfig` in the same file:

```ts
/** A generated `ocx_` data-plane key. `key` is the secret and never leaves the
 *  server except in the one-time POST response. */
export interface OcxApiKeyEntry {
  id: string;
  name: string;
  key: string;
  createdAt: string;
}
```

Named so phases 2–4 can refer to one type instead of restating the shape. No
optional fields are added here — phase 3 adds none either (`lastUsedAt` is
derived, not stored, `002` §3).

### `src/config.ts` — salvaging read schema

Add beside the other sub-schemas, before `configSchema`:

```ts
// Deliberately permissive. A user's config is not ours to invalidate: a strict
// entry here fails the whole parse, and loadConfig's fallback backs up the file
// and returns defaults (config.ts:1147-1159) — losing providers and pool accounts
// because one key name was 65 characters. Length/charset rules live at the POST
// and PATCH boundary instead, where they produce a 400.
// `.passthrough()`: unknown per-key properties survive a load → mutate → save.
const apiKeyEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  key: z.string().min(1),
  createdAt: z.string(),
}).passthrough();
```

and in `configSchema` (`src/config.ts:669-704`), alongside the other optional
fields:

```ts
  // Salvage element by element, and never fail the parse. Two failure modes had
  // to be measured on zod 4.4.3 rather than assumed:
  //   `.catch()` on the array      -> one bad entry discards EVERY key
  //   `z.array(z.unknown())`       -> a non-array value (`"apiKeys": "oops"`)
  //                                   still raises invalid_type, which reaches
  //                                   loadConfig's backup-and-reset path
  // Starting from `unknown` is what makes both survivable.
  apiKeys: z.unknown().optional().transform(value => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return undefined;
    return value.filter(row => apiKeyEntrySchema.safeParse(row).success)
      .map(row => apiKeyEntrySchema.parse(row));
  }),
```

Measured, both spellings, on the pinned version:

```
input                                  z.array(z.unknown())…   z.unknown()…
[ {valid, extra:1}, {id:""} ]          [ {valid, extra:1} ]    [ {valid, extra:1} ]
"oops"                                 invalid_type  ✗         undefined  ✓
```

**P amendment (wp2):** the transform does not warn from inside itself. The
existing `warnDegraded*` helpers take `(rawParsed, validated)` and run *after*
`safeParse` in `loadConfig` (`src/config.ts:998-1017`, called at `:1128-1131`) —
they compare the raw object against the validated one. A transform has no access
to that comparison and would fire on every read besides. So the warning follows
the same shape as its siblings: `warnDegradedApiKeys(rawParsed, validated)`,
declared beside them, comparing raw entry count to validated entry count and
reporting the difference. It is wired into `loadConfig` next to
`warnDegradedHostname` on both the success and the repaired-retry paths.

One consequence to state plainly: a dropped entry is not re-saved, so a later
mutation persists the config without it. That is the honest outcome for an entry
the admission loop could not have used anyway (`secretEquals` would have thrown on
a non-string `key`), but it is a deletion, and the warning above is what makes it
visible rather than silent.

### B-phase correction: what "salvage" actually had to mean

The audit killed the first two spellings of this, and both failures were the same
mistake — deciding what a key needs *before* checking what the code needs.

**Only `key` is load-bearing.** Admission compares that one string
(`src/server/auth-cors.ts` `isDataPlaneAdmissionSecret`) and reads nothing else.
The first implementation required all four fields, so a numeric `name` in a
hand-edited config silently revoked a working credential — on a remote bind, a
server that would not start. `key` is now the only required field; `id`, `name`
and `createdAt` degrade to `""`.

**Usable means what admission means.** `min(1)` accepted `"   "` and
`" ocx_data_x "`, neither of which can ever match: the presented token is trimmed,
the stored one is not. Worse, such an entry can sit at `apiKeys[0]`, which
`system-env.ts` and `cli/claude.ts` hand to launched clients — masking a valid key
behind it. The predicate is now `value.length > 0 && value === value.trim()`.

**A key you cannot revoke is not saved.** Degrading `id` to `""` left the user
holding a live credential that PATCH and DELETE refuse to match and the GUI cannot
select. Getting the repair right took three tries, and the two failures are worth
recording because both looked reasonable:

1. *Mint a UUID in the schema transform.* Wrong: the transform runs on every
   parse, so the same credential answered to a different id after each load and
   nothing could agree on it across a restart.
2. *Repair once in `loadConfig`, then write the ids back.* Wrong for a worse
   reason: it puts a file write on the **read** path. A loader that read the file,
   then wrote its snapshot after another process saved a legitimate change, would
   silently erase that change. No amount of atomic-write hardening fixes a lost
   update.
3. *Derive the id deterministically and never write.* `normalizeApiKeyIds` fills
   an empty or duplicated id from the entry's position (`salvaged-1`, …) — same
   file in, same ids out, no I/O and no randomness. The id is not derived from the
   secret; a public identifier should never be a function of key material. It runs
   as a shared post-parse step in `loadConfig` (both paths),
   `readConfigDiagnostics` and `validateConfigCandidate`, because CLI `show`/`get`/
   `export` read diagnostics and an id that exists on only one path is not stable.

One more subtlety the audit caught in that third spelling: explicit ids must be
**reserved before any synthesis**. Assigning `salvaged-1` to the first row would
otherwise displace a later row that already legitimately owns `salvaged-1` from an
earlier normalization, and the two would swap identities depending on array order.
The first holder of an id keeps it; only later collisions move.

A known limitation, stated rather than hidden: if a config still holds malformed
ids and the user reorders or deletes rows by hand, the positional ids shift. That
is inherent to positional derivation, and it resolves the moment any ordinary
mutation (POST/PATCH/DELETE) saves the normalized ids back through the atomic
write path.

The warnings follow the same discipline: `isUsableApiKeySecret` is shared by the
schema and the warning counters, so a dropped row can never be described as
"repaired metadata — the key still works", and a duplicate id gets its own line
because neither existing counter can see it.

### `oauth-account-routes.ts:443-445` — GET prefix

Before:

```ts
      keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.key.slice(0, 8) + "...", createdAt: k.createdAt })),
```

After:

```ts
      // 8 random hex past the fixed `ocx_data_` literal: enough to tell two keys
      // apart in the rail, 128 bits of the tail still unrevealed.
      keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.key.slice(0, 17) + "...", createdAt: k.createdAt })),
```

### `oauth-account-routes.ts:449-462` — POST

Before:

```ts
    const body = await req.json() as { name?: string };
    const name = (body.name ?? "").trim() || "default";
    // Generate key from provider keys hash + random salt
    const providerKeys = Object.values(config.providers).map(p => p.apiKey ?? "").filter(Boolean).join("|");
    const salt = crypto.randomUUID();
    const hashInput = `${providerKeys}|${salt}|${Date.now()}`;
    const hashBuf = new Bun.CryptoHasher("sha256").update(hashInput).digest();
    const key = "ocx_data_" + Buffer.from(hashBuf).toString("hex").slice(0, 40);
```

After:

```ts
    const body = await readJsonBody(req);
    if (!body) return jsonResponse({ error: "invalid body" }, 400, req, config);
    const nameField = validateKeyName(body.name, { required: false });
    if ("error" in nameField) return jsonResponse({ error: nameField.error }, 400, req, config);
    const name = nameField.value || "default";
    // Direct random draw. The old derivation hashed every provider API key into
    // the input, which was never needed for uniqueness and made this secret's
    // safety argument depend on concatenation rather than the RNG.
    const key = "ocx_data_" + randomBytes(20).toString("hex");
```

Two small helpers in the same file, because the current `as` casts are how a
non-string `name` turns into a 500: `(body.name ?? "").trim()` throws on
`{"name": 42}`, and `await req.json()` throws on a malformed body before any
handler code runs.

```ts
/** Parses a JSON object body, or null. Never throws. */
async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** The single place key-name rules live. Read stays tolerant (see the schema
 *  above); this is the write boundary that keeps new junk out. */
function validateKeyName(
  raw: unknown,
  opts: { required: boolean },
): { value: string } | { error: string } {
  if (raw === undefined || raw === null) {
    return opts.required ? { error: "name required" } : { value: "" };
  }
  if (typeof raw !== "string") return { error: "name must be a string" };
  const value = raw.trim();
  if (opts.required && !value) return { error: "name required" };
  if (value.length > 64) return { error: "name too long" };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { error: "invalid name" };
  return { value };
}
```

`id` is validated the same way at its two call sites: a non-string `id` is a 400,
not a filter that silently matches nothing.

`randomBytes` is imported from `node:crypto` at the top of the file, the same
import `src/server/management-auth.ts:1` already uses. 20 bytes is 40 hex — the
payload length is unchanged, so nothing that pattern-matches key shape breaks.
That matters: `isProxyAdmissionSecret` matches `/^ocx_(?:data|admin|session)_/`
(`src/server/auth-cors.ts:236`), which this still satisfies.

The control-character rejection closes W15's server half; the `maxLength` on the
input is phase 4's, alongside the rename field it also adds.

### `oauth-account-routes.ts:464-469` — DELETE and the new PATCH

Before:

```ts
  if (url.pathname === "/api/keys" && req.method === "DELETE") {
    const body = await req.json() as { id?: string };
    if (!body.id) return jsonResponse({ error: "id required" }, 400, req, config);
    config.apiKeys = (config.apiKeys ?? []).filter(k => k.id !== body.id);
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({ success: true }, 200, req, config);
  }
```

After:

```ts
  if (url.pathname === "/api/keys" && req.method === "PATCH") {
    const body = await readJsonBody(req);
    if (!body) return jsonResponse({ error: "invalid body" }, 400, req, config);
    if (typeof body.id !== "string" || !body.id) return jsonResponse({ error: "id required" }, 400, req, config);
    const nameField = validateKeyName(body.name, { required: true });
    if ("error" in nameField) return jsonResponse({ error: nameField.error }, 400, req, config);
    const name = nameField.value;
    const entry = (config.apiKeys ?? []).find(k => k.id === body.id);
    if (!entry) return jsonResponse({ error: "key not found" }, 404, req, config);
    entry.name = name;
    saveConfigPreservingClaudeCode(config);
    // Never echo key material from a rename.
    return jsonResponse({ id: entry.id, name: entry.name, createdAt: entry.createdAt }, 200, req, config);
  }

  if (url.pathname === "/api/keys" && req.method === "DELETE") {
    const body = await readJsonBody(req);
    if (!body) return jsonResponse({ error: "invalid body" }, 400, req, config);
    if (typeof body.id !== "string" || !body.id) return jsonResponse({ error: "id required" }, 400, req, config);
    const before = (config.apiKeys ?? []).length;
    config.apiKeys = (config.apiKeys ?? []).filter(k => k.id !== body.id);
    // A stale id must not read as a successful revocation.
    if (config.apiKeys.length === before) return jsonResponse({ error: "key not found" }, 404, req, config);
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({ success: true }, 200, req, config);
  }
```

PATCH is placed before DELETE so the method dispatch reads in CRUD order.

### Method allowlist — already clear

Checked rather than assumed: `corsHeaders` advertises
`"GET, POST, PUT, PATCH, DELETE, OPTIONS"` (`src/server/auth-cors.ts:124`), and
`managementCorsHeaders` reuses it (`:134-141`). `PATCH` needs no allowlist edit,
and the browser preflight from phase 4 will pass.

## Tests — `tests/api-keys-routes.test.ts` (NEW)

No direct test of these routes exists today (`001` §5), so this file starts the
coverage rather than extending it.

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | POST with a name | 201; body has full `ocx_data_` + 40 hex; entry persisted |
| 2 | Two POSTs | the two `key` values differ, and their first 17 chars differ |
| 3 | POST with no provider keys configured | still succeeds — proves generation no longer depends on provider material |
| 4 | GET after two POSTs | rows carry `prefix` of length 20 (`17 + "..."`), no `key` field anywhere in the payload |
| 5 | POST with a 65-char name | 400, nothing persisted |
| 6 | POST with `"a\u0000b"` | 400 |
| 7 | PATCH a known id | 200, name changed on the next GET, response contains no `key` |
| 8 | PATCH an unknown id | 404, config unchanged |
| 9 | PATCH with empty name | 400 |
| 10 | DELETE a known id | 200, gone from GET |
| 11 | DELETE an unknown id | **404**, and config length unchanged |
| 12 | POST `{"name": 42}`, `{"name": []}`, `{"name": {}}` | 400 each, no 500, nothing persisted |
| 13 | POST with a malformed JSON body | 400, not a thrown 500 |
| 14 | PATCH `{"id": 42}` | 400 |
| 15 | POST with an unknown extra field | ignored; only `name` is read |
| 16 | **Load a config whose `apiKeys` is not an array** (`"apiKeys": "oops"`) | `loadConfig` returns the rest of the config intact — providers and pool accounts survive, no backup-and-reset; a warning is emitted |
| 16b | **Mixed array: one valid entry, one malformed** | the valid key survives and still admits; only the bad entry is dropped; a warning names the count |
| 16c | Mixed array → management mutation → save | the surviving key is still present in the written file |
| 17 | **Load a config with a 200-character key name** | loads unchanged; the legacy name is not rejected at read |
| 18 | **Load → mutate → save round trip on an entry with an unknown extra property** | the extra property survives the save |

Test 11 is the activation scenario for the W5 fix: it fails against today's code,
which returns 200.

Tests 16–18 are the activation scenarios for the schema decision above, and they
are the most important tests in this phase. Each one kills a specific spelling
that looked correct:

- **16** (non-array) fails against `z.array(...)` in any form, including
  `z.array(z.unknown())` — the outer type error still reaches backup-and-reset
  (`src/config.ts:1147-1159`).
- **16b** (mixed array) fails against `.catch(undefined)` on the array, which
  returns zero keys instead of one.
- **16c** proves the survivor is not lost on the next save.
- **17** proves an existing long name is not retroactively fatal.
- **18** proves entry-level `.passthrough()` preserves what `001` §6 flagged.

Tests 12–15 drive the throw paths the old `as` casts had.

Test 3 is the activation scenario for the generation change: with
`config.providers` empty the old derivation still produced a key, so this test
alone does not distinguish — it is paired with test 2, where the old
implementation's uniqueness came from the UUID salt and the new one's from
`randomBytes`. The distinguishing proof is a source assertion that
`oauth-account-routes.ts` no longer reads `p.apiKey` inside the POST handler,
which is checked in the same file as a grep-style guard, in the manner of
`gui/tests/apikeys-layout.test.ts`.

Also re-run: `tests/config.test.ts` (schema regression, above),
`tests/server-management-auth.test.ts` (configured keys still admit),
`tests/server-auth.test.ts` (admission unchanged).

## Accept criteria

1. Two freshly generated keys have different displayed prefixes. **Activation:**
   test 2 above; observable is the inequality of `slice(0, 17)`.
2. The POST handler no longer reads provider API keys. **Activation:** source
   guard in the new test file; observable is the absence of `p.apiKey` in the
   handler body.
3. Deleting an unknown id returns 404 and mutates nothing. **Activation:** test
   11; observable is the status plus unchanged `config.apiKeys.length`.
4. Rename changes the name and never returns key material. **Activation:** test
   7; observable is the changed GET row and `!("key" in body)`.
5. A malformed or wrongly-typed name is rejected with a 400, never a 500.
   **Activation:** tests 5, 6, 9, 12–14.
6. Existing stored keys keep working. **Activation:** test 17 (a legacy long
   name loads) plus a new case in the route test file that seeds an entry whose
   `key` was produced by the old 40-hex derivation and admits with it.
   `tests/server-management-auth.test.ts:213-234` is re-run as a regression, but
   it is not the proof for this criterion: it seeds a hand-written
   `ocx_data_configured-secret`, not an old-scheme key.
7. A malformed entry costs only itself. **Activation:** tests 16, 16b, 16c;
   observable is intact providers, the surviving key still admitting, and that
   key still present in the file after a later mutation.
8. Unknown per-key properties survive a round trip. **Activation:** test 18.
9. `bun run typecheck` and the three named suites are green.

## Risk

The schema is the risky edit, not the crypto — and the risk is worse than it
first looks. `loadConfig` does not degrade a bad `apiKeys` array: it merges
defaults, re-parses, and on a second failure backs the file up and returns
defaults (`src/config.ts:1147-1159`). A strict entry schema would therefore turn
one over-long key name into the loss of every provider and pool account that user
had configured, and the obvious fix — `.catch(undefined)` on the array — still
loses every key the user had. Both were measured, not reasoned about. That is why
validation moved to the write boundary, why the read schema salvages per entry,
and why criteria 6–8 exist rather than a general "config tests still pass".

On a remote bind the array mattering is not cosmetic: `assertServerAuthConfig`
refuses startup without a data credential (`src/server/auth-cors.ts:194-202`), so
silently emptying `apiKeys` can turn a hand-edit typo into a server that will not
boot.

The generation change is forward-only: it cannot invalidate an existing key,
because nothing re-derives a key from its own construction at read time —
admission is a byte comparison (`src/server/auth-cors.ts:204-221`).
